"""
Reference profile feature extractor (M1.75).

Reads a WAV file (or in-memory buffer) and produces a ReferenceProfile —
strictly aggregate statistics, no time-series, no fingerprint, no
identifying metadata.

The extractor reads the audio buffer ONCE and discards it; no audio is
persisted by this module beyond what the caller already has.  Phase
information is never observed.

Algorithms (all aggregate-only):
  - LUFS-I / TP / LRA           : FFmpeg loudnorm pass-1
  - Short/Momentary percentiles : LUFS-meter style block analysis +
                                   numpy.percentile (NEVER the array itself)
  - Crest                       : 20*log10(peak / rms)
  - Transient density           : onset detector → events/min (a single number)
  - Compression score           : derived from LRA + crest + percentile
                                   spread (no extra signal data)
  - 1/3-oct spectrum            : FFT |X|² → octave-bin RMS → time-average
                                   over non-overlapping 1-sec windows
                                   (then the windows are discarded)
  - Spectral tilt               : least-squares slope of log-mag vs log-freq
  - Sub/lowmid/vocal/air ratios : band sums of the time-averaged spectrum
  - Harshness index             : peak/neighbour ratio in the 2-5 kHz band
  - Correlation / MS ratio      : aggregate over short windows then mean
  - Stereo width index          : derived from MS ratio + correlation

Reference docs:
  docs/redesign/loui-mastering-v2/m1.75/02-FEATURE-EXTRACTION-DESIGN.md
"""
from __future__ import annotations

import hashlib
import json
import math
import re
import shutil
import subprocess
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import numpy as np
import soundfile as sf

from .schema import (
    AIR_BAND,
    EXTRACTOR_VERSION,
    HARSH_BAND,
    HARSH_NEIGHBOUR_H,
    HARSH_NEIGHBOUR_L,
    LOW_MID_BAND,
    Percentiles,
    REFERENCE_PROFILE_SCHEMA_ID,
    ReferenceProfile,
    ReferenceProfileDynamics,
    ReferenceProfileFeatures,
    ReferenceProfileLoudness,
    ReferenceProfileProvenance,
    ReferenceProfileStereo,
    ReferenceProfileTonal,
    SUB_BAND,
    THIRD_OCT_CENTRES,
    VOCAL_BAND,
)


@dataclass
class ExtractionOptions:
    """Caller-supplied extraction knobs."""

    # User-controlled provenance metadata.
    user_label: Optional[str] = None
    source_type: str = "user-supplied"
    # Cache key handling — set to False for profiles intended for sharing.
    include_source_sha256: bool = True
    # When True, computes LUFS via FFmpeg loudnorm pass-1 (industry standard).
    # When False, skips it (falls back to numpy-based momentary LUFS).
    use_ffmpeg_loudnorm: bool = True


# ── FFmpeg loudness measurement (industry-standard, identical to the
# ── mastering test harness so numbers are apples-to-apples).
# ── (Lifted from utils/ffmpeg_wrapper.py's loudnorm_pass1 idiom.)


def _measure_lufs_ffmpeg(path: Path) -> dict[str, float]:
    if not shutil.which("ffmpeg"):
        raise RuntimeError("ffmpeg not available")
    r = subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-i", str(path),
            "-af", "loudnorm=I=-14:TP=-1:LRA=11:print_format=json",
            "-f", "null", "-",
        ],
        capture_output=True,
        text=True,
    )
    m = re.search(r"\{[^{}]*\"input_i\"[\s\S]*?\}", r.stderr)
    if not m:
        raise RuntimeError(f"loudnorm output not parseable (exit={r.returncode})")
    j = json.loads(m.group(0))
    return {
        "lufsI": float(j["input_i"]),
        "tpDb":  float(j["input_tp"]),
        "lra":   float(j["input_lra"]),
    }


# ── Block-level loudness percentiles
# ── Approximates short-term LUFS (3 s window) and momentary LUFS (400 ms).
# ── Uses RMS-as-proxy with K-weighting (cheap fast approximation).
# ── Result is reduced to {p10, p50, p90} — array discarded.


def _k_weight_filter(x: np.ndarray, sr: int) -> np.ndarray:
    """
    ITU-R BS.1770-4 K-weighting (2-stage biquad cascade), vectorised
    via lfilter-style recursion in pure numpy.  Returns weighted samples.
    """
    # Stage 1: high-shelf at 1681.974 Hz, +3.999 dB
    # Stage 2: RLB high-pass at 38.135 Hz, Q=0.5003
    # Pre-warped bilinear coefficients (libebur128 convention).
    # Coefficients copied from loudnessCore.ts (BS.1770-4).
    # For 48 kHz default.  For other rates, recompute via bilinear transform.
    # Simplified: warp by sample rate.
    f0_1 = 1681.974450955533
    g_1 = 3.999843853973347
    q_1 = 0.7071752370
    f0_2 = 38.13547088
    q_2 = 0.5003270373

    # Stage 1: shelving (precise RBJ shelving high-shelf)
    a = 10 ** (g_1 / 40)
    w0 = 2 * math.pi * f0_1 / sr
    cw, sw = math.cos(w0), math.sin(w0)
    alpha = sw / (2 * q_1)
    b0 = a * ((a + 1) + (a - 1) * cw + 2 * math.sqrt(a) * alpha)
    b1 = -2 * a * ((a - 1) + (a + 1) * cw)
    b2 = a * ((a + 1) + (a - 1) * cw - 2 * math.sqrt(a) * alpha)
    a0 = (a + 1) - (a - 1) * cw + 2 * math.sqrt(a) * alpha
    a1 = 2 * ((a - 1) - (a + 1) * cw)
    a2 = (a + 1) - (a - 1) * cw - 2 * math.sqrt(a) * alpha
    b0, b1, b2, a1, a2 = b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0
    y1 = _biquad(x, b0, b1, b2, a1, a2)

    # Stage 2: RBJ high-pass
    w0 = 2 * math.pi * f0_2 / sr
    cw, sw = math.cos(w0), math.sin(w0)
    alpha = sw / (2 * q_2)
    b0 = (1 + cw) / 2
    b1 = -(1 + cw)
    b2 = (1 + cw) / 2
    a0 = 1 + alpha
    a1 = -2 * cw
    a2 = 1 - alpha
    b0, b1, b2, a1, a2 = b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0
    return _biquad(y1, b0, b1, b2, a1, a2)


def _biquad(x: np.ndarray, b0: float, b1: float, b2: float, a1: float, a2: float) -> np.ndarray:
    """Direct-form-II biquad over float64 vector (Python loop — adequate
    for ~1-2 M samples; ~0.3 s per channel)."""
    out = np.empty_like(x, dtype=np.float64)
    x1 = x2 = y1 = y2 = 0.0
    for i in range(x.shape[0]):
        xi = float(x[i])
        yi = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
        out[i] = yi
        x2, x1 = x1, xi
        y2, y1 = y1, yi
    return out


def _block_lufs(samples: np.ndarray, sr: int, window_sec: float) -> np.ndarray:
    """
    Per-window LUFS approximation: K-weight → square → mean → 10·log10.

    Returns a 1D vector (one value per non-overlapping window) — used ONLY
    to compute percentiles, then discarded.  Never persisted.
    """
    if samples.ndim == 1:
        mono = samples
    else:
        mono = samples.mean(axis=1)
    w = _k_weight_filter(mono.astype(np.float64), sr)
    block = int(window_sec * sr)
    if block <= 0 or len(w) < block:
        return np.array([], dtype=np.float64)
    n_blocks = len(w) // block
    trimmed = w[: n_blocks * block].reshape(n_blocks, block)
    ms = np.mean(trimmed ** 2, axis=1)
    ms = np.maximum(ms, 1e-12)
    lufs = -0.691 + 10.0 * np.log10(ms)
    return lufs


# ── 1/3-octave spectrum (time-averaged)


def _third_oct_spectrum(samples: np.ndarray, sr: int) -> dict[str, float]:
    """
    Compute time-averaged 1/3-octave spectrum.

    Welch-style: split signal into non-overlapping 1-sec windows, FFT each
    with Hann, accumulate magnitude squared per centre.  Average over
    windows, convert to dB.  The per-window data is discarded.
    """
    if samples.ndim == 2:
        mono = samples.mean(axis=1)
    else:
        mono = samples
    win_n = sr
    if win_n <= 0 or mono.shape[0] < win_n:
        win_n = mono.shape[0]
    if win_n < 256:
        # Too short — return -inf row.
        return {str(c): float("-inf") for c in THIRD_OCT_CENTRES}

    accum: dict[float, float] = {float(c): 0.0 for c in THIRD_OCT_CENTRES}
    win_count = 0
    win = np.hanning(win_n)
    win_norm = max(np.sum(win), 1.0) / 2.0

    for start in range(0, mono.shape[0] - win_n + 1, win_n):
        x = mono[start : start + win_n] * win
        X = np.fft.rfft(x.astype(np.float64))
        mag = np.abs(X) / win_norm
        freqs = np.fft.rfftfreq(win_n, d=1.0 / sr)
        for cf in THIRD_OCT_CENTRES:
            lo = cf / (2 ** (1 / 6))
            hi = cf * (2 ** (1 / 6))
            mask = (freqs >= lo) & (freqs < hi)
            if not np.any(mask):
                continue
            band = mag[mask]
            accum[float(cf)] += float(np.mean(band ** 2))
        win_count += 1

    if win_count == 0:
        return {str(c): float("-inf") for c in THIRD_OCT_CENTRES}

    out: dict[str, float] = {}
    for cf in THIRD_OCT_CENTRES:
        mean_power = accum[float(cf)] / win_count
        if mean_power <= 0:
            out[str(cf)] = float("-inf")
        else:
            out[str(cf)] = float(10.0 * math.log10(mean_power))
    return out


def _band_energy_db(spectrum_db: dict[str, float], band: tuple[float, float]) -> float:
    """Sum of linear band power within [band[0], band[1]] (Hz), returned in dB."""
    lo, hi = band
    total = 0.0
    for cf_str, db in spectrum_db.items():
        cf = float(cf_str)
        if lo <= cf < hi and math.isfinite(db):
            total += 10 ** (db / 10)
    if total <= 0:
        return float("-inf")
    return 10.0 * math.log10(total)


def _total_band_energy(spectrum_db: dict[str, float]) -> float:
    """Linear sum of all bins."""
    total = 0.0
    for db in spectrum_db.values():
        if math.isfinite(db):
            total += 10 ** (db / 10)
    return total


def _sub_energy_ratio(spectrum_db: dict[str, float]) -> float:
    total = _total_band_energy(spectrum_db)
    if total <= 0:
        return 0.0
    sub_db = _band_energy_db(spectrum_db, SUB_BAND)
    if not math.isfinite(sub_db):
        return 0.0
    return max(0.0, min(1.0, (10 ** (sub_db / 10)) / total))


def _spectral_tilt(spectrum_db: dict[str, float]) -> float:
    """Least-squares slope of dB vs log2(freq).  Returns dB/octave."""
    pts: list[tuple[float, float]] = []
    for cf_str, db in spectrum_db.items():
        cf = float(cf_str)
        if cf <= 0 or not math.isfinite(db):
            continue
        pts.append((math.log2(cf), db))
    if len(pts) < 2:
        return 0.0
    xs = np.array([p[0] for p in pts])
    ys = np.array([p[1] for p in pts])
    # numpy.polyfit returns [slope, intercept]
    slope, _intercept = np.polyfit(xs, ys, 1)
    return float(slope)


def _harshness_index(spectrum_db: dict[str, float]) -> float:
    """Ratio of HARSH_BAND linear power vs mean of neighbour bands."""
    h = _band_energy_db(spectrum_db, HARSH_BAND)
    nl = _band_energy_db(spectrum_db, HARSH_NEIGHBOUR_L)
    nh = _band_energy_db(spectrum_db, HARSH_NEIGHBOUR_H)
    if not (math.isfinite(h) and math.isfinite(nl) and math.isfinite(nh)):
        return 0.0
    h_lin = 10 ** (h / 10)
    n_avg = (10 ** (nl / 10) + 10 ** (nh / 10)) / 2
    if n_avg <= 0:
        return 0.0
    return float(min(20.0, h_lin / n_avg))


# ── Dynamics + transient density


def _transient_density_per_min(samples: np.ndarray, sr: int) -> float:
    """
    Naive onset detector: high-pass + envelope + threshold-crossing rate.

    Returns events per minute as a SCALAR.  No event timestamps recorded.
    """
    if samples.ndim == 2:
        mono = samples.mean(axis=1)
    else:
        mono = samples
    n = mono.shape[0]
    if n < 1024:
        return 0.0
    duration_min = n / sr / 60.0
    if duration_min <= 0:
        return 0.0
    # Half-wave envelope of derivative (cheap transient detector).
    diff = np.abs(np.diff(mono))
    # Smooth with 5-ms moving average.
    win = max(1, int(0.005 * sr))
    if win > 1:
        kernel = np.ones(win) / win
        env = np.convolve(diff, kernel, mode="same")
    else:
        env = diff
    # Median absolute is the noise floor proxy.
    median = float(np.median(env))
    threshold = max(median * 6.0, 1e-5)
    # Count rising-edge crossings.
    above = env > threshold
    onsets = int(np.sum(np.logical_and(above[1:], ~above[:-1])))
    # Apply minimum gap of 30 ms by binning.
    gap = max(1, int(0.030 * sr))
    if gap > 1 and onsets > 0:
        # Re-count with binning.
        binned = above.reshape(-1, gap) if (above.size % gap == 0) else above[: above.size - (above.size % gap)].reshape(-1, gap)
        any_above = np.any(binned, axis=1)
        onsets = int(np.sum(np.logical_and(any_above[1:], ~any_above[:-1])))
    return float(onsets / duration_min)


def _compression_score(lra: float, crest_db: float, short_p10: float, short_p90: float) -> float:
    """
    Derive a 0..1 score from LRA + crest + short-term percentile spread.

    0 = highly dynamic (LRA ≥ 14 LU, crest ≥ 14, short-term spread ≥ 10 LU)
    1 = brickwall (LRA ≤ 1, crest ≤ 6, spread ≤ 1)
    """
    if not math.isfinite(lra) or not math.isfinite(crest_db):
        return 0.5

    # Each axis mapped to [0, 1] with 0 = dynamic, 1 = compressed.
    lra_score = 1.0 - max(0.0, min(1.0, lra / 14.0))
    crest_score = 1.0 - max(0.0, min(1.0, (crest_db - 4.0) / 12.0))
    spread = max(0.0, short_p90 - short_p10) if math.isfinite(short_p90 - short_p10) else 0.0
    spread_score = 1.0 - max(0.0, min(1.0, spread / 10.0))
    # Weighted mean — LRA most important.
    score = 0.55 * lra_score + 0.30 * crest_score + 0.15 * spread_score
    return float(max(0.0, min(1.0, score)))


# ── Stereo


def _stereo_features(samples: np.ndarray, sr: int) -> tuple[float, float, float]:
    """Returns (correlationMean, msRatioDb, stereoWidthIndex)."""
    if samples.ndim != 2 or samples.shape[1] < 2:
        return 1.0, -60.0, 1.0  # mono treated as perfectly correlated, narrow
    L = samples[:, 0].astype(np.float64)
    R = samples[:, 1].astype(np.float64)
    # Per-window correlation (1-sec) then mean.
    win = sr
    if L.shape[0] < win:
        win = L.shape[0]
    if win < 256:
        return 1.0, -60.0, 1.0
    n_blocks = L.shape[0] // win
    Lb = L[: n_blocks * win].reshape(n_blocks, win)
    Rb = R[: n_blocks * win].reshape(n_blocks, win)
    # Pearson correlation per block.
    L_mean = Lb.mean(axis=1, keepdims=True)
    R_mean = Rb.mean(axis=1, keepdims=True)
    L_c = Lb - L_mean
    R_c = Rb - R_mean
    num = np.sum(L_c * R_c, axis=1)
    den = np.sqrt(np.sum(L_c ** 2, axis=1) * np.sum(R_c ** 2, axis=1)) + 1e-12
    corrs = num / den
    corr_mean = float(np.mean(corrs))
    # MS energy
    M = 0.5 * (L + R)
    S = 0.5 * (L - R)
    pM = float(np.mean(M ** 2)) + 1e-12
    pS = float(np.mean(S ** 2)) + 1e-12
    ms_ratio_db = 10.0 * math.log10(pM / pS)
    # Width index: simple monotone mapping.
    # corr=+1, ms=high → 0.5 (very narrow)
    # corr=0, ms=balanced → 1.0
    # corr negative or ms<0 (S>M) → >1.0
    # We map via a smooth function.
    raw_width = 2.0 * pS / (pM + pS)
    # raw_width: 0 (pure mono) → 1 (pure side). We rescale so 1.0 = "moderate stereo" (≈ S = M).
    width_idx = float(min(4.0, raw_width * 2.0))
    return corr_mean, float(ms_ratio_db), width_idx


# ── Crest


def _crest_db(samples: np.ndarray) -> float:
    if samples.size == 0:
        return 0.0
    s = samples.astype(np.float64)
    peak = float(np.max(np.abs(s)))
    rms = float(np.sqrt(np.mean(s ** 2)))
    if peak <= 0 or rms <= 0:
        return 0.0
    return float(20.0 * math.log10(peak / rms))


# ── File hash (cache key only)


def _file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


# ── Public entry point


def extract_profile(
    audio_path: str | Path,
    *,
    profile_id: str,
    options: ExtractionOptions | None = None,
) -> ReferenceProfile:
    """
    Extract a ReferenceProfile from a WAV file.

    The audio data is loaded, analysed, then DISCARDED — no buffer or
    fingerprint is persisted by this function.  The returned profile is
    safe to share (subject to the legal guideline doc).
    """
    options = options or ExtractionOptions()
    path = Path(audio_path)

    samples, sr = sf.read(str(path), always_2d=True)
    n = samples.shape[0]
    channels = int(samples.shape[1])
    duration = n / sr if sr > 0 else 0.0

    # ── Loudness (FFmpeg loudnorm for industry-standard numbers + numpy
    # ── percentiles for distribution).
    if options.use_ffmpeg_loudnorm and shutil.which("ffmpeg"):
        loud_basic = _measure_lufs_ffmpeg(path)
        lufs_i = loud_basic["lufsI"]
        tp_db = loud_basic["tpDb"]
        lra = loud_basic["lra"]
    else:
        # Pure-numpy fallback (less accurate, used if ffmpeg unavailable).
        m = _block_lufs(samples, sr, 0.4)
        if m.size > 0:
            lufs_i = float(np.median(m))
            tp_db = float(20 * math.log10(max(1e-9, float(np.max(np.abs(samples))))))
            lra = float(np.percentile(m, 95) - np.percentile(m, 10))
        else:
            lufs_i = tp_db = lra = float("nan")

    short_blocks = _block_lufs(samples, sr, 3.0)
    momentary_blocks = _block_lufs(samples, sr, 0.4)
    if short_blocks.size > 0:
        st = Percentiles(
            p10=float(np.percentile(short_blocks, 10)),
            p50=float(np.percentile(short_blocks, 50)),
            p90=float(np.percentile(short_blocks, 90)),
        )
    else:
        st = Percentiles(lufs_i, lufs_i, lufs_i)
    if momentary_blocks.size > 0:
        mom = Percentiles(
            p10=float(np.percentile(momentary_blocks, 10)),
            p50=float(np.percentile(momentary_blocks, 50)),
            p90=float(np.percentile(momentary_blocks, 90)),
        )
    else:
        mom = Percentiles(lufs_i, lufs_i, lufs_i)

    # ── Dynamics
    crest = _crest_db(samples)
    transient_density = _transient_density_per_min(samples, sr)
    compression = _compression_score(lra, crest, st.p10, st.p90)

    # ── Tonal
    spectrum = _third_oct_spectrum(samples, sr)
    total_lin = _total_band_energy(spectrum)

    def band_relative_db(band: tuple[float, float]) -> float:
        if total_lin <= 0:
            return float("-inf")
        e = _band_energy_db(spectrum, band)
        if not math.isfinite(e):
            return float("-inf")
        # band energy in dB relative to total band energy
        return float(e - 10.0 * math.log10(total_lin))

    tonal = ReferenceProfileTonal(
        thirdOctSpectrumDb=spectrum,
        spectralTiltDbPerOct=_spectral_tilt(spectrum),
        subEnergyRatio=_sub_energy_ratio(spectrum),
        lowMidBalanceDb=band_relative_db(LOW_MID_BAND),
        vocalRegionEnergyDb=band_relative_db(VOCAL_BAND),
        airBandEnergyDb=band_relative_db(AIR_BAND),
        harshnessIndex=_harshness_index(spectrum),
    )

    # ── Stereo
    corr_mean, ms_ratio_db, width_idx = _stereo_features(samples, sr)

    # Free the buffer — explicit deletion to reinforce the no-storage rule.
    del samples

    features = ReferenceProfileFeatures(
        loudness=ReferenceProfileLoudness(
            integratedLufs=lufs_i,
            truePeakDbtp=tp_db,
            loudnessRange=lra,
            shortTermPercentiles=st,
            momentaryPercentiles=mom,
        ),
        dynamics=ReferenceProfileDynamics(
            crestDb=crest,
            transientDensityPerMin=transient_density,
            compressionScore=compression,
        ),
        tonal=tonal,
        stereo=ReferenceProfileStereo(
            correlationMean=corr_mean,
            msRatioDb=ms_ratio_db,
            stereoWidthIndex=width_idx,
        ),
    )

    provenance = ReferenceProfileProvenance(
        sourceType=options.source_type,
        createdAt=datetime.now(timezone.utc).isoformat(),
        durationSec=duration,
        sampleRate=int(sr),
        channels=channels,
        extractorVersion=EXTRACTOR_VERSION,
        sourceFileSha256=(_file_sha256(path) if options.include_source_sha256 else None),
        userLabel=options.user_label,
    )

    profile = ReferenceProfile(
        id=profile_id,
        version="1.0.0",
        provenance=provenance,
        features=features,
        featureFingerprint="",
    )
    profile.featureFingerprint = _feature_fingerprint(features)
    return profile


def _feature_fingerprint(features: ReferenceProfileFeatures) -> str:
    """SHA-256 of canonicalised features dict — for cache invalidation."""
    canon = json.dumps(features.to_dict(), sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canon.encode("utf-8")).hexdigest()
