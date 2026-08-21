"""
Audio Profile Engine P0

Test-only implementation for profile state calculation.
NO DSP processing, NO production pipeline connection.

Phase: AI-MASTERING-AUDIO-PROFILE-ENGINE-P0-1
"""

from .engine import AudioProfileEngine
from .profile_evaluator import ProfileEvaluator
from .conflict_engine import ConflictEngine
from .eligibility import EligibilityResolver
from .confidence import ConfidenceCalculator
from .constants import (
    ProfileState,
    Severity,
    DSPEligibility,
    ThresholdSource,
    ConfidenceGrade,
    ConflictSeverity,
)

__all__ = [
    "AudioProfileEngine",
    "ProfileEvaluator",
    "ConflictEngine",
    "EligibilityResolver",
    "ConfidenceCalculator",
    "ProfileState",
    "Severity",
    "DSPEligibility",
    "ThresholdSource",
    "ConfidenceGrade",
    "ConflictSeverity",
]

__version__ = "0.1.0-poc"
