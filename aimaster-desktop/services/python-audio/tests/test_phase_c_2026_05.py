"""
Phase-C production-integration tests, 2026-05.

Locks the contract for the new wired stages:

  • stereo_enhance pass actually runs (gain_stages records the amount,
    appliedCorrections lists the move).  Per-mode default is honoured.
  • translation_check populates `result["translationCheck"]` with the
    expected per-profile findings.  Bad masters trigger warnings.
  • vocal_intelligence populates `result["vocalIntelligence"]`.  An
    instrumental track is correctly skipped (centrality below threshold).
  • Mono-fold safety end-to-end: after the new pipeline (stereo_enhance
    + everything) the mastered output's low-band side energy is lower
    than what the legacy path would produce.
"""
from __future__ import annotations

import os
import subprocess

import pytest

from app.mastering.pipeline import run_pipeline
from app.qc.translation_check import run_translation_check
from app.qc.vocal_intelligence import run_vocal_intelligence
from app.utils.translation_sim import (
    measure_low_band_side_rms_db, stereo_correlation, ALL_PROFILES,
)
from app.utils.ffmpeg_wrapper import _FFMPEG_BIN


# ── Helper synthesis ────────────────────────────────────────────────────────

def _ffmpeg(*args: str) -> None:
    subprocess.run([_FFMPEG_BIN, "-hide_banner", "-y", *args],
                   check=True, capture_output=True, text=True)


def _make_low_band_stereo(tmp_path) -> str:
    """L=60Hz, R=80Hz at -10dBFS each + 1 kHz mid → low-band L/R differs."""
    out = str(tmp_path / "low_band_stereo.wav")
    _ffmpeg(
        "-f", "lavfi", "-i", "sine=frequency=60:duration=4:sample_rate=44100",
        "-f", "lavfi", "-i", "sine=frequency=80:duration=4:sample_rate=44100",
        "-f", "lavfi", "-i", "sine=frequency=1000:duration=4:sample_rate=44100",
        "-filter_complex",
        "[0:a]volume=-10dB[L_lo];[1:a]volume=-10dB[R_lo];"
        "[2:a]volume=-15dB,asplit=2[mid_l][mid_r];"
        "[L_lo][mid_l]amix=inputs=2:weights=1 1[L];"
        "[R_lo][mid_r]amix=inputs=2:weights=1 1[R];"
        "[L][R]amerge=inputs=2,pan=stereo|c0=c0|c1=c1",
        "-acodec", "pcm_s24le", out,
    )
    return out


# ── Phase C1 — stereo_enhance integration ──────────────────────────────────

@pytest.mark.parametrize("style,expected_amount", [
    ("natural",   None),     # 1.0 → no-op
    ("balanced",  1.05),
    ("bright",    1.10),
    ("warm",      None),     # 1.0 → no-op
    ("punch",     1.05),
    ("loud",      1.10),
    ("kpop_loud", 1.15),
])
def test_stereo_enhance_runs_with_per_mode_amount(pink_noise_wav, tmp_path,
                                                    style, expected_amount):
    """For every mode whose default stereo_enhance_amount > 1.0, the
    pipeline must record the move in gain_stages AND mention it in
    appliedCorrections.  For natural/warm (amount=1.0) the stage must
    be silently bypassed."""
    out = str(tmp_path / f"se_{style}.wav")
    result = run_pipeline(
        pink_noise_wav, out, style=style,
        target_lufs=-12.0, target_tp=-1.0,
        generate_waveforms=False,
    )
    gs = (result.get("gainStaging") or {}).get("stages", {})
    applied = result.get("appliedCorrections") or []
    if expected_amount is None:
        # Bypassed.
        assert "stereoEnhanceAmount" not in gs, (
            f"{style}: stereo_enhance ran when it should be no-op: {gs}"
        )
        assert not any("Stereo 확장" in s for s in applied), (
            f"{style}: appliedCorrections leaked stereo move: {applied}"
        )
    else:
        assert gs.get("stereoEnhanceAmount") == expected_amount, (
            f"{style}: expected stereoEnhanceAmount={expected_amount}, got {gs}"
        )
        assert any("Stereo 확장" in s for s in applied), (
            f"{style}: appliedCorrections missing stereo move: {applied}"
        )


def test_stereo_enhance_kwarg_overrides_mode_default(pink_noise_wav, tmp_path):
    """Explicit stereo_enhance_amount kwarg overrides the per-mode default."""
    out = str(tmp_path / "se_override.wav")
    result = run_pipeline(
        pink_noise_wav, out, style="balanced",   # default 1.05
        target_lufs=-12.0, target_tp=-1.0,
        stereo_enhance_amount=1.30,              # override
        generate_waveforms=False,
    )
    gs = (result.get("gainStaging") or {}).get("stages", {})
    assert gs.get("stereoEnhanceAmount") == 1.30, (
        f"override ignored: {gs}"
    )


def test_pipeline_low_band_mono_safer_than_legacy(tmp_path):
    """End-to-end: a low-band-stereo input mastered through the new
    pipeline (stereo_enhance enabled, kpop_loud default 1.15) must
    produce LOWER side energy in the sub-crossover band than running
    the same input through the explicit legacy `extrastereo=m=1.15:c=0`
    that the old pipeline would have applied."""
    src = _make_low_band_stereo(tmp_path)

    # New pipeline (auto stereo_enhance via mode default).
    new_out = str(tmp_path / "new.wav")
    run_pipeline(src, new_out, style="kpop_loud",
                 target_lufs=-9.0, target_tp=-0.8,
                 generate_waveforms=False)
    new_side = measure_low_band_side_rms_db(new_out, lo_hz=20, hi_hz=80)

    # Approximate legacy: same input through extrastereo=1.15 only
    # (no other mastering chain since we're isolating the stereo stage).
    legacy_out = str(tmp_path / "legacy.wav")
    _ffmpeg("-i", src, "-af", "extrastereo=m=1.15:c=0",
            "-acodec", "pcm_s24le", legacy_out)
    legacy_side = measure_low_band_side_rms_db(legacy_out, lo_hz=20, hi_hz=80)

    assert new_side is not None and legacy_side is not None
    # The new pipeline runs the full kpop_loud chain (compressor, EQ,
    # limiter, ISP guard, all of which modulate side energy) plus the
    # mono-safe stereo widener.  The "legacy" comparison is a bare
    # extrastereo on the raw input with NO other stages.  Even with
    # this asymmetric setup the new path measurably reduces the sub-
    # crossover side energy — we lock ≥ 1.5 dB safer.
    assert new_side < legacy_side - 1.5, (
        f"new pipeline side={new_side:.1f} dB, legacy extrastereo "
        f"side={legacy_side:.1f} dB — expected ≥ 1.5 dB safer."
    )


# ── Phase C2 — translation_check integration ───────────────────────────────

def test_translation_check_populates_findings(pink_noise_wav, tmp_path):
    """A normally-mastered pink noise input should produce a
    translation_check report with findings for each of the 4 profiles
    (phone / car / mono / youtube_normalize)."""
    out = str(tmp_path / "for_xlate.wav")
    result = run_pipeline(pink_noise_wav, out, style="balanced",
                          target_lufs=-12.0, target_tp=-1.0,
                          generate_waveforms=False)
    tc = result.get("translationCheck")
    assert tc is not None, "translationCheck missing from result"
    assert "verdict" in tc and tc["verdict"] in ("ok", "warn", "danger")
    findings = tc.get("findings", [])
    profiles = {f["profile"] for f in findings}
    expected = {"phone_speaker", "car_dash", "mono_fold", "youtube_normalize"}
    assert expected.issubset(profiles), (
        f"missing translation profiles: {expected - profiles}"
    )


def test_translation_check_phone_drop_flagged(tmp_path):
    """Synthesise a mostly-bass test signal whose energy lives BELOW the
    phone-speaker passband (300-3500 Hz).  After running translation
    check, phone_speaker must report a large LUFS drop and surface a
    warning."""
    src = str(tmp_path / "bass_only.wav")
    _ffmpeg(
        "-f", "lavfi", "-i", "sine=frequency=80:duration=5:sample_rate=44100",
        "-f", "lavfi", "-i", "sine=frequency=120:duration=5:sample_rate=44100",
        "-filter_complex",
        "[0:a]volume=-3dB[a];[1:a]volume=-3dB[b];[a][b]amerge=inputs=2,"
        "pan=stereo|c0=c0|c1=c1",
        "-acodec", "pcm_s24le", src,
    )
    report = run_translation_check(src, target_lufs=-12.0)
    phone = next((f for f in report["findings"] if f["profile"] == "phone_speaker"), None)
    assert phone is not None
    # Bass-only content should drop significantly when phone-band-passed.
    assert phone["verdict"] in ("warn", "danger"), (
        f"bass-only input should trigger phone-translation warning, got "
        f"verdict={phone['verdict']}, msg={phone['message']}"
    )


# ── Phase C4 — vocal_intelligence integration ──────────────────────────────

def test_vocal_intelligence_skips_instrumental(tmp_path):
    """A wide-stereo instrumental (different L vs R) should be flagged
    as instrumental (centrality below threshold) and skip detection."""
    src = str(tmp_path / "instrumental.wav")
    _ffmpeg(
        "-f", "lavfi", "-i", "sine=frequency=440:duration=4:sample_rate=44100",
        "-f", "lavfi", "-i", "sine=frequency=660:duration=4:sample_rate=44100",
        "-filter_complex",
        "[0:a]volume=-10dB[a];[1:a]volume=-10dB[b];[a][b]amerge=inputs=2,"
        "pan=stereo|c0=c0|c1=c1",
        "-acodec", "pcm_s24le", src,
    )
    report = run_vocal_intelligence(src)
    assert report.get("skipped") is True, (
        f"instrumental should be skipped, got {report}"
    )
    assert report["verdict"] == "ok"
    assert report["findings"] == []


def test_vocal_intelligence_in_pipeline_result(pink_noise_wav, tmp_path):
    """After mastering, the result must include vocalIntelligence with
    the metric block populated (skipped or with metrics)."""
    out = str(tmp_path / "for_vi.wav")
    result = run_pipeline(pink_noise_wav, out, style="balanced",
                          target_lufs=-12.0, target_tp=-1.0,
                          generate_waveforms=False)
    vi = result.get("vocalIntelligence")
    assert vi is not None
    assert "verdict" in vi
    assert "metrics" in vi or vi.get("skipped") is True
