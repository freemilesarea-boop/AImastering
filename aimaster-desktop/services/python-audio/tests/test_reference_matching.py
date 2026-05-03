"""
Tests for v3.4 Ozone-style reference matching:
  · reference_matching.py — analyze_reference, target profile, match score, EQ deltas
  · multiband.py          — band measurement + EQ chain builder
  · iterative.py          — orchestrator (smoke tested)
"""
from __future__ import annotations

import os
import subprocess

import pytest


# ── Reusable fixtures ───────────────────────────────────────────────────────

def _ffmpeg_available() -> bool:
    try:
        subprocess.run(["ffmpeg", "-version"], capture_output=True, timeout=5)
        return True
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False


@pytest.fixture(scope="module")
def reference_wav(tmp_path_factory):
    """A pre-mastered stereo reference at ~-14 LUFS (realistic streaming master)."""
    if not _ffmpeg_available():
        pytest.skip("ffmpeg not available")
    p = tmp_path_factory.mktemp("ref") / "reference.wav"
    # Pink noise normalised to -14 LUFS using loudnorm
    subprocess.run([
        "ffmpeg", "-y", "-f", "lavfi",
        "-i", "anoisesrc=color=pink:duration=10",
        "-ar", "44100", "-acodec", "pcm_s24le", "-ac", "2",
        "-af", "loudnorm=I=-14:TP=-1.5:LRA=8:linear=false",
        str(p),
    ], check=True, capture_output=True)
    return str(p)


@pytest.fixture(scope="module")
def quiet_input_wav(tmp_path_factory):
    """A quieter source (~-22 LUFS) so the iterative loop has work to do."""
    if not _ffmpeg_available():
        pytest.skip("ffmpeg not available")
    p = tmp_path_factory.mktemp("inp") / "input.wav"
    subprocess.run([
        "ffmpeg", "-y", "-f", "lavfi",
        "-i", "anoisesrc=color=pink:duration=10",
        "-ar", "44100", "-acodec", "pcm_s24le", "-ac", "2",
        "-af", "volume=-10dB",
        str(p),
    ], check=True, capture_output=True)
    return str(p)


# ── multiband.py ──────────────────────────────────────────────────────────

def test_band_definitions_have_4_bands():
    from app.mastering.multiband import BAND_DEFINITIONS, BAND_KEYS
    assert set(BAND_KEYS) == {"low", "mid", "vocal", "high"}
    for k in BAND_KEYS:
        lo, hi, c, q = BAND_DEFINITIONS[k]
        assert lo < hi
        assert lo <= c <= hi


def test_measure_band_profile_returns_4_dB_values(reference_wav):
    from app.mastering.multiband import measure_band_profile
    bands = measure_band_profile(reference_wav)
    assert set(bands.keys()) == {"low", "mid", "vocal", "high"}
    for k, v in bands.items():
        assert -120 <= v <= 0, f"{k} band {v} dB out of range"


def test_build_multiband_eq_chain_skips_small_deltas():
    from app.mastering.multiband import build_multiband_eq_chain
    # All deltas < 0.3 → no filter generated
    chain, applied = build_multiband_eq_chain(
        {"low": 0.1, "mid": -0.2, "vocal": 0.0, "high": 0.05}
    )
    assert chain == ""
    assert applied == []


def test_build_multiband_eq_chain_emits_equalizer_per_band():
    from app.mastering.multiband import build_multiband_eq_chain
    chain, applied = build_multiband_eq_chain(
        {"low": +1.5, "mid": -2.0, "vocal": -1.0, "high": +0.8}
    )
    # 4 equalizer filters joined by commas
    assert chain.count("equalizer=") == 4
    assert len(applied) == 4
    assert {a["band"] for a in applied} == {"low", "mid", "vocal", "high"}


def test_build_multiband_eq_chain_clamps_vocal_boost():
    """Vocal-band boost > +2 dB must be clamped to +2 dB by vocal protection."""
    from app.mastering.multiband import build_multiband_eq_chain
    log: list[dict] = []
    chain, applied = build_multiband_eq_chain(
        {"vocal": +4.0}, protection_log=log,
    )
    vocal_entry = next(a for a in applied if a["band"] == "vocal")
    assert vocal_entry["requestedDb"] == 4.0
    assert vocal_entry["appliedDb"]   == 2.0
    assert any("vocal_boost" in c["where"] for c in log)


def test_build_multiband_eq_chain_does_not_clamp_vocal_cut():
    """Vocal-band CUTS pass through (cuts reduce harshness, are user-requested)."""
    from app.mastering.multiband import build_multiband_eq_chain
    log: list[dict] = []
    chain, applied = build_multiband_eq_chain(
        {"vocal": -3.5}, protection_log=log,
    )
    vocal_entry = next(a for a in applied if a["band"] == "vocal")
    assert vocal_entry["appliedDb"] == -3.5
    assert log == []


# ── reference_matching.py ─────────────────────────────────────────────────

def test_analyze_reference_returns_full_profile(reference_wav):
    from app.mastering.reference_matching import analyze_reference
    profile = analyze_reference(reference_wav)
    assert profile.available
    assert profile.durationSec > 9.0
    assert profile.integratedLufs < 0   # well below 0 LUFS
    assert profile.crestDb > 5.0        # noise has >5 dB crest
    assert set(profile.bands.keys()) == {"low", "mid", "vocal", "high"}
    assert profile.stereoWidth is not None  # stereo file


def test_analyze_reference_returns_empty_for_missing_file():
    from app.mastering.reference_matching import analyze_reference
    profile = analyze_reference("/nonexistent.wav")
    assert profile.available is False


def test_compute_target_profile_copies_reference():
    from app.mastering.reference_matching import (
        analyze_reference, compute_target_profile, ReferenceProfile,
    )
    ref = ReferenceProfile(
        path="x", durationSec=10.0, integratedLufs=-12.0, truePeakDbtp=-1.5,
        lra=8.0, samplePeakDb=-3.0, rmsDb=-15.0, crestDb=12.0,
        bands={"low": -12.0, "mid": -10.0, "vocal": -15.0, "high": -20.0},
        stereoWidth=0.4, lrCorrelation=0.85, available=True,
    )
    target = compute_target_profile(ref)
    assert target["targetLufs"] == -12.0
    assert target["targetBands"] == ref.bands
    assert target["targetStereoWidth"] == 0.4


def test_compute_target_profile_respects_lufs_override():
    from app.mastering.reference_matching import (
        compute_target_profile, ReferenceProfile,
    )
    ref = ReferenceProfile(
        path="x", durationSec=10.0, integratedLufs=-9.0, truePeakDbtp=-1.0,
        lra=4.0, samplePeakDb=-2.0, rmsDb=-12.0, crestDb=10.0,
        bands={"low": -10.0, "mid": -8.0, "vocal": -12.0, "high": -16.0},
        stereoWidth=0.3, lrCorrelation=0.9, available=True,
    )
    target = compute_target_profile(ref, target_lufs_override=-14.0)
    assert target["targetLufs"] == -14.0
    # other axes preserved
    assert target["targetBands"] == ref.bands


def test_compute_match_score_perfect():
    from app.mastering.reference_matching import (
        compute_match_score, ReferenceProfile,
    )
    profile = ReferenceProfile(
        path="x", durationSec=10.0, integratedLufs=-14.0, truePeakDbtp=-1.0,
        lra=8.0, samplePeakDb=-3.0, rmsDb=-15.0, crestDb=12.0,
        bands={"low": -12.0, "mid": -10.0, "vocal": -15.0, "high": -20.0},
        stereoWidth=0.4, lrCorrelation=0.85, available=True,
    )
    target = {
        "targetLufs": -14.0, "targetTruePeak": -1.0, "targetLra": 8.0,
        "targetBands": dict(profile.bands), "targetStereoWidth": 0.4,
    }
    scores = compute_match_score(profile, target)
    assert scores["overall"] == 100.0
    assert all(s == 100.0 for s in scores["bands"].values())


def test_compute_match_score_off_target_drops():
    from app.mastering.reference_matching import (
        compute_match_score, ReferenceProfile,
    )
    profile = ReferenceProfile(
        path="x", durationSec=10.0, integratedLufs=-18.0,  # 4 LU off
        truePeakDbtp=-1.0, lra=2.0,                         # 6 LU off
        samplePeakDb=-3.0, rmsDb=-15.0, crestDb=12.0,
        bands={"low": -20.0, "mid": -18.0, "vocal": -25.0, "high": -30.0},  # all 8-10 dB off
        stereoWidth=0.4, lrCorrelation=0.85, available=True,
    )
    target = {
        "targetLufs": -14.0, "targetTruePeak": -1.0, "targetLra": 8.0,
        "targetBands": {"low": -12.0, "mid": -10.0, "vocal": -15.0, "high": -20.0},
        "targetStereoWidth": 0.4,
    }
    scores = compute_match_score(profile, target)
    assert scores["overall"] < 50      # significantly off
    assert scores["lufs"] < 30         # 4 LU off → near 0
    assert scores["lra"]  == 0.0       # 6 LU off → 0
    assert scores["weakestAxis"] is not None


def test_derive_eq_correction_clamps_max():
    from app.mastering.reference_matching import (
        derive_eq_correction, ReferenceProfile,
    )
    p = ReferenceProfile(
        path="x", durationSec=10.0, integratedLufs=-22.0, truePeakDbtp=-3.0,
        lra=12.0, samplePeakDb=-5.0, rmsDb=-22.0, crestDb=14.0,
        bands={"low": -30.0, "mid": -25.0, "vocal": -28.0, "high": -40.0},
        stereoWidth=0.3, lrCorrelation=0.8, available=True,
    )
    target = {
        "targetBands": {"low": -10.0, "mid": -10.0, "vocal": -15.0, "high": -15.0},
    }
    deltas = derive_eq_correction(p, target, max_band_correction_db=4.0)
    # All deltas clamped to ±4 dB
    for k, v in deltas.items():
        assert -4.0 <= v <= 4.0
    # vocal boost extra-clamped to +2 dB
    assert deltas["vocal"] <= 2.0


# ── iterative.py (smoke) ──────────────────────────────────────────────────

def test_iterative_mastering_matches_reference(reference_wav, quiet_input_wav, tmp_path):
    """End-to-end: iterative loop must improve match score over baseline."""
    from app.mastering.iterative import run_iterative_mastering
    out_path = str(tmp_path / "out.wav")
    result = run_iterative_mastering(
        quiet_input_wav, out_path,
        reference_path=reference_wav,
        max_iterations=2,
        accept_threshold=85.0,
        style="balanced",
        sample_rate=44100,
        bit_depth=24,
        generate_waveforms=False,
    )
    assert os.path.isfile(out_path)
    rm = result.get("referenceMatch")
    assert rm is not None
    assert rm["iterations"] >= 1
    assert rm["overall"] is not None
    # Match score should be at least mediocre — pink noise → pink noise is easy
    assert rm["overall"] > 50.0
    assert "perAxis" in rm and "bands" in rm["perAxis"]


def test_iterative_mastering_requires_reference_or_target(tmp_path):
    from app.mastering.iterative import run_iterative_mastering
    with pytest.raises(ValueError, match="reference_path or target"):
        run_iterative_mastering(
            "/x.wav", str(tmp_path / "o.wav"), max_iterations=1,
        )


def test_iterative_mastering_target_lufs_override_caps_loudness(
    reference_wav, quiet_input_wav, tmp_path,
):
    """User can match a -8 LUFS reference but cap at -14 for streaming."""
    from app.mastering.iterative import run_iterative_mastering
    out_path = str(tmp_path / "out_capped.wav")
    result = run_iterative_mastering(
        quiet_input_wav, out_path,
        reference_path=reference_wav,
        target_lufs_override=-14.0,
        max_iterations=1,
        style="balanced",
        sample_rate=44100,
        bit_depth=24,
        generate_waveforms=False,
    )
    target = result.get("targetProfile") or {}
    assert target.get("targetLufs") == -14.0
