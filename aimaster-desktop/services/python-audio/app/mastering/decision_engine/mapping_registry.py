"""
DSP Mapping Rule Registry for DSP Decision Engine P0.

Contains rules mapping profile deviations to DSP parameter adjustments.
All mappings are advisory-only - NO actual DSP processing.

Source Classification:
- DATA_DERIVED: From commercial/AI dataset validation
- DESIGN_CANDIDATE: Proposed but not validated with listening tests
- HEURISTIC: Industry standard / rule of thumb
- UNSUPPORTED: No mapping available - cannot recommend
"""

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Any, Callable

from .constants import MappingSource, Direction, Severity, ProcessorType


@dataclass
class MappingRule:
    """Single DSP mapping rule."""
    rule_id: str
    profile: str
    processor: ProcessorType
    parameter: str
    direction: Direction  # Which deviation direction this rule applies to
    source: MappingSource
    description: str

    # Mapping function: (delta_normalized, severity) -> suggested_value
    # Returns None if rule doesn't apply
    map_func: Optional[Callable[[float, Severity], Optional[float]]] = None

    # Parameter constraints from existing DSP processors
    safe_min: float = 0.0
    safe_max: float = 0.0
    unit: str = ""

    # Additional parameters (e.g., frequency for EQ)
    extra_params: Dict[str, Any] = field(default_factory=dict)

    def applies_to(self, direction: Direction) -> bool:
        """Check if this rule applies to a given direction."""
        if self.direction == Direction.UNKNOWN:
            return True  # Universal rule
        return self.direction == direction

    def map_delta_to_value(
        self,
        delta_normalized: float,
        severity: Severity,
    ) -> Optional[float]:
        """Map delta to suggested parameter value."""
        if self.map_func is None:
            return None
        return self.map_func(delta_normalized, severity)


class MappingRegistry:
    """
    Registry of DSP mapping rules.

    P0 Rules:
    - Most mappings are DESIGN_CANDIDATE or HEURISTIC
    - DATA_DERIVED requires validation with listening tests
    - UNSUPPORTED mappings result in UNCALIBRATED state
    - Safe ranges are derived from existing DSP processors
    """

    def __init__(self):
        self._rules: Dict[str, List[MappingRule]] = {}
        self._build_registry()

    def _build_registry(self):
        """Build mapping rule registry."""

        # === BRIGHTNESS Profile ===
        # High shelf EQ for brightness adjustment
        self._add_rule(MappingRule(
            rule_id="BRIGHT_001",
            profile="BRIGHTNESS",
            processor=ProcessorType.EQ,
            parameter="high_shelf_gain_db",
            direction=Direction.TOO_LOW,
            source=MappingSource.DESIGN_CANDIDATE,
            description="High shelf boost for dark tracks",
            safe_min=0.0,
            safe_max=1.5,  # From eq.py max air boost
            unit="dB",
            extra_params={"frequency_hz": 10000, "q": 0.7},
            map_func=lambda delta, sev: self._map_brightness_low(delta, sev),
        ))

        self._add_rule(MappingRule(
            rule_id="BRIGHT_002",
            profile="BRIGHTNESS",
            processor=ProcessorType.EQ,
            parameter="high_shelf_gain_db",
            direction=Direction.TOO_HIGH,
            source=MappingSource.DESIGN_CANDIDATE,
            description="High shelf cut for overly bright tracks",
            safe_min=-1.5,
            safe_max=0.0,
            unit="dB",
            extra_params={"frequency_hz": 10000, "q": 0.7},
            map_func=lambda delta, sev: self._map_brightness_high(delta, sev),
        ))

        # === PRESENCE Profile ===
        self._add_rule(MappingRule(
            rule_id="PRES_001",
            profile="PRESENCE",
            processor=ProcessorType.EQ,
            parameter="bell_gain_db",
            direction=Direction.TOO_LOW,
            source=MappingSource.DESIGN_CANDIDATE,
            description="Presence boost in 2-4kHz",
            safe_min=0.0,
            safe_max=1.5,
            unit="dB",
            extra_params={"frequency_hz": 3000, "q": 1.0},
            map_func=lambda delta, sev: self._map_presence_low(delta, sev),
        ))

        self._add_rule(MappingRule(
            rule_id="PRES_002",
            profile="PRESENCE",
            processor=ProcessorType.EQ,
            parameter="bell_gain_db",
            direction=Direction.TOO_HIGH,
            source=MappingSource.DESIGN_CANDIDATE,
            description="Presence cut in 2-4kHz",
            safe_min=-1.5,
            safe_max=0.0,
            unit="dB",
            extra_params={"frequency_hz": 3000, "q": 1.0},
            map_func=lambda delta, sev: self._map_presence_high(delta, sev),
        ))

        # === WARMTH Profile ===
        self._add_rule(MappingRule(
            rule_id="WARM_001",
            profile="WARMTH",
            processor=ProcessorType.EQ,
            parameter="low_mid_gain_db",
            direction=Direction.TOO_LOW,
            source=MappingSource.DESIGN_CANDIDATE,
            description="Low-mid boost for thin tracks",
            safe_min=0.0,
            safe_max=1.5,
            unit="dB",
            extra_params={"frequency_hz": 350, "q": 1.2},
            map_func=lambda delta, sev: self._map_warmth_low(delta, sev),
        ))

        self._add_rule(MappingRule(
            rule_id="WARM_002",
            profile="WARMTH",
            processor=ProcessorType.EQ,
            parameter="low_mid_gain_db",
            direction=Direction.TOO_HIGH,
            source=MappingSource.DESIGN_CANDIDATE,
            description="Low-mid cut for muddy tracks",
            safe_min=-1.5,
            safe_max=0.0,
            unit="dB",
            extra_params={"frequency_hz": 350, "q": 1.2},
            map_func=lambda delta, sev: self._map_warmth_high(delta, sev),
        ))

        # === LOW_END Profile ===
        self._add_rule(MappingRule(
            rule_id="LOW_001",
            profile="LOW_END",
            processor=ProcessorType.EQ,
            parameter="low_shelf_gain_db",
            direction=Direction.TOO_LOW,
            source=MappingSource.DESIGN_CANDIDATE,
            description="Low shelf boost for bass-light tracks",
            safe_min=0.0,
            safe_max=1.5,
            unit="dB",
            extra_params={"frequency_hz": 80, "q": 0.7},
            map_func=lambda delta, sev: self._map_low_end_low(delta, sev),
        ))

        self._add_rule(MappingRule(
            rule_id="LOW_002",
            profile="LOW_END",
            processor=ProcessorType.EQ,
            parameter="low_shelf_gain_db",
            direction=Direction.TOO_HIGH,
            source=MappingSource.DESIGN_CANDIDATE,
            description="Low shelf cut for bass-heavy tracks",
            safe_min=-1.5,
            safe_max=0.0,
            unit="dB",
            extra_params={"frequency_hz": 80, "q": 0.7},
            map_func=lambda delta, sev: self._map_low_end_high(delta, sev),
        ))

        # === DYNAMIC_RANGE Profile ===
        self._add_rule(MappingRule(
            rule_id="DYN_001",
            profile="DYNAMIC_RANGE",
            processor=ProcessorType.COMPRESSOR,
            parameter="ratio",
            direction=Direction.TOO_LOW,  # Crest too low = over-compressed
            source=MappingSource.HEURISTIC,
            description="Reduce compression for over-compressed tracks",
            safe_min=1.0,
            safe_max=2.0,  # From dynamics.py max ratio
            unit="ratio",
            map_func=lambda delta, sev: self._map_dynamics_low(delta, sev),
        ))

        self._add_rule(MappingRule(
            rule_id="DYN_002",
            profile="DYNAMIC_RANGE",
            processor=ProcessorType.COMPRESSOR,
            parameter="ratio",
            direction=Direction.TOO_HIGH,  # Crest too high = under-processed
            source=MappingSource.HEURISTIC,
            description="Gentle compression for under-processed tracks",
            safe_min=1.2,
            safe_max=2.0,
            unit="ratio",
            map_func=lambda delta, sev: self._map_dynamics_high(delta, sev),
        ))

        # === STEREO_IMAGE Profile ===
        self._add_rule(MappingRule(
            rule_id="STER_001",
            profile="STEREO_IMAGE",
            processor=ProcessorType.STEREO,
            parameter="width",
            direction=Direction.TOO_LOW,  # Narrow stereo
            source=MappingSource.DESIGN_CANDIDATE,
            description="Stereo widening for narrow tracks",
            safe_min=1.0,
            safe_max=1.10,  # From effects.py max stereo width
            unit="multiplier",
            map_func=lambda delta, sev: self._map_stereo_narrow(delta, sev),
        ))

        self._add_rule(MappingRule(
            rule_id="STER_002",
            profile="STEREO_IMAGE",
            processor=ProcessorType.STEREO,
            parameter="width",
            direction=Direction.TOO_HIGH,  # Wide stereo (potential phase issues)
            source=MappingSource.DESIGN_CANDIDATE,
            description="Stereo narrowing for wide tracks with phase issues",
            safe_min=0.9,
            safe_max=1.0,
            unit="multiplier",
            map_func=lambda delta, sev: self._map_stereo_wide(delta, sev),
        ))

        # === LOUDNESS Profile ===
        self._add_rule(MappingRule(
            rule_id="LOUD_001",
            profile="LOUDNESS",
            processor=ProcessorType.INPUT_GAIN,
            parameter="gain_db",
            direction=Direction.TOO_LOW,  # Quiet track
            source=MappingSource.HEURISTIC,
            description="Input gain for quiet tracks",
            safe_min=0.0,
            safe_max=2.0,
            unit="dB",
            map_func=lambda delta, sev: self._map_loudness_low(delta, sev),
        ))

        # === PEAK_SAFETY Profile ===
        self._add_rule(MappingRule(
            rule_id="PEAK_001",
            profile="PEAK_SAFETY",
            processor=ProcessorType.LIMITER,
            parameter="ceiling_dbtp",
            direction=Direction.TOO_HIGH,  # True peak too high
            source=MappingSource.HEURISTIC,
            description="Limiter ceiling for peak safety",
            safe_min=-3.0,
            safe_max=-0.5,
            unit="dBTP",
            map_func=lambda delta, sev: -1.0,  # Always recommend -1.0 dBTP ceiling
        ))

        # === TRANSIENT Profile ===
        self._add_rule(MappingRule(
            rule_id="TRANS_001",
            profile="TRANSIENT",
            processor=ProcessorType.TRANSIENT,
            parameter="attack_amount",
            direction=Direction.TOO_LOW,  # Flat transients
            source=MappingSource.UNSUPPORTED,  # Not validated
            description="Transient enhancement (not validated)",
            safe_min=0.0,
            safe_max=0.1,
            unit="percent",
            map_func=None,  # UNSUPPORTED
        ))

        # === TEXTURE Profile ===
        # TEXTURE is analysis-only in P0 - no DSP recommendations
        self._add_rule(MappingRule(
            rule_id="TEXT_001",
            profile="TEXTURE",
            processor=ProcessorType.SATURATION,
            parameter="amount",
            direction=Direction.UNKNOWN,
            source=MappingSource.UNSUPPORTED,
            description="Texture is analysis-only in P0",
            safe_min=0.0,
            safe_max=0.0,
            unit="",
            map_func=None,
        ))

        # === MID_CLARITY Profile ===
        self._add_rule(MappingRule(
            rule_id="MID_001",
            profile="MID_CLARITY",
            processor=ProcessorType.EQ,
            parameter="bell_gain_db",
            direction=Direction.TOO_LOW,
            source=MappingSource.DESIGN_CANDIDATE,
            description="Mid clarity boost",
            safe_min=0.0,
            safe_max=1.5,
            unit="dB",
            extra_params={"frequency_hz": 1500, "q": 1.0},
            map_func=lambda delta, sev: self._map_mid_clarity_low(delta, sev),
        ))

    def _add_rule(self, rule: MappingRule):
        """Add a rule to the registry."""
        if rule.profile not in self._rules:
            self._rules[rule.profile] = []
        self._rules[rule.profile].append(rule)

    # === Mapping Functions ===
    # These convert normalized delta to suggested parameter values
    # Returns None if delta is too small to act on

    def _map_brightness_low(self, delta: float, severity: Severity) -> Optional[float]:
        """Map dark track to high shelf boost."""
        if severity == Severity.NONE:
            return None
        # Conservative mapping: max 1.5 dB for critical deviation
        if severity == Severity.LOW:
            return 0.3
        elif severity == Severity.MEDIUM:
            return 0.6
        elif severity == Severity.HIGH:
            return 1.0
        else:  # CRITICAL
            return 1.5

    def _map_brightness_high(self, delta: float, severity: Severity) -> Optional[float]:
        """Map bright track to high shelf cut."""
        if severity == Severity.NONE:
            return None
        if severity == Severity.LOW:
            return -0.3
        elif severity == Severity.MEDIUM:
            return -0.6
        elif severity == Severity.HIGH:
            return -1.0
        else:
            return -1.5

    def _map_presence_low(self, delta: float, severity: Severity) -> Optional[float]:
        """Map recessed presence to presence boost."""
        if severity == Severity.NONE:
            return None
        if severity == Severity.LOW:
            return 0.3
        elif severity == Severity.MEDIUM:
            return 0.6
        elif severity == Severity.HIGH:
            return 0.9
        else:
            return 1.2

    def _map_presence_high(self, delta: float, severity: Severity) -> Optional[float]:
        """Map harsh presence to presence cut."""
        if severity == Severity.NONE:
            return None
        if severity == Severity.LOW:
            return -0.3
        elif severity == Severity.MEDIUM:
            return -0.6
        elif severity == Severity.HIGH:
            return -0.9
        else:
            return -1.2

    def _map_warmth_low(self, delta: float, severity: Severity) -> Optional[float]:
        """Map thin track to low-mid boost."""
        if severity == Severity.NONE:
            return None
        if severity == Severity.LOW:
            return 0.3
        elif severity == Severity.MEDIUM:
            return 0.6
        elif severity == Severity.HIGH:
            return 1.0
        else:
            return 1.2

    def _map_warmth_high(self, delta: float, severity: Severity) -> Optional[float]:
        """Map muddy track to low-mid cut."""
        if severity == Severity.NONE:
            return None
        if severity == Severity.LOW:
            return -0.3
        elif severity == Severity.MEDIUM:
            return -0.6
        elif severity == Severity.HIGH:
            return -1.0
        else:
            return -1.2

    def _map_low_end_low(self, delta: float, severity: Severity) -> Optional[float]:
        """Map bass-light to low shelf boost."""
        if severity == Severity.NONE:
            return None
        if severity == Severity.LOW:
            return 0.3
        elif severity == Severity.MEDIUM:
            return 0.6
        elif severity == Severity.HIGH:
            return 1.0
        else:
            return 1.5

    def _map_low_end_high(self, delta: float, severity: Severity) -> Optional[float]:
        """Map bass-heavy to low shelf cut."""
        if severity == Severity.NONE:
            return None
        if severity == Severity.LOW:
            return -0.3
        elif severity == Severity.MEDIUM:
            return -0.6
        elif severity == Severity.HIGH:
            return -1.0
        else:
            return -1.5

    def _map_dynamics_low(self, delta: float, severity: Severity) -> Optional[float]:
        """Map over-compressed to lighter ratio."""
        # Return a lower ratio to reduce compression
        if severity == Severity.NONE:
            return None
        if severity in [Severity.LOW, Severity.MEDIUM]:
            return 1.6  # Lighter compression
        else:
            return 1.3  # Even lighter

    def _map_dynamics_high(self, delta: float, severity: Severity) -> Optional[float]:
        """Map under-processed to gentle compression."""
        if severity == Severity.NONE:
            return None
        if severity == Severity.LOW:
            return 1.6
        elif severity == Severity.MEDIUM:
            return 1.8
        else:
            return 2.0  # Max ratio

    def _map_stereo_narrow(self, delta: float, severity: Severity) -> Optional[float]:
        """Map narrow stereo to widening."""
        if severity == Severity.NONE:
            return None
        if severity == Severity.LOW:
            return 1.02
        elif severity == Severity.MEDIUM:
            return 1.05
        else:
            return 1.10  # Max widening

    def _map_stereo_wide(self, delta: float, severity: Severity) -> Optional[float]:
        """Map wide stereo to narrowing."""
        if severity == Severity.NONE:
            return None
        if severity == Severity.LOW:
            return 0.98
        elif severity == Severity.MEDIUM:
            return 0.95
        else:
            return 0.90  # Max narrowing

    def _map_loudness_low(self, delta: float, severity: Severity) -> Optional[float]:
        """Map quiet track to input gain."""
        if severity == Severity.NONE:
            return None
        if severity == Severity.LOW:
            return 0.5
        elif severity == Severity.MEDIUM:
            return 1.0
        elif severity == Severity.HIGH:
            return 1.5
        else:
            return 2.0  # Max gain

    def _map_mid_clarity_low(self, delta: float, severity: Severity) -> Optional[float]:
        """Map muddy mids to clarity boost."""
        if severity == Severity.NONE:
            return None
        if severity == Severity.LOW:
            return 0.3
        elif severity == Severity.MEDIUM:
            return 0.5
        else:
            return 0.8

    # === Public API ===

    def get_rules_for_profile(self, profile: str) -> List[MappingRule]:
        """Get all mapping rules for a profile."""
        return self._rules.get(profile, [])

    def get_applicable_rules(
        self,
        profile: str,
        direction: Direction,
    ) -> List[MappingRule]:
        """Get rules that apply to a specific direction."""
        rules = self.get_rules_for_profile(profile)
        return [r for r in rules if r.applies_to(direction)]

    def get_rule_by_id(self, rule_id: str) -> Optional[MappingRule]:
        """Get a specific rule by ID."""
        for rules in self._rules.values():
            for rule in rules:
                if rule.rule_id == rule_id:
                    return rule
        return None

    def has_supported_mapping(self, profile: str) -> bool:
        """Check if profile has any non-UNSUPPORTED mappings."""
        rules = self.get_rules_for_profile(profile)
        return any(r.source != MappingSource.UNSUPPORTED for r in rules)

    def generate_audit_report(self) -> Dict:
        """Generate audit report of all mapping rules."""
        report = {
            "total_rules": 0,
            "by_source": {
                "DATA_DERIVED": 0,
                "DESIGN_CANDIDATE": 0,
                "HEURISTIC": 0,
                "UNSUPPORTED": 0,
            },
            "by_profile": {},
            "entries": [],
        }

        for profile, rules in self._rules.items():
            report["by_profile"][profile] = {
                "total": len(rules),
                "supported": sum(1 for r in rules if r.source != MappingSource.UNSUPPORTED),
            }
            for rule in rules:
                report["total_rules"] += 1
                report["by_source"][rule.source.value] += 1
                report["entries"].append({
                    "rule_id": rule.rule_id,
                    "profile": rule.profile,
                    "processor": rule.processor.value,
                    "parameter": rule.parameter,
                    "direction": rule.direction.value,
                    "source": rule.source.value,
                    "safe_min": rule.safe_min,
                    "safe_max": rule.safe_max,
                    "unit": rule.unit,
                    "description": rule.description,
                })

        return report


# Singleton instance
_registry: Optional[MappingRegistry] = None


def get_mapping_registry() -> MappingRegistry:
    """Get the global mapping registry."""
    global _registry
    if _registry is None:
        _registry = MappingRegistry()
    return _registry
