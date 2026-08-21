"""
Blend - Dry/Wet blending with RMS gain matching.

Design:
- Match processed RMS to dry before blending
- Ensure sample-aligned blending
- Support variable wet ratio
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Tuple

import numpy as np


# ============================================================================
# Constants
# ============================================================================

DEFAULT_WET_RATIOS = {
    "gentle": 0.25,    # 25% wet
    "balanced": 0.40,  # 40% wet
}


# ============================================================================
# RMS Matching
# ============================================================================

def compute_rms(audio: np.ndarray) -> float:
    """Compute RMS of audio signal."""
    return float(np.sqrt(np.mean(audio ** 2)))


def compute_rms_db(audio: np.ndarray) -> float:
    """Compute RMS in dB."""
    rms = compute_rms(audio)
    return float(20 * np.log10(max(rms, 1e-12)))


def match_rms(
    source: np.ndarray,
    target: np.ndarray,
    max_gain_db: float = 6.0,
) -> Tuple[np.ndarray, float]:
    """
    Match source RMS to target RMS.

    Args:
        source: Audio to adjust
        target: Target audio for RMS reference
        max_gain_db: Maximum gain adjustment allowed

    Returns:
        (adjusted_audio, gain_db_applied)
    """
    source_rms = compute_rms(source)
    target_rms = compute_rms(target)

    if source_rms < 1e-12:
        # Source is silent
        return source.copy(), 0.0

    # Calculate required gain
    gain_linear = target_rms / source_rms
    gain_db = 20 * np.log10(gain_linear)

    # Limit gain
    if abs(gain_db) > max_gain_db:
        gain_db = max_gain_db if gain_db > 0 else -max_gain_db
        gain_linear = 10 ** (gain_db / 20)

    return source * gain_linear, float(gain_db)


# ============================================================================
# Dry/Wet Blend
# ============================================================================

@dataclass
class BlendResult:
    """Result of dry/wet blending."""
    blended: np.ndarray
    wet_ratio: float
    dry_rms_db: float
    wet_rms_db_original: float
    wet_rms_db_matched: float
    gain_applied_db: float


def blend_dry_wet(
    dry: np.ndarray,
    wet: np.ndarray,
    wet_ratio: float,
    match_rms_enabled: bool = True,
    max_gain_db: float = 6.0,
) -> BlendResult:
    """
    Blend dry and wet signals.

    Args:
        dry: Original dry audio
        wet: Processed wet audio
        wet_ratio: Wet ratio (0.0 = all dry, 1.0 = all wet)
        match_rms_enabled: If True, match wet RMS to dry before blending
        max_gain_db: Maximum RMS matching gain

    Returns:
        BlendResult with blended audio and stats
    """
    # Validate inputs
    if dry.shape != wet.shape:
        raise ValueError(f"Shape mismatch: dry={dry.shape}, wet={wet.shape}")

    wet_ratio = float(np.clip(wet_ratio, 0.0, 1.0))
    dry_ratio = 1.0 - wet_ratio

    # Measure original RMS
    dry_rms_db = compute_rms_db(dry)
    wet_rms_db_original = compute_rms_db(wet)

    # RMS matching
    gain_applied_db = 0.0
    if match_rms_enabled and wet_ratio > 0:
        wet_matched, gain_applied_db = match_rms(wet, dry, max_gain_db)
        wet_rms_db_matched = compute_rms_db(wet_matched)
    else:
        wet_matched = wet
        wet_rms_db_matched = wet_rms_db_original

    # Blend
    blended = dry_ratio * dry + wet_ratio * wet_matched

    return BlendResult(
        blended=blended,
        wet_ratio=wet_ratio,
        dry_rms_db=dry_rms_db,
        wet_rms_db_original=wet_rms_db_original,
        wet_rms_db_matched=wet_rms_db_matched,
        gain_applied_db=gain_applied_db,
    )


def get_default_wet_ratio(strength: str) -> float:
    """Get default wet ratio for strength preset."""
    return DEFAULT_WET_RATIOS.get(strength, 0.25)


# ============================================================================
# Validation
# ============================================================================

def validate_blend_alignment(
    dry: np.ndarray,
    wet: np.ndarray,
    blended: np.ndarray,
) -> dict:
    """
    Validate blend result for sample alignment and channel preservation.

    Returns dict with validation results.
    """
    issues = []

    # Length check
    if dry.shape[0] != wet.shape[0]:
        issues.append(f"dry/wet length mismatch: {dry.shape[0]} vs {wet.shape[0]}")

    if dry.shape[0] != blended.shape[0]:
        issues.append(f"dry/blended length mismatch: {dry.shape[0]} vs {blended.shape[0]}")

    # Channel check
    dry_ch = dry.shape[1] if dry.ndim == 2 else 1
    wet_ch = wet.shape[1] if wet.ndim == 2 else 1
    blended_ch = blended.shape[1] if blended.ndim == 2 else 1

    if dry_ch != wet_ch:
        issues.append(f"dry/wet channel mismatch: {dry_ch} vs {wet_ch}")

    if dry_ch != blended_ch:
        issues.append(f"dry/blended channel mismatch: {dry_ch} vs {blended_ch}")

    # NaN/Inf check
    if np.any(np.isnan(blended)):
        issues.append("blended contains NaN")

    if np.any(np.isinf(blended)):
        issues.append("blended contains Inf")

    # Stereo correlation preservation (if stereo)
    dry_corr = None
    blended_corr = None
    if dry_ch == 2:
        if np.std(dry[:, 0]) > 1e-12 and np.std(dry[:, 1]) > 1e-12:
            dry_corr = float(np.corrcoef(dry[:, 0], dry[:, 1])[0, 1])
        if np.std(blended[:, 0]) > 1e-12 and np.std(blended[:, 1]) > 1e-12:
            blended_corr = float(np.corrcoef(blended[:, 0], blended[:, 1])[0, 1])

    return {
        "valid": len(issues) == 0,
        "issues": issues,
        "length_dry": dry.shape[0],
        "length_wet": wet.shape[0],
        "length_blended": blended.shape[0],
        "channels": dry_ch,
        "stereo_correlation_dry": dry_corr,
        "stereo_correlation_blended": blended_corr,
    }
