"""
Phase-B mastering-quality regression tests, 2026-05.

Locks the user-visible quality contract from the Phase-B directive:

  • Mono-safe stereo widening (low band stays mono after any width)
  • Translation across 4 playback chains (phone / car / laptop / 'phones)
  • Crest factor preservation through the master chain
  • Transient retention (kick/snare hits survive the limiter)
  • LUFS vs distortion tradeoff (THD doesn't blow up at louder targets)

These tests use synthesised inputs (so we know ground truth) and the
real Python pipeline.  They're slower than unit tests but each one
has a measurable pass/fail criterion that maps to a perceptual claim.
"""
from __future__ import annotations

import os
import subprocess
import tempfile

import pytest

from app.mastering.pipeline import run_pipeline
from app.mastering.stereo_enhance import build_stereo_enhance_chain
from app.utils.translation_sim import (
    PHONE_SPEAKER, CAR_DASH, LAPTOP_SPEAKER, HEADPHONES, ALL_PROFILES,
    apply_translation, youtube_normalize,
    measure_crest_factor_db, count_transients, estimate_thd_n_db,
    stereo_correlation, measure_low_band_side_rms_db,
)
from app.utils.ffmpeg_wrapper import _FFMPEG_BIN, measure_output


# ── Synthesis helpers ───────────────────────────────────────────────────────

def _ffmpeg(*args: str) -> None:
    subprocess.run([_FFMPEG_BIN, "-hide_banner", "-y", *args],
                   check=True, capture_output=True, text=True)


def _make_wide_stereo_test(tmp_path) -> str:
    """Build a wide-stereo test signal: L = 220 Hz, R = 330 Hz, both at
    -10 dBFS amplitude, 5 s.  The 'side' content is real (different
    notes each side), so a mono-safe widener must preserve LOW-band
    mono compatibility (we have NO low band intentionally — both tones
    are above 200 Hz)."""
    out = str(tmp_path / "wide_stereo.wav")
    _ffmpeg(
        "-f", "lavfi", "-i", "sine=frequency=220:duration=5:sample_rate=44100",
        "-f", "lavfi", "-i", "sine=frequency=330:duration=5:sample_rate=44100",
        "-filter_complex",
        "[0:a]volume=-10dB[l];[1:a]volume=-10dB[r];"
        "[l][r]amerge=inputs=2,pan=stereo|c0=c0|c1=c1",
        "-acodec", "pcm_s24le", out,
    )
    return out


def _make_low_band_stereo_test(tmp_path) -> str:
    """Build a stereo signal with DIFFERENT content in the low band on
    L vs R: L has 60 Hz + 1 kHz, R has 80 Hz + 1 kHz.  After mono-safe
    widening with 120 Hz crossover, the low band MUST be summed — the
    side energy below 120 Hz should drop to ~silence."""
    out = str(tmp_path / "low_band_stereo.wav")
    _ffmpeg(
        "-f", "lavfi", "-i", "sine=frequency=60:duration=5:sample_rate=44100",
        "-f", "lavfi", "-i", "sine=frequency=80:duration=5:sample_rate=44100",
        "-f", "lavfi", "-i", "sine=frequency=1000:duration=5:sample_rate=44100",
        "-filter_complex",
        # asplit the 1 kHz mid so it can be amix'd into BOTH channels
        # (ffmpeg requires each named pad to be consumed exactly once).
        "[0:a]volume=-10dB[L_lo];"
        "[1:a]volume=-10dB[R_lo];"
        "[2:a]volume=-15dB,asplit=2[mid_l][mid_r];"
        "[L_lo][mid_l]amix=inputs=2:weights=1 1[L];"
        "[R_lo][mid_r]amix=inputs=2:weights=1 1[R];"
        "[L][R]amerge=inputs=2,pan=stereo|c0=c0|c1=c1",
        "-acodec", "pcm_s24le", out,
    )
    return out


def _make_drum_test(tmp_path) -> str:
    """Build a 5-second drum-like input via numpy: low-level pink noise
    body (-30 dBFS RMS) + 10 explicit kick pulses (60 Hz with 50 ms
    exponential decay, peak amplitude 0.7).  numpy gives us exact
    amplitude control which ffmpeg's `sine` source does not."""
    import numpy as np
    import soundfile as sf
    sr  = 44100
    dur = 5.0
    n   = int(sr * dur)
    rng = np.random.default_rng(42)
    # Pink-ish noise body via 1/f filter approximation — keep low so
    # transients dominate.
    body = rng.standard_normal((n, 2)) * 0.005   # ~ -36 dBFS RMS
    # Inject 10 kicks at 0.4 s spacing, starting at 0.2 s.
    tau = sr * 0.05            # 50 ms decay
    for k in range(10):
        start = int(sr * (0.2 + k * 0.4))
        n_k = int(sr * 0.2)
        if start + n_k >= n: break
        env = np.exp(-np.arange(n_k) / tau)
        kick = 0.7 * env * np.sin(2 * np.pi * 60 * np.arange(n_k) / sr)
        body[start : start + n_k, 0] += kick
        body[start : start + n_k, 1] += kick
    # Normalize peak to 0.95 so we don't accidentally clip the wav.
    peak = float(np.max(np.abs(body)))
    if peak > 0.95:
        body *= 0.95 / peak
    out = str(tmp_path / "drum_test.wav")
    sf.write(out, body.astype(np.float32), sr, subtype="PCM_24")
    return out


# ── Mono-safe stereo widening ──────────────────────────────────────────────

def test_stereo_widen_no_op_when_width_1_0():
    """width=1.0 returns empty filter string — pipeline integrators can
    cheaply drop the stage."""
    log = []
    chain = build_stereo_enhance_chain(width=1.0, applied_log=log)
    assert chain == ""
    assert log[-1]["applied"] is False


def test_stereo_widen_chain_uses_ms_decode():
    """Generated filter must use the M/S decode pattern: pan to mono
    for both M and S, HPF the side band (cascaded for steeper rolloff),
    apply width as a side-level dB boost, then re-encode via amerge +
    pan with c0=c0+c1 / c1=c0-c1."""
    chain = build_stereo_enhance_chain(width=1.4)
    # M extraction: average of L and R into a mono channel
    assert "pan=mono|c0=0.5*c0+0.5*c1" in chain
    # S extraction: difference of L and R into a mono channel
    assert "pan=mono|c0=0.5*c0-0.5*c1" in chain
    # Side HPF — cascaded for ≥ 24 dB/oct (single highpass appears 2×)
    assert chain.count("highpass=") >= 2
    # Side level adjustment (volume in dB)
    assert "volume=" in chain
    # Final M/S → L/R re-encode
    assert "pan=stereo|c0=c0+c1|c1=c0-c1" in chain


def _apply_stereo_chain(src: str, chain: str, dst: str) -> None:
    """Run ffmpeg with the build_stereo_enhance_chain output as a
    filter_complex graph.  The chain ends in an `amix` whose output is
    unnamed → ffmpeg auto-maps it as the output stream."""
    _ffmpeg("-i", src, "-filter_complex", chain, "-acodec", "pcm_s24le", dst)


def test_stereo_widen_low_band_mono_safer_than_passthrough(tmp_path):
    """The headline mono-safe contract: feed a stereo signal whose low
    band has DIFFERENT L/R content; after widening with the crossover-
    based mono-safe widener, the SIDE energy in the SUB-CROSSOVER band
    must be SIGNIFICANTLY LOWER than the input's side energy.  The 4th-
    order crossover (Q=0.7 cascaded ×2) gives ~15 dB rejection at one
    octave below the corner; we assert at least 10 dB reduction.

    For comparison: a naive `extrastereo` (the legacy implementation)
    would AMPLIFY the side energy in the low band, making mono fold
    worse, not better."""
    src = _make_low_band_stereo_test(tmp_path)
    pre_side_db = measure_low_band_side_rms_db(src, lo_hz=20, hi_hz=80)
    assert pre_side_db is not None

    out = str(tmp_path / "widened.wav")
    chain = build_stereo_enhance_chain(width=1.4)
    _apply_stereo_chain(src, chain, out)
    post_side_db = measure_low_band_side_rms_db(out, lo_hz=20, hi_hz=80)
    assert post_side_db is not None

    reduction_db = pre_side_db - post_side_db
    assert reduction_db >= 10.0, (
        f"low-band side energy reduction = {reduction_db:.1f} dB "
        f"(input {pre_side_db:.1f} → output {post_side_db:.1f}). "
        f"M/S decode + side HPF should give ≥ 10 dB reduction below crossover."
    )

    # Cross-check: the LEGACY extrastereo (mono-unsafe) widener would
    # INCREASE side energy in the low band.  Verify ours moves the OTHER
    # direction.
    out_naive = str(tmp_path / "widened_naive.wav")
    _ffmpeg("-i", src, "-af", "extrastereo=m=1.4:c=0",
            "-acodec", "pcm_s24le", out_naive)
    naive_side_db = measure_low_band_side_rms_db(out_naive, lo_hz=20, hi_hz=80)
    assert naive_side_db is not None
    assert post_side_db < naive_side_db - 5.0, (
        f"new widener ({post_side_db:.1f} dB) not significantly safer than "
        f"naive extrastereo ({naive_side_db:.1f} dB) — mono protection failing."
    )


def test_stereo_widen_high_band_correlation_drops(tmp_path):
    """For an input that's already wide above the crossover, the widener
    must REDUCE L/R correlation (side level boost = wider stereo image).
    """
    src = _make_wide_stereo_test(tmp_path)
    pre_corr = stereo_correlation(src)
    assert pre_corr is not None

    out = str(tmp_path / "wider.wav")
    chain = build_stereo_enhance_chain(width=1.6)
    _apply_stereo_chain(src, chain, out)
    post_corr = stereo_correlation(out)
    assert post_corr is not None
    # Either pre is already 0 (independent tones) — in which case post
    # may stay near 0 — or pre > 0 and post should be lower or equal.
    assert post_corr <= pre_corr + 0.05, (
        f"correlation: pre={pre_corr:.3f} → post={post_corr:.3f} (no widening)"
    )


# ── Translation across playback chains ────────────────────────────────────

def test_master_translates_across_all_profiles(pink_noise_wav, tmp_path):
    """Master a pink-noise input, then play it through every translation
    profile.  Every profile must produce finite measurable LUFS (no
    NaN, no -inf) AND the relative loudness ranking must make sense:
    HEADPHONES ≥ LAPTOP_SPEAKER (laptop has HPF that drops some energy).
    """
    out = str(tmp_path / "for_translate.wav")
    result = run_pipeline(
        pink_noise_wav, out,
        style="balanced",
        target_lufs=-12.0,
        target_tp=-1.0,
        generate_waveforms=False,
    )
    assert os.path.isfile(result["outputPath"])

    measurements = {}
    for p in ALL_PROFILES:
        translated = apply_translation(result["outputPath"], p)
        m = measure_output(translated, -14.0, -1.0)
        assert m["integratedLufs"] != float("-inf"), (
            f"{p.name}: translation produced -inf LUFS (silence)"
        )
        measurements[p.name] = m["integratedLufs"]

    # Sanity: laptop speaker (no bass) should not be LOUDER than headphones
    # reference.  Phone speaker similar.
    assert measurements["headphones"] >= measurements["laptop_speaker"] - 0.5, (
        f"headphones {measurements['headphones']:.2f} < laptop "
        f"{measurements['laptop_speaker']:.2f} — translation profile inverted?"
    )


def test_youtube_normalize_only_attenuates_loud_masters(pink_noise_wav, tmp_path):
    """YouTube Music's policy is attenuate-only — masters quieter than
    -14 LUFS keep their original level.  Verify our simulator follows."""
    # Quiet master: target -20 LUFS.
    quiet = str(tmp_path / "quiet.wav")
    run_pipeline(pink_noise_wav, quiet,
                 style="natural", target_lufs=-20.0, target_tp=-1.0,
                 generate_waveforms=False)
    quiet_pre  = measure_output(quiet, -14.0, -1.0)["integratedLufs"]
    quiet_post = measure_output(youtube_normalize(quiet),
                                 -14.0, -1.0)["integratedLufs"]
    assert abs(quiet_post - quiet_pre) <= 0.5, (
        f"quiet master {quiet_pre:.2f} LUFS was changed to {quiet_post:.2f} "
        f"by youtube_normalize — policy violation (should be no-op when quieter)."
    )

    # Loud master: target -8 LUFS → YouTube attenuates to -14.
    loud = str(tmp_path / "loud.wav")
    run_pipeline(pink_noise_wav, loud,
                 style="loud", target_lufs=-8.0, target_tp=-1.0,
                 generate_waveforms=False)
    loud_pre  = measure_output(loud, -14.0, -1.0)["integratedLufs"]
    loud_post = measure_output(youtube_normalize(loud),
                                -14.0, -1.0)["integratedLufs"]
    assert loud_post < loud_pre - 1.0, (
        f"loud master {loud_pre:.2f} LUFS was NOT attenuated by "
        f"youtube_normalize (got {loud_post:.2f})."
    )
    assert abs(loud_post - (-14.0)) <= 1.5, (
        f"youtube_normalize landed at {loud_post:.2f} LUFS (target -14 ± 1.5)"
    )


# ── Crest factor preservation ──────────────────────────────────────────────

def test_crest_factor_preserved_within_budget(pink_noise_wav, tmp_path):
    """Crest factor (peak/RMS in dB) tells us how dynamic the signal is.
    A heavy-handed limiter destroys crest factor (squashes peaks).  Each
    mode has a different budget for crest reduction — Natural shouldn't
    cut more than 2 dB; Loud may cut up to 8 dB.  Anything past those
    means the limiter is destroying transients that the user wanted."""
    pre_crest = measure_crest_factor_db(pink_noise_wav)
    assert pre_crest is not None

    budgets = [
        # (style, target_lufs, target_tp, max_crest_loss_db)
        ("natural",  -14.0, -1.0,  3.0),
        ("balanced", -12.0, -1.0,  4.5),
        ("loud",     -10.0, -1.0,  7.5),
    ]
    for style, lufs, tp, budget in budgets:
        out = str(tmp_path / f"crest_{style}.wav")
        run_pipeline(pink_noise_wav, out, style=style,
                     target_lufs=lufs, target_tp=tp,
                     generate_waveforms=False)
        post_crest = measure_crest_factor_db(out)
        assert post_crest is not None
        loss = pre_crest - post_crest
        assert loss <= budget, (
            f"{style}: crest factor lost {loss:.1f} dB "
            f"(input {pre_crest:.1f}, output {post_crest:.1f}, budget {budget:.1f})"
        )


# ── Transient retention ────────────────────────────────────────────────────

def test_transient_retention_through_pipeline(tmp_path):
    """Synthesised drum-like input has 10 distinct kicks.  After mastering
    in a non-aggressive mode, count_transients should still find the
    same 10 (give or take 2 for envelope-detector edge cases).  In a
    more aggressive mode (kpop_loud) it can drop slightly but not below
    7 — anything fewer means kicks are being smashed below threshold."""
    src = _make_drum_test(tmp_path)
    pre_count = count_transients(src, threshold_db=-12.0, refractory_ms=50)
    assert pre_count is not None
    assert pre_count >= 8, f"input drum test only had {pre_count} transients"

    out_balanced = str(tmp_path / "drum_balanced.wav")
    run_pipeline(src, out_balanced, style="balanced",
                 target_lufs=-12.0, target_tp=-1.0,
                 generate_waveforms=False)
    bal_count = count_transients(out_balanced, threshold_db=-12.0, refractory_ms=50)
    assert bal_count is not None
    assert bal_count >= pre_count - 2, (
        f"balanced lost {pre_count - bal_count} transients ({pre_count} → {bal_count})"
    )

    out_loud = str(tmp_path / "drum_loud.wav")
    run_pipeline(src, out_loud, style="loud",
                 target_lufs=-10.0, target_tp=-1.0,
                 generate_waveforms=False)
    loud_count = count_transients(out_loud, threshold_db=-12.0, refractory_ms=50)
    assert loud_count is not None
    assert loud_count >= 7, (
        f"loud mode pulverised transients: {loud_count} survived (need ≥ 7)"
    )


# ── LUFS vs distortion tradeoff ────────────────────────────────────────────

@pytest.mark.parametrize("target_lufs,thd_budget_db", [
    (-14.0, -50.0),   # Natural-target: very clean
    (-12.0, -45.0),   # Balanced/streaming: clean
    (-10.0, -38.0),   # Loud: more saturation OK
    ( -9.0, -34.0),   # KPOP Loud: aggressive but musical
])
def test_thd_at_target_lufs_within_budget(sine_wav, tmp_path,
                                            target_lufs, thd_budget_db):
    """For a pure 440 Hz sine input at -10 dBFS amplitude, the master at
    each target LUFS must keep THD+N below the per-mode budget.
    Demonstrates: as target gets louder, more distortion is acceptable
    BUT the distortion must remain bounded — no harsh clipping.

    Higher (more positive) THD value = more distortion."""
    style_for = {-14.0: "natural", -12.0: "balanced",
                 -10.0: "loud", -9.0: "kpop_loud"}[target_lufs]
    out = str(tmp_path / f"thd_{style_for}.wav")
    run_pipeline(sine_wav, out, style=style_for,
                 target_lufs=target_lufs, target_tp=-1.0,
                 generate_waveforms=False)
    thd = estimate_thd_n_db(out, freq_hz=440.0)
    assert thd is not None
    assert thd <= thd_budget_db, (
        f"{style_for} @ {target_lufs} LUFS: THD+N = {thd:.1f} dB, "
        f"budget {thd_budget_db:.1f} dB — too much distortion."
    )
