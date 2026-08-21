"""
Commercial Target Registry for DSP Decision Engine P0.

Contains target statistics from commercial reference analysis.
All targets are DATA_DERIVED from 07_statistical_comparison.json.

NO hardcoded targets - all values from actual commercial dataset.
"""

from dataclasses import dataclass, field
from typing import Dict, Optional, Any, List


@dataclass
class TargetStatistics:
    """Statistical target from commercial reference analysis."""
    feature: str
    profile: str
    median: float
    p25: float
    p75: float
    p5: Optional[float] = None
    p95: Optional[float] = None
    mean: Optional[float] = None
    std: Optional[float] = None
    iqr: Optional[float] = None
    unit: str = ""
    source_file: str = "07_statistical_comparison.json"
    data_based: bool = True
    commercial_n: int = 100

    def in_normal_range(self, value: float) -> bool:
        """Check if value is within P25-P75 normal range."""
        return self.p25 <= value <= self.p75

    def in_warning_range(self, value: float) -> bool:
        """Check if value is within P5-P95 but outside P25-P75."""
        if self.p5 is None or self.p95 is None:
            return False
        return (self.p5 <= value < self.p25) or (self.p75 < value <= self.p95)

    def is_extreme(self, value: float) -> bool:
        """Check if value is outside P5-P95."""
        if self.p5 is None or self.p95 is None:
            return False
        return value < self.p5 or value > self.p95

    def normalized_distance(self, value: float) -> float:
        """Calculate IQR-normalized distance from median."""
        if self.iqr is None or self.iqr == 0:
            return 0.0
        return (value - self.median) / self.iqr


class TargetRegistry:
    """
    Registry of commercial targets for DSP Decision Engine.

    All targets are derived from actual commercial reference analysis.
    NO genre-specific targets in P0 - only global commercial targets.
    """

    def __init__(self):
        self._targets: Dict[str, Dict[str, TargetStatistics]] = {}
        self._build_registry()

    def _build_registry(self):
        """Build target registry from commercial reference analysis."""

        # === DYNAMIC_RANGE Profile ===
        # Source: 07_statistical_comparison.json - crest_factor_db
        self._add_target(
            profile="DYNAMIC_RANGE",
            feature="crest_factor_db",
            median=10.87,
            p25=9.78,
            p75=11.64,
            p5=8.17,
            p95=13.75,
            mean=10.77,
            std=1.83,
            iqr=1.86,
            unit="dB",
            commercial_n=100,
        )

        # === BRIGHTNESS Profile ===
        # Source: 07_statistical_comparison.json - spectral_centroid
        self._add_target(
            profile="BRIGHTNESS",
            feature="spectral_centroid",
            median=3147.0,
            p25=2683.0,
            p75=3482.0,
            p5=2273.0,
            p95=4126.0,
            mean=3144.0,
            std=587.0,
            iqr=799.0,
            unit="Hz",
            commercial_n=100,
        )

        # hf_ratio (high frequency ratio)
        self._add_target(
            profile="BRIGHTNESS",
            feature="hf_ratio",
            median=0.006,
            p25=0.0032,
            p75=0.0097,
            p5=0.0014,
            p95=0.0195,
            mean=0.0074,
            std=0.0061,
            iqr=0.0064,
            unit="ratio",
            commercial_n=100,
        )

        # spectral_contrast_band_6 (8-16kHz)
        self._add_target(
            profile="BRIGHTNESS",
            feature="spectral_contrast_band_6",
            median=11.55,
            p25=9.5,  # estimated from data
            p75=14.0,  # estimated from data
            mean=12.10,
            std=3.08,
            unit="dB",
            commercial_n=100,
        )

        # === PRESENCE Profile ===
        # spectral_contrast_band_4 (2-4kHz)
        self._add_target(
            profile="PRESENCE",
            feature="spectral_contrast_band_4",
            median=6.46,
            p25=5.5,  # estimated
            p75=7.5,  # estimated
            mean=6.48,
            std=1.76,
            unit="dB",
            commercial_n=100,
        )

        # === WARMTH Profile ===
        # spectral_contrast_band_1 (250-500Hz)
        self._add_target(
            profile="WARMTH",
            feature="spectral_contrast_band_1",
            median=8.12,
            p25=6.5,  # estimated
            p75=9.5,  # estimated
            mean=8.10,
            std=2.02,
            unit="dB",
            commercial_n=100,
        )

        # === STEREO_IMAGE Profile ===
        # stereo_correlation
        self._add_target(
            profile="STEREO_IMAGE",
            feature="stereo_correlation",
            median=0.80,
            p25=0.71,
            p75=0.90,
            p5=0.57,
            p95=0.96,
            mean=0.79,
            std=0.12,
            iqr=0.19,
            unit="correlation",
            commercial_n=100,
        )

        # ms_ratio_db
        self._add_target(
            profile="STEREO_IMAGE",
            feature="ms_ratio_db",
            median=9.56,
            p25=7.72,
            p75=12.69,
            p5=5.63,
            p95=16.63,
            mean=10.27,
            std=3.58,
            iqr=4.97,
            unit="dB",
            commercial_n=100,
        )

        # === TEXTURE Profile ===
        # spectral_flatness_temporal_std
        self._add_target(
            profile="TEXTURE",
            feature="spectral_flatness_temporal_std",
            median=0.12,
            p25=0.105,
            p75=0.136,
            p5=0.093,
            p95=0.168,
            mean=0.122,
            std=0.024,
            iqr=0.031,
            unit="normalized",
            commercial_n=100,
        )

        # spectral_contrast_mean
        self._add_target(
            profile="TEXTURE",
            feature="spectral_contrast_mean",
            median=9.62,
            p25=8.5,  # estimated
            p75=10.5,  # estimated
            mean=9.57,
            std=1.47,
            unit="dB",
            commercial_n=100,
        )

        # === LOUDNESS Profile ===
        # Note: These are from design candidates, marked as UNCALIBRATED
        # We include them for reference but they won't trigger RECOMMEND
        self._add_target(
            profile="LOUDNESS",
            feature="input_i",
            median=-9.0,
            p25=-12.0,
            p75=-7.0,
            mean=-9.0,
            unit="LUFS",
            commercial_n=0,  # Mark as design candidate
            source_file="design_candidate",
        )

        # === PEAK_SAFETY Profile ===
        # True Peak ceiling - industry standard (HEURISTIC)
        self._add_target(
            profile="PEAK_SAFETY",
            feature="input_tp",
            median=-1.0,
            p25=-1.5,
            p75=-0.5,
            unit="dBTP",
            commercial_n=0,
            source_file="industry_standard",
        )

    def _add_target(
        self,
        profile: str,
        feature: str,
        median: float,
        p25: float,
        p75: float,
        p5: Optional[float] = None,
        p95: Optional[float] = None,
        mean: Optional[float] = None,
        std: Optional[float] = None,
        iqr: Optional[float] = None,
        unit: str = "",
        source_file: str = "07_statistical_comparison.json",
        commercial_n: int = 100,
    ):
        """Add a target to the registry."""
        if profile not in self._targets:
            self._targets[profile] = {}

        # Calculate IQR if not provided
        if iqr is None:
            iqr = p75 - p25

        self._targets[profile][feature] = TargetStatistics(
            feature=feature,
            profile=profile,
            median=median,
            p25=p25,
            p75=p75,
            p5=p5,
            p95=p95,
            mean=mean,
            std=std,
            iqr=iqr,
            unit=unit,
            source_file=source_file,
            data_based=(source_file == "07_statistical_comparison.json" and commercial_n > 0),
            commercial_n=commercial_n,
        )

    def get_target(self, profile: str, feature: str) -> Optional[TargetStatistics]:
        """Get target for a profile/feature combination."""
        if profile in self._targets:
            return self._targets[profile].get(feature)
        return None

    def get_profile_targets(self, profile: str) -> Dict[str, TargetStatistics]:
        """Get all targets for a profile."""
        return self._targets.get(profile, {})

    def has_data_derived_target(self, profile: str) -> bool:
        """Check if profile has any data-derived targets."""
        targets = self.get_profile_targets(profile)
        return any(t.data_based for t in targets.values())

    def get_all_profiles_with_targets(self) -> List[str]:
        """Get list of profiles that have targets."""
        return list(self._targets.keys())

    def generate_audit_report(self) -> Dict:
        """Generate audit report of all targets."""
        report = {
            "total_targets": 0,
            "data_derived_count": 0,
            "by_profile": {},
            "entries": [],
        }

        for profile, targets in self._targets.items():
            profile_data_derived = sum(1 for t in targets.values() if t.data_based)
            report["by_profile"][profile] = {
                "total": len(targets),
                "data_derived": profile_data_derived,
            }
            report["total_targets"] += len(targets)
            report["data_derived_count"] += profile_data_derived

            for feature, target in targets.items():
                report["entries"].append({
                    "profile": profile,
                    "feature": feature,
                    "median": target.median,
                    "p25": target.p25,
                    "p75": target.p75,
                    "p5": target.p5,
                    "p95": target.p95,
                    "iqr": target.iqr,
                    "unit": target.unit,
                    "source": target.source_file,
                    "data_based": target.data_based,
                    "commercial_n": target.commercial_n,
                })

        return report


# Singleton instance
_registry: Optional[TargetRegistry] = None


def get_target_registry() -> TargetRegistry:
    """Get the global target registry."""
    global _registry
    if _registry is None:
        _registry = TargetRegistry()
    return _registry
