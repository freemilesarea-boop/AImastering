"""
Conflict Engine for Audio Profile Engine P0.

Implements 24 conflict rules from design.
Conflicts affect DSP Eligibility and allowed actions,
NOT Profile State itself.
"""

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Any, Callable

from .constants import ConflictSeverity
from .feature_input import FeatureSet


@dataclass
class ConflictResult:
    """Result of a single conflict rule evaluation."""
    rule_id: str
    name: str
    triggered: bool
    involved_profiles: List[str]
    severity: ConflictSeverity
    condition: str
    message: str
    resolution: str
    blocked_actions: List[str] = field(default_factory=list)
    feature_values: Dict[str, Any] = field(default_factory=dict)


@dataclass
class ConflictReport:
    """Complete conflict analysis report."""
    total_rules: int
    triggered_count: int
    block_count: int
    conditional_count: int
    warn_count: int
    results: List[ConflictResult]
    blocked_actions: List[str]
    conditional_profiles: List[str]


class ConflictEngine:
    """
    Evaluates 24 conflict rules against feature values.

    Conflict rules check for incompatible profile states or
    feature value combinations that would make DSP processing
    unsafe or ineffective.

    Conflicts DO NOT change Profile State - they only affect:
    - DSP Eligibility
    - Allowed Actions
    - Blocked Actions
    """

    def __init__(self):
        self._rules = self._build_rules()

    def _build_rules(self) -> List[Dict]:
        """Build the 24 conflict rules from design."""
        return [
            # === LOUDNESS CONFLICTS ===
            {
                "id": "LOUD_001",
                "name": "Loudness vs Dynamic Range",
                "profiles": ["LOUDNESS", "DYNAMIC_RANGE"],
                "condition": "input_i > -8.0 AND crest_factor_db > 12.0",
                "check": lambda f: (
                    f.get("input_i", -20) > -8.0 and
                    f.get("crest_factor_db", 10) > 12.0
                ),
                "severity": ConflictSeverity.WARN,
                "message": "High loudness target may compress dynamics",
                "resolution": "Reduce loudness target OR accept lower crest factor",
                "blocked_actions": [],
            },
            {
                "id": "LOUD_002",
                "name": "Loudness vs LRA Minimum",
                "profiles": ["LOUDNESS", "DYNAMIC_RANGE"],
                "condition": "input_i > -9.0 AND input_lra < 5.0",
                "check": lambda f: (
                    f.get("input_i", -20) > -9.0 and
                    f.get("input_lra", 7) < 5.0
                ),
                "severity": ConflictSeverity.BLOCK,
                "message": "Loudness target incompatible with low LRA",
                "resolution": "Reduce loudness target to preserve dynamic range",
                "blocked_actions": ["aggressive_limiting"],
            },
            {
                "id": "LOUD_003",
                "name": "Peak Safety vs Loudness",
                "profiles": ["PEAK_SAFETY", "LOUDNESS"],
                "condition": "input_tp > -0.5 AND input_i > -7.0",
                "check": lambda f: (
                    f.get("input_tp", -2) > -0.5 and
                    f.get("input_i", -14) > -7.0
                ),
                "severity": ConflictSeverity.WARN,
                "message": "True Peak ceiling risk at high loudness",
                "resolution": "Lower ceiling to -1.0 dBTP",
                "blocked_actions": [],
            },

            # === DYNAMICS CONFLICTS ===
            {
                "id": "DYN_001",
                "name": "Crest Factor vs Compression Density",
                "profiles": ["DYNAMIC_RANGE"],
                "condition": "crest_factor_db < 8.0 AND compression_density > 0.8",
                "check": lambda f: (
                    f.get("crest_factor_db", 10) < 8.0 and
                    f.get("compression_density", 0.5) > 0.8
                ),
                "severity": ConflictSeverity.BLOCK,
                "message": "Over-compression detected",
                "resolution": "Reduce limiting intensity",
                "blocked_actions": ["additional_compression", "limiting"],
            },
            {
                "id": "DYN_002",
                "name": "Envelope Smoothness Guard",
                "profiles": ["DYNAMIC_RANGE"],
                "condition": "envelope_smoothness < 0.3",
                "check": lambda f: f.get("envelope_smoothness", 0.5) < 0.3,
                "severity": ConflictSeverity.WARN,
                "message": "Potential pumping artifact risk",
                "resolution": "Increase compressor release time",
                "blocked_actions": [],
            },

            # === SPECTRAL CONFLICTS ===
            {
                "id": "SPEC_001",
                "name": "Brightness vs Presence",
                "profiles": ["BRIGHTNESS", "PRESENCE"],
                "condition": "spectral_centroid > 3800 AND band_ratio_2-4kHz > 0.20",
                "check": lambda f: (
                    f.get("spectral_centroid", 3000) > 3800 and
                    f.get("band_ratio_2-4kHz", 0.15) > 0.20
                ),
                "severity": ConflictSeverity.WARN,
                "message": "Combined brightness may cause harshness",
                "resolution": "Reduce either HF or presence boost",
                "blocked_actions": [],
            },
            {
                "id": "SPEC_002",
                "name": "Presence Contrast Deficit",
                "profiles": ["PRESENCE"],
                "condition": "band_ratio_2-4kHz > 0.18 AND spectral_contrast_band_4 < 5.0",
                "check": lambda f: (
                    f.get("band_ratio_2-4kHz", 0.15) > 0.18 and
                    f.get("spectral_contrast_band_4", 6.5) < 5.0
                ),
                "severity": ConflictSeverity.CONDITIONAL,
                "message": "High presence energy but low contrast",
                "resolution": "Consider multiband dynamics in 2-4kHz",
                "blocked_actions": [],
            },
            {
                "id": "SPEC_003",
                "name": "Brightness vs Low End",
                "profiles": ["BRIGHTNESS", "LOW_END"],
                "condition": "spectral_centroid > 3500 AND band_ratio_20-60Hz > 0.12",
                "check": lambda f: (
                    f.get("spectral_centroid", 3000) > 3500 and
                    f.get("band_ratio_20-60Hz", 0.08) > 0.12
                ),
                "severity": ConflictSeverity.WARN,
                "message": "High brightness with heavy sub-bass may cause imbalance",
                "resolution": "Review overall tonal balance",
                "blocked_actions": [],
            },
            {
                "id": "SPEC_004",
                "name": "HF Ratio Instability",
                "profiles": ["BRIGHTNESS"],
                "condition": "hf_ratio_variance > 0.04",
                "check": lambda f: f.get("hf_ratio_variance", 0.02) > 0.04,
                "severity": ConflictSeverity.CONDITIONAL,
                "message": "High frequency content varies significantly",
                "resolution": "Consider dynamic EQ or multiband limiting in HF",
                "blocked_actions": [],
            },

            # === LOW END CONFLICTS ===
            {
                "id": "LOW_001",
                "name": "Sub-bass vs Bass Overlap",
                "profiles": ["LOW_END"],
                "condition": "band_ratio_20-60Hz > 0.12 AND band_ratio_60-120Hz > 0.18",
                "check": lambda f: (
                    f.get("band_ratio_20-60Hz", 0.08) > 0.12 and
                    f.get("band_ratio_60-120Hz", 0.12) > 0.18
                ),
                "severity": ConflictSeverity.WARN,
                "message": "Heavy low end may cause muddiness",
                "resolution": "Consider HPF or low shelf cut",
                "blocked_actions": [],
            },
            {
                "id": "LOW_002",
                "name": "Low End vs Stereo Mono Compatibility",
                "profiles": ["LOW_END", "STEREO_IMAGE"],
                "condition": "band_ratio_20-60Hz > 0.08 AND stereo_correlation < 0.5",
                "check": lambda f: (
                    f.get("band_ratio_20-60Hz", 0.08) > 0.08 and
                    f.get("stereo_correlation", 0.8) < 0.5
                ),
                "severity": ConflictSeverity.BLOCK,
                "message": "Low stereo correlation with significant sub-bass",
                "resolution": "Apply mono bass filter below 100Hz",
                "blocked_actions": ["stereo_widening_low_end", "bass_enhancement"],
            },
            {
                "id": "LOW_003",
                "name": "Low End vs Warmth Balance",
                "profiles": ["LOW_END", "WARMTH"],
                "condition": "band_ratio_60-120Hz > 0.15 AND band_ratio_250-500Hz > 0.20",
                "check": lambda f: (
                    f.get("band_ratio_60-120Hz", 0.12) > 0.15 and
                    f.get("band_ratio_250-500Hz", 0.18) > 0.20
                ),
                "severity": ConflictSeverity.WARN,
                "message": "Combined low and low-mid may cause boominess",
                "resolution": "Create separation with EQ notch around 200Hz",
                "blocked_actions": [],
            },

            # === WARMTH CONFLICTS ===
            {
                "id": "WARM_001",
                "name": "Warmth vs Mid Clarity",
                "profiles": ["WARMTH", "MID_CLARITY"],
                "condition": "band_ratio_500-1000Hz > 0.18 AND band_ratio_1-2kHz > 0.16",
                "check": lambda f: (
                    f.get("band_ratio_500-1000Hz", 0.16) > 0.18 and
                    f.get("band_ratio_1-2kHz", 0.14) > 0.16
                ),
                "severity": ConflictSeverity.CONDITIONAL,
                "message": "Mid buildup may mask definition",
                "resolution": "Consider surgical cut in 800Hz-1.2kHz",
                "blocked_actions": [],
            },
            {
                "id": "WARM_002",
                "name": "Warmth Contrast Guard",
                "profiles": ["WARMTH"],
                "condition": "band_ratio_250-500Hz > 0.20 AND spectral_contrast_band_1 < 6.0",
                "check": lambda f: (
                    f.get("band_ratio_250-500Hz", 0.18) > 0.20 and
                    f.get("spectral_contrast_band_1", 8.0) < 6.0
                ),
                "severity": ConflictSeverity.WARN,
                "message": "High warmth energy with low dynamics",
                "resolution": "Add multiband compression in low-mids",
                "blocked_actions": [],
            },

            # === MID CLARITY CONFLICTS ===
            {
                "id": "MID_001",
                "name": "Nasal vs Sibilance",
                "profiles": ["MID_CLARITY"],
                "condition": "band_ratio_1-2kHz > 0.18 AND band_ratio_6-8kHz > 0.12",
                "check": lambda f: (
                    f.get("band_ratio_1-2kHz", 0.14) > 0.18 and
                    f.get("band_ratio_6-8kHz", 0.08) > 0.12
                ),
                "severity": ConflictSeverity.WARN,
                "message": "Combined nasal and sibilance prominence",
                "resolution": "Consider dynamic EQ or de-essing",
                "blocked_actions": [],
            },
            {
                "id": "MID_002",
                "name": "Mid Clarity vs Presence",
                "profiles": ["MID_CLARITY", "PRESENCE"],
                "condition": "band_ratio_1-2kHz > 0.16 AND band_ratio_2-4kHz > 0.18",
                "check": lambda f: (
                    f.get("band_ratio_1-2kHz", 0.14) > 0.16 and
                    f.get("band_ratio_2-4kHz", 0.15) > 0.18
                ),
                "severity": ConflictSeverity.CONDITIONAL,
                "message": "Continuous mid-high buildup (1-4kHz)",
                "resolution": "Create frequency separation with cuts",
                "blocked_actions": [],
            },

            # === STEREO CONFLICTS ===
            {
                "id": "STER_001",
                "name": "Stereo Width vs Mono Compatibility",
                "profiles": ["STEREO_IMAGE"],
                "condition": "stereo_width > 0.8 AND stereo_correlation < 0.4",
                "check": lambda f: (
                    f.get("stereo_width", 0.65) > 0.8 and
                    f.get("stereo_correlation", 0.8) < 0.4
                ),
                "severity": ConflictSeverity.BLOCK,
                "message": "Extreme width with poor mono compatibility",
                "resolution": "Reduce stereo widening",
                "blocked_actions": ["stereo_widening", "ms_processing"],
            },
            {
                "id": "STER_002",
                "name": "M/S Ratio Extreme",
                "profiles": ["STEREO_IMAGE"],
                "condition": "ms_ratio_db < -10.0 OR ms_ratio_db > -2.0",
                "check": lambda f: (
                    f.get("ms_ratio_db", -6.0) < -10.0 or
                    f.get("ms_ratio_db", -6.0) > -2.0
                ),
                "severity": ConflictSeverity.WARN,
                "message": "Extreme M/S imbalance",
                "resolution": "Review M/S processing balance",
                "blocked_actions": [],
            },
            {
                "id": "STER_003",
                "name": "L/R Balance Correction Limit",
                "profiles": ["STEREO_IMAGE"],
                "condition": "abs(lr_balance_db) > 2.0",
                "check": lambda f: abs(f.get("lr_balance_db", 0.0)) > 2.0,
                "severity": ConflictSeverity.CONDITIONAL,
                "message": "Significant L/R imbalance",
                "resolution": "Apply balance correction with limit",
                "blocked_actions": [],
            },
            {
                "id": "STER_004",
                "name": "Stereo Narrowing with Low Correlation",
                "profiles": ["STEREO_IMAGE"],
                "condition": "stereo_correlation < 0.3 AND stereo_width < 0.4",
                "check": lambda f: (
                    f.get("stereo_correlation", 0.8) < 0.3 and
                    f.get("stereo_width", 0.65) < 0.4
                ),
                "severity": ConflictSeverity.WARN,
                "message": "Narrow but uncorrelated stereo (phase issues)",
                "resolution": "Check for phase problems before processing",
                "blocked_actions": [],
            },

            # === TRANSIENT CONFLICTS ===
            {
                "id": "TRANS_001",
                "name": "Transient vs Dynamic Range",
                "profiles": ["TRANSIENT", "DYNAMIC_RANGE"],
                "condition": "spectral_flux_normalized_mean > 0.4 AND crest_factor_db < 9.0",
                "check": lambda f: (
                    f.get("spectral_flux_normalized_mean", 0.25) > 0.4 and
                    f.get("crest_factor_db", 10) < 9.0
                ),
                "severity": ConflictSeverity.WARN,
                "message": "High transient content but compressed dynamics",
                "resolution": "Reduce limiting to preserve transients",
                "blocked_actions": [],
            },
            {
                "id": "TRANS_002",
                "name": "Transient Density Extreme",
                "profiles": ["TRANSIENT"],
                "condition": "onset_density > 7.0",
                "check": lambda f: f.get("onset_density", 3.0) > 7.0,
                "severity": ConflictSeverity.CONDITIONAL,
                "message": "Very high onset density - careful with transient shaping",
                "resolution": "Use subtle transient shaping to avoid artifacts",
                "blocked_actions": [],
            },
            {
                "id": "TRANS_003",
                "name": "Envelope Range Protection",
                "profiles": ["TRANSIENT"],
                "condition": "envelope_range_normalized < 0.2",
                "check": lambda f: f.get("envelope_range_normalized", 0.5) < 0.2,
                "severity": ConflictSeverity.BLOCK,
                "message": "Already limited envelope range",
                "resolution": "Skip transient enhancement",
                "blocked_actions": ["transient_enhancement", "attack_boost"],
            },

            # === TEXTURE CONFLICTS ===
            {
                "id": "TEXT_001",
                "name": "Spectral Flatness vs Saturation",
                "profiles": ["TEXTURE"],
                "condition": "spectral_flatness > 0.35",
                "check": lambda f: f.get("spectral_flatness", 0.15) > 0.35,
                "severity": ConflictSeverity.CONDITIONAL,
                "message": "High spectral flatness (noise-like) - limit saturation",
                "resolution": "Reduce exciter/saturation intensity",
                "blocked_actions": [],
            },
        ]

    def evaluate_all(self, features: FeatureSet) -> ConflictReport:
        """
        Evaluate all conflict rules against feature values.

        Args:
            features: FeatureSet containing the track's features

        Returns:
            ConflictReport with all rule results
        """
        results = []
        blocked_actions = set()
        conditional_profiles = set()

        for rule in self._rules:
            triggered = rule["check"](features)

            # Collect feature values used in this rule
            feature_values = {}
            for feat in self._extract_features_from_condition(rule["condition"]):
                val = features.get(feat)
                if val is not None:
                    feature_values[feat] = val

            result = ConflictResult(
                rule_id=rule["id"],
                name=rule["name"],
                triggered=triggered,
                involved_profiles=rule["profiles"],
                severity=rule["severity"],
                condition=rule["condition"],
                message=rule["message"] if triggered else "",
                resolution=rule["resolution"] if triggered else "",
                blocked_actions=rule["blocked_actions"] if triggered else [],
                feature_values=feature_values,
            )
            results.append(result)

            if triggered:
                blocked_actions.update(rule["blocked_actions"])
                if rule["severity"] == ConflictSeverity.CONDITIONAL:
                    conditional_profiles.update(rule["profiles"])

        # Count by severity
        triggered_results = [r for r in results if r.triggered]
        block_count = sum(1 for r in triggered_results if r.severity == ConflictSeverity.BLOCK)
        conditional_count = sum(1 for r in triggered_results if r.severity == ConflictSeverity.CONDITIONAL)
        warn_count = sum(1 for r in triggered_results if r.severity == ConflictSeverity.WARN)

        return ConflictReport(
            total_rules=len(self._rules),
            triggered_count=len(triggered_results),
            block_count=block_count,
            conditional_count=conditional_count,
            warn_count=warn_count,
            results=results,
            blocked_actions=list(blocked_actions),
            conditional_profiles=list(conditional_profiles),
        )

    def _extract_features_from_condition(self, condition: str) -> List[str]:
        """Extract feature names from a condition string."""
        # Simple extraction - look for known feature patterns
        known_features = [
            "input_i", "input_tp", "input_lra", "crest_factor_db",
            "compression_density", "envelope_smoothness", "spectral_centroid",
            "band_ratio_2-4kHz", "band_ratio_20-60Hz", "band_ratio_60-120Hz",
            "band_ratio_250-500Hz", "band_ratio_500-1000Hz", "band_ratio_1-2kHz",
            "band_ratio_6-8kHz", "spectral_contrast_band_4", "spectral_contrast_band_1",
            "hf_ratio_variance", "stereo_width", "stereo_correlation",
            "ms_ratio_db", "lr_balance_db", "spectral_flux_normalized_mean",
            "onset_density", "envelope_range_normalized", "spectral_flatness",
        ]
        return [f for f in known_features if f in condition]

    def get_rule_by_id(self, rule_id: str) -> Optional[Dict]:
        """Get a specific rule by ID."""
        for rule in self._rules:
            if rule["id"] == rule_id:
                return rule
        return None

    def get_rules_for_profile(self, profile_id: str) -> List[Dict]:
        """Get all rules involving a specific profile."""
        return [r for r in self._rules if profile_id in r["profiles"]]
