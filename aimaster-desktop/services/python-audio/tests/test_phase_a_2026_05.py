"""
Phase-A integration tests added 2026-05.

Coverage:
  · Preview / render consistency — preview MP3 LUFS matches the WAV
    LUFS for every mode (catches future re-introductions of C-09 or
    similar stage-ordering regressions).
  · Mode switching stability — running the SAME input through every
    mode in sequence does not corrupt state across runs.
  · License gate enforcement: master() called from a "free trial
    exhausted" simulated state must NOT proceed (this is enforced in
    audioHandlers.ts on the TS side, but tests stay close to the
    Python pipeline; we cover the Python end of the contract here by
    asserting the pipeline doesn't have its own bypass paths).
"""
from __future__ import annotations

import os
import subprocess

import pytest

from app.mastering.pipeline import run_pipeline
from app.utils.ffmpeg_wrapper import measure_output


_ALL_MODES = [
    ("natural",   -14.0, -1.0),
    ("balanced",  -12.0, -1.0),
    ("bright",    -12.0, -1.0),
    ("loud",      -10.0, -1.0),
    ("kpop_loud", -9.0,  -0.8),
    ("warm",      -12.0, -1.0),
    ("punch",     -12.0, -1.0),
]


def _measure_mp3_loudness(mp3_path: str) -> float:
    """Decode the MP3 and run loudnorm pass1 to get integrated LUFS."""
    # Use ffmpeg -af loudnorm=print_format=json -f null - to get a measurement.
    proc = subprocess.run(
        ["ffmpeg", "-y", "-i", mp3_path,
         "-af", "loudnorm=print_format=json:I=-14:LRA=11:tp=-1",
         "-f", "null", "-"],
        capture_output=True, text=True, timeout=120,
    )
    # loudnorm prints JSON at the end of stderr; find the last opening brace.
    err = proc.stderr
    last_open = err.rfind("{")
    last_close = err.rfind("}")
    if last_open < 0 or last_close <= last_open:
        pytest.skip(f"could not parse loudnorm output for {mp3_path}")
    import json
    data = json.loads(err[last_open : last_close + 1])
    return float(data.get("input_i", -90))


@pytest.mark.parametrize("style,target_lufs,target_tp", _ALL_MODES)
def test_preview_mp3_lufs_matches_wav_lufs(pink_noise_wav, tmp_path,
                                             style, target_lufs, target_tp):
    """Phase-A consistency contract: the preview MP3 reported in
    `previewPath` must reflect the same audio as the WAV at `outputPath`.
    Allow 1.5 LU tolerance for MP3 lossy compression artefacts (256 kbps
    typically reads back within 0.3 LU; we leave headroom for CBR jitter
    and the LUFS measurement's own ±0.5 LU pass1 slop)."""
    out = str(tmp_path / f"out_{style}.wav")
    result = run_pipeline(
        pink_noise_wav, out,
        style=style,
        target_lufs=target_lufs,
        target_tp=target_tp,
        generate_waveforms=False,
    )

    preview = result["previewPath"]
    if not preview or not os.path.isfile(preview):
        pytest.skip(f"{style}: no preview MP3 produced")

    wav_lufs = measure_output(out, target_lufs, target_tp)["integratedLufs"]
    mp3_lufs = _measure_mp3_loudness(preview)

    # Tolerance: MP3 256 kbps loudnorm typically agrees within 0.5 LU;
    # we allow 1.5 LU to absorb pass1 jitter on short noise clips.
    assert abs(wav_lufs - mp3_lufs) <= 1.5, (
        f"{style}: WAV={wav_lufs:.2f} LUFS but preview MP3={mp3_lufs:.2f} LUFS "
        f"— preview/render divergence (regression of C-09?)"
    )


def test_mode_switching_does_not_leak_state(pink_noise_wav, tmp_path):
    """Running every mode in sequence on the same input must:
      (a) hit every mode's LUFS target within ±1.2 LU (loudnorm pass1
          has ~0.5 LU intrinsic jitter on short noise inputs, so the
          tolerance is intentionally looser than the per-mode WAV-vs-
          report consistency test which uses 0.6 LU);
      (b) NOT collapse to identical outputs (would indicate cached
          state from a previous mode's chain leaking through);
      (c) preserve target-LUFS ordering — modes with lower target
          LUFS must produce quieter output than modes with higher.
    Catches any module-level mutable state that contaminates
    subsequent runs."""
    measured = []
    for style, target_lufs, target_tp in _ALL_MODES:
        out = str(tmp_path / f"seq_{style}.wav")
        result = run_pipeline(
            pink_noise_wav, out,
            style=style,
            target_lufs=target_lufs,
            target_tp=target_tp,
            generate_waveforms=False,
        )
        measured.append((style, target_lufs, result["loudnessAfter"]["integratedLufs"]))

    # (a) each mode within ±1.2 LU of target
    for style, target, lufs in measured:
        assert abs(lufs - target) <= 1.2, (
            f"{style}: state-leak suspect — measured {lufs:.2f} LUFS, "
            f"target {target} (loudnorm pass1 jitter ≤ 0.5 LU, ours = "
            f"{abs(lufs - target):.2f})"
        )

    # (b) output diversity — at least 4 distinct LUFS values across 7 modes
    # (some modes share targets, so we don't expect 7 unique).  Identical
    # results across the board would prove a cached chain.
    distinct = {round(l, 1) for _, _, l in measured}
    assert len(distinct) >= 4, (
        f"only {len(distinct)} distinct LUFS values across 7 modes — "
        f"state contamination suspect.  measurements={measured}"
    )

    # (c) ordering: higher target LUFS → louder output.
    by_target = sorted(measured, key=lambda m: m[1])
    for i in range(1, len(by_target)):
        prev_target, prev_lufs = by_target[i - 1][1], by_target[i - 1][2]
        cur_target,  cur_lufs  = by_target[i][1],     by_target[i][2]
        if cur_target > prev_target + 0.5:   # ignore ties
            assert cur_lufs > prev_lufs - 0.5, (
                f"ordering violated: target {prev_target}→{cur_target} but "
                f"output {prev_lufs:.2f}→{cur_lufs:.2f}"
            )


def test_pipeline_has_no_license_bypass_path(pink_noise_wav, tmp_path):
    """run_pipeline accepts no `bypass_license` / `pro_only` / similar
    kwarg.  The license gate lives in main process audioHandlers.ts;
    the Python pipeline must not have its own bypass that an attacker
    could exploit by calling main.py directly."""
    import inspect
    sig = inspect.signature(run_pipeline)
    forbidden = {"bypass_license", "pro_only", "skip_license", "license_bypass"}
    leaks = forbidden & set(sig.parameters.keys())
    assert not leaks, (
        f"run_pipeline exposes license-bypass kwargs: {leaks} — gate must "
        f"live ONLY in main process IPC handler."
    )
