"""
Closed Loop Calibration P1 Module

Calibrates DSP parameter mappings based on actual feature response measurements.

Phase: AI-MASTERING-CLOSED-LOOP-CALIBRATION-P1-1
"""

from .constants import (
    CalibrationStatus,
    MappingChangeType,
    MappingSourceCandidate,
    PARAMETER_SWEEPS,
    MIN_TRACKS_FOR_CURVE,
    MIN_TRACKS_FOR_PROMOTION,
    DIRECTION_CORRECTNESS_MIN_DERIVED,
    DIRECTION_CORRECTNESS_MIN_DESIGN,
    SAFETY_PASS_RATE_MIN,
    OVERSHOOT_RATE_MAX,
    REGRESSION_RATE_MAX,
    REPRODUCIBILITY_RUNS,
)
from .schema import (
    TrackInfo,
    SweepCandidate,
    FeatureResponse,
    CandidateResult,
    ResponseCurvePoint,
    ResponseCurve,
    MappingCalibrationResult,
    NoActionAuditResult,
    CalibrationReport,
)
from .dataset_builder import DatasetBuilder, DatasetSummary
from .sweep_registry import SweepRegistry
from .candidate_runner import CandidateRunner
from .response_analyzer import ResponseAnalyzer, ResponseAnalysis
from .curve_builder import CurveBuilder
from .mapping_calibrator import MappingCalibrator
from .no_action_auditor import NoActionAuditor
from .confidence import ConfidenceCalculator, CalibrationConfidence
from .engine import CalibrationEngine, create_calibration_engine


__all__ = [
    # Constants
    "CalibrationStatus",
    "MappingChangeType",
    "MappingSourceCandidate",
    "PARAMETER_SWEEPS",
    "MIN_TRACKS_FOR_CURVE",
    "MIN_TRACKS_FOR_PROMOTION",
    # Schema
    "TrackInfo",
    "SweepCandidate",
    "FeatureResponse",
    "CandidateResult",
    "ResponseCurvePoint",
    "ResponseCurve",
    "MappingCalibrationResult",
    "NoActionAuditResult",
    "CalibrationReport",
    # Components
    "DatasetBuilder",
    "DatasetSummary",
    "SweepRegistry",
    "CandidateRunner",
    "ResponseAnalyzer",
    "ResponseAnalysis",
    "CurveBuilder",
    "MappingCalibrator",
    "NoActionAuditor",
    "ConfidenceCalculator",
    "CalibrationConfidence",
    # Engine
    "CalibrationEngine",
    "create_calibration_engine",
]
