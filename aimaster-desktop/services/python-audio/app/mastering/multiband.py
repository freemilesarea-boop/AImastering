"""
4-band multi-band processing for the iterative reference-matching mastering.

Bands (matches the user's spec):
    low   — 20 –   200 Hz   (sub + bass body)
    mid   — 200 –  2000 Hz  (instrument body, low vocal)
    vocal — 2000 – 5000 Hz  (lead vocal, snare, presence)
    high  — 5000 – 16000 Hz (cymbals, air, sibilance)

This module stays pragmatic: rather than building a 4-band parallel
acrossover/amix graph (which works in ffmpeg but quadruples the filter
chain length and risks phase issues at the crossovers), we use sequential
band-targeted shelving / peaking EQs.  The tonal effect is the same as
what Ozone's "EQ Match" mode does — push each band toward the reference's
energy without splitting the signal.

Multi-band *compression* is delegated to the existing dynamic-EQ presets
in `app/mastering/dynamic_eq.py`, whose bands already align with these
frequencies (boomy_low → low, muddy_lowmid → mid, harsh_highmid/vocal_
presence → vocal, sibilance/air_dynamic → high).  Vocal protection clamps
the vocal band cuts to ≤ 2.5 dB no matter what the reference asks for.
"""
from __future__ import annotations

import math
from typing import Any

from app.utils.logger import log
from app.utils.vocal_protection import VOCAL_PROTECTION

try:
    import numpy as np
    import soundfile as sf
    HAS_SF = True
except ImportError:
    HAS_SF = False


# ── Band definitions ────────────────────────────────────────────────────────

BAND_DEFINITIONS: dict[str, tuple[float, float, float, float]] = {
    # key   → (lo_hz, hi_hz, eq_centre_hz, eq_q_or_width)
    "low":   (20.0,    200.0,  100.0,  1.0),
    "mid":   (200.0,  2000.0,  700.0,  1.0),
    "vocal": (2000.0, 5000.0, 3000.0,  1.2),
    "high":  (5000.0, 16000.0, 9000.0, 0.9),
}

BAND_KEYS = list(BAND_DEFINITIONS.keys())


# ── Measurement ─────────────────────────────────────────────────────────────

def _band_rms_db(mono, sr: int, lo_hz: float, hi_hz: float) -> float:
    """RMS energy (dBFS) of a mono signal restricted to [lo_hz, hi_hz]."""
    if mono.size == 0:
        return -120.0
    n = len(mono)
    spec = np.fft.rfft(mono)
    freqs = np.fft.rfftfreq(n, 1.0 / sr)
    mask = (freqs >= lo_hz) & (freqs <= hi_hz)
    spec_band = np.zeros_like(spec)
    spec_band[mask] = spec[mask]
    filtered = np.fft.irfft(spec_band, n=n)
    rms = float(np.sqrt(np.mean(filtered ** 2)))
    return round(20.0 * math.log10(max(rms, 1e-12)), 2)


def measure_band_profile(file_path: str, max_seconds: float = 60.0) -> dict[str, float]:
    """Return {band_key → RMS_dBFS} for every band in BAND_DEFINITIONS."""
    if not HAS_SF:
        return {}
    try:
        data, sr = sf.read(file_path, always_2d=True, dtype="float32")
    except Exception as exc:
        log("WARN", f"[multiband] read failed: {exc}")
        return {}
    if data.size == 0:
        return {}
    max_samples = int(max_seconds * sr)
    mono = np.mean(data[:max_samples], axis=1).astype(np.float32)
    nyquist = sr / 2.0
    out: dict[str, float] = {}
    for key, (lo, hi, _c, _q) in BAND_DEFINITIONS.items():
        out[key] = _band_rms_db(mono, sr, lo, min(hi, nyquist - 1.0))
    return out


# ── EQ chain builder ────────────────────────────────────────────────────────

def build_multiband_eq_chain(
    band_deltas_db: dict[str, float],
    *,
    skip_below: float = 0.3,
    protection_log: list[dict] | None = None,
) -> tuple[str, list[dict[str, Any]]]:
    """
    Translate a per-band gain delta dict into an ffmpeg filter string.

    Each band gets one `equalizer` peak filter at its centre frequency.
    Vocal-band BOOSTs are clamped to vocal-protection limits (boost
    promotes harshness; cuts promote thinness — only the boost direction
    is dangerous, cuts are user-requested reference matching).

    Returns (filter_string, applied_list).  applied_list is one dict per
    band describing the actual gain that ended up applied (after clamps).
    """
    parts: list[str] = []
    applied: list[dict[str, Any]] = []

    for key, gain_db in band_deltas_db.items():
        if key not in BAND_DEFINITIONS:
            continue
        if abs(gain_db) < skip_below:
            continue
        lo, hi, centre, q = BAND_DEFINITIONS[key]

        clamped = float(gain_db)
        # Vocal-band protection: cap BOOSTS in 1.5–5 kHz at +2 dB.  Cuts pass
        # because they reduce harshness; boosts can crush vocal clarity.
        if (key == "vocal" and clamped > 0.0
            and lo >= VOCAL_PROTECTION.BAND_LOW_HZ - 100
            and clamped > 2.0):
            if protection_log is not None:
                protection_log.append({
                    "where":    f"reference_match.vocal_boost@{centre}Hz",
                    "original": gain_db,
                    "clamped":  2.0,
                    "reason":   "vocal protection: vocal-band boost > +2 dB causes harshness",
                })
            clamped = 2.0

        # Width (Q) — use 'q' type with q value
        parts.append(
            f"equalizer=f={centre:.0f}:t=q:w={q:.2f}:g={clamped:+.2f}"
        )
        applied.append({
            "band":      key,
            "rangeHz":   [lo, hi],
            "centreHz":  centre,
            "q":         q,
            "requestedDb": round(float(gain_db), 2),
            "appliedDb":   round(float(clamped), 2),
        })

    return ",".join(parts), applied


# ── Convenience: derive crossover frequencies (used by the iterative report) ─

def crossover_frequencies() -> list[float]:
    """Return the 3 crossover boundaries between the 4 bands (Hz)."""
    return [200.0, 2000.0, 5000.0]
