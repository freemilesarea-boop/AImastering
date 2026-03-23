"""Audio file analysis — loudness stats + AI artifact detection."""
from __future__ import annotations
import os
from typing import Any

import numpy as np

from app.utils.ffmpeg_wrapper import ffprobe_info, loudnorm_pass1
from app.utils.logger import log

try:
    import soundfile as sf
    HAS_SF = True
except ImportError:
    HAS_SF = False


# ── helpers ───────────────────────────────────────────────────────────────────

def _fft_energy_ratio(data: np.ndarray, sr: int, lo: float, hi: float) -> float:
    mono = data.mean(axis=0) if data.ndim > 1 else data
    spectrum = np.abs(np.fft.rfft(mono))
    freqs = np.fft.rfftfreq(len(mono), d=1.0 / sr)
    total = spectrum.sum() + 1e-12
    band = spectrum[(freqs >= lo) & (freqs <= hi)].sum()
    return float(band / total)


def _detect_silence_edges(data: np.ndarray, sr: int, threshold_db: float = -60.0) -> tuple[float, float]:
    mono = np.abs(data.mean(axis=0) if data.ndim > 1 else data)
    threshold = 10 ** (threshold_db / 20)
    nonsilent = np.where(mono > threshold)[0]
    if len(nonsilent) == 0:
        return float(len(mono) / sr * 1000), float(len(mono) / sr * 1000)
    start_ms = float(nonsilent[0] / sr * 1000)
    end_ms = float((len(mono) - nonsilent[-1]) / sr * 1000)
    return start_ms, end_ms


def _detect_ai_artifacts(data: np.ndarray, sr: int, lra: float, lufs: float) -> dict[str, bool]:
    harsh = _fft_energy_ratio(data, sr, 3000, 5000) > 0.28
    boomy = _fft_energy_ratio(data, sr, 60, 200) > 0.45
    brickwall = lra < 2.5
    # stereo imbalance
    if data.ndim >= 2 and data.shape[0] == 2:
        rms_l = float(np.sqrt(np.mean(data[0] ** 2)) + 1e-12)
        rms_r = float(np.sqrt(np.mean(data[1] ** 2)) + 1e-12)
        diff_db = abs(20 * np.log10(rms_l / rms_r))
        stereo_imbalance = diff_db > 3.0
    else:
        stereo_imbalance = False
    # Nyquist upsample heuristic (energy above 90% of Nyquist is suspiciously low)
    nyquist = sr / 2
    high_ratio = _fft_energy_ratio(data, sr, nyquist * 0.9, nyquist)
    upsample = high_ratio < 0.001
    return {
        "harshHighMid": harsh,
        "boomyLowEnd": boomy,
        "brickwallCompression": brickwall,
        "stereoImbalance": stereo_imbalance,
        "silenceAtStart": False,   # filled below
        "silenceAtEnd": False,     # filled below
        "intersampleRisk": False,  # filled below
        "upsampleSuspected": upsample,
    }


def _measure_dc_offset(data: np.ndarray) -> float:
    mono = data.mean(axis=0) if data.ndim > 1 else data
    dc = float(np.mean(mono))
    return float(20 * np.log10(abs(dc) + 1e-12))


# ── public API ────────────────────────────────────────────────────────────────

def analyze_file(file_path: str) -> dict[str, Any]:
    if not os.path.exists(file_path):
        raise FileNotFoundError(f"File not found: {file_path}")

    probe = ffprobe_info(file_path)
    audio_stream = next((s for s in probe["streams"] if s["codec_type"] == "audio"), {})
    fmt = probe.get("format", {})

    sample_rate = int(audio_stream.get("sample_rate", 44100))
    channels = int(audio_stream.get("channels", 2))
    duration = float(fmt.get("duration", 0))
    size_bytes = int(fmt.get("size", os.path.getsize(file_path)))
    codec = audio_stream.get("codec_name", "unknown")
    bit_depth = int(audio_stream.get("bits_per_raw_sample", 0) or
                    audio_stream.get("bits_per_sample", 16) or 16)

    pass1 = loudnorm_pass1(file_path)
    lufs = float(pass1.get("input_i", -23))
    tp = float(pass1.get("input_tp", 0))
    lra = float(pass1.get("input_lra", 0))
    thresh = float(pass1.get("input_thresh", -33))

    ai = {"harshHighMid": False, "boomyLowEnd": False, "brickwallCompression": lra < 2.5,
          "stereoImbalance": False, "silenceAtStart": False, "silenceAtEnd": False,
          "intersampleRisk": tp > -0.5, "upsampleSuspected": False}
    dc_db = -120.0
    silence_start_ms = 0.0
    silence_end_ms = 0.0

    if HAS_SF:
        try:
            raw, sr = sf.read(file_path, always_2d=True, dtype="float32")
            data = raw.T  # shape: (channels, samples)
            ai = _detect_ai_artifacts(data, sr, lra, lufs)
            silence_start_ms, silence_end_ms = _detect_silence_edges(data, sr)
            ai["silenceAtStart"] = silence_start_ms > 500
            ai["silenceAtEnd"] = silence_end_ms > 500
            ai["intersampleRisk"] = tp > -0.5
            dc_db = _measure_dc_offset(data)
        except Exception as exc:
            log("WARN", f"soundfile analysis failed: {exc}")

    return {
        "fileInfo": {
            "path": file_path,
            "name": os.path.basename(file_path),
            "sizeBytes": size_bytes,
            "durationSec": duration,
            "sampleRate": sample_rate,
            "bitDepth": bit_depth,
            "channels": channels,
            "format": codec,
        },
        "loudness": {
            "integratedLufs": lufs,
            "truePeakDbtp": tp,
            "lra": lra,
            "shortTermMax": thresh,
        },
        "aiDetection": ai,
        "dcOffsetDb": dc_db,
        "silenceStartMs": silence_start_ms,
        "silenceEndMs": silence_end_ms,
    }
