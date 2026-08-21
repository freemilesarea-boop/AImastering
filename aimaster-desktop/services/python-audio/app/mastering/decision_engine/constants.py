"""
Constants and type definitions for DSP Decision Engine P0.

Test-only implementation - NO actual DSP processing.
"""

from enum import Enum
from typing import Dict, List


class DecisionState(str, Enum):
    """Decision state for each profile."""
    NO_ACTION = "NO_ACTION"           # Within target range, no adjustment needed
    RECOMMEND = "RECOMMEND"            # Feature/Threshold/Confidence sufficient
    CONDITIONAL = "CONDITIONAL"        # Possible conflict or safety concern
    BLOCKED = "BLOCKED"                # Safety or conflict rule blocks recommendation
    INSUFFICIENT_DATA = "INSUFFICIENT_DATA"  # Missing required features
    UNCALIBRATED = "UNCALIBRATED"      # Missing validated target or mapping
    CONFLICTED = "CONFLICTED"          # Opposing recommendations detected


class Direction(str, Enum):
    """Feature deviation direction."""
    TOO_LOW = "TOO_LOW"
    SLIGHTLY_LOW = "SLIGHTLY_LOW"
    IN_RANGE = "IN_RANGE"
    SLIGHTLY_HIGH = "SLIGHTLY_HIGH"
    TOO_HIGH = "TOO_HIGH"
    UNKNOWN = "UNKNOWN"


class Severity(str, Enum):
    """Deviation severity."""
    NONE = "NONE"
    LOW = "LOW"
    MEDIUM = "MEDIUM"
    HIGH = "HIGH"
    CRITICAL = "CRITICAL"


class MappingSource(str, Enum):
    """DSP mapping rule source classification."""
    DATA_DERIVED = "DATA_DERIVED"          # From commercial/AI dataset validation
    DESIGN_CANDIDATE = "DESIGN_CANDIDATE"  # Proposed but not validated
    HEURISTIC = "HEURISTIC"                # Industry standard / rule of thumb
    UNSUPPORTED = "UNSUPPORTED"            # No mapping available


# Confidence ceilings by mapping source
MAPPING_CONFIDENCE_CEILING: Dict[str, float] = {
    "DATA_DERIVED": 1.00,
    "DESIGN_CANDIDATE": 0.65,
    "HEURISTIC": 0.45,
    "UNSUPPORTED": 0.00,
}


# Recommendation confidence thresholds
CONFIDENCE_THRESHOLD_RECOMMEND = 0.75
CONFIDENCE_THRESHOLD_CONDITIONAL = 0.50
CONFIDENCE_THRESHOLD_WEAK = 0.01


class InterventionTier(str, Enum):
    """How far a measured deviation is allowed to travel toward real DSP.

    Deliberately separate from ``Direction``: Direction says *where* a value sits
    relative to the commercial percentiles and is a pure measurement, while the
    tier says *what we are permitted to do about it*. Keeping them apart is what
    lets a SLIGHTLY_* deviation stay SLIGHTLY_* while still being classified as
    non-correctable — no direction is ever re-labelled as a stronger one.
    """
    NONE = "NONE"            # In range, or nothing measurable — never correctable
    WATCH = "WATCH"          # Small deviation — report only, never correctable
    CANDIDATE = "CANDIDATE"  # Large deviation inside P5-P95 — correctable only with evidence
    ACT = "ACT"              # Outside P5-P95 — correctable only with evidence


# Tiers that are even allowed to ask for a correction. NONE/WATCH never are.
# Being in this set is necessary, never sufficient: the evidence gate applies on
# top of it, which is why ACT does not mean "apply automatically".
CORRECTABLE_INTERVENTION_TIERS = frozenset({
    InterventionTier.CANDIDATE.value,
    InterventionTier.ACT.value,
})


# Mapping sources whose provenance is strong enough to touch real audio.
# DESIGN_CANDIDATE and HEURISTIC may still produce advisory recommendations;
# they may not be rendered. Promotion into this set requires measured
# calibration evidence, not a code edit.
EVIDENCE_MAPPING_SOURCES = frozenset({MappingSource.DATA_DERIVED.value})


# Profile order (same as Audio Profile Engine)
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


# DSP Processor types
class ProcessorType(str, Enum):
    """DSP processor types."""
    EQ = "EQ"
    COMPRESSOR = "COMPRESSOR"
    LIMITER = "LIMITER"
    STEREO = "STEREO"
    TRANSIENT = "TRANSIENT"
    SATURATION = "SATURATION"
    INPUT_GAIN = "INPUT_GAIN"


# Profile to processor mapping (allowed processors per profile)
PROFILE_PROCESSORS: Dict[str, List[str]] = {
    "LOUDNESS": ["INPUT_GAIN", "LIMITER"],
    "PEAK_SAFETY": ["LIMITER", "INPUT_GAIN"],
    "DYNAMIC_RANGE": ["COMPRESSOR", "LIMITER", "TRANSIENT"],
    "LOW_END": ["EQ"],
    "WARMTH": ["EQ", "SATURATION"],
    "MID_CLARITY": ["EQ"],
    "PRESENCE": ["EQ"],
    "BRIGHTNESS": ["EQ", "SATURATION"],
    "STEREO_IMAGE": ["STEREO"],
    "TRANSIENT": ["TRANSIENT", "COMPRESSOR"],
    "TEXTURE": [],  # TEXTURE is analysis-only in P0
}
