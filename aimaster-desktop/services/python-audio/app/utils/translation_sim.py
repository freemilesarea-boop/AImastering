"""
Translation simulator + audio-quality probes (Phase-B, 2026-05).

Purpose: prove that masters survive being played back through real-world
playback chains, not just on a calibrated studio monitor.  Three EQ
profiles approximate the most common "where does the master go wrong"
scenarios:

  • PHONE_SPEAKER  — narrow bandpass 300–3500 Hz, with a presence bump
                      at ~2 kHz to mimic the tinny, compressed sound of
                      a phone earpiece / mono BT speaker.
  • CAR_DASH       — low-end boost (+5 dB at 80 Hz) + harsh-mid bump
                      (+3 dB at 3.5 kHz, where dashboard plastics
                      resonate).  Where bad masters expose mud or harsh
                      vocals.
  • LAPTOP_SPEAKER — high-pass at 200 Hz (no real bass) + presence cut
                      at 4 kHz (typical small-driver dip).
  • HEADPHONES     — identity reference.

Plus YouTube Music's loudness normalization (-14 LUFS target):
  • YOUTUBE_NORMALIZE — apply gain to bring the integrated LUFS to
                        exactly -14, capped to keep TP ≤ 0 dBTP.

Probes:
  • measure_crest_factor_db(path) — peak / RMS ratio.  Higher = more
                                     dynamic.  Lower after master =
                                     more compressed / squashed.
  • count_transients(path, threshold_db) — peak detector with a
                                            refractory window.  Returns
                                            the number of distinct
                                            transient onsets above
                                            threshold.
  • estimate_thd_n_db(path, freq_hz) — for sine-tone inputs, energy
                                        outside the fundamental ±
                                        neighbours.

These are the building blocks for the test suite that asserts
"perceptually higher quality, not just louder".
"""
from __future__ import annotations

import json
import math
import os
import subprocess
import tempfile
from dataclasses import dataclass

from app.utils.ffmpeg_wrapper import _FFMPEG_BIN

try:
    import numpy as np
    import soundfile as sf
    HAS_NUMPY = True
except ImportError:  # pragma: no cover
    HAS_NUMPY = False


# ── Translation EQ profiles ────────────────────────────────────────────────

@dataclass(frozen=True)
class TranslationProfile:
    name:       str
    filter_str: str
    description: str


PHONE_SPEAKER = TranslationProfile(
    name="phone_speaker",
    description="Tinny mono phone earpiece (300–3500 Hz BPF + 2 kHz bump)",
    filter_str=(
        "highpass=f=300:t=q:w=0.7,"
        "lowpass=f=3500:t=q:w=0.7,"
        "equalizer=f=2000:t=o:w=1.0:g=4.0,"
        # Force mono — phone speakers are mono.
        "pan=stereo|c0<c0+c1|c1<c0+c1"
    ),
)

CAR_DASH = TranslationProfile(
    name="car_dash",
    description="Car dashboard speakers (low-end boost + harsh-mid resonance)",
    filter_str=(
        "equalizer=f=80:t=q:w=1.0:g=5.0,"     # low-end thump
        "equalizer=f=3500:t=o:w=1.5:g=3.0,"   # plastic resonance
        "equalizer=f=12000:t=h:g=-2.0"        # rolled-off air
    ),
)

LAPTOP_SPEAKER = TranslationProfile(
    name="laptop_speaker",
    description="Small laptop driver (no bass, 4 kHz dip)",
    filter_str=(
        "highpass=f=200:t=q:w=0.7,"
        "equalizer=f=4000:t=o:w=1.5:g=-3.0,"
        "lowpass=f=10000:t=q:w=0.7"
    ),
)

HEADPHONES = TranslationProfile(
    name="headphones",
    description="Identity reference (linear playback)",
    filter_str="",   # no-op
)

ALL_PROFILES = [PHONE_SPEAKER, CAR_DASH, LAPTOP_SPEAKER, HEADPHONES]


def apply_translation(input_path: str, profile: TranslationProfile,
                      output_path: str | None = None) -> str:
    """Render a copy of `input_path` through the translation EQ profile.
    Returns the output path (auto-named if not supplied)."""
    if output_path is None:
        fd, output_path = tempfile.mkstemp(
            suffix=f"_{profile.name}.wav", prefix="aimaster_xlate_",
        )
        os.close(fd)

    cmd = [_FFMPEG_BIN, "-hide_banner", "-y", "-i", input_path]
    if profile.filter_str:
        cmd.extend(["-af", profile.filter_str])
    cmd.extend(["-acodec", "pcm_s24le", "-ar", "44100", output_path])
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if proc.returncode != 0:
        raise RuntimeError(
            f"translation render failed for {profile.name}: {proc.stderr[-1000:]}"
        )
    return output_path


def youtube_normalize(input_path: str, output_path: str | None = None,
                      target_lufs: float = -14.0) -> str:
    """Approximate YouTube Music normalization: gain-only adjustment to
    hit `target_lufs`, with a TP guard so peaks don't exceed -1 dBTP.

    YouTube Music does NOT compress to hit the target — it only attenuates
    loud masters with no upward gain.  So masters quieter than -14 LUFS
    play at their original loudness.  We mimic that policy here."""
    if output_path is None:
        fd, output_path = tempfile.mkstemp(suffix="_yt.wav",
                                           prefix="aimaster_xlate_")
        os.close(fd)
    # Measure input.
    from app.utils.ffmpeg_wrapper import measure_output
    pre = measure_output(input_path, target_lufs, -1.0)
    pre_lufs = pre["integratedLufs"]
    # Only attenuate (YouTube policy).
    gain_db = min(0.0, target_lufs - pre_lufs)
    cmd = [_FFMPEG_BIN, "-hide_banner", "-y", "-i", input_path]
    if abs(gain_db) > 0.05:
        cmd.extend(["-af", f"volume={gain_db:.2f}dB,alimiter=level_in=1.0:level_out=1:limit=0.891251:attack=5:release=80"])
    else:
        cmd.extend(["-c", "copy"]) if input_path.endswith(".wav") else cmd.extend(["-acodec", "pcm_s24le"])
    if "-c" not in cmd[-2:]:
        cmd.extend(["-acodec", "pcm_s24le", "-ar", "44100"])
    cmd.append(output_path)
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if proc.returncode != 0:
        raise RuntimeError(
            f"youtube_normalize render failed: {proc.stderr[-1000:]}"
        )
    return output_path


# ── Audio-quality probes ────────────────────────────────────────────────────

def measure_crest_factor_db(path: str) -> float | None:
    """Peak / RMS ratio in dB.  Higher = more dynamic."""
    if not HAS_NUMPY:
        return None
    try:
        data, _sr = sf.read(path, always_2d=True)
    except Exception:
        return None
    if data.size == 0:
        return None
    peak = float(np.max(np.abs(data)))
    rms  = float(np.sqrt(np.mean(np.square(data))))
    if rms <= 0 or peak <= 0:
        return None
    return 20.0 * math.log10(peak / rms)


def count_transients(path: str, threshold_db: float = -10.0,
                     refractory_ms: float = 40.0) -> int | None:
    """Count distinct peak onsets above `threshold_db` (dBFS), with a
    refractory window so a single drum hit isn't multi-counted by its
    decay oscillation.  Mono-summed for measurement."""
    if not HAS_NUMPY:
        return None
    try:
        data, sr = sf.read(path, always_2d=True)
    except Exception:
        return None
    if data.size == 0:
        return None
    mono = data.mean(axis=1)
    threshold_lin = 10 ** (threshold_db / 20)
    refractory_samp = int(sr * refractory_ms / 1000)
    last_trigger = -refractory_samp - 1
    n = 0
    for i in range(len(mono)):
        if abs(mono[i]) >= threshold_lin and i - last_trigger > refractory_samp:
            n += 1
            last_trigger = i
    return n


def estimate_thd_n_db(path: str, freq_hz: float) -> float | None:
    """For sine inputs at `freq_hz`, return the energy outside the
    fundamental ± 5 % bin in dB relative to the fundamental.  Lower
    (more negative) is cleaner."""
    if not HAS_NUMPY:
        return None
    try:
        data, sr = sf.read(path, always_2d=True)
    except Exception:
        return None
    if data.size == 0:
        return None
    mono = data.mean(axis=1)
    n = min(len(mono), sr * 4)         # 4 sec window
    mono = mono[:n].astype(np.float64)
    # Hann window to reduce spectral leakage.
    w = np.hanning(n)
    spectrum = np.fft.rfft(mono * w)
    mag = np.abs(spectrum)
    bin_center = int(round(freq_hz * n / sr))
    band = max(1, int(round(0.05 * bin_center)))
    fund_lo = max(0, bin_center - band)
    fund_hi = min(len(mag), bin_center + band + 1)
    fund_energy  = float(np.sum(mag[fund_lo:fund_hi] ** 2))
    total_energy = float(np.sum(mag ** 2))
    if fund_energy <= 0 or total_energy <= 0:
        return None
    rest = max(0.0, total_energy - fund_energy)
    if rest <= 0:
        return -200.0   # numerical floor
    return 10.0 * math.log10(rest / fund_energy)


def stereo_correlation(path: str) -> float | None:
    """Pearson correlation between L and R channels.  +1 = mono, 0 = wide."""
    if not HAS_NUMPY:
        return None
    try:
        data, _sr = sf.read(path, always_2d=True)
    except Exception:
        return None
    if data.shape[1] < 2:
        return 1.0
    l, r = data[:, 0], data[:, 1]
    if np.std(l) == 0 or np.std(r) == 0:
        return 1.0
    cc = np.corrcoef(l, r)[0, 1]
    if not np.isfinite(cc):
        return None
    return float(cc)


def measure_band_rms_db(path: str, lo_hz: float, hi_hz: float) -> float | None:
    """RMS in dBFS of the [lo_hz, hi_hz] band.  Used by mono-compatibility
    tests — measure low-band of (L-R)/2 (side); should be near silent
    after mono-safe widening."""
    if not HAS_NUMPY:
        return None
    try:
        data, sr = sf.read(path, always_2d=True)
    except Exception:
        return None
    if data.shape[1] < 2:
        # Mono — return overall band RMS.
        x = data[:, 0]
    else:
        x = data.mean(axis=1)
    n = len(x)
    spec = np.fft.rfft(x.astype(np.float64))
    freqs = np.fft.rfftfreq(n, 1.0 / sr)
    mask  = (freqs >= lo_hz) & (freqs < hi_hz)
    if not np.any(mask):
        return None
    band_energy = float(np.sum(np.abs(spec[mask]) ** 2)) / n
    if band_energy <= 0:
        return -200.0
    return 10.0 * math.log10(band_energy)


def measure_low_band_side_rms_db(path: str, lo_hz: float = 0.0,
                                  hi_hz: float = 150.0) -> float | None:
    """RMS in dBFS of the SIDE signal (L-R)/2 in the low-band.  Used to
    verify mono-safe widening: should be near silent after the chain."""
    if not HAS_NUMPY:
        return None
    try:
        data, sr = sf.read(path, always_2d=True)
    except Exception:
        return None
    if data.shape[1] < 2:
        return -200.0
    side = (data[:, 0] - data[:, 1]) * 0.5
    n = len(side)
    spec = np.fft.rfft(side.astype(np.float64))
    freqs = np.fft.rfftfreq(n, 1.0 / sr)
    mask  = (freqs >= lo_hz) & (freqs < hi_hz)
    if not np.any(mask):
        return None
    band_energy = float(np.sum(np.abs(spec[mask]) ** 2)) / n
    if band_energy <= 0:
        return -200.0
    return 10.0 * math.log10(band_energy)
