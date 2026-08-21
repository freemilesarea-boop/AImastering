"""
Closed Loop Calibration P1 - Confidence Calculator

Calculates calibration confidence scores.

Phase: AI-MASTERING-CLOSED-LOOP-CALIBRATION-P1-1
"""

from typing import Dict, List, Any
from dataclasses import dataclass

from .constants import (
    MIN_TRACKS_FOR_CURVE,
    MIN_TRACKS_FOR_PROMOTION,
    DIRECTION_CORRECTNESS_MIN_DERIVED,
    SAFETY_PASS_RATE_MIN,
    OVERSHOOT_RATE_MAX,
)
from .schema import (
    ResponseCurve,
    MappingCalibrationResult,
)


@dataclass
class CalibrationConfidence:
    """Confidence assessment for calibration results."""
    overall_confidence: float
    sample_score: float
    direction_score: float
    safety_score: float
    variance_penalty: float
    regression_penalty: float

    components: Dict[str, float]
    promotable_rules: int
    blocked_rules: int


class ConfidenceCalculator:
    """
    Calculates confidence scores for calibration results.

    Components:
    - Sample count score
    - Direction correctness score
    - Safety pass rate score
    - Variance penalty
    - Regression penalty
    """

    def calculate_overall_confidence(
        self,
        curves: List[ResponseCurve],
        calibrations: List[MappingCalibrationResult],
    ) -> CalibrationConfidence:
        """
        Calculate overall calibration confidence.

        Args:
            curves: Response curves
            calibrations: Calibration results

        Returns:
            CalibrationConfidence with scores
        """
        if not curves or not calibrations:
            return CalibrationConfidence(
                overall_confidence=0.0,
                sample_score=0.0,
                direction_score=0.0,
                safety_score=0.0,
                variance_penalty=0.0,
                regression_penalty=0.0,
                components={},
                promotable_rules=0,
                blocked_rules=0,
            )

        # Sample count score (0-0.25)
        total_samples = sum(c.valid_samples for c in curves)
        sample_score = min(total_samples / (MIN_TRACKS_FOR_PROMOTION * len(curves)), 1.0) * 0.25

        # Direction correctness score (0-0.35)
        avg_direction = sum(c.overall_direction_correct_rate for c in curves) / len(curves)
        direction_score = avg_direction * 0.35

        # Safety score (0-0.25)
        safety_rates = []
        for c in curves:
            if c.total_samples > 0:
                rate = c.valid_samples / c.total_samples
                safety_rates.append(rate)
        avg_safety = sum(safety_rates) / len(safety_rates) if safety_rates else 0.0
        safety_score = avg_safety * 0.25

        # Variance penalty (0-0.10)
        variances = []
        for curve in curves:
            for point in curve.points:
                if point.std_response > 0:
                    variances.append(point.std_response)
        avg_variance = sum(variances) / len(variances) if variances else 0.0
        variance_penalty = min(avg_variance / 2.0, 0.10)

        # Regression penalty (based on blocked rules)
        blocked_rules = sum(1 for c in calibrations if c.source_candidate.value == "BLOCKED")
        regression_penalty = min(blocked_rules / len(calibrations), 0.05) if calibrations else 0.0

        # Overall
        overall = sample_score + direction_score + safety_score - variance_penalty - regression_penalty
        overall = max(0.0, min(1.0, overall))

        # Count promotable
        promotable = sum(1 for c in calibrations if c.promotion_eligible)

        return CalibrationConfidence(
            overall_confidence=overall,
            sample_score=sample_score,
            direction_score=direction_score,
            safety_score=safety_score,
            variance_penalty=variance_penalty,
            regression_penalty=regression_penalty,
            components={
                "total_curves": len(curves),
                "total_samples": total_samples,
                "avg_direction_correct": avg_direction,
                "avg_safety_rate": avg_safety,
                "avg_variance": avg_variance,
            },
            promotable_rules=promotable,
            blocked_rules=blocked_rules,
        )

    def generate_confidence_report(
        self,
        confidence: CalibrationConfidence,
    ) -> Dict:
        """Generate confidence report."""
        return {
            "overall_confidence": confidence.overall_confidence,
            "confidence_grade": self._grade_confidence(confidence.overall_confidence),
            "scores": {
                "sample_score": confidence.sample_score,
                "direction_score": confidence.direction_score,
                "safety_score": confidence.safety_score,
                "variance_penalty": confidence.variance_penalty,
                "regression_penalty": confidence.regression_penalty,
            },
            "components": confidence.components,
            "summary": {
                "promotable_rules": confidence.promotable_rules,
                "blocked_rules": confidence.blocked_rules,
            },
            "interpretation": self._interpret_confidence(confidence),
        }

    def _grade_confidence(self, score: float) -> str:
        """Grade confidence score."""
        if score >= 0.80:
            return "HIGH"
        elif score >= 0.60:
            return "MEDIUM"
        elif score >= 0.40:
            return "LOW"
        else:
            return "INSUFFICIENT"

    def _interpret_confidence(self, confidence: CalibrationConfidence) -> str:
        """Interpret confidence score."""
        if confidence.overall_confidence >= 0.80:
            return "Calibration results are highly reliable. Ready for listening test validation."
        elif confidence.overall_confidence >= 0.60:
            return "Calibration results are moderately reliable. Some rules may need more data."
        elif confidence.overall_confidence >= 0.40:
            return "Calibration results have limited reliability. More tracks recommended."
        else:
            return "Insufficient data for reliable calibration. Expand dataset."
