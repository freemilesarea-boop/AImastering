"""
Safety Clamp for DSP Decision Engine P0.

Ensures all recommendations stay within safe parameter ranges.
Derived from existing DSP processor parameter ranges.
"""

from dataclasses import dataclass
from typing import Dict, Optional, Tuple


@dataclass
class SafeRange:
    """Safe parameter range."""
    parameter: str
    processor: str
    min_value: float
    max_value: float
    unit: str
    source: str  # Where this range comes from (e.g., "eq.py", "dynamics.py")
    notes: str = ""


class SafetyClamp:
    """
    Enforces safe parameter ranges on all recommendations.

    P0 Safety Ranges (from existing DSP processors):
    - EQ Gain: ±1.5 dB (from eq.py adaptive EQ)
    - High Shelf: ±1.5 dB
    - Low Shelf: ±1.5 dB
    - Bell EQ: ±1.5 dB
    - Input Gain: ±2.0 dB
    - Limiter Ceiling: -3.0 to -0.5 dBTP
    - Stereo Width: 0.9 to 1.10 (from effects.py)
    - Compressor Ratio: 1.0 to 2.0 (from dynamics.py vocal protection)
    - Transient Amount: ±10%
    - Saturation Amount: 0 to 5% (from effects.py)
    """

    def __init__(self):
        self._ranges: Dict[str, SafeRange] = {}
        self._build_ranges()

    def _build_ranges(self):
        """Build safe range definitions from existing DSP processors."""

        # EQ ranges (from eq.py)
        self._add_range(SafeRange(
            parameter="high_shelf_gain_db",
            processor="EQ",
            min_value=-1.5,
            max_value=1.5,
            unit="dB",
            source="eq.py",
            notes="Base EQ adaptive air boost max is 3.5, but P0 uses ±1.5 for safety",
        ))

        self._add_range(SafeRange(
            parameter="low_shelf_gain_db",
            processor="EQ",
            min_value=-1.5,
            max_value=1.5,
            unit="dB",
            source="eq.py",
            notes="Base EQ adaptive low boost max is 4.0, but P0 uses ±1.5 for safety",
        ))

        self._add_range(SafeRange(
            parameter="bell_gain_db",
            processor="EQ",
            min_value=-1.5,
            max_value=1.5,
            unit="dB",
            source="eq.py",
            notes="Conservative bell EQ range for P0",
        ))

        self._add_range(SafeRange(
            parameter="low_mid_gain_db",
            processor="EQ",
            min_value=-1.5,
            max_value=1.5,
            unit="dB",
            source="eq.py",
        ))

        # Input gain (from mastering.py / dynamics.py)
        self._add_range(SafeRange(
            parameter="gain_db",
            processor="INPUT_GAIN",
            min_value=-2.0,
            max_value=2.0,
            unit="dB",
            source="dynamics.py",
            notes="Pre-gain adjustment range",
        ))

        # Limiter ceiling (from effects.py soft_clipper_filter)
        self._add_range(SafeRange(
            parameter="ceiling_dbtp",
            processor="LIMITER",
            min_value=-3.0,
            max_value=-0.5,
            unit="dBTP",
            source="effects.py",
            notes="True peak ceiling for streaming",
        ))

        # Stereo width (from effects.py stereo_width_filter)
        self._add_range(SafeRange(
            parameter="width",
            processor="STEREO",
            min_value=0.9,
            max_value=1.10,
            unit="multiplier",
            source="effects.py",
            notes="extrastereo m parameter, 1.0 = passthrough",
        ))

        # Compressor ratio (from dynamics.py with vocal protection)
        self._add_range(SafeRange(
            parameter="ratio",
            processor="COMPRESSOR",
            min_value=1.0,
            max_value=2.0,
            unit="ratio",
            source="dynamics.py",
            notes="Vocal protection clamps ratio to max 2.0",
        ))

        # Compressor threshold
        self._add_range(SafeRange(
            parameter="threshold_db",
            processor="COMPRESSOR",
            min_value=-22.0,
            max_value=-14.0,
            unit="dB",
            source="dynamics.py",
            notes="Range from dynamics.py style presets",
        ))

        # Saturation (from effects.py)
        self._add_range(SafeRange(
            parameter="amount",
            processor="SATURATION",
            min_value=0.0,
            max_value=0.05,  # 5%
            unit="ratio",
            source="effects.py",
            notes="saturation_filter amount 0.0-1.0, P0 uses max 5%",
        ))

        # Transient amount
        self._add_range(SafeRange(
            parameter="attack_amount",
            processor="TRANSIENT",
            min_value=-0.10,  # -10%
            max_value=0.10,   # +10%
            unit="percent",
            source="design",
            notes="P0 transient adjustment range",
        ))

    def _add_range(self, safe_range: SafeRange):
        """Add a safe range to the registry."""
        key = f"{safe_range.processor}:{safe_range.parameter}"
        self._ranges[key] = safe_range

    def get_range(self, processor: str, parameter: str) -> Optional[SafeRange]:
        """Get safe range for a processor/parameter combination."""
        key = f"{processor}:{parameter}"
        return self._ranges.get(key)

    def clamp(
        self,
        processor: str,
        parameter: str,
        value: float,
    ) -> Tuple[float, bool, Optional[float]]:
        """
        Clamp a value to its safe range.

        Args:
            processor: Processor type (e.g., "EQ", "COMPRESSOR")
            parameter: Parameter name
            value: Proposed value

        Returns:
            Tuple of (clamped_value, was_clamped, original_value)
        """
        safe_range = self.get_range(processor, parameter)

        if safe_range is None:
            # No range defined - return unchanged but log
            return (value, False, None)

        if value < safe_range.min_value:
            return (safe_range.min_value, True, value)
        elif value > safe_range.max_value:
            return (safe_range.max_value, True, value)
        else:
            return (value, False, None)

    def is_within_range(
        self,
        processor: str,
        parameter: str,
        value: float,
    ) -> bool:
        """Check if value is within safe range."""
        safe_range = self.get_range(processor, parameter)
        if safe_range is None:
            return True  # No range = assume safe
        return safe_range.min_value <= value <= safe_range.max_value

    def get_safe_min(self, processor: str, parameter: str) -> Optional[float]:
        """Get minimum safe value."""
        safe_range = self.get_range(processor, parameter)
        return safe_range.min_value if safe_range else None

    def get_safe_max(self, processor: str, parameter: str) -> Optional[float]:
        """Get maximum safe value."""
        safe_range = self.get_range(processor, parameter)
        return safe_range.max_value if safe_range else None

    def generate_audit_report(self) -> Dict:
        """Generate audit report of all safe ranges."""
        report = {
            "total_ranges": len(self._ranges),
            "by_processor": {},
            "entries": [],
        }

        for key, safe_range in self._ranges.items():
            processor = safe_range.processor
            if processor not in report["by_processor"]:
                report["by_processor"][processor] = 0
            report["by_processor"][processor] += 1

            report["entries"].append({
                "processor": safe_range.processor,
                "parameter": safe_range.parameter,
                "min": safe_range.min_value,
                "max": safe_range.max_value,
                "unit": safe_range.unit,
                "source": safe_range.source,
                "notes": safe_range.notes,
            })

        return report


# Singleton instance
_clamp: Optional[SafetyClamp] = None


def get_safety_clamp() -> SafetyClamp:
    """Get the global safety clamp."""
    global _clamp
    if _clamp is None:
        _clamp = SafetyClamp()
    return _clamp
