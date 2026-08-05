"""
Profile Evaluator for Audio Profile Engine P0.

Implements Primary/Supporting/Protection feature rules:
- Primary features determine state direction
- Supporting features modify severity
- Protection features restrict DSP actions

P0 Rule: Only DATA_DERIVED thresholds can determine state.
Missing thresholds -> UNCALIBRATED
Missing primary features -> INSUFFICIENT_DATA
"""

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Any, Tuple

from .constants import (
    ProfileState, Severity, ThresholdSource, PROFILE_ORDER
)
from .threshold_registry import get_registry, ThresholdRegistry
from .feature_input import FeatureSet


@dataclass
class ProfileResult:
    """Result of evaluating a single profile."""
    profile_id: str
    state: ProfileState
    severity: Optional[Severity]
    primary_values: Dict[str, Any]
    supporting_values: Dict[str, Any]
    protection_values: Dict[str, Any]
    deviation_from_commercial: Dict[str, float]
    evidence: List[str]
    missing_features: List[str]
    threshold_source: str  # "DATA_DERIVED", "DESIGN_CANDIDATE", etc.
    warnings: List[str] = field(default_factory=list)


class ProfileEvaluator:
    """
    Evaluates audio features against profile definitions.

    Primary/Supporting/Protection Rules:
    1. If primary features are missing -> state = INSUFFICIENT_DATA
    2. If thresholds are not DATA_DERIVED -> state = UNCALIBRATED
    3. Supporting features only modify severity, never direction
    4. Protection features only restrict actions, never determine state
    """

    # Profile definitions: primary, supporting, protection features
    PROFILE_FEATURES: Dict[str, Dict[str, List[str]]] = {
        "LOUDNESS": {
            "primary": ["input_i", "rms_db"],
            "supporting": ["peak_db", "input_tp"],
            "protection": ["input_lra"],
        },
        "PEAK_SAFETY": {
            "primary": ["input_tp", "peak_db"],
            "supporting": ["crest_factor_db"],
            "protection": ["stereo_correlation"],
        },
        "DYNAMIC_RANGE": {
            "primary": ["crest_factor_db", "input_lra"],
            "supporting": ["rms_std", "crest_factor_variance", "compression_density"],
            "protection": ["envelope_smoothness"],
        },
        "BRIGHTNESS": {
            "primary": ["spectral_centroid"],
            "supporting": ["hf_ratio", "band_ratio_8-10kHz", "band_ratio_10-12kHz", "band_ratio_12-16kHz"],
            "protection": ["spectral_rolloff", "hf_ratio_variance"],
        },
        "PRESENCE": {
            "primary": ["band_ratio_2-4kHz", "spectral_contrast_band_4"],
            "supporting": ["band_ratio_4-6kHz", "spectral_contrast_band_5"],
            "protection": ["spectral_flatness_temporal_std"],
        },
        "WARMTH": {
            "primary": ["band_ratio_250-500Hz", "band_ratio_500-1000Hz"],
            "supporting": ["band_ratio_120-250Hz", "spectral_contrast_band_1", "spectral_contrast_band_2"],
            "protection": ["spectral_contrast_band_3"],
        },
        "LOW_END": {
            "primary": ["band_ratio_20-60Hz", "band_ratio_60-120Hz"],
            "supporting": ["spectral_contrast_band_0"],
            "protection": ["stereo_correlation"],
        },
        "MID_CLARITY": {
            "primary": ["band_ratio_1-2kHz", "band_ratio_6-8kHz"],
            "supporting": ["spectral_contrast_band_3"],
            "protection": ["spectral_flatness_temporal_std"],
        },
        "STEREO_IMAGE": {
            "primary": ["stereo_width", "stereo_correlation"],
            "supporting": ["ms_ratio_db", "lr_balance_db"],
            "protection": ["stereo_correlation"],  # Self-protection
        },
        "TRANSIENT": {
            "primary": ["spectral_flux_normalized_mean", "onset_density"],
            "supporting": ["spectral_flux_normalized_std"],
            "protection": ["envelope_range_normalized", "envelope_std_normalized"],
        },
        "TEXTURE": {
            "primary": ["spectral_contrast_mean", "spectral_flatness"],
            "supporting": ["spectral_contrast_band_2", "spectral_contrast_band_5", "broadband_flatness"],
            "protection": ["spectral_flatness_temporal_std"],
        },
    }

    def __init__(self, registry: Optional[ThresholdRegistry] = None):
        self.registry = registry or get_registry()

    def evaluate_profile(self, profile_id: str, features: FeatureSet) -> ProfileResult:
        """
        Evaluate a single profile for a track.

        Args:
            profile_id: Profile ID (e.g., "BRIGHTNESS")
            features: FeatureSet containing the track's features

        Returns:
            ProfileResult with state, severity, and evidence
        """
        if profile_id not in self.PROFILE_FEATURES:
            raise ValueError(f"Unknown profile: {profile_id}")

        profile_def = self.PROFILE_FEATURES[profile_id]
        primary_features = profile_def["primary"]
        supporting_features = profile_def["supporting"]
        protection_features = profile_def["protection"]

        # Collect feature values
        primary_values = {}
        supporting_values = {}
        protection_values = {}
        missing_features = []
        evidence = []
        warnings = []

        # Get primary feature values
        for feat in primary_features:
            val = features.get(feat)
            if val is not None:
                primary_values[feat] = val
            else:
                missing_features.append(feat)

        # Get supporting feature values
        for feat in supporting_features:
            val = features.get(feat)
            if val is not None:
                supporting_values[feat] = val

        # Get protection feature values
        for feat in protection_features:
            val = features.get(feat)
            if val is not None:
                protection_values[feat] = val

        # Check if we have enough primary features
        if len(primary_values) < len(primary_features):
            return ProfileResult(
                profile_id=profile_id,
                state=ProfileState.INSUFFICIENT_DATA,
                severity=None,
                primary_values=primary_values,
                supporting_values=supporting_values,
                protection_values=protection_values,
                deviation_from_commercial={},
                evidence=[f"Missing primary features: {missing_features}"],
                missing_features=missing_features,
                threshold_source="N/A",
                warnings=[f"Cannot evaluate {profile_id} - missing {len(missing_features)} primary feature(s)"],
            )

        # Check if we have DATA_DERIVED thresholds
        has_data_thresholds = self.registry.has_data_derived_thresholds(profile_id)

        # Evaluate state based on profile type
        if has_data_thresholds:
            state, severity, deviations, eval_evidence = self._evaluate_with_thresholds(
                profile_id, primary_values, supporting_values
            )
            threshold_source = "DATA_DERIVED"
            evidence.extend(eval_evidence)
        else:
            # No data-derived thresholds -> UNCALIBRATED
            state = ProfileState.UNCALIBRATED
            severity = None
            deviations = {}
            evidence.append(f"No DATA_DERIVED thresholds for {profile_id}")
            threshold_source = "DESIGN_CANDIDATE"
            warnings.append(f"{profile_id} state is UNCALIBRATED - thresholds not validated")

        return ProfileResult(
            profile_id=profile_id,
            state=state,
            severity=severity,
            primary_values=primary_values,
            supporting_values=supporting_values,
            protection_values=protection_values,
            deviation_from_commercial=deviations,
            evidence=evidence,
            missing_features=missing_features,
            threshold_source=threshold_source,
            warnings=warnings,
        )

    def _evaluate_with_thresholds(
        self, profile_id: str,
        primary_values: Dict[str, Any],
        supporting_values: Dict[str, Any]
    ) -> Tuple[ProfileState, Optional[Severity], Dict[str, float], List[str]]:
        """Evaluate state using DATA_DERIVED thresholds."""

        if profile_id == "DYNAMIC_RANGE":
            return self._evaluate_dynamic_range(primary_values, supporting_values)
        elif profile_id == "BRIGHTNESS":
            return self._evaluate_brightness(primary_values, supporting_values)
        elif profile_id == "PRESENCE":
            return self._evaluate_presence(primary_values, supporting_values)
        elif profile_id == "STEREO_IMAGE":
            return self._evaluate_stereo(primary_values, supporting_values)
        elif profile_id == "TEXTURE":
            return self._evaluate_texture(primary_values, supporting_values)
        else:
            # No data-derived thresholds for this profile
            return ProfileState.UNCALIBRATED, None, {}, [f"No data thresholds for {profile_id}"]

    def _evaluate_dynamic_range(
        self, primary: Dict, supporting: Dict
    ) -> Tuple[ProfileState, Optional[Severity], Dict[str, float], List[str]]:
        """Evaluate DYNAMIC_RANGE profile."""
        crest = primary.get("crest_factor_db")
        if crest is None:
            return ProfileState.UNCALIBRATED, None, {}, ["Missing crest_factor_db"]

        # Get data-derived thresholds
        p50 = self.registry.get_value("DYNAMIC_RANGE", "crest_factor_commercial_median", 10.87)
        p25 = self.registry.get_value("DYNAMIC_RANGE", "crest_factor_commercial_p25", 9.78)
        p75 = self.registry.get_value("DYNAMIC_RANGE", "crest_factor_commercial_p75", 11.64)
        p5 = self.registry.get_value("DYNAMIC_RANGE", "crest_factor_commercial_p5", 8.17)
        p95 = self.registry.get_value("DYNAMIC_RANGE", "crest_factor_commercial_p95", 13.75)

        deviation = crest - p50
        deviations = {"crest_factor_db": deviation}
        evidence = [f"crest_factor_db={crest:.2f}, commercial_median={p50:.2f}, deviation={deviation:+.2f}"]

        # Determine state and severity
        if crest < p5:
            # Very compressed
            state = ProfileState.OVER_COMPRESSED
            severity = Severity.CRITICAL
            evidence.append(f"Below P5 ({p5:.2f}) - over-compressed")
        elif crest < p25:
            # Compressed
            state = ProfileState.COMPRESSED
            if crest < (p5 + p25) / 2:
                severity = Severity.HIGH
            else:
                severity = Severity.MEDIUM
            evidence.append(f"Below P25 ({p25:.2f}) - compressed")
        elif crest <= p75:
            # Balanced
            state = ProfileState.BALANCED
            severity = Severity.NONE
            evidence.append(f"Within P25-P75 range - balanced dynamics")
        elif crest <= p95:
            # Dynamic
            state = ProfileState.DYNAMIC
            if crest > (p75 + p95) / 2:
                severity = Severity.MEDIUM
            else:
                severity = Severity.LOW
            evidence.append(f"Above P75 ({p75:.2f}) - dynamic")
        else:
            # Very dynamic (above P95)
            state = ProfileState.DYNAMIC
            severity = Severity.HIGH
            evidence.append(f"Above P95 ({p95:.2f}) - very dynamic")

        return state, severity, deviations, evidence

    def _evaluate_brightness(
        self, primary: Dict, supporting: Dict
    ) -> Tuple[ProfileState, Optional[Severity], Dict[str, float], List[str]]:
        """Evaluate BRIGHTNESS profile."""
        centroid = primary.get("spectral_centroid")
        if centroid is None:
            return ProfileState.UNCALIBRATED, None, {}, ["Missing spectral_centroid"]

        # Get data-derived thresholds
        p50 = self.registry.get_value("BRIGHTNESS", "centroid_commercial_median", 3147.0)
        p25 = self.registry.get_value("BRIGHTNESS", "centroid_commercial_p25", 2683.0)
        p75 = self.registry.get_value("BRIGHTNESS", "centroid_commercial_p75", 3482.0)
        p5 = self.registry.get_value("BRIGHTNESS", "centroid_commercial_p5", 2273.0)
        p95 = self.registry.get_value("BRIGHTNESS", "centroid_commercial_p95", 4126.0)

        deviation = centroid - p50
        deviations = {"spectral_centroid": deviation}
        evidence = [f"spectral_centroid={centroid:.0f}Hz, commercial_median={p50:.0f}Hz, deviation={deviation:+.0f}Hz"]

        # Determine state and severity
        if centroid < p5:
            state = ProfileState.DARK
            severity = Severity.HIGH
            evidence.append(f"Below P5 ({p5:.0f}Hz) - very dark")
        elif centroid < p25:
            state = ProfileState.DARK
            severity = Severity.LOW if centroid > (p5 + p25) / 2 else Severity.MEDIUM
            evidence.append(f"Below P25 ({p25:.0f}Hz) - dark")
        elif centroid <= p75:
            state = ProfileState.BALANCED
            severity = Severity.NONE
            evidence.append(f"Within P25-P75 range - balanced brightness")
        elif centroid <= p95:
            state = ProfileState.BRIGHT
            severity = Severity.LOW if centroid < (p75 + p95) / 2 else Severity.MEDIUM
            evidence.append(f"Above P75 ({p75:.0f}Hz) - bright")
        else:
            state = ProfileState.BRIGHT
            severity = Severity.HIGH
            evidence.append(f"Above P95 ({p95:.0f}Hz) - very bright")

        return state, severity, deviations, evidence

    def _evaluate_presence(
        self, primary: Dict, supporting: Dict
    ) -> Tuple[ProfileState, Optional[Severity], Dict[str, float], List[str]]:
        """Evaluate PRESENCE profile."""
        contrast = primary.get("spectral_contrast_band_4")
        if contrast is None:
            return ProfileState.UNCALIBRATED, None, {}, ["Missing spectral_contrast_band_4"]

        # Get data-derived thresholds
        median = self.registry.get_value("PRESENCE", "contrast_band4_commercial_median", 6.46)
        mean = self.registry.get_value("PRESENCE", "contrast_band4_commercial_mean", 6.48)

        deviation = contrast - median
        deviations = {"spectral_contrast_band_4": deviation}
        evidence = [f"spectral_contrast_band_4={contrast:.2f}, commercial_median={median:.2f}, deviation={deviation:+.2f}"]

        # Simple threshold-based evaluation (no percentiles in data)
        # Using +-1.5 as rough IQR estimate
        iqr_estimate = 1.5

        if contrast < median - 1.5 * iqr_estimate:
            state = ProfileState.RECESSED
            severity = Severity.HIGH
            evidence.append("Significantly below commercial - recessed presence")
        elif contrast < median - 0.5 * iqr_estimate:
            state = ProfileState.RECESSED
            severity = Severity.LOW
            evidence.append("Below commercial median - slightly recessed")
        elif contrast <= median + 0.5 * iqr_estimate:
            state = ProfileState.BALANCED
            severity = Severity.NONE
            evidence.append("Near commercial median - balanced presence")
        elif contrast <= median + 1.5 * iqr_estimate:
            state = ProfileState.PRESENT
            severity = Severity.LOW
            evidence.append("Above commercial median - forward presence")
        else:
            state = ProfileState.PRESENT
            severity = Severity.HIGH
            evidence.append("Significantly above commercial - very forward")

        return state, severity, deviations, evidence

    def _evaluate_stereo(
        self, primary: Dict, supporting: Dict
    ) -> Tuple[ProfileState, Optional[Severity], Dict[str, float], List[str]]:
        """Evaluate STEREO_IMAGE profile."""
        correlation = primary.get("stereo_correlation")
        if correlation is None:
            return ProfileState.UNCALIBRATED, None, {}, ["Missing stereo_correlation"]

        # Get data-derived thresholds
        p50 = self.registry.get_value("STEREO_IMAGE", "correlation_commercial_median", 0.80)
        p25 = self.registry.get_value("STEREO_IMAGE", "correlation_commercial_p25", 0.71)
        p5 = self.registry.get_value("STEREO_IMAGE", "correlation_commercial_p5", 0.57)

        deviation = correlation - p50
        deviations = {"stereo_correlation": deviation}
        evidence = [f"stereo_correlation={correlation:.3f}, commercial_median={p50:.2f}, deviation={deviation:+.3f}"]

        # Check for phase issues first
        if correlation < 0.1:
            state = ProfileState.PHASE_RISK
            severity = Severity.CRITICAL
            evidence.append("Very low correlation - phase issues likely")
        elif correlation < 0.3:
            state = ProfileState.PHASE_RISK
            severity = Severity.HIGH
            evidence.append("Low correlation - potential phase issues")
        elif correlation < p5:
            state = ProfileState.WIDE
            severity = Severity.HIGH
            evidence.append(f"Below P5 ({p5:.2f}) - very wide stereo")
        elif correlation < p25:
            state = ProfileState.WIDE
            severity = Severity.LOW
            evidence.append(f"Below P25 ({p25:.2f}) - wide stereo")
        elif correlation <= 0.90:
            state = ProfileState.BALANCED
            severity = Severity.NONE
            evidence.append("Within normal correlation range")
        else:
            state = ProfileState.NARROW
            severity = Severity.LOW
            evidence.append("High correlation - narrow/mono-ish stereo")

        return state, severity, deviations, evidence

    def _evaluate_texture(
        self, primary: Dict, supporting: Dict
    ) -> Tuple[ProfileState, Optional[Severity], Dict[str, float], List[str]]:
        """
        Evaluate TEXTURE profile.

        TEXTURE is analysis-only in P0 - no DSP recommendations.
        States: CLEAN, TEXTURED, GRAINY_RISK, INSTABILITY_RISK, UNCALIBRATED
        """
        flatness_std = None
        # Try to get spectral_flatness_temporal_std from supporting or features
        if "spectral_flatness_temporal_std" in primary:
            flatness_std = primary["spectral_flatness_temporal_std"]

        contrast_mean = primary.get("spectral_contrast_mean")
        flatness = primary.get("spectral_flatness")

        if contrast_mean is None and flatness is None:
            return ProfileState.UNCALIBRATED, None, {}, ["Missing texture features"]

        deviations = {}
        evidence = []

        # Get data-derived thresholds
        if contrast_mean is not None:
            contrast_median = self.registry.get_value("TEXTURE", "contrast_mean_commercial_median", 9.62)
            deviation = contrast_mean - contrast_median
            deviations["spectral_contrast_mean"] = deviation
            evidence.append(f"spectral_contrast_mean={contrast_mean:.2f}, commercial={contrast_median:.2f}")

        if flatness_std is not None:
            std_median = self.registry.get_value("TEXTURE", "flatness_std_commercial_median", 0.12)
            std_p75 = self.registry.get_value("TEXTURE", "flatness_std_commercial_p75", 0.136)
            deviation_std = flatness_std - std_median
            deviations["spectral_flatness_temporal_std"] = deviation_std
            evidence.append(f"flatness_temporal_std={flatness_std:.4f}, commercial_median={std_median:.4f}")

            # Check for instability
            if flatness_std > std_p75 * 1.5:
                return ProfileState.INSTABILITY_RISK, Severity.MEDIUM, deviations, \
                    evidence + ["High temporal flatness variation - instability risk"]

        # Determine texture state
        if flatness is not None:
            if flatness > 0.35:
                state = ProfileState.GRAINY_RISK
                severity = Severity.MEDIUM
                evidence.append(f"High spectral flatness ({flatness:.3f}) - grainy texture risk")
            elif flatness > 0.25:
                state = ProfileState.TEXTURED
                severity = Severity.LOW
                evidence.append("Moderate spectral flatness - textured")
            elif flatness > 0.1:
                state = ProfileState.BALANCED
                severity = Severity.NONE
                evidence.append("Normal spectral flatness - balanced texture")
            else:
                state = ProfileState.CLEAN
                severity = Severity.NONE
                evidence.append("Low spectral flatness - clean texture")
        else:
            # Only have contrast_mean
            state = ProfileState.UNCALIBRATED
            severity = None
            evidence.append("Limited texture data - partial evaluation")

        return state, severity, deviations, evidence

    def evaluate_all_profiles(self, features: FeatureSet) -> Dict[str, ProfileResult]:
        """
        Evaluate all profiles for a track.

        Returns:
            Dictionary mapping profile_id to ProfileResult
        """
        results = {}
        for profile_id in PROFILE_ORDER:
            results[profile_id] = self.evaluate_profile(profile_id, features)
        return results
