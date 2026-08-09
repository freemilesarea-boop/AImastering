"""
Closed Loop Render Engine P0 - Constants

Test-only implementation for DSP recommendation validation.
NO production pipeline connection.

Phase: AI-MASTERING-CLOSED-LOOP-RENDER-P0-1
"""

from enum import Enum
from typing import Dict, List, Tuple

from app.mastering.decision_engine.constants import (
    CONFIDENCE_THRESHOLD_RECOMMEND,
    CORRECTABLE_INTERVENTION_TIERS,
    EVIDENCE_MAPPING_SOURCES,
)


class RenderStatus(Enum):
    """Closed loop render final status."""
    ACCEPTED = "ACCEPTED"
    PARTIALLY_ACCEPTED = "PARTIALLY_ACCEPTED"
    REJECTED = "REJECTED"
    BLOCKED = "BLOCKED"
    RENDER_FAILED = "RENDER_FAILED"
    INSUFFICIENT_DATA = "INSUFFICIENT_DATA"
    NO_ACTION = "NO_ACTION"


class ValidationResult(Enum):
    """Movement/safety validation result."""
    PASS = "PASS"
    FAIL = "FAIL"
    WARN = "WARN"
    SKIP = "SKIP"


class RegressionSeverity(Enum):
    """Collateral regression severity."""
    NONE = "NONE"
    LOW = "LOW"
    MEDIUM = "MEDIUM"
    HIGH = "HIGH"
    CRITICAL = "CRITICAL"


# Profile priority order for recommendation selection
PROFILE_PRIORITY_ORDER: List[str] = [
    "PEAK_SAFETY",
    "LOUDNESS",
    "DYNAMIC_RANGE",
    "LOW_END",
    "MID_CLARITY",
    "PRESENCE",
    "BRIGHTNESS",
    "TRANSIENT",
    "STEREO_IMAGE",
    "TEXTURE",
    "WARMTH",
]

# P0 Constraints
MAX_RECOMMENDATIONS_PER_PASS = 3
MAX_PASSES = 2

# Confidence thresholds
#
# The apply gate is DERIVED from the recommend gate rather than restated as a
# literal. Stating it twice is what let the two drift apart: the apply gate sat
# at 0.40 while the recommend gate was 0.75, so a mapping that could never reach
# RECOMMEND still reached real audio through CONDITIONAL. Deriving it makes that
# class of defect unrepresentable — the apply gate cannot be lowered without
# lowering the recommend gate it is defined from.
MIN_CONFIDENCE_FOR_APPLY = CONFIDENCE_THRESHOLD_RECOMMEND
MIN_CONFIDENCE_FOR_RECOMMEND = 0.60

# Tiers permitted to reach real audio. IN_RANGE (NONE) and small deviations
# (WATCH) are never correctable, regardless of anything downstream.
APPLICABLE_INTERVENTION_TIERS = CORRECTABLE_INTERVENTION_TIERS

# Mapping sources permitted to reach real audio. Advisory recommendations are
# still generated for the others; they are simply never rendered.
APPLY_REQUIRES_MAPPING_SOURCES = EVIDENCE_MAPPING_SOURCES

# Import-time invariant. Deliberately a raise and not an ``assert`` so that
# running under ``python -O`` cannot strip the one check that keeps an
# unvalidated correction away from a user's audio.
if MIN_CONFIDENCE_FOR_APPLY < CONFIDENCE_THRESHOLD_RECOMMEND:
    raise RuntimeError(
        "Apply gate is looser than the recommend gate: "
        f"MIN_CONFIDENCE_FOR_APPLY={MIN_CONFIDENCE_FOR_APPLY} < "
        f"CONFIDENCE_THRESHOLD_RECOMMEND={CONFIDENCE_THRESHOLD_RECOMMEND}. "
        "A recommendation that cannot be recommended must never be applied."
    )

# Safety thresholds
SAFETY_TRUE_PEAK_MAX_DBTP = -1.0
SAFETY_CLIPPING_MAX_SAMPLES = 0
SAFETY_LOUDNESS_JUMP_MAX_LU = 3.0
SAFETY_CORRELATION_MIN = -0.3  # Negative correlation warning
SAFETY_DURATION_DIFF_MAX_MS = 20
SAFETY_MONO_COMPATIBILITY_MIN = 0.5

# Movement validation thresholds
MOVEMENT_IMPROVEMENT_MIN_PERCENT = 5.0  # Minimum improvement to consider successful
OVERSHOOT_THRESHOLD_PERCENT = 150.0  # Overshoot if went past target by 50%

# Collateral regression thresholds
REGRESSION_LOW_THRESHOLD = 0.10  # 10% degradation
REGRESSION_MEDIUM_THRESHOLD = 0.25  # 25% degradation
REGRESSION_HIGH_THRESHOLD = 0.50  # 50% degradation
REGRESSION_CRITICAL_THRESHOLD = 1.0  # 100% degradation (doubled)

# Processor types supported in this P0
SUPPORTED_PROCESSORS = {
    "EQ",
    "COMPRESSOR",
    "LIMITER",
    "STEREO",
    "INPUT_GAIN",
}

# Profiles that are analysis-only (no DSP rendering)
ANALYSIS_ONLY_PROFILES = {
    "TEXTURE",
}

# Profile to feature mapping for movement validation
PROFILE_PRIMARY_FEATURES: Dict[str, List[str]] = {
    "LOUDNESS": ["input_i", "rms_db"],
    "PEAK_SAFETY": ["input_tp", "sample_peak_dbfs"],
    "DYNAMIC_RANGE": ["crest_factor_db", "input_lra"],
    "LOW_END": ["band_ratio_20-60Hz", "band_ratio_60-120Hz"],
    "WARMTH": ["band_ratio_250-500Hz"],
    "MID_CLARITY": ["band_ratio_500-1000Hz", "band_ratio_1-2kHz"],
    "PRESENCE": ["band_ratio_2-4kHz"],
    "BRIGHTNESS": ["spectral_centroid", "hf_ratio"],
    "STEREO_IMAGE": ["stereo_correlation", "stereo_width"],
    "TRANSIENT": ["spectral_flux_normalized_mean", "onset_density"],
    "TEXTURE": ["spectral_flatness_temporal_std"],
}

# Collateral check mapping: when applying profile X, check profiles Y
COLLATERAL_CHECK_MAP: Dict[str, List[str]] = {
    "LOUDNESS": ["PEAK_SAFETY", "DYNAMIC_RANGE"],
    "BRIGHTNESS": ["TEXTURE", "PEAK_SAFETY"],
    "LOW_END": ["PEAK_SAFETY", "STEREO_IMAGE"],
    "STEREO_IMAGE": ["STEREO_IMAGE"],  # Self-check for correlation
    "DYNAMIC_RANGE": ["LOUDNESS", "TRANSIENT"],
}

# Feature direction mapping (is higher value better?)
FEATURE_HIGHER_IS_BETTER: Dict[str, bool] = {
    "input_i": True,  # Higher LUFS = louder (up to target)
    "input_tp": False,  # Lower TP = safer
    "sample_peak_dbfs": False,  # Lower peak = more headroom
    "rms_db": True,  # Higher RMS = fuller
    "crest_factor_db": True,  # Higher = more dynamics
    "input_lra": True,  # Higher = more dynamics
    "spectral_centroid": True,  # Higher = brighter
    "hf_ratio": True,  # Higher = brighter
    "stereo_correlation": True,  # Higher = more mono-compatible
    "stereo_width": True,  # Higher = wider (up to safety limit)
    "mono_compatibility_score": True,  # Higher = safer
}
