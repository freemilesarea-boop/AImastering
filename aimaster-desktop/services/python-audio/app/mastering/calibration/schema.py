"""
Closed Loop Calibration P1 - Schema

Data classes for calibration results.

Phase: AI-MASTERING-CLOSED-LOOP-CALIBRATION-P1-1
"""

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Any

from .constants import CalibrationStatus, MappingChangeType, MappingSourceCandidate


@dataclass
class TrackInfo:
    """Information about a track in the calibration dataset."""
    file_name: str
    file_path: str
    duration_sec: float
    sample_rate: int
    channels: int
    valid: bool
    exclusion_reason: Optional[str] = None
    characteristics: Dict[str, Any] = field(default_factory=dict)


@dataclass
class SweepCandidate:
    """Single parameter sweep candidate."""
    candidate_id: str
    track_name: str
    track_path: str
    processor: str
    parameter: str
    value: float
    unit: str
    frequency_hz: Optional[int] = None
    q: Optional[float] = None
    status: CalibrationStatus = CalibrationStatus.PENDING
    output_path: str = ""
    filter_chain: str = ""


@dataclass
class FeatureResponse:
    """Feature response to a parameter change."""
    feature: str
    before_value: float
    after_value: float
    delta: float
    response_per_unit: float  # e.g., delta per dB
    target_median: Optional[float] = None
    before_distance: Optional[float] = None
    after_distance: Optional[float] = None
    direction_correct: bool = False
    improvement_percent: float = 0.0


@dataclass
class CandidateResult:
    """Result of a single candidate render and analysis."""
    candidate: SweepCandidate
    status: CalibrationStatus
    render_success: bool
    safety_passed: bool
    safety_failures: List[str] = field(default_factory=list)
    before_features: Dict[str, Any] = field(default_factory=dict)
    after_features: Dict[str, Any] = field(default_factory=dict)
    primary_responses: List[FeatureResponse] = field(default_factory=list)
    collateral_responses: List[FeatureResponse] = field(default_factory=list)
    overshoot: bool = False
    regression_detected: bool = False
    notes: str = ""

    def to_dict(self) -> Dict:
        return {
            "candidate_id": self.candidate.candidate_id,
            "track_name": self.candidate.track_name,
            "processor": self.candidate.processor,
            "parameter": self.candidate.parameter,
            "value": self.candidate.value,
            "unit": self.candidate.unit,
            "frequency_hz": self.candidate.frequency_hz,
            "status": self.status.value,
            "render_success": self.render_success,
            "safety_passed": self.safety_passed,
            "safety_failures": self.safety_failures,
            "primary_responses": [
                {
                    "feature": r.feature,
                    "before": r.before_value,
                    "after": r.after_value,
                    "delta": r.delta,
                    "response_per_unit": r.response_per_unit,
                    "direction_correct": r.direction_correct,
                    "improvement_percent": r.improvement_percent,
                }
                for r in self.primary_responses
            ],
            "collateral_responses": [
                {
                    "feature": r.feature,
                    "before": r.before_value,
                    "after": r.after_value,
                    "delta": r.delta,
                }
                for r in self.collateral_responses
            ],
            "overshoot": self.overshoot,
            "regression_detected": self.regression_detected,
            "notes": self.notes,
        }


@dataclass
class ResponseCurvePoint:
    """Single point on a response curve."""
    value: float  # Parameter value (e.g., -1.5 dB)
    frequency_hz: Optional[int] = None
    sample_count: int = 0
    valid_count: int = 0
    rejected_count: int = 0

    mean_response: float = 0.0
    median_response: float = 0.0
    std_response: float = 0.0
    p25_response: float = 0.0
    p75_response: float = 0.0
    min_response: float = 0.0
    max_response: float = 0.0

    direction_correct_rate: float = 0.0
    improvement_rate: float = 0.0
    safety_pass_rate: float = 0.0
    overshoot_rate: float = 0.0


@dataclass
class ResponseCurve:
    """Response curve for a processor/parameter/feature combination."""
    processor: str
    parameter: str
    feature: str
    profile: str
    unit: str
    frequency_hz: Optional[int] = None

    points: List[ResponseCurvePoint] = field(default_factory=list)

    total_samples: int = 0
    valid_samples: int = 0
    rejected_samples: int = 0

    overall_direction_correct_rate: float = 0.0
    nonlinear_response: bool = False
    saturation_point: Optional[float] = None
    unsafe_point: Optional[float] = None

    def to_dict(self) -> Dict:
        return {
            "processor": self.processor,
            "parameter": self.parameter,
            "feature": self.feature,
            "profile": self.profile,
            "unit": self.unit,
            "frequency_hz": self.frequency_hz,
            "total_samples": self.total_samples,
            "valid_samples": self.valid_samples,
            "rejected_samples": self.rejected_samples,
            "overall_direction_correct_rate": self.overall_direction_correct_rate,
            "nonlinear_response": self.nonlinear_response,
            "saturation_point": self.saturation_point,
            "unsafe_point": self.unsafe_point,
            "points": [
                {
                    "value": p.value,
                    "frequency_hz": p.frequency_hz,
                    "sample_count": p.sample_count,
                    "valid_count": p.valid_count,
                    "median_response": p.median_response,
                    "p25_response": p.p25_response,
                    "p75_response": p.p75_response,
                    "std_response": p.std_response,
                    "direction_correct_rate": p.direction_correct_rate,
                    "safety_pass_rate": p.safety_pass_rate,
                    "overshoot_rate": p.overshoot_rate,
                }
                for p in self.points
            ],
        }


@dataclass
class MappingCalibrationResult:
    """Calibration result for a single mapping rule."""
    rule_id: str
    profile: str
    processor: str
    parameter: str

    existing_range: Dict[str, float] = field(default_factory=dict)
    calibrated_range: Dict[str, float] = field(default_factory=dict)

    change_type: MappingChangeType = MappingChangeType.UNCHANGED
    source_candidate: MappingSourceCandidate = MappingSourceCandidate.DESIGN_CANDIDATE

    valid_tracks: int = 0
    direction_correctness: float = 0.0
    safety_pass_rate: float = 0.0
    overshoot_rate: float = 0.0
    regression_rate: float = 0.0

    confidence_score: float = 0.0
    promotion_eligible: bool = False

    notes: str = ""


@dataclass
class NoActionAuditResult:
    """Result of NO_ACTION sensitivity audit."""
    track_name: str
    profile: str
    original_state: str  # RECOMMEND, NO_ACTION, etc.

    feature_values: Dict[str, float] = field(default_factory=dict)
    target_ranges: Dict[str, Dict] = field(default_factory=dict)

    in_p25_p75: bool = False
    in_p5_p95: bool = False
    distance_from_median: float = 0.0

    confirmed_no_action: bool = False
    possible_false_no_action: bool = False
    audit_reason: str = ""


@dataclass
class CalibrationReport:
    """Complete calibration report."""
    timestamp: str
    phase: str = "AI-MASTERING-CLOSED-LOOP-CALIBRATION-P1-1"

    # Dataset
    dataset_summary: Dict[str, Any] = field(default_factory=dict)

    # Candidates
    total_candidates: int = 0
    rendered_candidates: int = 0
    passed_candidates: int = 0
    rejected_candidates: int = 0
    safety_failed_candidates: int = 0

    # Response curves
    response_curves: List[ResponseCurve] = field(default_factory=list)

    # Mapping calibration
    mapping_calibrations: List[MappingCalibrationResult] = field(default_factory=list)

    # No-Action audit
    no_action_audits: List[NoActionAuditResult] = field(default_factory=list)

    # Reproducibility
    reproducibility_passed: bool = False
    reproducibility_details: Dict = field(default_factory=dict)

    # Validation
    schema_valid: bool = False
    existing_tests_passed: bool = False
    test_count: int = 0

    # Safety
    runtime_safe: bool = True
    production_affected: bool = False
