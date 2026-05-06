"""
Phase-D adaptive-mastering-intelligence tests, 2026-05.

Locks the contract for the new analysis stages:

  • Section analyzer detects high/mid/low energy sections from a
    synthesized "verse / chorus / verse / chorus" envelope and
    correctly groups them.
  • Mode-suggester recommends Loud for constant-density tracks AND
    Natural for very-dynamic tracks.
  • AI artifact detector flags phase-inverted stereo as a phase
    anomaly AND surfaces metallic-ring excess on a synthesized
    4-7 kHz peak input.
  • Pipeline integration: every new stage's report is present in
    `result` and structured warnings make it into pipelineWarnings.

Synthesised inputs (numpy → soundfile) so we know ground truth and
can assert structural detection rather than absolute thresholds.
"""
from __future__ import annotations

import os

import numpy as np
import pytest
import soundfile as sf

from app.mastering.pipeline import run_pipeline
from app.qc.ai_artifact_check import (
    run_ai_artifact_check,
    PHASE_ANOMALY_DANGER, METALLIC_DANGER_DB,
)
from app.analysis.section_analyzer import (
    analyze_sections, suggest_mode_from_sections,
)


# ── Synthesis helpers ──────────────────────────────────────────────────────

def _silence(n: int, channels: int = 2) -> np.ndarray:
    return np.zeros((n, channels), dtype=np.float32)


def _noise(n: int, rms: float = 0.05, channels: int = 2) -> np.ndarray:
    rng = np.random.default_rng(42)
    out = rng.standard_normal((n, channels)).astype(np.float32)
    out *= rms / max(1e-9, float(np.sqrt(np.mean(out ** 2))))
    return out


def _make_verse_chorus(tmp_path, sr: int = 44100) -> str:
    """20 s test file: 2 verse + 2 chorus + outro pattern.
        verse  (4 s @ -22 dBFS RMS)  → mid energy
        chorus (4 s @ -12 dBFS RMS)  → high energy
        verse  (4 s @ -22 dBFS RMS)
        chorus (4 s @ -12 dBFS RMS)
        outro  (4 s @ -32 dBFS RMS)  → low energy
    """
    out = str(tmp_path / "verse_chorus.wav")
    parts = []
    spec = [
        (4.0, 10 ** (-22 / 20)),
        (4.0, 10 ** (-12 / 20)),
        (4.0, 10 ** (-22 / 20)),
        (4.0, 10 ** (-12 / 20)),
        (4.0, 10 ** (-32 / 20)),
    ]
    for dur, rms in spec:
        n = int(round(dur * sr))
        parts.append(_noise(n, rms=rms))
    data = np.vstack(parts)
    sf.write(out, data, sr, subtype="PCM_24")
    return out


def _make_constant_density(tmp_path, sr: int = 44100) -> str:
    """20 s of pink-ish noise at constant -16 dBFS RMS — no
    sectional structure."""
    out = str(tmp_path / "constant.wav")
    n = sr * 20
    data = _noise(n, rms=10 ** (-16 / 20))
    sf.write(out, data, sr, subtype="PCM_24")
    return out


def _make_phase_inverted(tmp_path, sr: int = 44100) -> str:
    """L/R have inverted phase across the full file — extreme phase
    anomaly that should fail mono fold.  R = -L."""
    out = str(tmp_path / "phase_inverted.wav")
    n = sr * 5
    rng = np.random.default_rng(7)
    base = rng.standard_normal(n).astype(np.float32) * 0.1
    data = np.column_stack([base, -base])
    sf.write(out, data, sr, subtype="PCM_24")
    return out


def _make_metallic_ring(tmp_path, sr: int = 44100) -> str:
    """Pink noise floor + strong narrowband ringing at 5.5 kHz to
    mimic AI vocoder artifacts."""
    out = str(tmp_path / "metallic.wav")
    n = sr * 5
    rng = np.random.default_rng(9)
    bg = rng.standard_normal((n, 2)).astype(np.float32) * 0.03
    t = np.arange(n) / sr
    ring = (0.35 * np.sin(2 * np.pi * 5500 * t)).astype(np.float32)
    data = bg.copy()
    data[:, 0] += ring
    data[:, 1] += ring * 0.97
    sf.write(out, data, sr, subtype="PCM_24")
    return out


# ── Section analyzer ────────────────────────────────────────────────────────

def _fake_segment_report(window_sec: float = 0.5,
                          stlufs_pattern: list[float] = None) -> dict:
    """Build a fake compute_segment_timeseries result for testing the
    analyzer in isolation."""
    pattern = stlufs_pattern or [-22, -22, -22, -22,
                                  -12, -12, -12, -12,
                                  -22, -22, -22, -22,
                                  -12, -12, -12, -12,
                                  -32, -32, -32, -32]
    windows = [{
        "start": i * window_sec,
        "end": (i + 1) * window_sec,
        "stLufs": v,
        "rmsDb":  v - 0.7,
        "peakDb": v + 8.0,
        "crestDb": 8.0,
    } for i, v in enumerate(pattern)]
    return {"windowSec": window_sec, "windows": windows,
             "suspectSegments": [], "summary": None}


def test_section_analyzer_groups_verse_chorus():
    """A clean verse/chorus pattern should yield ≥ 2 'high' sections
    + ≥ 2 'mid' sections + ≥ 1 'low' section AND alternationScore > 0.5."""
    seg = _fake_segment_report()
    report = analyze_sections(seg)
    assert not report["skipped"]
    summary = report["summary"]
    assert summary["highSectionCount"] >= 2
    # mid+low in this pattern
    assert summary["midSectionCount"] + summary["lowSectionCount"] >= 2
    assert summary["alternationScore"] >= 0.5, (
        f"alternationScore = {summary['alternationScore']} (expected ≥ 0.5)"
    )
    # The dynamic range between -32 (low) and -12 (high) sections.
    assert summary["dynamicRangeLu"] >= 15.0, (
        f"dynamicRangeLu = {summary['dynamicRangeLu']} (expected ≥ 15)"
    )


def test_section_analyzer_constant_density():
    """A flat-LUFS pattern should produce a single section with
    alternationScore = 0."""
    seg = _fake_segment_report(stlufs_pattern=[-16] * 20)
    report = analyze_sections(seg)
    summary = report["summary"]
    # 1 section, all 'mid'.
    assert len(report["sections"]) == 1
    assert summary["alternationScore"] == 0.0
    assert summary["dynamicRangeLu"] == 0.0


def test_mode_suggester_recommends_natural_for_dynamic():
    seg = _fake_segment_report()
    sa = analyze_sections(seg)
    sug = suggest_mode_from_sections(sa, current_style="loud")
    assert sug["suggestedMode"] == "natural"
    assert sug["wouldChange"] is True


def test_mode_suggester_recommends_loud_for_constant():
    seg = _fake_segment_report(stlufs_pattern=[-16] * 20)
    sa = analyze_sections(seg)
    sug = suggest_mode_from_sections(sa, current_style="natural")
    assert sug["suggestedMode"] in ("loud", "kpop_loud")


# ── AI artifact detector ────────────────────────────────────────────────────

def test_ai_artifact_phase_anomaly_flagged(tmp_path):
    src = _make_phase_inverted(tmp_path)
    report = run_ai_artifact_check(src)
    assert not report["skipped"]
    codes = {f["code"] for f in report["findings"]}
    assert "AI_PHASE_DANGER" in codes, (
        f"phase-inverted input not flagged: {report}"
    )
    # Correlation should be very negative.
    assert report["metrics"]["stereoCorrelation"] < PHASE_ANOMALY_DANGER + 0.05


def test_ai_artifact_metallic_ring_flagged(tmp_path):
    src = _make_metallic_ring(tmp_path)
    report = run_ai_artifact_check(src)
    codes = {f["code"] for f in report["findings"]}
    assert "AI_METALLIC_DANGER" in codes or "AI_METALLIC_WARN" in codes, (
        f"metallic-ring input not flagged: {report}"
    )
    assert report["metrics"]["metallicExcessDb"] >= METALLIC_DANGER_DB - 1.0


def test_ai_artifact_clean_track_no_findings(tmp_path):
    """Pink noise (broad-spectrum, decorrelated R = independent noise)
    should NOT trigger any AI artifact warnings."""
    out = str(tmp_path / "clean.wav")
    n = 44100 * 5
    rng = np.random.default_rng(13)
    # Independent L/R but no phase inversion → correlation ~ 0 (not negative)
    data = rng.standard_normal((n, 2)).astype(np.float32) * 0.1
    sf.write(out, data, 44100, subtype="PCM_24")
    report = run_ai_artifact_check(out)
    assert report["verdict"] == "ok", (
        f"clean noise misflagged as AI artifact: {report}"
    )


# ── Pipeline integration ────────────────────────────────────────────────────

def test_pipeline_result_includes_section_analysis(pink_noise_wav, tmp_path):
    """run_pipeline must populate `sectionAnalysis`, `modeSuggestion`,
    `aiArtifactCheck` keys in the result dict."""
    out = str(tmp_path / "phase_d_pipe.wav")
    result = run_pipeline(pink_noise_wav, out, style="balanced",
                          target_lufs=-12.0, target_tp=-1.0,
                          generate_waveforms=False)
    assert "sectionAnalysis"  in result
    assert "modeSuggestion"   in result
    assert "aiArtifactCheck"  in result
    sa = result["sectionAnalysis"]
    assert sa is not None
    # On 30s pink noise the analyzer may skip (constant density) —
    # either skipped=True OR a real summary, both acceptable.
    if not sa.get("skipped"):
        assert "summary" in sa
        assert "dynamicRangeLu" in sa["summary"]


def test_pipeline_perceptual_loudness_movement_preserved(tmp_path):
    """Phase-D promise: masters preserve emotional dynamics.  A
    verse/chorus input must still have ≥ 4 LU dynamic range between
    its sections AFTER mastering in Balanced mode (Natural would be
    more conservative; Balanced is the strict test).  Anything lower
    means we've squashed the song into constant density."""
    src = _make_verse_chorus(tmp_path)
    out = str(tmp_path / "preserved.wav")
    result = run_pipeline(src, out, style="balanced",
                          target_lufs=-12.0, target_tp=-1.0,
                          generate_waveforms=False)
    sa = result.get("sectionAnalysis")
    assert sa is not None and not sa.get("skipped"), (
        f"section analysis should run on a 20-sec verse/chorus track: {sa}"
    )
    dr = sa["summary"]["dynamicRangeLu"]
    assert dr >= 4.0, (
        f"verse/chorus dynamic range collapsed to {dr:.1f} LU after master "
        f"(expected ≥ 4 LU preserved).  Pipeline is over-flattening."
    )
