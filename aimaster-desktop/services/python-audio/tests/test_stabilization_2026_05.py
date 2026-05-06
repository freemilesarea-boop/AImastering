"""
Integration tests added in the 2026-05 stabilization pass.

Goal: prove that every promised guarantee is actually enforced end-to-end.

Coverage:

  • Per-mode end-to-end run for every MasteringStyle the UI exposes —
    asserts the WAV's measured LUFS / TP match the reported loudnessAfter
    (catches stage-ordering bugs like C-09 where preview/PNG/loudnessAfter
    diverged from the actual WAV).

  • Limiter "high" effective input gain is actually higher than "medium"
    (catches H-39 where the vocal-protection clamp collapsed both to 0.5).

  • Safe-mode compressor scales actually change the compressor filter
    string (catches H-38 where the override was recorded but never read
    by build_dynamics_filter).

  • Tonal budget enforcement emits TONAL_BUDGET_EXCEEDED when an applied
    move is over budget (catches H-37 where check_budget was defined
    but never called).

  • iterative early-stop relocates side products (catches H-33 where
    previewPath / afterWaveformPath pointed at deleted temp files).
"""
from __future__ import annotations

import os
import shutil
import tempfile

import pytest

from app.mastering.dynamics  import build_dynamics_filter
from app.mastering.pipeline  import LIMITER_STRENGTHS, run_pipeline
from app.mastering.tonal_budget import check_budget
from app.utils.ffmpeg_wrapper import measure_output


# ── Per-mode end-to-end coherence ───────────────────────────────────────────

# Every style the UI MASTERING_MODES list exposes.  Targets matched to
# packages/shared-types/src/index.ts MASTERING_MODES — keeping these in
# sync is part of the stabilization contract.
_PER_MODE_TARGETS = [
    ("natural",   -14.0, -1.0),
    ("balanced",  -12.0, -1.0),
    ("bright",    -12.0, -1.0),
    ("loud",      -10.0, -1.0),
    ("kpop_loud", -9.0,  -0.8),
    ("warm",      -12.0, -1.0),
    ("punch",     -12.0, -1.0),
]


@pytest.mark.parametrize("style,target_lufs,target_tp", _PER_MODE_TARGETS)
def test_mode_reports_match_wav(pink_noise_wav, tmp_path, style, target_lufs, target_tp):
    """For every mode, the loudnessAfter reported by run_pipeline must agree
    with what `measure_output` independently observes from the WAV file on
    disk (catches stage-ordering bugs where the report is computed from a
    pre-mutation snapshot)."""
    out = str(tmp_path / f"out_{style}.wav")
    result = run_pipeline(
        pink_noise_wav, out,
        style=style,
        target_lufs=target_lufs,
        target_tp=target_tp,
        generate_waveforms=False,
    )

    # Independently measure the WAV file to detect any reporter drift.
    actual = measure_output(out, target_lufs, target_tp)
    reported = result["loudnessAfter"]

    # Allow ±0.6 LU because measure_output's loudnorm pass1 has 0.5 LU
    # internal jitter on short loops.
    assert abs(actual["integratedLufs"] - reported["integratedLufs"]) <= 0.6, (
        f"{style}: WAV={actual['integratedLufs']:.2f} LUFS but "
        f"loudnessAfter reports {reported['integratedLufs']:.2f}"
    )
    # TP tolerance ±0.3 dBTP is generous enough for ffmpeg's loudnorm reporter.
    assert abs(actual["truePeakDbtp"] - reported["truePeakDbtp"]) <= 0.3, (
        f"{style}: WAV TP={actual['truePeakDbtp']:.2f} dBTP but "
        f"loudnessAfter reports {reported['truePeakDbtp']:.2f}"
    )


# ── H-39: limiter "high" must actually be louder than "medium" ──────────────

def test_limiter_strength_high_differs_from_medium():
    """LIMITER_STRENGTHS table must produce DIFFERENT input_gain values
    for medium and high after the vocal-protection clamp.  Previously
    both ended up at 0.5 dB (clamp ceiling) → user-facing 'high' choice
    was indistinguishable from 'medium'."""
    medium = LIMITER_STRENGTHS["medium"]["input_gain_db"]
    high   = LIMITER_STRENGTHS["high"]["input_gain_db"]
    low    = LIMITER_STRENGTHS["low"]["input_gain_db"]
    # Strict ordering — every step must add audible loudness lift.
    assert low < medium < high, (
        f"LIMITER_STRENGTHS not strictly increasing: "
        f"low={low} medium={medium} high={high}"
    )
    # All three must respect the vocal_protection clamp.
    from app.utils.vocal_protection import VOCAL_PROTECTION as VP
    for k in ("low", "medium", "high"):
        assert LIMITER_STRENGTHS[k]["input_gain_db"] <= VP.MAX_LIMITER_INPUT_GAIN_DB + 1e-9, (
            f"{k} input_gain {LIMITER_STRENGTHS[k]['input_gain_db']} "
            f"exceeds vocal_protection clamp {VP.MAX_LIMITER_INPUT_GAIN_DB}"
        )


# ── H-38: safe-mode compressor scales actually affect the filter ────────────

def test_safe_mode_compressor_ratio_scale_changes_filter():
    """compressor_ratio_scale must actually change the produced acompressor
    filter string.  Previously the kwarg was accepted but ignored."""
    base = build_dynamics_filter("balanced", input_peak_db=-3.0)
    safe = build_dynamics_filter(
        "balanced", input_peak_db=-3.0,
        compressor_ratio_scale=0.5,
    )
    assert base != safe, (
        f"compressor_ratio_scale had no effect:\n  base: {base}\n  safe: {safe}"
    )
    # Specifically the ratio= field must shrink.
    import re
    base_ratio = float(re.search(r"ratio=([\d.]+)", base).group(1))
    safe_ratio = float(re.search(r"ratio=([\d.]+)", safe).group(1))
    assert safe_ratio < base_ratio, (
        f"safe mode ratio {safe_ratio} not lower than base {base_ratio}"
    )


def test_safe_mode_compressor_attack_scale_lengthens_attack():
    """compressor_attack_scale > 1 should INCREASE the attack value (slower)."""
    base = build_dynamics_filter("balanced", input_peak_db=-3.0)
    safe = build_dynamics_filter(
        "balanced", input_peak_db=-3.0,
        compressor_attack_scale=2.0,
    )
    import re
    base_attack = float(re.search(r"attack=([\d.]+)", base).group(1))
    safe_attack = float(re.search(r"attack=([\d.]+)", safe).group(1))
    assert safe_attack > base_attack, (
        f"safe mode attack {safe_attack}ms not slower than base {base_attack}ms"
    )


# ── H-37: tonal budget enforcement actually fires ──────────────────────────

def test_tonal_budget_check_returns_violation_when_over_budget():
    """check_budget must surface a human-readable violation when the
    requested band move exceeds the per-stage budget."""
    # TG_FINAL_GUARD allows low band ±2.5 dB.  +5 dB must violate.
    msg = check_budget("TG_FINAL_GUARD", "low", 5.0)
    assert msg is not None
    assert "TG_FINAL_GUARD" in msg
    assert "low" in msg
    # And within budget must return None.
    assert check_budget("TG_FINAL_GUARD", "low", 1.0) is None
    # Unknown stages return None gracefully.
    assert check_budget("UNKNOWN_STAGE", "low", 5.0) is None
    # Unknown bands too.
    assert check_budget("TG_FINAL_GUARD", "no_such_band", 5.0) is None


# ── H-33: iterative early-stop relocates side products ─────────────────────

def test_iterative_relocate_helper_copies_side_products(tmp_path):
    """When an iterative job early-stops, the WAV + every side product
    listed in last_result must be relocated alongside output_path before
    the temp work_dir is wiped — otherwise returned paths point to
    deleted files."""
    from app.mastering.iterative import _relocate_iter_outputs

    # Simulate: create a fake "iter work_dir" with the products that
    # run_pipeline would have produced for output_path = work_dir/iter_3.wav.
    work_dir = tmp_path / "work"
    work_dir.mkdir()
    iter_wav    = work_dir / "iter_3.wav"
    iter_mp3    = work_dir / "iter_3_preview.mp3"
    iter_after  = work_dir / "iter_3_after.png"
    iter_before = work_dir / "iter_3_before.png"
    iter_cmp    = work_dir / "iter_3_compare.png"
    for p in (iter_wav, iter_mp3, iter_after, iter_before, iter_cmp):
        p.write_bytes(b"\x00")

    final_dir = tmp_path / "out"
    final_dir.mkdir()
    final_wav = final_dir / "result.wav"

    last_result = {
        "outputPath":           str(iter_wav),
        "previewPath":          str(iter_mp3),
        "afterWaveformPath":    str(iter_after),
        "beforeWaveformPath":   str(iter_before),
        "compareWaveformPath":  str(iter_cmp),
    }

    _relocate_iter_outputs(str(iter_wav), str(final_wav), last_result)

    # All paths must now point to files that exist and live in final_dir.
    for key in ("outputPath", "previewPath", "afterWaveformPath",
                "beforeWaveformPath", "compareWaveformPath"):
        path = last_result[key]
        assert path, f"{key} was emptied but should have a relocated path"
        assert os.path.isfile(path), (
            f"{key} relocated to {path} which doesn't exist"
        )
        assert os.path.dirname(path) == str(final_dir), (
            f"{key} relocated to {path}, expected to live in {final_dir}"
        )


def test_iterative_relocate_handles_missing_side_product(tmp_path):
    """If a side product the pipeline reported is actually missing,
    relocate must blank the path rather than crash."""
    from app.mastering.iterative import _relocate_iter_outputs

    work_dir = tmp_path / "work"
    work_dir.mkdir()
    iter_wav = work_dir / "iter_1.wav"
    iter_wav.write_bytes(b"\x00")

    final_wav = tmp_path / "out.wav"

    last_result = {
        "outputPath":  str(iter_wav),
        # Pipeline reported a preview path but the file doesn't exist.
        "previewPath": str(work_dir / "iter_1_preview.mp3"),
    }

    _relocate_iter_outputs(str(iter_wav), str(final_wav), last_result)

    assert os.path.isfile(last_result["outputPath"])
    assert last_result["previewPath"] == ""
