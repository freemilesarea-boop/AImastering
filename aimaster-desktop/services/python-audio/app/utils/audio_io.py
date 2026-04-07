"""
Waveform-level analysis using soundfile + numpy.

Provides per-sample measurements that FFmpeg cannot easily supply:
  - Per-channel RMS (dB)
  - Sample peak (dBFS)
  - DC offset
  - Stereo correlation  (Pearson coefficient, -1 to +1)
  - L/R balance heuristic (dB difference)
  - Start / end silence duration (ms)
  - Clipping detection (samples at or above 0.9999 FS)
  - Spectral balance: low / mid / high band energy ratios (FFT-based)

All public functions return None when soundfile is unavailable,
so the pipeline degrades gracefully rather than crashing.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Optional

from app.utils.logger import log

try:
    import numpy as np
    import soundfile as sf
    HAS_SF = True
except ImportError:
    HAS_SF = False
    log("WARN", "soundfile/numpy not installed — waveform analysis will be skipped")


# ── Data model ────────────────────────────────────────────────────────────────

@dataclass
class WaveformStats:
    # ── RMS (dBFS, full-scale) ────────────────────────────────────────────
    rms_db_l: float           # left channel (or mono)
    rms_db_r: float           # right channel (= L for mono)
    rms_db_overall: float     # both channels combined

    # ── Sample peak (dBFS) ───────────────────────────────────────────────
    sample_peak_db_l: float
    sample_peak_db_r: float
    sample_peak_db: float

    # ── DC offset ────────────────────────────────────────────────────────
    dc_offset_db_l: float
    dc_offset_db_r: float
    dc_offset_detected: bool  # True if |dc| > DC_WARN_THRESHOLD on either ch

    # ── Stereo correlation ────────────────────────────────────────────────
    stereo_correlation: float # Pearson [-1, +1]; float("nan") for mono
    lr_balance_db: float      # L_rms_dB - R_rms_dB; 0 for mono
    lr_imbalance_detected: bool  # |diff| > LR_WARN_THRESHOLD_DB

    # ── Silence ───────────────────────────────────────────────────────────
    silence_start_ms: float
    silence_end_ms: float

    # ── Clipping ─────────────────────────────────────────────────────────
    clipping_detected: bool
    clipping_samples: int     # total samples at or above 0.9999 FS

    # ── Spectral balance (FFT-based, dB) ──────────────────────────────────
    # Bands: low 20-250 Hz | mid 250-8000 Hz | high 8000-22050 Hz
    # Ratios are relative to mid (reference = 0 dB)
    low_energy_db: float      # band RMS (absolute dB)
    mid_energy_db: float
    high_energy_db: float
    low_to_mid_db: float      # low_energy_db - mid_energy_db  (<0 = bass-light)
    high_to_mid_db: float     # high_energy_db - mid_energy_db (<0 = dark)

    # ── File info ─────────────────────────────────────────────────────────
    channels: int
    sample_rate: int
    duration_sec: float

    # ── Warnings produced during analysis ────────────────────────────────
    warnings: list[str] = field(default_factory=list)


# ── Thresholds ────────────────────────────────────────────────────────────────

SILENCE_THRESHOLD_DB: float = -60.0
DC_WARN_THRESHOLD_DB: float = -80.0
LR_WARN_THRESHOLD_DB: float = 3.0
CLIP_THRESHOLD: float = 0.9999

# Spectral analysis: max segment length to keep FFT fast regardless of track length
_SPECTRAL_MAX_SECONDS: float = 60.0


# ── Helpers ───────────────────────────────────────────────────────────────────

def _db(linear: float) -> float:
    return 20.0 * math.log10(max(abs(linear), 1e-12))


def _band_rms_db(mono: "np.ndarray", sr: int, f_low: float, f_high: float) -> float:
    """
    Compute RMS energy (dBFS) of a mono signal filtered to [f_low, f_high] Hz.
    Uses brick-wall FFT bandpass filter — zero-phase, no ringing.
    """
    n = len(mono)
    spec = np.fft.rfft(mono)
    freqs = np.fft.rfftfreq(n, 1.0 / sr)
    mask = (freqs >= f_low) & (freqs <= f_high)
    spec_band = np.zeros_like(spec)
    spec_band[mask] = spec[mask]
    filtered = np.fft.irfft(spec_band, n=n)
    rms = float(np.sqrt(np.mean(filtered ** 2)))
    return 20.0 * math.log10(max(rms, 1e-12))


def _compute_spectral_balance(
    data: "np.ndarray",   # shape (n_samples, n_channels)
    sr: int,
) -> tuple[float, float, float, float, float]:
    """
    Compute low/mid/high band RMS (dB) from a representative segment.
    Returns: (low_db, mid_db, high_db, low_to_mid, high_to_mid)
    """
    # Mono mix + take up to _SPECTRAL_MAX_SECONDS
    max_samples = int(_SPECTRAL_MAX_SECONDS * sr)
    mono = np.mean(data[:max_samples], axis=1).astype(np.float32)

    nyquist = sr / 2.0
    hi_cap = min(22000.0, nyquist - 1.0)

    low_db  = _band_rms_db(mono, sr, 20.0,  250.0)
    mid_db  = _band_rms_db(mono, sr, 250.0, 8000.0)
    high_db = _band_rms_db(mono, sr, 8000.0, hi_cap)

    return low_db, mid_db, high_db, low_db - mid_db, high_db - mid_db


# ── Main entry point ──────────────────────────────────────────────────────────

def analyze_waveform(
    file_path: str,
    silence_threshold_db: float = SILENCE_THRESHOLD_DB,
) -> Optional["WaveformStats"]:
    """
    Read the audio file and compute waveform + spectral statistics.
    Returns None if soundfile is unavailable or the file cannot be decoded.
    Original file is never modified.
    """
    if not HAS_SF:
        return None

    try:
        data, sr = sf.read(file_path, always_2d=True, dtype="float32")
    except Exception as exc:
        log("WARN", f"soundfile.read failed for '{file_path}': {exc}")
        return None

    n_samples, n_ch = data.shape
    duration = n_samples / sr
    warnings: list[str] = []

    # ── Channel views ─────────────────────────────────────────────────────
    ch_l: "np.ndarray" = data[:, 0]
    ch_r: "np.ndarray" = data[:, 1] if n_ch >= 2 else data[:, 0]

    # ── RMS ───────────────────────────────────────────────────────────────
    rms_l = float(np.sqrt(np.mean(ch_l ** 2)))
    rms_r = float(np.sqrt(np.mean(ch_r ** 2)))
    rms_overall = float(np.sqrt(np.mean(data ** 2)))

    # ── Sample peak ───────────────────────────────────────────────────────
    peak_l = float(np.max(np.abs(ch_l)))
    peak_r = float(np.max(np.abs(ch_r)))
    peak_overall = float(np.max(np.abs(data)))

    # ── DC offset ─────────────────────────────────────────────────────────
    dc_l = float(np.mean(ch_l))
    dc_r = float(np.mean(ch_r))
    dc_db_l = _db(dc_l)
    dc_db_r = _db(dc_r)
    dc_detected = dc_db_l > DC_WARN_THRESHOLD_DB or dc_db_r > DC_WARN_THRESHOLD_DB
    if dc_detected:
        warnings.append(
            f"DC 오프셋이 감지되었습니다 "
            f"(L: {dc_db_l:.1f} dB, R: {dc_db_r:.1f} dB). "
            f"마스터링 전 제거를 권장합니다."
        )

    # ── Stereo correlation ────────────────────────────────────────────────
    if n_ch >= 2:
        corr_matrix = np.corrcoef(ch_l, ch_r)
        stereo_corr = float(corr_matrix[0, 1])
        lr_balance = _db(rms_l) - _db(rms_r)
        lr_imbalance = abs(lr_balance) > LR_WARN_THRESHOLD_DB
        if lr_imbalance:
            side = "L" if lr_balance > 0 else "R"
            warnings.append(
                f"L/R 밸런스 차이가 큽니다 ({lr_balance:+.1f} dB, {side}채널이 더 큼). "
                f"스테레오 불균형을 확인해주세요."
            )
    else:
        stereo_corr = float("nan")
        lr_balance = 0.0
        lr_imbalance = False
        warnings.append("모노 파일이 감지되었습니다. 스테레오로 처리하지만 결과가 모노로 출력됩니다.")

    # ── Silence detection ─────────────────────────────────────────────────
    threshold_linear = 10.0 ** (silence_threshold_db / 20.0)
    mono_abs: "np.ndarray" = np.max(np.abs(data), axis=1)
    nonsilent = np.where(mono_abs > threshold_linear)[0]

    if len(nonsilent) == 0:
        silence_start_ms = duration * 1000.0
        silence_end_ms = duration * 1000.0
        warnings.append("파일 전체가 무음입니다.")
    else:
        silence_start_ms = float(nonsilent[0] / sr * 1000.0)
        silence_end_ms = float((n_samples - 1 - nonsilent[-1]) / sr * 1000.0)

    if silence_start_ms > 500:
        warnings.append(
            f"시작 부분에 {silence_start_ms:.0f} ms의 묵음이 있습니다. "
            f"필요시 제거 옵션을 활성화하세요."
        )
    if silence_end_ms > 500:
        warnings.append(
            f"끝 부분에 {silence_end_ms:.0f} ms의 묵음이 있습니다. "
            f"필요시 제거 옵션을 활성화하세요."
        )

    # ── Clipping ──────────────────────────────────────────────────────────
    clip_count = int(np.sum(np.abs(data) >= CLIP_THRESHOLD))
    clipping = clip_count > 0
    if clipping:
        warnings.append(
            f"클리핑이 감지되었습니다 ({clip_count}개 샘플). "
            f"입력 파일이 이미 왜곡되어 있을 수 있습니다."
        )

    # ── Spectral balance ──────────────────────────────────────────────────
    try:
        low_db, mid_db, high_db, low_to_mid, high_to_mid = _compute_spectral_balance(data, sr)
    except Exception as exc:
        log("WARN", f"Spectral balance analysis failed: {exc}")
        low_db, mid_db, high_db, low_to_mid, high_to_mid = -60.0, -40.0, -60.0, -20.0, -20.0

    return WaveformStats(
        rms_db_l=_db(rms_l),
        rms_db_r=_db(rms_r),
        rms_db_overall=_db(rms_overall),
        sample_peak_db_l=_db(peak_l),
        sample_peak_db_r=_db(peak_r),
        sample_peak_db=_db(peak_overall),
        dc_offset_db_l=dc_db_l,
        dc_offset_db_r=dc_db_r,
        dc_offset_detected=dc_detected,
        stereo_correlation=stereo_corr,
        lr_balance_db=lr_balance,
        lr_imbalance_detected=lr_imbalance,
        silence_start_ms=silence_start_ms,
        silence_end_ms=silence_end_ms,
        clipping_detected=clipping,
        clipping_samples=clip_count,
        low_energy_db=round(low_db, 1),
        mid_energy_db=round(mid_db, 1),
        high_energy_db=round(high_db, 1),
        low_to_mid_db=round(low_to_mid, 1),
        high_to_mid_db=round(high_to_mid, 1),
        channels=n_ch,
        sample_rate=sr,
        duration_sec=duration,
        warnings=warnings,
    )


def waveform_stats_to_dict(ws: "WaveformStats") -> dict:
    """Serialize WaveformStats to a plain dict for JSON-RPC responses."""
    return {
        "rmsDb": {
            "l": round(ws.rms_db_l, 2),
            "r": round(ws.rms_db_r, 2),
            "overall": round(ws.rms_db_overall, 2),
        },
        "samplePeakDb": {
            "l": round(ws.sample_peak_db_l, 2),
            "r": round(ws.sample_peak_db_r, 2),
            "overall": round(ws.sample_peak_db, 2),
        },
        "dcOffset": {
            "dbL": round(ws.dc_offset_db_l, 2),
            "dbR": round(ws.dc_offset_db_r, 2),
            "detected": ws.dc_offset_detected,
        },
        "stereoCorrelation": None if math.isnan(ws.stereo_correlation) else round(ws.stereo_correlation, 3),
        "lrBalanceDb": round(ws.lr_balance_db, 2),
        "lrImbalanceDetected": ws.lr_imbalance_detected,
        "silenceStartMs": round(ws.silence_start_ms, 1),
        "silenceEndMs": round(ws.silence_end_ms, 1),
        "clippingDetected": ws.clipping_detected,
        "clippingSamples": ws.clipping_samples,
        "spectralBalance": {
            "lowEnergyDb":  ws.low_energy_db,
            "midEnergyDb":  ws.mid_energy_db,
            "highEnergyDb": ws.high_energy_db,
            "lowToMidDb":   ws.low_to_mid_db,
            "highToMidDb":  ws.high_to_mid_db,
        },
        "channels": ws.channels,
        "sampleRate": ws.sample_rate,
        "durationSec": round(ws.duration_sec, 3),
        "warnings": ws.warnings,
    }
