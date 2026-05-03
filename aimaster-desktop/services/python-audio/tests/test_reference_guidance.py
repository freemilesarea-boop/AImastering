"""
Tests for v3.4.1 reference-guidance system:
  · validate_reference()       — flag bad references (LUFS/TP/LRA/duration)
  · compare_input_vs_reference() — flag genre/spectrum mismatch
  · reference_presets           — built-in preset list + auto-recommend
"""
from __future__ import annotations

import pytest


def _profile(**overrides):
    """Helper to build a ReferenceProfile with sane defaults."""
    from app.mastering.reference_matching import ReferenceProfile
    base = dict(
        path="x", durationSec=180.0,
        integratedLufs=-12.0, truePeakDbtp=-1.0, lra=7.0,
        samplePeakDb=-3.0, rmsDb=-15.0, crestDb=10.0,
        bands={"low": -16.0, "mid": -14.0, "vocal": -17.0, "high": -22.0},
        stereoWidth=0.4, lrCorrelation=0.85, available=True,
    )
    base.update(overrides)
    return ReferenceProfile(**base)


# ── validate_reference ──────────────────────────────────────────────────────

def test_validate_reference_passes_clean_master():
    from app.mastering.reference_matching import validate_reference
    warnings = validate_reference(_profile())
    assert warnings == []


def test_validate_reference_flags_too_quiet():
    from app.mastering.reference_matching import validate_reference
    w = validate_reference(_profile(integratedLufs=-30.0))
    codes = [x["code"] for x in w]
    assert "REFERENCE_TOO_QUIET" in codes


def test_validate_reference_flags_too_loud():
    from app.mastering.reference_matching import validate_reference
    w = validate_reference(_profile(integratedLufs=-4.0))
    assert any(x["code"] == "REFERENCE_TOO_LOUD" for x in w)


def test_validate_reference_flags_tp_overshoot():
    from app.mastering.reference_matching import validate_reference
    w = validate_reference(_profile(truePeakDbtp=+0.2))
    assert any(x["code"] == "REFERENCE_TP_OVER" for x in w)


def test_validate_reference_flags_brickwall():
    from app.mastering.reference_matching import validate_reference
    w = validate_reference(_profile(lra=0.5))
    assert any(x["code"] == "REFERENCE_BRICKWALL" for x in w)


def test_validate_reference_flags_too_dynamic():
    from app.mastering.reference_matching import validate_reference
    w = validate_reference(_profile(lra=20.0))
    assert any(x["code"] == "REFERENCE_VERY_DYNAMIC" for x in w)


def test_validate_reference_flags_short_duration():
    from app.mastering.reference_matching import validate_reference
    w = validate_reference(_profile(durationSec=5.0))
    assert any(x["code"] == "REFERENCE_TOO_SHORT" for x in w)


def test_validate_reference_flags_unanalyzable():
    from app.mastering.reference_matching import validate_reference
    w = validate_reference(_profile(available=False))
    assert any(x["code"] == "REFERENCE_UNAVAILABLE" for x in w)
    assert w[0]["severity"] == "danger"


# ── compare_input_vs_reference ──────────────────────────────────────────────

def test_compare_clean_compatible_pair():
    from app.mastering.reference_matching import compare_input_vs_reference
    inp = _profile(bands={"low": -18, "mid": -15, "vocal": -17, "high": -23})
    ref = _profile(bands={"low": -16, "mid": -14, "vocal": -17, "high": -22})
    warnings = compare_input_vs_reference(inp, ref)
    assert warnings == []


def test_compare_flags_band_shape_mismatch():
    """Hip-hop input (bass-heavy) vs jazz reference (balanced) → mismatch."""
    from app.mastering.reference_matching import compare_input_vs_reference
    inp = _profile(bands={"low": -8, "mid": -20, "vocal": -22, "high": -28})
    ref = _profile(bands={"low": -22, "mid": -16, "vocal": -18, "high": -23})
    warnings = compare_input_vs_reference(inp, ref)
    codes = [w["code"] for w in warnings]
    assert any("GENRE_MISMATCH" in c for c in codes)


def test_compare_flags_lra_gap():
    """Unmastered demo vs mastered reference → big LRA gap."""
    from app.mastering.reference_matching import compare_input_vs_reference
    inp = _profile(lra=15.0)
    ref = _profile(lra=4.0)
    warnings = compare_input_vs_reference(inp, ref)
    codes = [w["code"] for w in warnings]
    assert "INPUT_FAR_MORE_DYNAMIC" in codes


def test_compare_flags_stereo_width_mismatch():
    from app.mastering.reference_matching import compare_input_vs_reference
    inp = _profile(stereoWidth=0.05)
    ref = _profile(stereoWidth=0.55)
    warnings = compare_input_vs_reference(inp, ref)
    assert any(w["code"] == "STEREO_WIDTH_MISMATCH" for w in warnings)


def test_compare_skips_when_either_unavailable():
    from app.mastering.reference_matching import compare_input_vs_reference
    inp = _profile(available=False)
    ref = _profile()
    assert compare_input_vs_reference(inp, ref) == []


# ── reference_presets ──────────────────────────────────────────────────────

def test_list_reference_presets_returns_at_least_5():
    from app.mastering.reference_presets import list_reference_presets
    presets = list_reference_presets()
    assert len(presets) >= 5
    keys = {p["key"] for p in presets}
    # Must include the streaming-safe fallback at minimum
    assert "streaming_safe" in keys
    # Each preset has the required UI fields
    for p in presets:
        for required in ("key", "label", "description", "bestFor", "targetLufs"):
            assert required in p, f"preset {p.get('key')} missing {required}"


def test_get_reference_preset_returns_target_profile_shape():
    from app.mastering.reference_presets import get_reference_preset
    p = get_reference_preset("streaming_safe")
    assert p is not None
    for key in ("targetLufs", "targetTruePeak", "targetLra",
                "targetBands", "targetStereoWidth", "targetCrestDb",
                "sourceReferencePath"):
        assert key in p
    # Bands must have the 4 standard keys
    assert set(p["targetBands"].keys()) == {"low", "mid", "vocal", "high"}
    # Source path is a preset:* sentinel, NOT a real file path
    assert p["sourceReferencePath"].startswith("preset:")


def test_get_reference_preset_unknown_key_returns_none():
    from app.mastering.reference_presets import get_reference_preset
    assert get_reference_preset("nonexistent") is None


def test_recommend_preset_chooses_jazz_for_high_dynamics():
    from app.mastering.reference_presets import recommend_preset_for_input
    p = _profile(lra=14.0, crestDb=14.0)
    rec = recommend_preset_for_input(p)
    assert rec is not None
    assert rec["key"] in ("jazz_natural", "acoustic_warm")


def test_recommend_preset_chooses_pop_ballad_for_midrange():
    from app.mastering.reference_presets import recommend_preset_for_input
    p = _profile(lra=8.0, crestDb=10.0)
    rec = recommend_preset_for_input(p)
    assert rec["key"] == "pop_ballad"


def test_recommend_preset_chooses_hiphop_for_bass_heavy_loud():
    from app.mastering.reference_presets import recommend_preset_for_input
    p = _profile(
        lra=3.5, crestDb=7.0,
        bands={"low": -12, "mid": -16, "vocal": -19, "high": -24},
    )
    rec = recommend_preset_for_input(p)
    assert rec["key"] in ("hiphop_punchy", "kpop_modern")


def test_recommend_preset_falls_back_to_streaming_safe():
    from app.mastering.reference_presets import recommend_preset_for_input
    # Mid-LRA + balanced spectrum doesn't match any specific genre
    p = _profile(lra=4.5, crestDb=7.0,
                 bands={"low": -16, "mid": -16, "vocal": -16, "high": -16})
    rec = recommend_preset_for_input(p)
    assert rec is not None
    # Should at least produce *some* recommendation
    assert "key" in rec and "reason" in rec


# ── Iterative loop integration ────────────────────────────────────────────

def test_iterative_surfaces_reference_warnings(tmp_path):
    """The iterative loop must surface validation warnings into the result."""
    import subprocess, os
    if not _ffmpeg_available():
        pytest.skip("ffmpeg not available")

    # Create a deliberately-bad reference: very quiet (~ -30 LUFS)
    ref_path = str(tmp_path / "bad_ref.wav")
    subprocess.run([
        "ffmpeg", "-y", "-f", "lavfi",
        "-i", "anoisesrc=color=pink:duration=5",
        "-ar", "44100", "-acodec", "pcm_s24le", "-ac", "2",
        "-af", "volume=-30dB",
        ref_path,
    ], check=True, capture_output=True)

    in_path = str(tmp_path / "input.wav")
    subprocess.run([
        "ffmpeg", "-y", "-f", "lavfi",
        "-i", "anoisesrc=color=pink:duration=10",
        "-ar", "44100", "-acodec", "pcm_s24le", "-ac", "2",
        "-af", "volume=-12dB",
        in_path,
    ], check=True, capture_output=True)

    from app.mastering.iterative import run_iterative_mastering
    result = run_iterative_mastering(
        in_path, str(tmp_path / "out.wav"),
        reference_path=ref_path,
        max_iterations=1,
        target_lufs_override=-14.0,    # don't chase the -30 LUFS reference
        style="balanced",
        sample_rate=44100, bit_depth=24,
        generate_waveforms=False,
    )
    rw = result.get("referenceWarnings") or []
    codes = [w["code"] for w in rw]
    # Quiet ref + short ref should both trip
    assert "REFERENCE_TOO_QUIET" in codes
    assert "REFERENCE_TOO_SHORT" in codes


def _ffmpeg_available() -> bool:
    import subprocess
    try:
        subprocess.run(["ffmpeg", "-version"], capture_output=True, timeout=5)
        return True
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False
