"""
Safety Gate - Validation and Adaptive Retry support.

Design:
- Critical failures: immediate bypass (non-retryable)
- Retryable failures: can retry with reduced wet ratio
- Failure classification with codes
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import List, Optional, Tuple

import numpy as np


# ============================================================================
# Failure Classification
# ============================================================================

class FailureCategory(Enum):
    """Failure category for classification."""
    STRUCTURAL = "structural"  # Non-retryable
    PEAK = "peak"              # Retryable
    QUALITY = "quality"        # Retryable
    METRIC = "metric"          # Retryable


@dataclass(frozen=True)
class FailureCode:
    """Failure code definition."""
    code: str
    category: FailureCategory
    message: str
    retryable: bool


# Define all failure codes
FAILURE_CODES = {
    # Structural (non-retryable)
    "S1": FailureCode("S1", FailureCategory.STRUCTURAL, "Output contains NaN", False),
    "S2": FailureCode("S2", FailureCategory.STRUCTURAL, "Output contains Inf", False),
    "S3": FailureCode("S3", FailureCategory.STRUCTURAL, "Sample rate changed", False),
    "S4": FailureCode("S4", FailureCategory.STRUCTURAL, "Channel count changed", False),
    "S5": FailureCode("S5", FailureCategory.STRUCTURAL, "Output length differs", False),
    "S6": FailureCode("S6", FailureCategory.STRUCTURAL, "Output is silent", False),
    "S7": FailureCode("S7", FailureCategory.STRUCTURAL, "File generation failed", False),

    # Peak (retryable)
    "P1": FailureCode("P1", FailureCategory.PEAK, "True peak rose above threshold", True),
    "P2": FailureCode("P2", FailureCategory.PEAK, "Clipping introduced", True),

    # Quality (retryable)
    "Q1": FailureCode("Q1", FailureCategory.QUALITY, "HF energy dropped excessively", True),
    "Q2": FailureCode("Q2", FailureCategory.QUALITY, "Vocal band dropped excessively", True),
    "Q3": FailureCode("Q3", FailureCategory.QUALITY, "Transient loss detected", True),

    # Metric (retryable)
    "M1": FailureCode("M1", FailureCategory.METRIC, "LUFS/RMS change exceeded threshold", True),
    "M2": FailureCode("M2", FailureCategory.METRIC, "Stereo correlation changed excessively", True),
}


# ============================================================================
# Thresholds
# ============================================================================

@dataclass
class SafetyThresholds:
    """Thresholds for safety checks."""
    # Peak
    tp_rise_fail_dbtp: float = 0.1   # True peak rise > 0.1 dBTP = fail

    # Loudness
    lufs_warn: float = 0.5           # |ΔLUFS| > 0.5 = warning
    lufs_fail: float = 1.0           # |ΔLUFS| > 1.0 = fail
    rms_warn_db: float = 0.5
    rms_fail_db: float = 1.0

    # Stereo
    corr_warn: float = 0.10          # |Δcorrelation| > 0.10 = warning
    corr_fail: float = 0.20          # |Δcorrelation| > 0.20 = fail

    # Frequency bands
    hf_drop_warn: float = 0.35       # HF dropped > 35% = warning
    hf_drop_fail: float = 0.50       # HF dropped > 50% = fail
    vocal_drop_warn: float = 0.10    # 2-6kHz dropped > 10% = warning
    vocal_drop_fail: float = 0.20    # 2-6kHz dropped > 20% = fail

    # Silent threshold
    silent_rms_db: float = -90.0     # RMS < -90 dB = silent


DEFAULT_THRESHOLDS = SafetyThresholds()


# ============================================================================
# Safety Result
# ============================================================================

@dataclass
class SafetyFailure:
    """A single safety failure."""
    code: str
    message: str
    category: str
    retryable: bool
    value: Optional[float] = None
    threshold: Optional[float] = None


@dataclass
class SafetyResult:
    """Result of safety evaluation."""
    passed: bool
    failures: List[SafetyFailure] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)
    can_retry: bool = False
    metrics: dict = field(default_factory=dict)


# ============================================================================
# Safety Evaluation
# ============================================================================

def evaluate_safety(
    original: np.ndarray,
    processed: np.ndarray,
    original_sr: int,
    processed_sr: int,
    original_metrics: dict,
    processed_metrics: dict,
    thresholds: SafetyThresholds = None,
) -> SafetyResult:
    """
    Evaluate safety of processed audio.

    Args:
        original: Original audio array
        processed: Processed audio array
        original_sr: Original sample rate
        processed_sr: Processed sample rate
        original_metrics: Metrics for original audio
        processed_metrics: Metrics for processed audio
        thresholds: Safety thresholds

    Returns:
        SafetyResult with pass/fail status and details
    """
    if thresholds is None:
        thresholds = DEFAULT_THRESHOLDS

    failures = []
    warnings = []

    # ── Structural checks (non-retryable) ──

    # NaN check
    if np.any(np.isnan(processed)):
        failures.append(_make_failure("S1"))

    # Inf check
    if np.any(np.isinf(processed)):
        failures.append(_make_failure("S2"))

    # Sample rate
    if original_sr != processed_sr:
        failures.append(_make_failure("S3", value=processed_sr, threshold=original_sr))

    # Channels
    orig_ch = original.shape[1] if original.ndim == 2 else 1
    proc_ch = processed.shape[1] if processed.ndim == 2 else 1
    if orig_ch != proc_ch:
        failures.append(_make_failure("S4", value=proc_ch, threshold=orig_ch))

    # Length
    if original.shape[0] != processed.shape[0]:
        failures.append(_make_failure("S5", value=processed.shape[0], threshold=original.shape[0]))

    # Silent
    proc_rms_db = processed_metrics.get("rms_db", -120)
    if proc_rms_db <= thresholds.silent_rms_db:
        failures.append(_make_failure("S6", value=proc_rms_db, threshold=thresholds.silent_rms_db))

    # If we have structural failures, stop here
    if failures:
        return SafetyResult(
            passed=False,
            failures=failures,
            warnings=warnings,
            can_retry=False,
            metrics=_collect_metrics(original_metrics, processed_metrics),
        )

    # ── Peak checks (retryable) ──

    orig_tp = original_metrics.get("true_peak_dbtp")
    proc_tp = processed_metrics.get("true_peak_dbtp")

    if orig_tp is not None and proc_tp is not None:
        tp_rise = proc_tp - orig_tp
        if tp_rise > thresholds.tp_rise_fail_dbtp:
            failures.append(_make_failure("P1", value=tp_rise, threshold=thresholds.tp_rise_fail_dbtp))

    # Clipping
    orig_clipping = original_metrics.get("clipping", False)
    proc_clipping = processed_metrics.get("clipping", False)
    if proc_clipping and not orig_clipping:
        failures.append(_make_failure("P2"))

    # ── Quality checks (retryable) ──

    # HF energy
    orig_hf = original_metrics.get("hf_energy", 0)
    proc_hf = processed_metrics.get("hf_energy", 0)
    if orig_hf > 1e-10:
        hf_drop = (orig_hf - proc_hf) / orig_hf
        if hf_drop > thresholds.hf_drop_fail:
            failures.append(_make_failure("Q1", value=hf_drop, threshold=thresholds.hf_drop_fail))
        elif hf_drop > thresholds.hf_drop_warn:
            warnings.append(f"HF energy dropped {hf_drop*100:.1f}%")

    # Vocal band
    orig_vocal = original_metrics.get("vocal_energy", 0)
    proc_vocal = processed_metrics.get("vocal_energy", 0)
    if orig_vocal > 1e-10:
        vocal_drop = (orig_vocal - proc_vocal) / orig_vocal
        if vocal_drop > thresholds.vocal_drop_fail:
            failures.append(_make_failure("Q2", value=vocal_drop, threshold=thresholds.vocal_drop_fail))
        elif vocal_drop > thresholds.vocal_drop_warn:
            warnings.append(f"Vocal band energy dropped {vocal_drop*100:.1f}%")

    # ── Metric checks (retryable) ──

    # RMS
    orig_rms_db = original_metrics.get("rms_db", -60)
    proc_rms_db = processed_metrics.get("rms_db", -60)
    rms_delta = abs(proc_rms_db - orig_rms_db)
    if rms_delta > thresholds.rms_fail_db:
        failures.append(_make_failure("M1", value=rms_delta, threshold=thresholds.rms_fail_db))
    elif rms_delta > thresholds.rms_warn_db:
        warnings.append(f"RMS changed {rms_delta:.2f} dB")

    # Stereo correlation
    orig_corr = original_metrics.get("stereo_correlation")
    proc_corr = processed_metrics.get("stereo_correlation")
    if orig_corr is not None and proc_corr is not None:
        corr_delta = abs(proc_corr - orig_corr)
        if corr_delta > thresholds.corr_fail:
            failures.append(_make_failure("M2", value=corr_delta, threshold=thresholds.corr_fail))
        elif corr_delta > thresholds.corr_warn:
            warnings.append(f"Stereo correlation changed {corr_delta:.3f}")

    # Determine if can retry
    can_retry = all(f.retryable for f in failures)

    return SafetyResult(
        passed=len(failures) == 0,
        failures=failures,
        warnings=warnings,
        can_retry=can_retry,
        metrics=_collect_metrics(original_metrics, processed_metrics),
    )


def _make_failure(code: str, value: float = None, threshold: float = None) -> SafetyFailure:
    """Create SafetyFailure from code."""
    fc = FAILURE_CODES.get(code)
    if fc is None:
        return SafetyFailure(code, "Unknown failure", "unknown", False, value, threshold)
    return SafetyFailure(
        code=fc.code,
        message=fc.message,
        category=fc.category.value,
        retryable=fc.retryable,
        value=value,
        threshold=threshold,
    )


def _collect_metrics(original: dict, processed: dict) -> dict:
    """Collect delta metrics for reporting."""
    return {
        "original": original,
        "processed": processed,
        "delta": {
            "rms_db": (processed.get("rms_db", 0) - original.get("rms_db", 0)),
            "true_peak_dbtp": (
                (processed.get("true_peak_dbtp", 0) - original.get("true_peak_dbtp", 0))
                if processed.get("true_peak_dbtp") and original.get("true_peak_dbtp")
                else None
            ),
            "stereo_correlation": (
                (processed.get("stereo_correlation", 0) - original.get("stereo_correlation", 0))
                if processed.get("stereo_correlation") and original.get("stereo_correlation")
                else None
            ),
        },
    }


# ============================================================================
# Metrics Measurement
# ============================================================================

def measure_metrics(
    audio: np.ndarray,
    sample_rate: int,
    frequencies: np.ndarray = None,
) -> dict:
    """
    Measure audio metrics for safety evaluation.

    Args:
        audio: Audio array
        sample_rate: Sample rate
        frequencies: Frequency axis (for band energy, optional)

    Returns:
        Dict of metrics
    """
    # Make explicit copy to avoid any reference issues
    audio = np.asarray(audio, dtype=np.float64).copy()

    # Basic stats - measure peak FIRST before any operations
    peak = float(np.max(np.abs(audio)))
    peak_db = float(20 * np.log10(max(peak, 1e-12)))

    # RMS calculation
    rms = float(np.sqrt(np.mean(audio ** 2)))
    rms_db = float(20 * np.log10(max(rms, 1e-12)))
    clipping = bool(peak >= 0.9999)

    # Stereo correlation
    stereo_corr = None
    if audio.ndim == 2 and audio.shape[1] == 2:
        left_std = np.std(audio[:, 0])
        right_std = np.std(audio[:, 1])
        if left_std > 1e-12 and right_std > 1e-12:
            stereo_corr = float(np.corrcoef(audio[:, 0], audio[:, 1])[0, 1])

    # Finite check
    is_finite = bool(np.all(np.isfinite(audio)))

    return {
        "rms": rms,
        "rms_db": rms_db,
        "peak": peak,
        "peak_db": peak_db,
        "clipping": clipping,
        "stereo_correlation": stereo_corr,
        "is_finite": is_finite,
        "duration_samples": audio.shape[0],
        "channels": audio.shape[1] if audio.ndim == 2 else 1,
    }


# ============================================================================
# Adaptive Retry
# ============================================================================

@dataclass
class RetryConfig:
    """Configuration for adaptive retry."""
    max_attempts: int = 3
    wet_reduction_factor: float = 0.7  # Each retry: wet *= 0.7
    min_wet_ratio: float = 0.10        # Below this = bypass
    disable_reconstruction_on_retry: int = 2  # Disable recon after attempt 2


@dataclass
class RetryAttempt:
    """Record of a single retry attempt."""
    attempt: int
    wet_ratio: float
    reconstruction_enabled: bool
    safety_result: SafetyResult


@dataclass
class RetryHistory:
    """History of all retry attempts."""
    attempts: List[RetryAttempt] = field(default_factory=list)
    final_attempt: int = 0
    final_wet_ratio: float = 0.0
    bypassed: bool = False
    success: bool = False


def calculate_retry_params(
    attempt: int,
    initial_wet: float,
    config: RetryConfig,
) -> Tuple[float, bool]:
    """
    Calculate wet ratio and reconstruction setting for retry attempt.

    Args:
        attempt: Attempt number (1-based)
        initial_wet: Initial wet ratio
        config: Retry configuration

    Returns:
        (wet_ratio, reconstruction_enabled)
    """
    if attempt == 1:
        return initial_wet, True

    # Calculate reduced wet ratio
    wet_ratio = initial_wet
    for _ in range(1, attempt):
        wet_ratio *= config.wet_reduction_factor

    # Check minimum
    if wet_ratio < config.min_wet_ratio:
        wet_ratio = 0.0  # Will bypass

    # Reconstruction setting
    reconstruction_enabled = attempt < config.disable_reconstruction_on_retry

    return wet_ratio, reconstruction_enabled


def should_continue_retry(
    safety_result: SafetyResult,
    attempt: int,
    wet_ratio: float,
    config: RetryConfig,
) -> bool:
    """
    Determine if retry should continue.

    Args:
        safety_result: Result of current attempt
        attempt: Current attempt number
        wet_ratio: Current wet ratio
        config: Retry configuration

    Returns:
        True if should retry, False if should stop
    """
    # Passed: no need to retry
    if safety_result.passed:
        return False

    # Non-retryable failure
    if not safety_result.can_retry:
        return False

    # Max attempts reached
    if attempt >= config.max_attempts:
        return False

    # Wet ratio would go below minimum
    next_wet = wet_ratio * config.wet_reduction_factor
    if next_wet < config.min_wet_ratio:
        return False

    return True
