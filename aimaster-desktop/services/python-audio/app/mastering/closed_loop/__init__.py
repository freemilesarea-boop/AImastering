"""
Closed Loop Render Engine P0

Test-only implementation for DSP recommendation validation.
NO production pipeline connection.

Phase: AI-MASTERING-CLOSED-LOOP-RENDER-P0-1
"""

from .engine import ClosedLoopEngine, create_engine
from .constants import (
    RenderStatus,
    ValidationResult,
    RegressionSeverity,
    MAX_PASSES,
    MAX_RECOMMENDATIONS_PER_PASS,
)
from .schema import (
    ClosedLoopResult,
    PassResult,
    TranslatedParameter,
    SelectedRecommendation,
    MovementResult,
    RegressionResult,
    SafetyCheckResult,
    SafetyGateResult,
)
from .recommendation_selector import RecommendationSelector, SelectionResult
from .parameter_translator import ParameterTranslator, TranslationResult
from .render_executor import RenderExecutor, RenderResult
from .movement_validator import MovementValidator, MovementValidationResult
from .regression_detector import RegressionDetector, RegressionDetectionResult
from .safety_gate import SafetyGate
from .accept_reject import AcceptRejectEngine, AcceptRejectDecision
from .rollback import RollbackManager, RollbackState

__all__ = [
    "ClosedLoopEngine",
    "create_engine",
    "RenderStatus",
    "ValidationResult",
    "RegressionSeverity",
    "MAX_PASSES",
    "MAX_RECOMMENDATIONS_PER_PASS",
    "ClosedLoopResult",
    "PassResult",
    "TranslatedParameter",
    "SelectedRecommendation",
    "MovementResult",
    "RegressionResult",
    "SafetyCheckResult",
    "SafetyGateResult",
    "RecommendationSelector",
    "SelectionResult",
    "ParameterTranslator",
    "TranslationResult",
    "RenderExecutor",
    "RenderResult",
    "MovementValidator",
    "MovementValidationResult",
    "RegressionDetector",
    "RegressionDetectionResult",
    "SafetyGate",
    "AcceptRejectEngine",
    "AcceptRejectDecision",
    "RollbackManager",
    "RollbackState",
]

__version__ = "0.1.0-poc"
