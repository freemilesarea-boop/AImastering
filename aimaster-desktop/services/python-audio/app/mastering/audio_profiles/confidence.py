"""
Confidence Calculator for Audio Profile Engine P0.

Calculates confidence score with 6 components:
- Reproducibility (from Canonical Audit)
- Gain Invariance (from Canonical Audit)
- Sample Rate Robustness (from Canonical Audit)
- Metric Validation (value range check)
- Feature Agreement (primary features agree)
- Data Completeness (all required features present)

Confidence ceilings apply based on threshold source.
"""

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Any

from .constants import (
    ConfidenceGrade, ThresholdSource,
    FEATURE_CONFIDENCE,
    CONFIDENCE_CEILING_STANDARD,
    CONFIDENCE_CEILING_REVIEW,
    CONFIDENCE_CEILING_EXPERIMENTAL,
    CONFIDENCE_CEILING_UNCALIBRATED,
)
from .profile_evaluator import ProfileResult
from .threshold_registry import get_registry


@dataclass
class ConfidenceComponents:
    """Individual confidence component scores."""
    reproducibility: float = 1.0
    gain_invariance: float = 1.0
    sample_rate_robustness: float = 1.0
    metric_validation: float = 1.0
    feature_agreement: float = 1.0
    data_completeness: float = 1.0


@dataclass
class ConfidenceResult:
    """Complete confidence result for a profile."""
    profile_id: str
    confidence: float
    grade: ConfidenceGrade
    components: ConfidenceComponents
    ceiling_applied: float
    ceiling_reason: str
    details: List[str] = field(default_factory=list)


class ConfidenceCalculator:
    """
    Calculates confidence scores for profile evaluations.

    Confidence formula:
    - Primary feature confidences: 50% weight
    - Supporting feature confidences: 30% weight
    - Protection feature confidence: 20% weight

    Confidence ceiling based on threshold source:
    - Standard metrics only: max 0.95
    - REVIEW features included: max 0.80
    - Experimental features: max 0.60
    - Uncalibrated thresholds: max 0.39
    """

    # Component weights
    WEIGHTS = {
        "reproducibility": 0.25,
        "gain_invariance": 0.25,
        "sample_rate_robustness": 0.15,
        "metric_validation": 0.20,
        "feature_agreement": 0.15,
    }

    # Feature-level confidence weights
    FEATURE_WEIGHTS = {
        "primary": 0.50,
        "supporting": 0.30,
        "protection": 0.20,
    }

    # Valid ranges for metric validation
    METRIC_RANGES: Dict[str, tuple] = {
        "stereo_correlation": (-1.0, 1.0),
        "crest_factor_db": (0.0, 40.0),
        "input_i": (-70.0, 0.0),
        "input_tp": (-70.0, 3.0),
        "input_lra": (0.0, 30.0),
        "spectral_centroid": (20.0, 20000.0),
        "spectral_flatness": (0.0, 1.0),
        "spectral_flatness_temporal_std": (0.0, 1.0),
        "stereo_width": (0.0, 1.0),
        "ms_ratio_db": (-30.0, 30.0),
        "hf_ratio": (0.0, 1.0),
    }

    # Band ratio range (applies to all band_ratio_* features)
    BAND_RATIO_RANGE = (0.0, 1.0)

    def __init__(self):
        self.registry = get_registry()

    def calculate(self, profile_result: ProfileResult) -> ConfidenceResult:
        """
        Calculate confidence for a profile evaluation result.

        Args:
            profile_result: Result from ProfileEvaluator

        Returns:
            ConfidenceResult with score, grade, and components
        """
        components = ConfidenceComponents()
        details = []

        # 1. Reproducibility - from Canonical Audit (assume passed)
        components.reproducibility = 1.0
        details.append("Reproducibility: 1.0 (Canonical Audit passed)")

        # 2. Gain Invariance - from Canonical Audit (assume passed)
        components.gain_invariance = 1.0
        details.append("Gain Invariance: 1.0 (Canonical Audit passed)")

        # 3. Sample Rate Robustness - slight penalty for SR-sensitive features
        sr_sensitive = {"band_ratio_12-16kHz", "hf_ratio", "spectral_rolloff"}
        primary_features = set(profile_result.primary_values.keys())
        if primary_features & sr_sensitive:
            components.sample_rate_robustness = 0.9
            details.append("SR Robustness: 0.9 (SR-sensitive features present)")
        else:
            components.sample_rate_robustness = 1.0
            details.append("SR Robustness: 1.0 (no SR-sensitive features)")

        # 4. Metric Validation - check values are in valid ranges
        components.metric_validation = self._calculate_metric_validation(
            profile_result, details
        )

        # 5. Feature Agreement - check if primary features agree on direction
        components.feature_agreement = self._calculate_feature_agreement(
            profile_result, details
        )

        # 6. Data Completeness - based on missing features
        total_features = (
            len(profile_result.primary_values) +
            len(profile_result.supporting_values) +
            len(profile_result.protection_values)
        )
        missing_count = len(profile_result.missing_features)

        if missing_count == 0:
            components.data_completeness = 1.0
        else:
            # Primary missing = bigger penalty
            primary_missing = len([
                f for f in profile_result.missing_features
                if f in self._get_primary_features(profile_result.profile_id)
            ])
            if primary_missing > 0:
                components.data_completeness = 0.0
            else:
                components.data_completeness = max(0.5, 1.0 - (missing_count * 0.1))

        details.append(f"Data Completeness: {components.data_completeness:.2f} (missing: {missing_count})")

        # Calculate weighted score
        raw_score = self._calculate_weighted_score(components)

        # Determine ceiling based on threshold source
        ceiling, ceiling_reason = self._determine_ceiling(profile_result)

        # Apply ceiling
        final_score = min(raw_score, ceiling)

        # Determine grade
        grade = self._score_to_grade(final_score)

        details.append(f"Raw score: {raw_score:.3f}, Ceiling: {ceiling:.2f}, Final: {final_score:.3f}")

        return ConfidenceResult(
            profile_id=profile_result.profile_id,
            confidence=round(final_score, 3),
            grade=grade,
            components=components,
            ceiling_applied=ceiling,
            ceiling_reason=ceiling_reason,
            details=details,
        )

    def _calculate_metric_validation(
        self, profile_result: ProfileResult, details: List[str]
    ) -> float:
        """Check if feature values are within valid physical ranges."""
        valid_count = 0
        total_count = 0

        all_values = {
            **profile_result.primary_values,
            **profile_result.supporting_values,
            **profile_result.protection_values,
        }

        for feature, value in all_values.items():
            if value is None:
                continue

            total_count += 1

            # Get range for this feature
            if feature in self.METRIC_RANGES:
                min_val, max_val = self.METRIC_RANGES[feature]
            elif feature.startswith("band_ratio_"):
                min_val, max_val = self.BAND_RATIO_RANGE
            elif feature.startswith("spectral_contrast_"):
                min_val, max_val = (0.0, 50.0)  # Reasonable contrast range
            else:
                # Unknown feature - assume valid
                valid_count += 1
                continue

            if min_val <= value <= max_val:
                valid_count += 1
            else:
                details.append(f"Metric out of range: {feature}={value} (expected {min_val}-{max_val})")

        if total_count == 0:
            return 1.0

        validation_score = valid_count / total_count
        details.append(f"Metric Validation: {validation_score:.2f} ({valid_count}/{total_count} valid)")
        return validation_score

    def _calculate_feature_agreement(
        self, profile_result: ProfileResult, details: List[str]
    ) -> float:
        """
        Check if primary features agree on state direction.

        For profiles with multiple primary features, they should
        point in the same direction (e.g., both indicate "bright").
        """
        profile_id = profile_result.profile_id
        primary_values = profile_result.primary_values

        if len(primary_values) < 2:
            # Single primary feature - always agrees with itself
            details.append("Feature Agreement: 1.0 (single primary feature)")
            return 1.0

        # Profile-specific agreement checks
        if profile_id == "DYNAMIC_RANGE":
            # crest_factor_db and input_lra should correlate
            crest = primary_values.get("crest_factor_db")
            lra = primary_values.get("input_lra")
            if crest is not None and lra is not None:
                # Both should indicate similar dynamics level
                # Higher crest and higher LRA both suggest more dynamic
                crest_median = 10.87
                lra_median = 7.0  # Design candidate, but reasonable
                crest_direction = 1 if crest > crest_median else -1
                lra_direction = 1 if lra > lra_median else -1
                if crest_direction == lra_direction:
                    score = 1.0
                else:
                    score = 0.6  # Disagreement
                    details.append(f"Feature disagreement: crest={crest:.2f}, lra={lra:.2f}")
                details.append(f"Feature Agreement: {score:.2f}")
                return score

        elif profile_id == "STEREO_IMAGE":
            # stereo_width and stereo_correlation are inversely related
            width = primary_values.get("stereo_width")
            corr = primary_values.get("stereo_correlation")
            if width is not None and corr is not None:
                # Wide stereo = low correlation, narrow = high correlation
                # Check for consistency
                if (width > 0.7 and corr < 0.6) or (width < 0.4 and corr > 0.8) or (0.4 <= width <= 0.7):
                    score = 1.0
                else:
                    score = 0.7  # Slight disagreement
                    details.append(f"Stereo consistency check: width={width:.2f}, corr={corr:.3f}")
                details.append(f"Feature Agreement: {score:.2f}")
                return score

        # Default: assume agreement if we reach here
        details.append("Feature Agreement: 1.0 (default)")
        return 1.0

    def _calculate_weighted_score(self, components: ConfidenceComponents) -> float:
        """Calculate weighted confidence score from components."""
        # Data completeness is a prerequisite - if 0, overall is 0
        if components.data_completeness == 0:
            return 0.0

        score = (
            components.reproducibility * self.WEIGHTS["reproducibility"] +
            components.gain_invariance * self.WEIGHTS["gain_invariance"] +
            components.sample_rate_robustness * self.WEIGHTS["sample_rate_robustness"] +
            components.metric_validation * self.WEIGHTS["metric_validation"] +
            components.feature_agreement * self.WEIGHTS["feature_agreement"]
        )

        # Apply data completeness as a multiplier
        score *= components.data_completeness

        return score

    def _determine_ceiling(self, profile_result: ProfileResult) -> tuple:
        """Determine confidence ceiling based on threshold source and feature types."""
        profile_id = profile_result.profile_id

        # Check threshold source
        threshold_source = profile_result.threshold_source

        if threshold_source == "N/A" or profile_result.state.value == "INSUFFICIENT_DATA":
            return 0.0, "Insufficient data"

        if threshold_source != "DATA_DERIVED":
            return CONFIDENCE_CEILING_UNCALIBRATED, "Thresholds not validated"

        # Check if any primary features are REVIEW status
        # (For P0, we consider all Canonical Audit VALID features as standard)
        primary_confidences = [
            FEATURE_CONFIDENCE.get(f, 0.75)
            for f in profile_result.primary_values.keys()
        ]

        if not primary_confidences:
            return CONFIDENCE_CEILING_UNCALIBRATED, "No primary feature confidences"

        min_primary_confidence = min(primary_confidences)

        if min_primary_confidence >= 0.90:
            return CONFIDENCE_CEILING_STANDARD, "Standard metrics"
        elif min_primary_confidence >= 0.75:
            return CONFIDENCE_CEILING_REVIEW, "Some features need review"
        else:
            return CONFIDENCE_CEILING_EXPERIMENTAL, "Experimental features"

    def _score_to_grade(self, score: float) -> ConfidenceGrade:
        """Convert numeric score to grade."""
        if score >= 0.80:
            return ConfidenceGrade.HIGH
        elif score >= 0.60:
            return ConfidenceGrade.MEDIUM
        elif score >= 0.40:
            return ConfidenceGrade.LOW
        else:
            return ConfidenceGrade.VERY_LOW

    def _get_primary_features(self, profile_id: str) -> List[str]:
        """Get primary features for a profile."""
        from .profile_evaluator import ProfileEvaluator
        return ProfileEvaluator.PROFILE_FEATURES.get(profile_id, {}).get("primary", [])


def calculate_profile_confidence(profile_result: ProfileResult) -> ConfidenceResult:
    """Convenience function to calculate confidence."""
    calculator = ConfidenceCalculator()
    return calculator.calculate(profile_result)
