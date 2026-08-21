"""
Closed Loop Render Engine P0 - Regression Detector

Detects collateral regression when improving one profile
may have degraded another.

Phase: AI-MASTERING-CLOSED-LOOP-RENDER-P0-1
"""

from typing import Dict, List, Any
from dataclasses import dataclass
import math

from .constants import (
    COLLATERAL_CHECK_MAP,
    PROFILE_PRIMARY_FEATURES,
    REGRESSION_LOW_THRESHOLD,
    REGRESSION_MEDIUM_THRESHOLD,
    REGRESSION_HIGH_THRESHOLD,
    REGRESSION_CRITICAL_THRESHOLD,
    RegressionSeverity,
)
from .schema import RegressionResult, SelectedRecommendation
from app.mastering.decision_engine.target_registry import get_target_registry


@dataclass
class RegressionDetectionResult:
    """Aggregate result of regression detection."""
    has_blocking_regression: bool
    results: List[RegressionResult]
    severity_counts: Dict[str, int]
    blocking_profiles: List[str]


class RegressionDetector:
    """
    Detects collateral regression from DSP changes.

    Checks:
    - LOUDNESS -> PEAK_SAFETY, DYNAMIC_RANGE
    - BRIGHTNESS -> TEXTURE, PEAK_SAFETY
    - LOW_END -> PEAK_SAFETY, STEREO_IMAGE
    - STEREO_IMAGE -> STEREO_IMAGE (correlation)
    - DYNAMIC_RANGE -> LOUDNESS, TRANSIENT
    """

    def __init__(self):
        self.target_registry = get_target_registry()

    def detect_regression(
        self,
        applied_recommendations: List[SelectedRecommendation],
        before_features: Dict[str, Any],
        after_features: Dict[str, Any],
    ) -> RegressionDetectionResult:
        """
        Detect collateral regressions.

        Args:
            applied_recommendations: Recommendations that were applied
            before_features: Features before processing
            after_features: Features after processing

        Returns:
            RegressionDetectionResult with all regression checks
        """
        results: List[RegressionResult] = []
        severity_counts = {s.value: 0 for s in RegressionSeverity}
        blocking_profiles: List[str] = []

        # Get profiles that were modified
        modified_profiles = {rec.profile for rec in applied_recommendations}

        # Check each modified profile against its collateral targets
        for source_profile in modified_profiles:
            affected_profiles = COLLATERAL_CHECK_MAP.get(source_profile, [])

            for affected_profile in affected_profiles:
                # Check each feature of the affected profile
                features = PROFILE_PRIMARY_FEATURES.get(affected_profile, [])

                for feature in features:
                    result = self._check_feature_regression(
                        source_profile,
                        affected_profile,
                        feature,
                        before_features,
                        after_features,
                    )
                    if result:
                        results.append(result)
                        severity_counts[result.severity.value] += 1

                        if result.is_blocking:
                            if affected_profile not in blocking_profiles:
                                blocking_profiles.append(affected_profile)

        # Special checks
        special_results = self._special_regression_checks(
            before_features, after_features,
        )
        for result in special_results:
            results.append(result)
            severity_counts[result.severity.value] += 1
            if result.is_blocking and result.affected_profile not in blocking_profiles:
                blocking_profiles.append(result.affected_profile)

        has_blocking = len(blocking_profiles) > 0

        return RegressionDetectionResult(
            has_blocking_regression=has_blocking,
            results=results,
            severity_counts=severity_counts,
            blocking_profiles=blocking_profiles,
        )

    def _check_feature_regression(
        self,
        source_profile: str,
        affected_profile: str,
        feature: str,
        before_features: Dict[str, Any],
        after_features: Dict[str, Any],
    ) -> RegressionResult | None:
        """Check regression for a single feature."""
        before_value = self._get_value(before_features, feature)
        after_value = self._get_value(after_features, feature)

        if before_value is None or after_value is None:
            return None

        target = self.target_registry.get_target(affected_profile, feature)
        if target is None:
            return None

        before_distance = abs(before_value - target.median)
        after_distance = abs(after_value - target.median)

        # Only report if distance increased (regression)
        if after_distance <= before_distance:
            return None

        regression_amount = after_distance - before_distance
        if before_distance > 0.0001:
            regression_percent = (regression_amount / before_distance) * 100
        else:
            regression_percent = regression_amount * 100

        severity = self._classify_severity(regression_percent / 100.0)
        is_blocking = severity in (
            RegressionSeverity.HIGH,
            RegressionSeverity.CRITICAL,
        )

        return RegressionResult(
            source_profile=source_profile,
            affected_profile=affected_profile,
            feature=feature,
            before_value=before_value,
            after_value=after_value,
            target_median=target.median,
            before_distance=before_distance,
            after_distance=after_distance,
            regression_amount=regression_amount,
            regression_percent=regression_percent,
            severity=severity,
            is_blocking=is_blocking,
            notes=f"Distance to target increased by {regression_percent:.1f}%",
        )

    def _special_regression_checks(
        self,
        before: Dict[str, Any],
        after: Dict[str, Any],
    ) -> List[RegressionResult]:
        """Special regression checks that don't fit the standard pattern."""
        results = []

        # 1. Peak safety regression (any increase in true peak)
        before_tp = self._get_value(before, "input_tp")
        after_tp = self._get_value(after, "input_tp")
        if before_tp is not None and after_tp is not None:
            if after_tp > before_tp + 0.5:  # Allow 0.5 dB tolerance
                increase = after_tp - before_tp
                severity = RegressionSeverity.HIGH if increase > 1.0 else RegressionSeverity.MEDIUM
                results.append(RegressionResult(
                    source_profile="ANY",
                    affected_profile="PEAK_SAFETY",
                    feature="input_tp",
                    before_value=before_tp,
                    after_value=after_tp,
                    target_median=-1.0,
                    before_distance=abs(before_tp - (-1.0)),
                    after_distance=abs(after_tp - (-1.0)),
                    regression_amount=increase,
                    regression_percent=increase * 100,
                    severity=severity,
                    is_blocking=severity == RegressionSeverity.HIGH,
                    notes=f"True peak increased by {increase:.2f} dB",
                ))

        # 2. Stereo correlation regression (drop in correlation)
        before_corr = self._get_value(before, "stereo_correlation")
        after_corr = self._get_value(after, "stereo_correlation")
        if before_corr is not None and after_corr is not None:
            if after_corr < before_corr - 0.1:  # Significant drop
                drop = before_corr - after_corr
                is_critical = after_corr < 0.0  # Negative correlation
                severity = (RegressionSeverity.CRITICAL if is_critical
                           else RegressionSeverity.HIGH if drop > 0.3
                           else RegressionSeverity.MEDIUM)
                results.append(RegressionResult(
                    source_profile="ANY",
                    affected_profile="STEREO_IMAGE",
                    feature="stereo_correlation",
                    before_value=before_corr,
                    after_value=after_corr,
                    target_median=0.9,
                    before_distance=abs(before_corr - 0.9),
                    after_distance=abs(after_corr - 0.9),
                    regression_amount=drop,
                    regression_percent=drop * 100,
                    severity=severity,
                    is_blocking=severity in (RegressionSeverity.HIGH, RegressionSeverity.CRITICAL),
                    notes=f"Correlation dropped by {drop:.2f}" + (" - NEGATIVE CORRELATION!" if is_critical else ""),
                ))

        # 3. Crest factor regression (loss of dynamics)
        before_crest = self._get_value(before, "crest_factor_db")
        after_crest = self._get_value(after, "crest_factor_db")
        if before_crest is not None and after_crest is not None:
            if after_crest < before_crest - 2.0:  # More than 2 dB loss
                loss = before_crest - after_crest
                severity = RegressionSeverity.HIGH if loss > 4.0 else RegressionSeverity.MEDIUM
                results.append(RegressionResult(
                    source_profile="ANY",
                    affected_profile="DYNAMIC_RANGE",
                    feature="crest_factor_db",
                    before_value=before_crest,
                    after_value=after_crest,
                    target_median=11.0,
                    before_distance=abs(before_crest - 11.0),
                    after_distance=abs(after_crest - 11.0),
                    regression_amount=loss,
                    regression_percent=(loss / before_crest) * 100 if before_crest > 0 else 0,
                    severity=severity,
                    is_blocking=severity == RegressionSeverity.HIGH,
                    notes=f"Dynamics reduced by {loss:.2f} dB",
                ))

        return results

    def _get_value(self, features: Dict[str, Any], key: str) -> float | None:
        """Get value from features dict."""
        value = features.get(key)
        if value is None:
            return None
        try:
            f = float(value)
            if math.isnan(f) or math.isinf(f):
                return None
            return f
        except (TypeError, ValueError):
            return None

    def _classify_severity(self, regression_ratio: float) -> RegressionSeverity:
        """Classify regression severity based on ratio."""
        if regression_ratio >= REGRESSION_CRITICAL_THRESHOLD:
            return RegressionSeverity.CRITICAL
        elif regression_ratio >= REGRESSION_HIGH_THRESHOLD:
            return RegressionSeverity.HIGH
        elif regression_ratio >= REGRESSION_MEDIUM_THRESHOLD:
            return RegressionSeverity.MEDIUM
        elif regression_ratio >= REGRESSION_LOW_THRESHOLD:
            return RegressionSeverity.LOW
        else:
            return RegressionSeverity.NONE
