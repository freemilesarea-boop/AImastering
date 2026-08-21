"""
Constants and type definitions for Audio Profile Engine P0.
"""

from enum import Enum
from typing import Dict, List, Set


class ProfileState(str, Enum):
    """Profile state values."""
    # Core states
    BALANCED = "BALANCED"

    # Directional states
    LOUD = "LOUD"
    QUIET = "QUIET"
    DYNAMIC = "DYNAMIC"
    COMPRESSED = "COMPRESSED"
    BRIGHT = "BRIGHT"
    DARK = "DARK"
    WARM = "WARM"
    THIN = "THIN"
    HEAVY = "HEAVY"
    LIGHT = "LIGHT"
    PRESENT = "PRESENT"
    RECESSED = "RECESSED"
    WIDE = "WIDE"
    NARROW = "NARROW"
    PUNCHY = "PUNCHY"
    FLAT = "FLAT"

    # Risk states
    CLIPPING_RISK = "CLIPPING_RISK"
    OVER_COMPRESSED = "OVER_COMPRESSED"
    PHASE_RISK = "PHASE_RISK"

    # Texture-specific states
    CLEAN = "CLEAN"
    TEXTURED = "TEXTURED"
    GRAINY_RISK = "GRAINY_RISK"
    INSTABILITY_RISK = "INSTABILITY_RISK"

    # Data quality states
    UNCALIBRATED = "UNCALIBRATED"
    INSUFFICIENT_DATA = "INSUFFICIENT_DATA"
    PARTIAL = "PARTIAL"


class Severity(str, Enum):
    """Severity levels for profile deviations."""
    NONE = "NONE"
    LOW = "LOW"
    MEDIUM = "MEDIUM"
    HIGH = "HIGH"
    CRITICAL = "CRITICAL"


class ConfidenceGrade(str, Enum):
    """Confidence grade classifications."""
    HIGH = "HIGH"        # >= 0.80
    MEDIUM = "MEDIUM"    # 0.60 - 0.79
    LOW = "LOW"          # 0.40 - 0.59
    VERY_LOW = "VERY_LOW"  # < 0.40


class DSPEligibility(str, Enum):
    """DSP eligibility states."""
    ELIGIBLE = "ELIGIBLE"
    CONDITIONAL = "CONDITIONAL"
    MONITOR_ONLY = "MONITOR_ONLY"
    BLOCKED = "BLOCKED"
    NOT_APPLICABLE = "N/A"


class ConflictSeverity(str, Enum):
    """Conflict rule severity."""
    WARN = "WARN"
    CONDITIONAL = "CONDITIONAL"
    BLOCK = "BLOCK"


class ThresholdSource(str, Enum):
    """Threshold data source classification."""
    DATA_DERIVED = "DATA_DERIVED"      # From actual commercial data
    DESIGN_CANDIDATE = "DESIGN_CANDIDATE"  # Proposed but unvalidated
    HEURISTIC = "HEURISTIC"            # Industry standard / rule of thumb
    UNKNOWN = "UNKNOWN"                 # Source unclear


# Profile IDs in processing order
PROFILE_ORDER: List[str] = [
    "LOUDNESS",
    "PEAK_SAFETY",
    "DYNAMIC_RANGE",
    "LOW_END",
    "WARMTH",
    "MID_CLARITY",
    "PRESENCE",
    "BRIGHTNESS",
    "STEREO_IMAGE",
    "TRANSIENT",
    "TEXTURE",
]

# Feature confidence from Canonical Audit
FEATURE_CONFIDENCE: Dict[str, float] = {
    "input_i": 0.95,
    "input_tp": 0.95,
    "input_lra": 0.95,
    "rms_db": 0.90,
    "peak_db": 0.90,
    "crest_factor_db": 0.95,
    "rms_std": 0.80,
    "crest_factor_variance": 0.85,
    "compression_density": 0.80,
    "envelope_smoothness": 0.75,
    "spectral_centroid": 0.95,
    "spectral_flatness": 0.80,
    "spectral_rolloff": 0.80,
    "spectral_contrast_band_0": 0.85,
    "spectral_contrast_band_1": 0.85,
    "spectral_contrast_band_2": 0.85,
    "spectral_contrast_band_3": 0.85,
    "spectral_contrast_band_4": 0.95,
    "spectral_contrast_band_5": 0.85,
    "spectral_contrast_mean": 0.75,
    "spectral_flux_normalized_mean": 0.80,
    "spectral_flux_normalized_std": 0.80,
    "hf_ratio": 0.85,
    "hf_ratio_variance": 0.75,
    "band_ratio_20-60Hz": 0.90,
    "band_ratio_60-120Hz": 0.90,
    "band_ratio_120-250Hz": 0.90,
    "band_ratio_250-500Hz": 0.90,
    "band_ratio_500-1000Hz": 0.90,
    "band_ratio_1-2kHz": 0.90,
    "band_ratio_2-4kHz": 0.95,
    "band_ratio_4-6kHz": 0.90,
    "band_ratio_6-8kHz": 0.90,
    "band_ratio_8-10kHz": 0.85,
    "band_ratio_10-12kHz": 0.85,
    "band_ratio_12-16kHz": 0.80,
    "stereo_width": 0.90,
    "stereo_correlation": 0.95,
    "ms_ratio_db": 0.90,
    "lr_balance_db": 0.85,
    "envelope_std_normalized": 0.80,
    "envelope_range_normalized": 0.80,
    "onset_density": 0.75,
    "spectral_flatness_temporal_std": 0.80,
    "broadband_flatness": 0.75,
}

# Confidence ceilings based on feature type
CONFIDENCE_CEILING_STANDARD = 0.95
CONFIDENCE_CEILING_REVIEW = 0.80
CONFIDENCE_CEILING_EXPERIMENTAL = 0.60
CONFIDENCE_CEILING_UNCALIBRATED = 0.39

# Eligibility confidence thresholds
ELIGIBILITY_THRESHOLD_ELIGIBLE = 0.80
ELIGIBILITY_THRESHOLD_CONDITIONAL = 0.60
ELIGIBILITY_THRESHOLD_MONITOR = 0.40
