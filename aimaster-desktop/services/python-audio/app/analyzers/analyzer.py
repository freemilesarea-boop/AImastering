"""
Stage 1: Input Analysis

Measures all required items from the pipeline spec:
  duration, sample_rate, channels, bit_depth, codec_name,
  peak level, true peak, integrated loudness, loudness range,
  RMS (per-channel + overall), stereo correlation / L-R balance,
  start silence duration, end silence duration.

Stage 2 warnings are also emitted here (DC offset, sample rate,
mono, clipping) so they travel with the analysis result.

Original file is never modified.
"""
from __future__ import annotations

import math
import os
from typing import Any

from app.utils.ffmpeg_wrapper import (
    FFmpegError,
    ffprobe_info,
    loudnorm_pass1,
    parse_audio_stream,
    parse_bit_depth,
)
from app.utils.audio_io import analyze_waveform, waveform_stats_to_dict
from app.utils.logger import log

# ── AI artifact thresholds ────────────────────────────────────────────────────
# (applied only when soundfile/numpy is available)

_HARSH_HIGHMID_THRESHOLD = 0.28   # 3–5 kHz energy ratio
_BOOMY_LOW_THRESHOLD = 0.45       # 60–200 Hz energy ratio
_BRICKWALL_LRA = 2.5              # LU — below this = over-compressed
_LR_IMBALANCE_DB = 3.0            # dB
_UPSAMPLE_NYQUIST_RATIO = 0.001   # near-zero high-freq energy = upsample suspect
_INTERSAMPLE_RISK_TP = -0.5       # dBTP threshold


# ── FFT helpers ───────────────────────────────────────────────────────────────

def _fft_energy_ratio(
    samples: "Any",  # np.ndarray shape (n_samples,)
    sr: int,
    lo_hz: float,
    hi_hz: float,
) -> float:
    """Return fraction of total FFT energy in [lo_hz, hi_hz]."""
    try:
        import numpy as np
        spectrum = np.abs(np.fft.rfft(samples))
        freqs = np.fft.rfftfreq(len(samples), d=1.0 / sr)
        total = spectrum.sum() + 1e-12
        band = spectrum[(freqs >= lo_hz) & (freqs <= hi_hz)].sum()
        return float(band / total)
    except Exception:
        return 0.0


def _detect_ai_artifacts(
    data: "Any",  # np.ndarray shape (n_samples, n_channels)
    sr: int,
    lufs: float,
    true_peak: float,
    lra: float,
) -> dict[str, bool]:
    """
    Detect AI-specific audio artifacts using FFT energy ratios and heuristics.
    data shape: (n_samples, n_channels)  [soundfile convention]
    """
    try:
        import numpy as np

        mono = data.mean(axis=1) if data.ndim > 1 else data

        harsh = _fft_energy_ratio(mono, sr, 3000, 5000) > _HARSH_HIGHMID_THRESHOLD
        boomy = _fft_energy_ratio(mono, sr, 60, 200)   > _BOOMY_LOW_THRESHOLD

        brickwall = lra < _BRICKWALL_LRA

        # Stereo imbalance — compare per-channel RMS
        if data.ndim >= 2 and data.shape[1] >= 2:
            rms_l = float(np.sqrt(np.mean(data[:, 0] ** 2)) + 1e-12)
            rms_r = float(np.sqrt(np.mean(data[:, 1] ** 2)) + 1e-12)
            lr_diff_db = abs(20.0 * math.log10(rms_l / rms_r))
            stereo_imbalance = lr_diff_db > _LR_IMBALANCE_DB
        else:
            stereo_imbalance = False

        nyquist = sr / 2
        upsample = _fft_energy_ratio(mono, sr, nyquist * 0.9, nyquist) < _UPSAMPLE_NYQUIST_RATIO

        intersample_risk = true_peak > _INTERSAMPLE_RISK_TP

        return {
            "harshHighMid":       harsh,
            "boomyLowEnd":        boomy,
            "brickwallCompression": brickwall,
            "stereoImbalance":    stereo_imbalance,
            "intersampleRisk":    intersample_risk,
            "upsampleSuspected":  upsample,
        }
    except Exception as exc:
        log("WARN", f"AI artifact detection failed: {exc}")
        return {
            "harshHighMid": False, "boomyLowEnd": False,
            "brickwallCompression": lra < _BRICKWALL_LRA,
            "stereoImbalance": False, "intersampleRisk": true_peak > _INTERSAMPLE_RISK_TP,
            "upsampleSuspected": False,
        }


# ── Stage-2 preprocessing warnings ───────────────────────────────────────────

_RECOMMENDED_SAMPLE_RATES = {44100, 48000, 88200, 96000}


def _preprocessing_warnings(
    sample_rate: int,
    channels: int,
    peak_db: float,
    dc_detected: bool,
) -> list[dict[str, str]]:
    """
    Return Stage-2 warnings as list of {code, level, userMessage, devDetail}.
    These are informational — they do NOT abort processing.
    """
    warns: list[dict[str, str]] = []

    if sample_rate not in _RECOMMENDED_SAMPLE_RATES:
        warns.append({
            "code": "NON_STANDARD_SAMPLE_RATE",
            "level": "warning",
            "userMessage": f"샘플레이트 {sample_rate} Hz는 비권장 값입니다. 마스터링 후 44100 Hz로 변환됩니다.",
            "devDetail": f"sample_rate={sample_rate}, recommended={_RECOMMENDED_SAMPLE_RATES}",
        })

    if channels == 1:
        warns.append({
            "code": "MONO_INPUT",
            "level": "warning",
            "userMessage": "모노 파일이 입력되었습니다. 마스터링은 가능하지만 스테레오 출력이 아닙니다.",
            "devDetail": "channels=1",
        })

    if dc_detected:
        warns.append({
            "code": "DC_OFFSET_DETECTED",
            "level": "warning",
            "userMessage": "DC 오프셋이 감지되었습니다. 소리 품질에 영향을 줄 수 있습니다. 처리 전 제거를 권장합니다.",
            "devDetail": f"peak_db={peak_db:.2f}",
        })

    if peak_db >= 0.0:
        warns.append({
            "code": "INPUT_CLIPPING",
            "level": "warning",
            "userMessage": "입력 파일에서 클리핑이 감지되었습니다 (피크 ≥ 0 dBFS). 마스터링 결과에 왜곡이 포함될 수 있습니다.",
            "devDetail": f"sample_peak_db={peak_db:.2f}",
        })

    return warns


# ── Public API ────────────────────────────────────────────────────────────────

def analyze_file(file_path: str) -> dict[str, Any]:
    """
    Full Stage-1 analysis.

    Returns a dict matching AudioAnalysisResult in shared-types, plus:
      - waveform: detailed per-channel waveform stats (or None)
      - aiDetection: AI artifact flags
      - warnings: list of Stage-2 preprocessing warnings
      - errors: list of non-fatal measurement failures
    """
    # ── Validate input ────────────────────────────────────────────────────
    if not os.path.exists(file_path):
        raise FFmpegError(
            f"파일을 찾을 수 없습니다: {os.path.basename(file_path)}",
        )
    if os.path.getsize(file_path) == 0:
        raise FFmpegError("파일 크기가 0입니다. 올바른 오디오 파일을 선택해주세요.")

    log("INFO", f"Analyzing: {file_path}")

    # ── ffprobe metadata ──────────────────────────────────────────────────
    probe = ffprobe_info(file_path)
    audio = parse_audio_stream(probe)
    fmt = probe.get("format", {})

    codec_name  = audio.get("codec_name", "unknown")
    sample_rate = int(audio.get("sample_rate", 44100))
    channels    = int(audio.get("channels", 2))
    duration    = float(fmt.get("duration") or audio.get("duration") or 0.0)
    size_bytes  = int(fmt.get("size") or os.path.getsize(file_path))
    bit_depth   = parse_bit_depth(audio)

    log("INFO", f"  codec={codec_name}, sr={sample_rate}, ch={channels}, "
                f"bits={bit_depth}, dur={duration:.2f}s")

    # ── Loudness via loudnorm pass-1 ──────────────────────────────────────
    # (true peak, integrated LUFS, LRA)
    pass1 = loudnorm_pass1(file_path)
    integrated_lufs = float(pass1.get("input_i", -99.0))
    true_peak_dbtp  = float(pass1.get("input_tp", 0.0))
    lra             = float(pass1.get("input_lra", 0.0))
    loudness_thresh = float(pass1.get("input_thresh", -33.0))

    log("INFO", f"  LUFS={integrated_lufs:.1f}, TP={true_peak_dbtp:.1f}, LRA={lra:.1f}")

    # ── Waveform analysis via soundfile/numpy ─────────────────────────────
    waveform = analyze_waveform(file_path)
    waveform_dict = waveform_stats_to_dict(waveform) if waveform is not None else None

    # ── AI artifact detection ──────────────────────────────────────────────
    ai_detection: dict[str, bool] = {
        "harshHighMid": False, "boomyLowEnd": False,
        "brickwallCompression": lra < _BRICKWALL_LRA,
        "stereoImbalance": waveform.lr_imbalance_detected if waveform else False,
        "intersampleRisk": true_peak_dbtp > _INTERSAMPLE_RISK_TP,
        "upsampleSuspected": False,
        "silenceAtStart": (waveform.silence_start_ms > 500) if waveform else False,
        "silenceAtEnd":   (waveform.silence_end_ms   > 500) if waveform else False,
    }

    if waveform is not None:
        try:
            import soundfile as sf
            import numpy as np
            raw_data, sf_sr = sf.read(file_path, always_2d=True, dtype="float32")
            fft_ai = _detect_ai_artifacts(raw_data, sf_sr, integrated_lufs, true_peak_dbtp, lra)
            ai_detection.update(fft_ai)
        except Exception as exc:
            log("WARN", f"FFT artifact detection skipped: {exc}")

    # ── Stage-2 preprocessing warnings ────────────────────────────────────
    peak_db = waveform.sample_peak_db if waveform else true_peak_dbtp
    dc_detected = waveform.dc_offset_detected if waveform else False
    stage2_warnings = _preprocessing_warnings(sample_rate, channels, peak_db, dc_detected)

    # Merge waveform-level warnings (silence, clipping, L/R imbalance)
    if waveform:
        for msg in waveform.warnings:
            stage2_warnings.append({
                "code": "WAVEFORM_DETAIL",
                "level": "warning",
                "userMessage": msg,
                "devDetail": "",
            })

    return {
        # ── File metadata ──────────────────────────────────────────────
        "fileInfo": {
            "path":        file_path,
            "name":        os.path.basename(file_path),
            "sizeBytes":   size_bytes,
            "durationSec": round(duration, 3),
            "sampleRate":  sample_rate,
            "bitDepth":    bit_depth,
            "channels":    channels,
            "format":      codec_name,
        },
        # ── Loudness (from loudnorm pass-1) ────────────────────────────
        "loudness": {
            "integratedLufs": round(integrated_lufs, 2),
            "truePeakDbtp":   round(true_peak_dbtp,  2),
            "lra":            round(lra, 2),
            "shortTermMax":   round(loudness_thresh, 2),
        },
        # ── Waveform (from soundfile/numpy) ────────────────────────────
        "waveform": waveform_dict,
        # ── AI artifact detection ──────────────────────────────────────
        "aiDetection": ai_detection,
        # ── Stage-2 warnings ────────────────────────────────────────────
        "warnings": stage2_warnings,
    }
