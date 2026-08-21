"""
DSP Decision Engine P0

Test-only implementation for advisory DSP recommendations.
NO actual DSP processing, NO production pipeline connection.

Phase: AI-MASTERING-DSP-DECISION-ENGINE-P0-1
"""

from .engine import DSPDecisionEngine, EngineResult, create_engine
from .constants import (
    DecisionState,
    Direction,
    Severity,
    MappingSource,
    ProcessorType,
    PROFILE_ORDER,
)
from .target_registry import get_target_registry, TargetRegistry, TargetStatistics
from .delta_engine import DeltaEngine, ProfileDelta, FeatureDelta
from .mapping_registry import get_mapping_registry, MappingRegistry, MappingRule
from .recommendation_engine import (
    RecommendationEngine,
    ProfileRecommendation,
    DSPRecommendation,
)
from .safety_clamp import get_safety_clamp, SafetyClamp

__all__ = [
    "DSPDecisionEngine",
    "EngineResult",
    "create_engine",
    "DecisionState",
    "Direction",
    "Severity",
    "MappingSource",
    "ProcessorType",
    "PROFILE_ORDER",
    "get_target_registry",
    "TargetRegistry",
    "TargetStatistics",
    "DeltaEngine",
    "ProfileDelta",
    "FeatureDelta",
    "get_mapping_registry",
    "MappingRegistry",
    "MappingRule",
    "RecommendationEngine",
    "ProfileRecommendation",
    "DSPRecommendation",
    "get_safety_clamp",
    "SafetyClamp",
]

__version__ = "0.1.0-poc"
