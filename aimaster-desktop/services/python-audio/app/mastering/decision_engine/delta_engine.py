"""
Feature Delta Engine for DSP Decision Engine P0.

Calculates differences between AI track features and commercial targets.
"""

from dataclasses import dataclass, field
from typing import Dict, Optional, Any, List

from .constants import Direction, Severity
from .target_registry import get_target_registry, TargetStatistics


@dataclass
class FeatureDelta:
    """Delta calculation result for a single feature."""
    feature: str
    profile: str
    actual: Optional[float]
    target_median: Optional[float]
    target_p25: Optional[float]
    target_p75: Optional[float]
    target_p5: Optional[float]
    target_p95: Optional[float]
    delta_absolute: Optional[float]
    delta_percent: Optional[float]
    position: str  # "BELOW_P5", "BELOW_P25", "IN_RANGE", "ABOVE_P75", "ABOVE_P95", "UNKNOWN"
    distance_normalized: Optional[float]  # IQR-normalized distance
    direction: Direction
    severity: Severity
    has_target: bool
    target_data_based: bool
    unit: str = ""

    def to_dict(self) -> Dict:
        """Convert to dictionary."""
        return {
            "feature": self.feature,
            "profile": self.profile,
            "actual": self.actual,
            "target_median": self.target_median,
            "target_p25": self.target_p25,
            "target_p75": self.target_p75,
            "target_p5": self.target_p5,
            "target_p95": self.target_p95,
            "delta_absolute": self.delta_absolute,
            "delta_percent": self.delta_percent,
            "position": self.position,
            "distance_normalized": self.distance_normalized,
            "direction": self.direction.value,
            "severity": self.severity.value,
            "has_target": self.has_target,
            "target_data_based": self.target_data_based,
            "unit": self.unit,
        }


@dataclass
class ProfileDelta:
    """Aggregated delta for a profile across all its features."""
    profile: str
    feature_deltas: List[FeatureDelta]
    primary_direction: Direction
    overall_severity: Severity
    has_data_derived_target: bool
    missing_features: List[str]
    confidence_factor: float  # 0-1 based on feature completeness

    def to_dict(self) -> Dict:
        """Convert to dictionary."""
        return {
            "profile": self.profile,
            "feature_deltas": [fd.to_dict() for fd in self.feature_deltas],
            "primary_direction": self.primary_direction.value,
            "overall_severity": self.overall_severity.value,
            "has_data_derived_target": self.has_data_derived_target,
            "missing_features": self.missing_features,
            "confidence_factor": self.confidence_factor,
        }


# Profile to primary features mapping
PROFILE_PRIMARY_FEATURES: Dict[str, List[str]] = {
    "LOUDNESS": ["input_i", "rms_db"],
    "PEAK_SAFETY": ["input_tp", "sample_peak_dbfs"],
    "DYNAMIC_RANGE": ["crest_factor_db", "input_lra"],
    "LOW_END": ["band_ratio_20-60Hz", "band_ratio_60-120Hz"],
    "WARMTH": ["band_ratio_250-500Hz", "spectral_contrast_band_1"],
    "MID_CLARITY": ["band_ratio_1-2kHz", "band_ratio_500-1000Hz"],
    "PRESENCE": ["band_ratio_2-4kHz", "spectral_contrast_band_4"],
    "BRIGHTNESS": ["spectral_centroid", "hf_ratio", "spectral_contrast_band_6"],
    "STEREO_IMAGE": ["stereo_correlation", "stereo_width", "ms_ratio_db"],
    "TRANSIENT": ["spectral_flux_normalized_mean", "onset_density"],
    "TEXTURE": ["spectral_flatness_temporal_std", "spectral_contrast_mean"],
}


class DeltaEngine:
    """
    Calculates feature deltas between AI track and commercial targets.

    Does NOT make DSP recommendations - only calculates differences.
    """

    def __init__(self):
        self.target_registry = get_target_registry()

    def calculate_feature_delta(
        self,
        feature: str,
        profile: str,
        actual_value: Optional[float],
    ) -> FeatureDelta:
        """
        Calculate delta for a single feature.

        Args:
            feature: Feature name
            profile: Profile this feature belongs to
            actual_value: Measured value from AI track

        Returns:
            FeatureDelta with all calculations
        """
        target = self.target_registry.get_target(profile, feature)

        # No target available
        if target is None:
            return FeatureDelta(
                feature=feature,
                profile=profile,
                actual=actual_value,
                target_median=None,
                target_p25=None,
                target_p75=None,
                target_p5=None,
                target_p95=None,
                delta_absolute=None,
                delta_percent=None,
                position="UNKNOWN",
                distance_normalized=None,
                direction=Direction.UNKNOWN,
                severity=Severity.NONE,
                has_target=False,
                target_data_based=False,
            )

        # No actual value
        if actual_value is None:
            return FeatureDelta(
                feature=feature,
                profile=profile,
                actual=None,
                target_median=target.median,
                target_p25=target.p25,
                target_p75=target.p75,
                target_p5=target.p5,
                target_p95=target.p95,
                delta_absolute=None,
                delta_percent=None,
                position="UNKNOWN",
                distance_normalized=None,
                direction=Direction.UNKNOWN,
                severity=Severity.NONE,
                has_target=True,
                target_data_based=target.data_based,
                unit=target.unit,
            )

        # Calculate deltas
        delta_abs = actual_value - target.median
        delta_pct = (delta_abs / abs(target.median) * 100) if target.median != 0 else 0.0
        distance_norm = target.normalized_distance(actual_value)

        # Determine position
        position = self._determine_position(actual_value, target)

        # Determine direction
        direction = self._determine_direction(actual_value, target)

        # Determine severity
        severity = self._determine_severity(actual_value, target)

        return FeatureDelta(
            feature=feature,
            profile=profile,
            actual=actual_value,
            target_median=target.median,
            target_p25=target.p25,
            target_p75=target.p75,
            target_p5=target.p5,
            target_p95=target.p95,
            delta_absolute=round(delta_abs, 4),
            delta_percent=round(delta_pct, 2),
            position=position,
            distance_normalized=round(distance_norm, 3),
            direction=direction,
            severity=severity,
            has_target=True,
            target_data_based=target.data_based,
            unit=target.unit,
        )

    def _determine_position(self, value: float, target: TargetStatistics) -> str:
        """Determine percentile position of value."""
        if target.p5 is not None and value < target.p5:
            return "BELOW_P5"
        elif value < target.p25:
            return "BELOW_P25"
        elif value <= target.p75:
            return "IN_RANGE"
        elif target.p95 is not None and value > target.p95:
            return "ABOVE_P95"
        else:
            return "ABOVE_P75"

    def _determine_direction(self, value: float, target: TargetStatistics) -> Direction:
        """Determine direction of deviation."""
        if target.p5 is not None and value < target.p5:
            return Direction.TOO_LOW
        elif value < target.p25:
            return Direction.SLIGHTLY_LOW
        elif value <= target.p75:
            return Direction.IN_RANGE
        elif target.p95 is not None and value > target.p95:
            return Direction.TOO_HIGH
        else:
            return Direction.SLIGHTLY_HIGH

    def _determine_severity(self, value: float, target: TargetStatistics) -> Severity:
        """Determine severity based on normalized distance."""
        if target.in_normal_range(value):
            return Severity.NONE

        norm_dist = abs(target.normalized_distance(value))

        # Severity thresholds based on IQR distance
        if norm_dist <= 0.5:
            return Severity.LOW
        elif norm_dist <= 1.0:
            return Severity.MEDIUM
        elif norm_dist <= 2.0:
            return Severity.HIGH
        else:
            return Severity.CRITICAL

    def calculate_profile_delta(
        self,
        profile: str,
        features: Dict[str, Any],
    ) -> ProfileDelta:
        """
        Calculate delta for all features in a profile.

        Args:
            profile: Profile ID
            features: Dictionary of feature values

        Returns:
            ProfileDelta with all feature deltas
        """
        primary_features = PROFILE_PRIMARY_FEATURES.get(profile, [])
        feature_deltas = []
        missing_features = []
        directions = []
        severities = []

        for feature in primary_features:
            actual = features.get(feature)

            if actual is None:
                missing_features.append(feature)
                continue

            delta = self.calculate_feature_delta(feature, profile, actual)
            feature_deltas.append(delta)

            if delta.direction != Direction.UNKNOWN:
                directions.append(delta.direction)
                severities.append(delta.severity)

        # Determine primary direction (majority vote)
        primary_direction = self._aggregate_direction(directions)

        # Determine overall severity (maximum)
        overall_severity = self._aggregate_severity(severities)

        # Check if profile has data-derived targets
        has_data_derived = any(fd.target_data_based for fd in feature_deltas)

        # Confidence factor based on feature completeness
        if len(primary_features) == 0:
            confidence_factor = 0.0
        else:
            confidence_factor = len(feature_deltas) / len(primary_features)

        return ProfileDelta(
            profile=profile,
            feature_deltas=feature_deltas,
            primary_direction=primary_direction,
            overall_severity=overall_severity,
            has_data_derived_target=has_data_derived,
            missing_features=missing_features,
            confidence_factor=round(confidence_factor, 2),
        )

    def _aggregate_direction(self, directions: List[Direction]) -> Direction:
        """Aggregate multiple directions into one."""
        if not directions:
            return Direction.UNKNOWN

        # Count by type
        low_count = sum(1 for d in directions if d in [Direction.TOO_LOW, Direction.SLIGHTLY_LOW])
        high_count = sum(1 for d in directions if d in [Direction.TOO_HIGH, Direction.SLIGHTLY_HIGH])
        in_range_count = sum(1 for d in directions if d == Direction.IN_RANGE)

        if in_range_count >= len(directions) / 2:
            return Direction.IN_RANGE
        elif low_count > high_count:
            # Check if any are TOO_LOW
            if any(d == Direction.TOO_LOW for d in directions):
                return Direction.TOO_LOW
            return Direction.SLIGHTLY_LOW
        elif high_count > low_count:
            if any(d == Direction.TOO_HIGH for d in directions):
                return Direction.TOO_HIGH
            return Direction.SLIGHTLY_HIGH
        else:
            return Direction.IN_RANGE  # Tie goes to in-range

    def _aggregate_severity(self, severities: List[Severity]) -> Severity:
        """Aggregate severities - take maximum."""
        if not severities:
            return Severity.NONE

        severity_order = [Severity.NONE, Severity.LOW, Severity.MEDIUM, Severity.HIGH, Severity.CRITICAL]
        max_idx = max(severity_order.index(s) for s in severities)
        return severity_order[max_idx]

    def calculate_all_profile_deltas(
        self,
        features: Dict[str, Any],
    ) -> Dict[str, ProfileDelta]:
        """
        Calculate deltas for all profiles.

        Args:
            features: Dictionary of all feature values

        Returns:
            Dictionary mapping profile ID to ProfileDelta
        """
        from .constants import PROFILE_ORDER

        results = {}
        for profile in PROFILE_ORDER:
            results[profile] = self.calculate_profile_delta(profile, features)
        return results
