"""
Closed Loop Render Engine P0 - Movement Validator

Validates that recommendations moved features in the correct direction
toward the target.

Phase: AI-MASTERING-CLOSED-LOOP-RENDER-P0-1
"""

from typing import Dict, List, Optional, Any
from dataclasses import dataclass
import math

from .constants import (
    PROFILE_PRIMARY_FEATURES,
    FEATURE_HIGHER_IS_BETTER,
    MOVEMENT_IMPROVEMENT_MIN_PERCENT,
    OVERSHOOT_THRESHOLD_PERCENT,
    ValidationResult,
)
from .schema import MovementResult, SelectedRecommendation
from app.mastering.decision_engine.target_registry import get_target_registry


@dataclass
class MovementValidationResult:
    """Aggregate result of movement validation."""
    all_passed: bool
    results: List[MovementResult]
    improvement_count: int
    regression_count: int
    no_change_count: int
    overshoot_count: int


class MovementValidator:
    """
    Validates that DSP changes moved features toward targets.

    Checks:
    - Direction correctness (moved toward target, not away)
    - Distance improvement (closer to target median)
    - Overshoot detection (went past target)
    """

    def __init__(self):
        self.target_registry = get_target_registry()

    def validate_movement(
        self,
        applied_recommendations: List[SelectedRecommendation],
        before_features: Dict[str, Any],
        after_features: Dict[str, Any],
    ) -> MovementValidationResult:
        """
        Validate movement for all applied recommendations.

        Args:
            applied_recommendations: Recommendations that were applied
            before_features: Features before processing
            after_features: Features after processing

        Returns:
            MovementValidationResult with all movement checks
        """
        results: List[MovementResult] = []
        improvement_count = 0
        regression_count = 0
        no_change_count = 0
        overshoot_count = 0

        for rec in applied_recommendations:
            profile = rec.profile

            # Get primary features for this profile
            features = PROFILE_PRIMARY_FEATURES.get(profile, [])

            for feature in features:
                # Get values
                before_value = self._get_feature_value(before_features, feature)
                after_value = self._get_feature_value(after_features, feature)

                if before_value is None or after_value is None:
                    results.append(MovementResult(
                        profile=profile,
                        feature=feature,
                        before_value=0.0,
                        after_value=0.0,
                        target_median=0.0,
                        target_p25=0.0,
                        target_p75=0.0,
                        before_distance=0.0,
                        after_distance=0.0,
                        direction_correct=False,
                        improvement_amount=0.0,
                        improvement_percent=0.0,
                        overshoot=False,
                        validation_result=ValidationResult.SKIP,
                        notes=f"Missing feature value: {feature}",
                    ))
                    continue

                # Get target
                target = self.target_registry.get_target(profile, feature)
                if target is None:
                    results.append(MovementResult(
                        profile=profile,
                        feature=feature,
                        before_value=before_value,
                        after_value=after_value,
                        target_median=0.0,
                        target_p25=0.0,
                        target_p75=0.0,
                        before_distance=0.0,
                        after_distance=0.0,
                        direction_correct=False,
                        improvement_amount=0.0,
                        improvement_percent=0.0,
                        overshoot=False,
                        validation_result=ValidationResult.SKIP,
                        notes=f"No target for feature: {feature}",
                    ))
                    continue

                # Calculate distances
                before_distance = abs(before_value - target.median)
                after_distance = abs(after_value - target.median)

                # Determine if direction is correct
                direction_correct = self._check_direction(
                    before_value, after_value, target.median,
                )

                # Calculate improvement
                improvement_amount = before_distance - after_distance
                if before_distance > 0.0001:
                    improvement_percent = (improvement_amount / before_distance) * 100
                else:
                    improvement_percent = 0.0

                # Check for overshoot
                overshoot = self._check_overshoot(
                    before_value, after_value, target.median,
                    target.p25, target.p75,
                )

                # Determine validation result
                if improvement_percent >= MOVEMENT_IMPROVEMENT_MIN_PERCENT:
                    if overshoot:
                        validation_result = ValidationResult.WARN
                        overshoot_count += 1
                    else:
                        validation_result = ValidationResult.PASS
                    improvement_count += 1
                elif improvement_percent <= -MOVEMENT_IMPROVEMENT_MIN_PERCENT:
                    validation_result = ValidationResult.FAIL
                    regression_count += 1
                else:
                    validation_result = ValidationResult.WARN
                    no_change_count += 1

                notes = self._build_notes(
                    direction_correct, improvement_percent, overshoot,
                    before_value, after_value, target.median,
                )

                results.append(MovementResult(
                    profile=profile,
                    feature=feature,
                    before_value=before_value,
                    after_value=after_value,
                    target_median=target.median,
                    target_p25=target.p25,
                    target_p75=target.p75,
                    before_distance=before_distance,
                    after_distance=after_distance,
                    direction_correct=direction_correct,
                    improvement_amount=improvement_amount,
                    improvement_percent=improvement_percent,
                    overshoot=overshoot,
                    validation_result=validation_result,
                    notes=notes,
                ))

        all_passed = regression_count == 0 and (
            improvement_count > 0 or len(results) == 0
        )

        return MovementValidationResult(
            all_passed=all_passed,
            results=results,
            improvement_count=improvement_count,
            regression_count=regression_count,
            no_change_count=no_change_count,
            overshoot_count=overshoot_count,
        )

    def _get_feature_value(
        self,
        features: Dict[str, Any],
        feature_name: str,
    ) -> Optional[float]:
        """Get feature value from features dict."""
        value = features.get(feature_name)
        if value is None:
            return None
        try:
            f = float(value)
            if math.isnan(f) or math.isinf(f):
                return None
            return f
        except (TypeError, ValueError):
            return None

    def _check_direction(
        self,
        before: float,
        after: float,
        target_median: float,
    ) -> bool:
        """Check if movement was in correct direction."""
        if abs(after - target_median) < 0.0001:
            # Hit target exactly
            return True

        was_below = before < target_median
        moved_up = after > before

        if was_below:
            # Was below target, should move up
            return moved_up
        else:
            # Was above target, should move down
            return not moved_up

    def _check_overshoot(
        self,
        before: float,
        after: float,
        target_median: float,
        target_p25: float,
        target_p75: float,
    ) -> bool:
        """Check if movement overshot the target."""
        was_below = before < target_median
        after_in_range = target_p25 <= after <= target_p75

        if after_in_range:
            return False

        # Check if we crossed the target
        if was_below:
            return after > target_p75
        else:
            return after < target_p25

    def _build_notes(
        self,
        direction_correct: bool,
        improvement_percent: float,
        overshoot: bool,
        before: float,
        after: float,
        target: float,
    ) -> str:
        """Build human-readable notes."""
        parts = []

        if direction_correct:
            parts.append(f"Correct direction ({improvement_percent:+.1f}% improvement)")
        else:
            parts.append(f"Wrong direction ({improvement_percent:+.1f}%)")

        if overshoot:
            parts.append("OVERSHOOT")

        if abs(after - target) < 0.01 * abs(target):
            parts.append("At target")

        return "; ".join(parts) if parts else ""
