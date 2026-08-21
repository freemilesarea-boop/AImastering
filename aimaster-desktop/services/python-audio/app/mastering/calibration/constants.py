"""
Closed Loop Calibration P1 - Constants

Calibration-specific constants for DSP parameter sweep and response measurement.

Phase: AI-MASTERING-CLOSED-LOOP-CALIBRATION-P1-1
"""

from enum import Enum
from typing import Dict, List


class CalibrationStatus(Enum):
    """Status of a calibration candidate."""
    PENDING = "PENDING"
    RENDERED = "RENDERED"
    ANALYZED = "ANALYZED"
    PASSED = "PASSED"
    REJECTED = "REJECTED"
    SAFETY_FAILED = "SAFETY_FAILED"
    RENDER_FAILED = "RENDER_FAILED"


class MappingChangeType(Enum):
    """Type of mapping rule change."""
    UNCHANGED = "UNCHANGED"
    REDUCED = "REDUCED"
    INCREASED = "INCREASED"
    NARROWED = "NARROWED"
    BLOCKED = "BLOCKED"
    INSUFFICIENT_DATA = "INSUFFICIENT_DATA"


class MappingSourceCandidate(Enum):
    """Candidate source classification after calibration."""
    DATA_DERIVED_CANDIDATE = "DATA_DERIVED_CANDIDATE"  # Ready for listening test
    DESIGN_CANDIDATE = "DESIGN_CANDIDATE"  # Current status maintained
    HEURISTIC = "HEURISTIC"  # Not enough data to promote
    BLOCKED = "BLOCKED"  # Too many safety failures


# Minimum tracks for statistical validity
MIN_TRACKS_FOR_CURVE = 5
MIN_TRACKS_FOR_PROMOTION = 10

# Direction correctness thresholds for promotion
DIRECTION_CORRECTNESS_MIN_DESIGN = 0.60  # 60% for DESIGN_CANDIDATE maintenance
DIRECTION_CORRECTNESS_MIN_DERIVED = 0.80  # 80% for DATA_DERIVED_CANDIDATE

# Safety thresholds
SAFETY_PASS_RATE_MIN = 0.95  # 95% of candidates must pass safety
OVERSHOOT_RATE_MAX = 0.15  # Max 15% overshoot rate
REGRESSION_RATE_MAX = 0.20  # Max 20% collateral regression rate

# One-variable-at-a-time constraints
MAX_SIMULTANEOUS_PARAMS = 1

# Sweep limits
MAX_STEPS_PER_PARAM = 6
MAX_FREQUENCIES_PER_EQ = 3

# Reproducibility
REPRODUCIBILITY_RUNS = 3
REPRODUCIBILITY_TOLERANCE_FEATURE = 0.01  # 1% tolerance for feature values
REPRODUCIBILITY_TOLERANCE_DB = 0.1  # 0.1 dB tolerance for dB values


# Parameter sweep definitions (within safety clamp limits)
# Each entry: (parameter, processor, steps, unit, extra_params)
PARAMETER_SWEEPS: Dict[str, Dict] = {
    "high_shelf_gain_db": {
        "processor": "EQ",
        "steps": [-1.5, -1.0, -0.5, +0.5, +1.0, +1.5],
        "unit": "dB",
        "frequencies": [8000, 10000, 12000],
        "q": 0.7,
        "primary_profile": "BRIGHTNESS",
        "primary_features": ["spectral_centroid", "hf_ratio"],
    },
    "low_shelf_gain_db": {
        "processor": "EQ",
        "steps": [-1.5, -1.0, -0.5, +0.5, +1.0, +1.5],
        "unit": "dB",
        "frequencies": [60, 100, 150],
        "q": 0.7,
        "primary_profile": "LOW_END",
        "primary_features": ["band_ratio_20-60Hz", "band_ratio_60-120Hz"],
    },
    "gain_db": {
        "processor": "INPUT_GAIN",
        "steps": [-2.0, -1.0, +1.0, +2.0],
        "unit": "dB",
        "primary_profile": "LOUDNESS",
        "primary_features": ["input_i", "rms_db"],
    },
    "width": {
        "processor": "STEREO",
        "steps": [0.90, 0.95, 1.05, 1.10],
        "unit": "multiplier",
        "primary_profile": "STEREO_IMAGE",
        "primary_features": ["stereo_correlation", "ms_ratio_db"],
    },
    "bell_gain_db_warmth": {
        "processor": "EQ",
        "steps": [-1.5, -1.0, -0.5, +0.5, +1.0, +1.5],
        "unit": "dB",
        "frequencies": [350],
        "q": 1.2,
        "primary_profile": "WARMTH",
        "primary_features": ["spectral_contrast_band_1"],
    },
    "bell_gain_db_presence": {
        "processor": "EQ",
        "steps": [-1.5, -1.0, -0.5, +0.5, +1.0, +1.5],
        "unit": "dB",
        "frequencies": [3000],
        "q": 1.0,
        "primary_profile": "PRESENCE",
        "primary_features": ["spectral_contrast_band_4"],
    },
}


# Collateral features to check for each primary profile
COLLATERAL_FEATURES: Dict[str, List[str]] = {
    "BRIGHTNESS": ["input_tp", "stereo_correlation"],
    "LOW_END": ["input_tp", "stereo_correlation", "crest_factor_db"],
    "WARMTH": ["input_tp", "spectral_centroid"],
    "PRESENCE": ["input_tp", "spectral_centroid"],
    "LOUDNESS": ["input_tp", "crest_factor_db"],
    "STEREO_IMAGE": ["input_tp", "stereo_correlation", "mono_compatibility_score"],
}


# Profile feature mapping for No-Action audit
NO_ACTION_AUDIT_FEATURES: Dict[str, List[str]] = {
    "BRIGHTNESS": ["spectral_centroid", "hf_ratio"],
    "LOW_END": ["band_ratio_20-60Hz", "band_ratio_60-120Hz"],
    "WARMTH": ["spectral_contrast_band_1"],
    "PRESENCE": ["spectral_contrast_band_4"],
    "DYNAMIC_RANGE": ["crest_factor_db", "input_lra"],
    "STEREO_IMAGE": ["stereo_correlation", "ms_ratio_db"],
    "TEXTURE": ["spectral_flatness_temporal_std"],
}
