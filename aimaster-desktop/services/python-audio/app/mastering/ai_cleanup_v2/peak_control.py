"""
Peak Control - True Peak measurement and global gain correction.

P0 implementation uses GLOBAL gain reduction only.
NO dynamic limiting or soft-knee limiter.

If processed True Peak exceeds original, the entire signal
is reduced by a fixed gain to match.

True Peak measurement uses FFmpeg loudnorm (existing wrapper).
"""
from __future__ import annotations

import os
import subprocess
import tempfile
from dataclasses import dataclass
from typing import Optional, Tuple

import numpy as np

try:
    import soundfile as sf
    _HAS_SF = True
except ImportError:
    _HAS_SF = False


# ============================================================================
# Constants
# ============================================================================

DEFAULT_MARGIN_DB = 0.1  # Target True Peak <= original - 0.1 dB


# ============================================================================
# True Peak Measurement
# ============================================================================

def _resolve_ffmpeg() -> str:
    """Get FFmpeg binary path."""
    return os.environ.get("AIMASTER_FFMPEG", "ffmpeg")


def measure_true_peak_ffmpeg(
    audio_path: str,
    ffmpeg_path: Optional[str] = None,
) -> Optional[float]:
    """
    Measure True Peak using FFmpeg loudnorm pass 1.

    Args:
        audio_path: Path to audio file
        ffmpeg_path: FFmpeg binary path (default: from env or PATH)

    Returns:
        True Peak in dBTP, or None if measurement fails
    """
    ffmpeg = ffmpeg_path or _resolve_ffmpeg()

    try:
        proc = subprocess.run(
            [ffmpeg, "-hide_banner", "-i", audio_path,
             "-af", "loudnorm=print_format=json",
             "-f", "null", "-"],
            capture_output=True, text=True, encoding="utf-8",
            errors="replace", timeout=60,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None

    # Parse JSON from stderr
    import json
    output = proc.stderr or ""

    # Find JSON block
    try:
        # loudnorm outputs JSON at the end
        json_start = output.rfind("{")
        json_end = output.rfind("}") + 1
        if json_start >= 0 and json_end > json_start:
            json_str = output[json_start:json_end]
            data = json.loads(json_str)
            tp = data.get("input_tp")
            if tp is not None:
                return float(tp)
    except (json.JSONDecodeError, ValueError):
        pass

    return None


def measure_true_peak_numpy(
    audio: np.ndarray,
    sample_rate: int,
    oversample_factor: int = 4,
) -> float:
    """
    Estimate True Peak using simple oversampling (NumPy only).

    This is a simplified approximation. For accurate True Peak,
    use FFmpeg loudnorm.

    Args:
        audio: Audio array
        sample_rate: Sample rate
        oversample_factor: Oversampling factor (default 4x)

    Returns:
        Estimated True Peak in dBTP
    """
    if audio.ndim == 2:
        # Process both channels
        peaks = []
        for ch in range(audio.shape[1]):
            peaks.append(_estimate_true_peak_1d(audio[:, ch], oversample_factor))
        peak = max(peaks)
    else:
        peak = _estimate_true_peak_1d(audio, oversample_factor)

    return float(20 * np.log10(max(peak, 1e-12)))


def _estimate_true_peak_1d(
    signal: np.ndarray,
    oversample_factor: int,
) -> float:
    """
    Estimate true peak via linear interpolation oversampling.

    This is a simple approximation, not ITU-R BS.1770 compliant.
    """
    if len(signal) < 2:
        return float(np.max(np.abs(signal))) if len(signal) > 0 else 0.0

    # Simple linear interpolation oversampling
    n = len(signal)
    n_out = n * oversample_factor

    # Create interpolated signal
    x_orig = np.arange(n)
    x_new = np.linspace(0, n - 1, n_out)

    # NumPy linear interpolation
    oversampled = np.interp(x_new, x_orig, signal)

    return float(np.max(np.abs(oversampled)))


# ============================================================================
# Peak Control
# ============================================================================

@dataclass
class PeakControlResult:
    """Result of peak control."""
    audio: np.ndarray
    original_peak_dbtp: float
    processed_peak_dbtp: float
    corrected_peak_dbtp: float
    gain_applied_db: float
    clipping_introduced: bool
    measurement_method: str


def apply_peak_control(
    audio: np.ndarray,
    original_peak_dbtp: float,
    sample_rate: int,
    margin_db: float = DEFAULT_MARGIN_DB,
    temp_dir: Optional[str] = None,
) -> PeakControlResult:
    """
    Apply global gain reduction if True Peak exceeds original.

    Args:
        audio: Processed audio array
        original_peak_dbtp: Original True Peak in dBTP
        sample_rate: Sample rate
        margin_db: Target margin below original peak
        temp_dir: Directory for temp files (for FFmpeg measurement)

    Returns:
        PeakControlResult with corrected audio and stats
    """
    # First, measure processed True Peak
    processed_peak_dbtp = None
    measurement_method = "numpy"

    # Try FFmpeg measurement if soundfile is available
    if _HAS_SF and temp_dir:
        try:
            with tempfile.NamedTemporaryFile(
                suffix=".wav", dir=temp_dir, delete=False
            ) as f:
                temp_path = f.name

            sf.write(temp_path, audio.astype(np.float32), sample_rate)
            processed_peak_dbtp = measure_true_peak_ffmpeg(temp_path)

            if processed_peak_dbtp is not None:
                measurement_method = "ffmpeg"

            os.unlink(temp_path)
        except Exception:
            pass

    # Fallback to NumPy estimation
    if processed_peak_dbtp is None:
        processed_peak_dbtp = measure_true_peak_numpy(audio, sample_rate)

    # Calculate required gain reduction
    target_peak_dbtp = original_peak_dbtp - margin_db
    peak_excess_db = processed_peak_dbtp - target_peak_dbtp

    gain_applied_db = 0.0
    corrected = audio.copy()

    if peak_excess_db > 0:
        # Need to reduce
        gain_applied_db = -peak_excess_db
        gain_linear = 10 ** (gain_applied_db / 20)
        corrected = audio * gain_linear

    # Check for clipping
    clipping_introduced = bool(np.any(np.abs(corrected) > 1.0))

    # Measure corrected peak
    corrected_peak_dbtp = processed_peak_dbtp + gain_applied_db

    return PeakControlResult(
        audio=corrected,
        original_peak_dbtp=original_peak_dbtp,
        processed_peak_dbtp=processed_peak_dbtp,
        corrected_peak_dbtp=corrected_peak_dbtp,
        gain_applied_db=gain_applied_db,
        clipping_introduced=clipping_introduced,
        measurement_method=measurement_method,
    )


def measure_peak_stats(
    audio: np.ndarray,
    sample_rate: int,
    temp_path: Optional[str] = None,
) -> dict:
    """
    Measure peak statistics for audio.

    Returns dict with sample peak and true peak (if FFmpeg available).
    """
    # Sample peak
    sample_peak = float(np.max(np.abs(audio)))
    sample_peak_db = float(20 * np.log10(max(sample_peak, 1e-12)))

    # True peak via NumPy estimation
    true_peak_dbtp_numpy = measure_true_peak_numpy(audio, sample_rate)

    # True peak via FFmpeg if temp path provided
    true_peak_dbtp_ffmpeg = None
    if temp_path and _HAS_SF:
        try:
            sf.write(temp_path, audio.astype(np.float32), sample_rate)
            true_peak_dbtp_ffmpeg = measure_true_peak_ffmpeg(temp_path)
        except Exception:
            pass

    return {
        "sample_peak": sample_peak,
        "sample_peak_db": sample_peak_db,
        "true_peak_dbtp_numpy": true_peak_dbtp_numpy,
        "true_peak_dbtp_ffmpeg": true_peak_dbtp_ffmpeg,
        "clipping": bool(sample_peak >= 1.0),
    }


def check_clipping(audio: np.ndarray, threshold: float = 0.9999) -> dict:
    """
    Check for clipping in audio.

    Returns dict with clipping statistics.
    """
    abs_audio = np.abs(audio)
    clipped_samples = np.sum(abs_audio >= threshold)
    max_value = float(np.max(abs_audio))

    return {
        "clipping_detected": bool(clipped_samples > 0),
        "clipped_samples": int(clipped_samples),
        "clipping_ratio": float(clipped_samples / max(audio.size, 1)),
        "max_sample_value": max_value,
        "max_sample_db": float(20 * np.log10(max(max_value, 1e-12))),
    }
