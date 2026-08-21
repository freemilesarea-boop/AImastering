"""
Threshold Registry - Tracks source and validity of all thresholds.

P0 Rule: Only DATA_DERIVED thresholds can determine Profile State.
DESIGN_CANDIDATE, HEURISTIC, UNKNOWN -> state = UNCALIBRATED
"""

from dataclasses import dataclass
from typing import Dict, Optional, Any
from .constants import ThresholdSource


@dataclass
class ThresholdEntry:
    """Single threshold entry with source tracking."""
    profile: str
    threshold_name: str
    value: Any
    source: ThresholdSource
    source_file: Optional[str] = None
    source_feature: Optional[str] = None
    percentile_basis: Optional[str] = None  # e.g., "P50", "P25-P75"
    data_based: bool = False
    notes: str = ""


class ThresholdRegistry:
    """
    Registry of all thresholds with source classification.

    Thresholds are classified as:
    - DATA_DERIVED: From actual commercial reference data (07_statistical_comparison.json)
    - DESIGN_CANDIDATE: Proposed in design but not validated
    - HEURISTIC: Industry standard / rule of thumb
    - UNKNOWN: Source unclear
    """

    def __init__(self):
        self._thresholds: Dict[str, Dict[str, ThresholdEntry]] = {}
        self._build_registry()

    def _build_registry(self):
        """Build threshold registry with source classification."""

        # =====================================================================
        # DATA_DERIVED thresholds (from 07_statistical_comparison.json)
        # These are the ONLY thresholds that can determine state in P0
        # =====================================================================

        # DYNAMIC_RANGE - crest_factor_db
        # Source: commercial_mean=10.77, commercial_p25=9.78, commercial_p50=10.87, commercial_p75=11.64
        self._add("DYNAMIC_RANGE", "crest_factor_commercial_median", 10.87,
                  ThresholdSource.DATA_DERIVED,
                  source_file="07_statistical_comparison.json",
                  source_feature="crest_factor_db",
                  percentile_basis="P50")
        self._add("DYNAMIC_RANGE", "crest_factor_commercial_p25", 9.78,
                  ThresholdSource.DATA_DERIVED,
                  source_file="07_statistical_comparison.json",
                  source_feature="crest_factor_db",
                  percentile_basis="P25")
        self._add("DYNAMIC_RANGE", "crest_factor_commercial_p75", 11.64,
                  ThresholdSource.DATA_DERIVED,
                  source_file="07_statistical_comparison.json",
                  source_feature="crest_factor_db",
                  percentile_basis="P75")
        self._add("DYNAMIC_RANGE", "crest_factor_commercial_p5", 8.17,
                  ThresholdSource.DATA_DERIVED,
                  source_file="07_statistical_comparison.json",
                  source_feature="crest_factor_db",
                  percentile_basis="P5")
        self._add("DYNAMIC_RANGE", "crest_factor_commercial_p95", 13.75,
                  ThresholdSource.DATA_DERIVED,
                  source_file="07_statistical_comparison.json",
                  source_feature="crest_factor_db",
                  percentile_basis="P95")
        self._add("DYNAMIC_RANGE", "crest_factor_commercial_iqr", 1.86,
                  ThresholdSource.DATA_DERIVED,
                  source_file="07_statistical_comparison.json",
                  source_feature="crest_factor_db",
                  percentile_basis="IQR")

        # BRIGHTNESS - spectral_centroid
        # Source: commercial_mean=3144, commercial_p25=2683, commercial_p50=3147, commercial_p75=3482
        self._add("BRIGHTNESS", "centroid_commercial_median", 3147.0,
                  ThresholdSource.DATA_DERIVED,
                  source_file="07_statistical_comparison.json",
                  source_feature="spectral_centroid",
                  percentile_basis="P50")
        self._add("BRIGHTNESS", "centroid_commercial_p25", 2683.0,
                  ThresholdSource.DATA_DERIVED,
                  source_file="07_statistical_comparison.json",
                  source_feature="spectral_centroid",
                  percentile_basis="P25")
        self._add("BRIGHTNESS", "centroid_commercial_p75", 3482.0,
                  ThresholdSource.DATA_DERIVED,
                  source_file="07_statistical_comparison.json",
                  source_feature="spectral_centroid",
                  percentile_basis="P75")
        self._add("BRIGHTNESS", "centroid_commercial_p5", 2273.0,
                  ThresholdSource.DATA_DERIVED,
                  source_file="07_statistical_comparison.json",
                  source_feature="spectral_centroid",
                  percentile_basis="P5")
        self._add("BRIGHTNESS", "centroid_commercial_p95", 4126.0,
                  ThresholdSource.DATA_DERIVED,
                  source_file="07_statistical_comparison.json",
                  source_feature="spectral_centroid",
                  percentile_basis="P95")
        self._add("BRIGHTNESS", "centroid_commercial_iqr", 799.0,
                  ThresholdSource.DATA_DERIVED,
                  source_file="07_statistical_comparison.json",
                  source_feature="spectral_centroid",
                  percentile_basis="IQR")

        # PRESENCE - spectral_contrast_band_4 (2-4kHz)
        # Source: commercial_mean=6.48, commercial_median=6.46
        self._add("PRESENCE", "contrast_band4_commercial_median", 6.46,
                  ThresholdSource.DATA_DERIVED,
                  source_file="07_statistical_comparison.json",
                  source_feature="spectral_contrast_band_4_2000-4000Hz",
                  percentile_basis="P50")
        self._add("PRESENCE", "contrast_band4_commercial_mean", 6.48,
                  ThresholdSource.DATA_DERIVED,
                  source_file="07_statistical_comparison.json",
                  source_feature="spectral_contrast_band_4_2000-4000Hz",
                  percentile_basis="mean")

        # STEREO_IMAGE - stereo_correlation
        # Source: commercial_mean=0.79, commercial_p25=0.71, commercial_p50=0.80, commercial_p75=0.90
        self._add("STEREO_IMAGE", "correlation_commercial_median", 0.80,
                  ThresholdSource.DATA_DERIVED,
                  source_file="07_statistical_comparison.json",
                  source_feature="stereo_correlation",
                  percentile_basis="P50")
        self._add("STEREO_IMAGE", "correlation_commercial_p25", 0.71,
                  ThresholdSource.DATA_DERIVED,
                  source_file="07_statistical_comparison.json",
                  source_feature="stereo_correlation",
                  percentile_basis="P25")
        self._add("STEREO_IMAGE", "correlation_commercial_p75", 0.90,
                  ThresholdSource.DATA_DERIVED,
                  source_file="07_statistical_comparison.json",
                  source_feature="stereo_correlation",
                  percentile_basis="P75")
        self._add("STEREO_IMAGE", "correlation_commercial_p5", 0.57,
                  ThresholdSource.DATA_DERIVED,
                  source_file="07_statistical_comparison.json",
                  source_feature="stereo_correlation",
                  percentile_basis="P5")
        self._add("STEREO_IMAGE", "correlation_commercial_iqr", 0.19,
                  ThresholdSource.DATA_DERIVED,
                  source_file="07_statistical_comparison.json",
                  source_feature="stereo_correlation",
                  percentile_basis="IQR")

        # ms_ratio_db
        self._add("STEREO_IMAGE", "ms_ratio_commercial_median", 9.56,
                  ThresholdSource.DATA_DERIVED,
                  source_file="07_statistical_comparison.json",
                  source_feature="ms_ratio_db",
                  percentile_basis="P50")
        self._add("STEREO_IMAGE", "ms_ratio_commercial_p25", 7.72,
                  ThresholdSource.DATA_DERIVED,
                  source_file="07_statistical_comparison.json",
                  source_feature="ms_ratio_db",
                  percentile_basis="P25")
        self._add("STEREO_IMAGE", "ms_ratio_commercial_p75", 12.69,
                  ThresholdSource.DATA_DERIVED,
                  source_file="07_statistical_comparison.json",
                  source_feature="ms_ratio_db",
                  percentile_basis="P75")

        # spectral_flatness_temporal_std
        self._add("TEXTURE", "flatness_std_commercial_median", 0.12,
                  ThresholdSource.DATA_DERIVED,
                  source_file="07_statistical_comparison.json",
                  source_feature="spectral_flatness_temporal_std",
                  percentile_basis="P50")
        self._add("TEXTURE", "flatness_std_commercial_p25", 0.105,
                  ThresholdSource.DATA_DERIVED,
                  source_file="07_statistical_comparison.json",
                  source_feature="spectral_flatness_temporal_std",
                  percentile_basis="P25")
        self._add("TEXTURE", "flatness_std_commercial_p75", 0.136,
                  ThresholdSource.DATA_DERIVED,
                  source_file="07_statistical_comparison.json",
                  source_feature="spectral_flatness_temporal_std",
                  percentile_basis="P75")

        # hf_ratio
        self._add("BRIGHTNESS", "hf_ratio_commercial_median", 0.006,
                  ThresholdSource.DATA_DERIVED,
                  source_file="07_statistical_comparison.json",
                  source_feature="hf_ratio",
                  percentile_basis="P50")
        self._add("BRIGHTNESS", "hf_ratio_commercial_p25", 0.0032,
                  ThresholdSource.DATA_DERIVED,
                  source_file="07_statistical_comparison.json",
                  source_feature="hf_ratio",
                  percentile_basis="P25")
        self._add("BRIGHTNESS", "hf_ratio_commercial_p75", 0.0097,
                  ThresholdSource.DATA_DERIVED,
                  source_file="07_statistical_comparison.json",
                  source_feature="hf_ratio",
                  percentile_basis="P75")

        # spectral_contrast_band_1 (250-500Hz)
        self._add("WARMTH", "contrast_band1_commercial_median", 8.12,
                  ThresholdSource.DATA_DERIVED,
                  source_file="07_statistical_comparison.json",
                  source_feature="spectral_contrast_band_1_250-500Hz",
                  percentile_basis="P50")

        # spectral_contrast_band_6 (8-16kHz)
        self._add("BRIGHTNESS", "contrast_band6_commercial_median", 11.55,
                  ThresholdSource.DATA_DERIVED,
                  source_file="07_statistical_comparison.json",
                  source_feature="spectral_contrast_band_6_8000-16000Hz",
                  percentile_basis="P50")

        # spectral_contrast_mean
        self._add("TEXTURE", "contrast_mean_commercial_median", 9.62,
                  ThresholdSource.DATA_DERIVED,
                  source_file="07_statistical_comparison.json",
                  source_feature="spectral_contrast_mean",
                  percentile_basis="P50")

        # =====================================================================
        # DESIGN_CANDIDATE thresholds (from 01_profile_definitions.json)
        # These cannot determine state in P0 - will result in UNCALIBRATED
        # =====================================================================

        # LOUDNESS - input_i ranges (design proposal)
        self._add("LOUDNESS", "input_i_median", -9.0,
                  ThresholdSource.DESIGN_CANDIDATE,
                  source_file="01_profile_definitions.json",
                  notes="Design proposal, not validated against data")
        self._add("LOUDNESS", "input_i_range_low", -14.0,
                  ThresholdSource.DESIGN_CANDIDATE,
                  source_file="01_profile_definitions.json")
        self._add("LOUDNESS", "input_i_range_high", -6.0,
                  ThresholdSource.DESIGN_CANDIDATE,
                  source_file="01_profile_definitions.json")
        self._add("LOUDNESS", "rms_db_median", -12.5,
                  ThresholdSource.DESIGN_CANDIDATE,
                  source_file="01_profile_definitions.json")
        self._add("LOUDNESS", "action_trigger", 1.5,
                  ThresholdSource.DESIGN_CANDIDATE,
                  source_file="01_profile_definitions.json")

        # PEAK_SAFETY - True Peak thresholds
        self._add("PEAK_SAFETY", "tp_target", -1.0,
                  ThresholdSource.HEURISTIC,
                  notes="Industry standard True Peak ceiling")
        self._add("PEAK_SAFETY", "tp_max", -0.1,
                  ThresholdSource.HEURISTIC,
                  notes="Streaming platform requirement")
        self._add("PEAK_SAFETY", "ceiling", -1.0,
                  ThresholdSource.DESIGN_CANDIDATE,
                  source_file="01_profile_definitions.json")

        # DYNAMIC_RANGE - additional thresholds
        self._add("DYNAMIC_RANGE", "min_crest", 6.0,
                  ThresholdSource.HEURISTIC,
                  notes="Below this = over-compressed")
        self._add("DYNAMIC_RANGE", "max_crest", 18.0,
                  ThresholdSource.HEURISTIC,
                  notes="Above this = under-processed")
        self._add("DYNAMIC_RANGE", "action_trigger", 1.0,
                  ThresholdSource.DESIGN_CANDIDATE,
                  source_file="01_profile_definitions.json")
        self._add("DYNAMIC_RANGE", "lra_median", 7.0,
                  ThresholdSource.DESIGN_CANDIDATE,
                  source_file="01_profile_definitions.json")

        # BRIGHTNESS - additional thresholds
        self._add("BRIGHTNESS", "action_trigger", 200.0,
                  ThresholdSource.DESIGN_CANDIDATE,
                  source_file="01_profile_definitions.json")
        self._add("BRIGHTNESS", "hf_protection_max", 0.05,
                  ThresholdSource.DESIGN_CANDIDATE,
                  source_file="01_profile_definitions.json")

        # PRESENCE - additional thresholds
        self._add("PRESENCE", "band_ratio_2-4kHz_median", 0.15,
                  ThresholdSource.DESIGN_CANDIDATE,
                  source_file="01_profile_definitions.json")
        self._add("PRESENCE", "action_trigger", 0.02,
                  ThresholdSource.DESIGN_CANDIDATE,
                  source_file="01_profile_definitions.json")
        self._add("PRESENCE", "contrast_trigger", 1.0,
                  ThresholdSource.DESIGN_CANDIDATE,
                  source_file="01_profile_definitions.json")

        # WARMTH thresholds
        self._add("WARMTH", "band_ratio_250-500Hz_median", 0.18,
                  ThresholdSource.DESIGN_CANDIDATE,
                  source_file="01_profile_definitions.json")
        self._add("WARMTH", "band_ratio_500-1000Hz_median", 0.16,
                  ThresholdSource.DESIGN_CANDIDATE,
                  source_file="01_profile_definitions.json")
        self._add("WARMTH", "action_trigger", 0.02,
                  ThresholdSource.DESIGN_CANDIDATE,
                  source_file="01_profile_definitions.json")

        # LOW_END thresholds
        self._add("LOW_END", "band_ratio_20-60Hz_median", 0.08,
                  ThresholdSource.DESIGN_CANDIDATE,
                  source_file="01_profile_definitions.json")
        self._add("LOW_END", "band_ratio_60-120Hz_median", 0.12,
                  ThresholdSource.DESIGN_CANDIDATE,
                  source_file="01_profile_definitions.json")
        self._add("LOW_END", "action_trigger", 0.02,
                  ThresholdSource.DESIGN_CANDIDATE,
                  source_file="01_profile_definitions.json")
        self._add("LOW_END", "mono_correlation_min", 0.5,
                  ThresholdSource.HEURISTIC,
                  notes="Mono compatibility threshold for bass")

        # MID_CLARITY thresholds
        self._add("MID_CLARITY", "band_ratio_1-2kHz_median", 0.14,
                  ThresholdSource.DESIGN_CANDIDATE,
                  source_file="01_profile_definitions.json")
        self._add("MID_CLARITY", "band_ratio_6-8kHz_median", 0.08,
                  ThresholdSource.DESIGN_CANDIDATE,
                  source_file="01_profile_definitions.json")
        self._add("MID_CLARITY", "action_trigger", 0.015,
                  ThresholdSource.DESIGN_CANDIDATE,
                  source_file="01_profile_definitions.json")

        # STEREO_IMAGE - additional thresholds
        self._add("STEREO_IMAGE", "width_median", 0.65,
                  ThresholdSource.DESIGN_CANDIDATE,
                  source_file="01_profile_definitions.json")
        self._add("STEREO_IMAGE", "action_trigger_width", 0.1,
                  ThresholdSource.DESIGN_CANDIDATE,
                  source_file="01_profile_definitions.json")
        self._add("STEREO_IMAGE", "action_trigger_correlation", 0.1,
                  ThresholdSource.DESIGN_CANDIDATE,
                  source_file="01_profile_definitions.json")
        self._add("STEREO_IMAGE", "protection_correlation_min", 0.3,
                  ThresholdSource.HEURISTIC,
                  notes="Below this = mono compatibility warning")
        self._add("STEREO_IMAGE", "protection_correlation_critical", 0.1,
                  ThresholdSource.HEURISTIC,
                  notes="Below this = block stereo processing")

        # TRANSIENT thresholds
        self._add("TRANSIENT", "flux_median", 0.25,
                  ThresholdSource.DESIGN_CANDIDATE,
                  source_file="01_profile_definitions.json")
        self._add("TRANSIENT", "onset_density_median", 3.0,
                  ThresholdSource.DESIGN_CANDIDATE,
                  source_file="01_profile_definitions.json")
        self._add("TRANSIENT", "action_trigger", 0.1,
                  ThresholdSource.DESIGN_CANDIDATE,
                  source_file="01_profile_definitions.json")
        self._add("TRANSIENT", "density_low", 1.5,
                  ThresholdSource.DESIGN_CANDIDATE,
                  source_file="01_profile_definitions.json")
        self._add("TRANSIENT", "density_high", 6.0,
                  ThresholdSource.DESIGN_CANDIDATE,
                  source_file="01_profile_definitions.json")

        # TEXTURE thresholds
        self._add("TEXTURE", "flatness_median", 0.15,
                  ThresholdSource.DESIGN_CANDIDATE,
                  source_file="01_profile_definitions.json")
        self._add("TEXTURE", "action_trigger_contrast", 1.0,
                  ThresholdSource.DESIGN_CANDIDATE,
                  source_file="01_profile_definitions.json")
        self._add("TEXTURE", "action_trigger_flatness", 0.05,
                  ThresholdSource.DESIGN_CANDIDATE,
                  source_file="01_profile_definitions.json")
        self._add("TEXTURE", "flatness_high", 0.4,
                  ThresholdSource.DESIGN_CANDIDATE,
                  source_file="01_profile_definitions.json")

    def _add(self, profile: str, threshold_name: str, value: Any,
             source: ThresholdSource, **kwargs):
        """Add a threshold entry to the registry."""
        if profile not in self._thresholds:
            self._thresholds[profile] = {}

        self._thresholds[profile][threshold_name] = ThresholdEntry(
            profile=profile,
            threshold_name=threshold_name,
            value=value,
            source=source,
            data_based=(source == ThresholdSource.DATA_DERIVED),
            **kwargs
        )

    def get(self, profile: str, threshold_name: str) -> Optional[ThresholdEntry]:
        """Get a threshold entry."""
        if profile in self._thresholds:
            return self._thresholds[profile].get(threshold_name)
        return None

    def get_value(self, profile: str, threshold_name: str, default: Any = None) -> Any:
        """Get threshold value, returning default if not found."""
        entry = self.get(profile, threshold_name)
        return entry.value if entry else default

    def is_data_derived(self, profile: str, threshold_name: str) -> bool:
        """Check if threshold is derived from actual data."""
        entry = self.get(profile, threshold_name)
        return entry.data_based if entry else False

    def get_profile_thresholds(self, profile: str) -> Dict[str, ThresholdEntry]:
        """Get all thresholds for a profile."""
        return self._thresholds.get(profile, {})

    def has_data_derived_thresholds(self, profile: str) -> bool:
        """Check if profile has any data-derived thresholds."""
        thresholds = self.get_profile_thresholds(profile)
        return any(t.data_based for t in thresholds.values())

    def get_all_entries(self) -> Dict[str, Dict[str, ThresholdEntry]]:
        """Get all threshold entries."""
        return self._thresholds

    def generate_audit_report(self) -> Dict:
        """Generate threshold audit report for output."""
        report = {
            "total_thresholds": 0,
            "by_source": {
                "DATA_DERIVED": 0,
                "DESIGN_CANDIDATE": 0,
                "HEURISTIC": 0,
                "UNKNOWN": 0,
            },
            "by_profile": {},
            "entries": []
        }

        for profile, thresholds in self._thresholds.items():
            report["by_profile"][profile] = {
                "total": len(thresholds),
                "data_derived": sum(1 for t in thresholds.values() if t.data_based),
            }
            for name, entry in thresholds.items():
                report["total_thresholds"] += 1
                report["by_source"][entry.source.value] += 1
                report["entries"].append({
                    "profile": entry.profile,
                    "threshold": entry.threshold_name,
                    "value": entry.value,
                    "source": entry.source.value,
                    "source_file": entry.source_file,
                    "source_feature": entry.source_feature,
                    "percentile_basis": entry.percentile_basis,
                    "data_based": entry.data_based,
                    "notes": entry.notes,
                })

        return report


# Singleton instance
_registry: Optional[ThresholdRegistry] = None


def get_registry() -> ThresholdRegistry:
    """Get the global threshold registry."""
    global _registry
    if _registry is None:
        _registry = ThresholdRegistry()
    return _registry
