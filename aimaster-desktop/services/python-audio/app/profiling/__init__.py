"""
Reference profiling system (M1.75).

Extracts characteristic features (loudness, dynamics, tonal balance, stereo)
from audio buffers — strictly aggregate, no reconstruction-enabling data.

Reference docs:
  docs/redesign/loui-mastering-v2/m1.75/00-REFERENCE-PROFILING-OVERVIEW.md
  docs/redesign/loui-mastering-v2/m1.75/06-REFERENCE-SAFE-LEGAL-GUIDELINE.md
"""
from .schema import (
    ReferenceProfile,
    ReferenceProfileProvenance,
    ReferenceProfileFeatures,
    ReferenceProfileLoudness,
    ReferenceProfileDynamics,
    ReferenceProfileTonal,
    ReferenceProfileStereo,
    REFERENCE_PROFILE_SCHEMA_ID,
    EXTRACTOR_VERSION,
)
from .validate import validate_reference_profile, ProfileValidationError
from .extract import extract_profile, ExtractionOptions
from .compare import (
    compare_profiles,
    ProfileComparison,
    AxisDelta,
)
from .recommend import (
    recommend_preset,
    PresetRecommendation,
    derive_adaptive_overrides,
    AdaptiveOverrides,
)

__all__ = [
    "ReferenceProfile",
    "ReferenceProfileProvenance",
    "ReferenceProfileFeatures",
    "ReferenceProfileLoudness",
    "ReferenceProfileDynamics",
    "ReferenceProfileTonal",
    "ReferenceProfileStereo",
    "REFERENCE_PROFILE_SCHEMA_ID",
    "EXTRACTOR_VERSION",
    "validate_reference_profile",
    "ProfileValidationError",
    "extract_profile",
    "ExtractionOptions",
    "compare_profiles",
    "ProfileComparison",
    "AxisDelta",
    "recommend_preset",
    "PresetRecommendation",
    "derive_adaptive_overrides",
    "AdaptiveOverrides",
]
