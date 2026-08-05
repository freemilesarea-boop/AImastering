"""
Closed Loop Render Engine P0 - Schema

Data classes for closed loop render validation.

Phase: AI-MASTERING-CLOSED-LOOP-RENDER-P0-1
"""

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional
from .constants import RenderStatus, ValidationResult, RegressionSeverity


@dataclass
class TranslatedParameter:
    """Translated DSP parameter ready for FFmpeg."""
    processor: str
    parameter: str
    value: float
    unit: str
    ffmpeg_filter: str
    source_recommendation_id: str
    frequency_hz: Optional[int] = None
    q: Optional[float] = None
    was_clamped: bool = False
    original_value: Optional[float] = None

    def to_dict(self) -> Dict:
        result = {
            "processor": self.processor,
            "parameter": self.parameter,
            "value": round(self.value, 4),
            "unit": self.unit,
            "ffmpeg_filter": self.ffmpeg_filter,
            "source_recommendation_id": self.source_recommendation_id,
            "was_clamped": self.was_clamped,
        }
        if self.frequency_hz is not None:
            result["frequency_hz"] = self.frequency_hz
        if self.q is not None:
            result["q"] = round(self.q, 2)
        if self.original_value is not None:
            result["original_value"] = round(self.original_value, 4)
        return result


@dataclass
class SelectedRecommendation:
    """A recommendation selected for application."""
    profile: str
    recommendation_id: str
    processor: str
    parameter: str
    suggested_value: float
    confidence: float
    priority: int
    reason: str
    translated: Optional[TranslatedParameter] = None

    def to_dict(self) -> Dict:
        return {
            "profile": self.profile,
            "recommendation_id": self.recommendation_id,
            "processor": self.processor,
            "parameter": self.parameter,
            "suggested_value": round(self.suggested_value, 4),
            "confidence": round(self.confidence, 3),
            "priority": self.priority,
            "reason": self.reason,
            "translated": self.translated.to_dict() if self.translated else None,
        }


@dataclass
class MovementResult:
    """Result of target movement validation."""
    profile: str
    feature: str
    before_value: float
    after_value: float
    target_median: float
    target_p25: float
    target_p75: float
    before_distance: float
    after_distance: float
    direction_correct: bool
    improvement_amount: float
    improvement_percent: float
    overshoot: bool
    validation_result: ValidationResult
    notes: str = ""

    def to_dict(self) -> Dict:
        return {
            "profile": self.profile,
            "feature": self.feature,
            "before_value": round(self.before_value, 4),
            "after_value": round(self.after_value, 4),
            "target_median": round(self.target_median, 4),
            "target_p25": round(self.target_p25, 4),
            "target_p75": round(self.target_p75, 4),
            "before_distance": round(self.before_distance, 4),
            "after_distance": round(self.after_distance, 4),
            "direction_correct": self.direction_correct,
            "improvement_amount": round(self.improvement_amount, 4),
            "improvement_percent": round(self.improvement_percent, 2),
            "overshoot": self.overshoot,
            "validation_result": self.validation_result.value,
            "notes": self.notes,
        }


@dataclass
class RegressionResult:
    """Result of collateral regression check."""
    source_profile: str  # Profile that was modified
    affected_profile: str  # Profile that may have regressed
    feature: str
    before_value: float
    after_value: float
    target_median: float
    before_distance: float
    after_distance: float
    regression_amount: float
    regression_percent: float
    severity: RegressionSeverity
    is_blocking: bool
    notes: str = ""

    def to_dict(self) -> Dict:
        return {
            "source_profile": self.source_profile,
            "affected_profile": self.affected_profile,
            "feature": self.feature,
            "before_value": round(self.before_value, 4),
            "after_value": round(self.after_value, 4),
            "target_median": round(self.target_median, 4),
            "before_distance": round(self.before_distance, 4),
            "after_distance": round(self.after_distance, 4),
            "regression_amount": round(self.regression_amount, 4),
            "regression_percent": round(self.regression_percent, 2),
            "severity": self.severity.value,
            "is_blocking": self.is_blocking,
            "notes": self.notes,
        }


@dataclass
class SafetyCheckResult:
    """Result of a single safety check."""
    check_name: str
    passed: bool
    measured_value: float
    threshold: float
    unit: str
    severity: str  # "critical", "warning", "info"
    message: str

    def to_dict(self) -> Dict:
        return {
            "check_name": self.check_name,
            "passed": self.passed,
            "measured_value": round(self.measured_value, 4),
            "threshold": round(self.threshold, 4),
            "unit": self.unit,
            "severity": self.severity,
            "message": self.message,
        }


@dataclass
class SafetyGateResult:
    """Complete safety gate validation result."""
    passed: bool
    checks: List[SafetyCheckResult]
    critical_failures: int
    warning_count: int
    failure_codes: List[str]

    def to_dict(self) -> Dict:
        return {
            "passed": self.passed,
            "checks": [c.to_dict() for c in self.checks],
            "critical_failures": self.critical_failures,
            "warning_count": self.warning_count,
            "failure_codes": self.failure_codes,
        }


@dataclass
class PassResult:
    """Result of a single render pass."""
    pass_number: int
    applied_recommendations: List[SelectedRecommendation]
    filter_chain: str
    candidate_path: str
    before_features: Dict[str, Any]
    after_features: Dict[str, Any]
    movement_results: List[MovementResult]
    regression_results: List[RegressionResult]
    safety_result: SafetyGateResult
    status: RenderStatus
    accepted_recommendations: List[str]  # IDs
    rejected_recommendations: List[str]  # IDs
    notes: str = ""

    def to_dict(self) -> Dict:
        return {
            "pass_number": self.pass_number,
            "applied_recommendations": [r.to_dict() for r in self.applied_recommendations],
            "filter_chain": self.filter_chain,
            "candidate_path": self.candidate_path,
            "movement_results": [m.to_dict() for m in self.movement_results],
            "regression_results": [r.to_dict() for r in self.regression_results],
            "safety_result": self.safety_result.to_dict(),
            "status": self.status.value,
            "accepted_recommendations": self.accepted_recommendations,
            "rejected_recommendations": self.rejected_recommendations,
            "notes": self.notes,
        }


@dataclass
class ClosedLoopResult:
    """Complete closed loop render result."""
    file_name: str
    timestamp: str
    original_path: str
    final_path: str
    final_status: RenderStatus
    pass_count: int
    passes: List[PassResult]
    decision_summary: Dict[str, Any]
    original_features: Dict[str, Any]
    final_features: Dict[str, Any]
    level_matched_paths: Dict[str, str]  # {"original": ..., "candidate": ...}
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict:
        return {
            "file_name": self.file_name,
            "timestamp": self.timestamp,
            "original_path": self.original_path,
            "final_path": self.final_path,
            "final_status": self.final_status.value,
            "pass_count": self.pass_count,
            "passes": [p.to_dict() for p in self.passes],
            "decision_summary": self.decision_summary,
            "level_matched_paths": self.level_matched_paths,
            "metadata": self.metadata,
        }
