"""
Closed Loop Calibration P1 - Sweep Registry

Defines parameter sweep configurations based on safety clamps.

Phase: AI-MASTERING-CLOSED-LOOP-CALIBRATION-P1-1
"""

from typing import Dict, List, Optional, Any
from dataclasses import dataclass, field

from .constants import PARAMETER_SWEEPS, MAX_STEPS_PER_PARAM
from .schema import SweepCandidate, CalibrationStatus
from app.mastering.decision_engine.safety_clamp import get_safety_clamp
from app.utils.logger import log


@dataclass
class SweepDefinition:
    """Definition of a parameter sweep."""
    sweep_id: str
    processor: str
    parameter: str
    steps: List[float]
    unit: str
    frequencies: List[int] = field(default_factory=list)
    q: Optional[float] = None
    primary_profile: str = ""
    primary_features: List[str] = field(default_factory=list)

    def total_points(self) -> int:
        """Total sweep points (steps × frequencies if applicable)."""
        if self.frequencies:
            return len(self.steps) * len(self.frequencies)
        return len(self.steps)


class SweepRegistry:
    """
    Registry of parameter sweep definitions.

    P1 Rules:
    - One variable at a time
    - Within safety clamp limits
    - Limited steps per parameter
    - Respect processor support
    """

    def __init__(self):
        self.safety_clamp = get_safety_clamp()
        self.definitions: Dict[str, SweepDefinition] = {}
        self._build_registry()

    def _build_registry(self):
        """Build sweep definitions from constants."""
        for param_name, config in PARAMETER_SWEEPS.items():
            # Validate steps against safety clamp
            processor = config["processor"]
            steps = self._clamp_steps(
                processor,
                param_name.replace("_warmth", "").replace("_presence", ""),
                config["steps"],
            )

            if not steps:
                log("WARN", f"[sweep] No valid steps for {param_name}")
                continue

            sweep_id = f"SWEEP_{processor}_{param_name}"

            self.definitions[sweep_id] = SweepDefinition(
                sweep_id=sweep_id,
                processor=processor,
                parameter=param_name,
                steps=steps,
                unit=config["unit"],
                frequencies=config.get("frequencies", []),
                q=config.get("q"),
                primary_profile=config.get("primary_profile", ""),
                primary_features=config.get("primary_features", []),
            )

        log("INFO", f"[sweep] Registered {len(self.definitions)} sweep definitions")

    def _clamp_steps(
        self,
        processor: str,
        parameter: str,
        steps: List[float],
    ) -> List[float]:
        """Clamp steps to safety range."""
        safe_min = self.safety_clamp.get_safe_min(processor, parameter)
        safe_max = self.safety_clamp.get_safe_max(processor, parameter)

        if safe_min is None or safe_max is None:
            # No safety range defined, use steps as-is but limited
            return steps[:MAX_STEPS_PER_PARAM]

        clamped = []
        for step in steps:
            if safe_min <= step <= safe_max:
                clamped.append(step)

        return clamped[:MAX_STEPS_PER_PARAM]

    def get_all_definitions(self) -> List[SweepDefinition]:
        """Get all sweep definitions."""
        return list(self.definitions.values())

    def get_definition(self, sweep_id: str) -> Optional[SweepDefinition]:
        """Get a specific sweep definition."""
        return self.definitions.get(sweep_id)

    def generate_candidates(
        self,
        track_paths: List[str],
        definitions: Optional[List[SweepDefinition]] = None,
    ) -> List[SweepCandidate]:
        """
        Generate sweep candidates for all tracks and definitions.

        Args:
            track_paths: List of track file paths
            definitions: Optional subset of definitions (defaults to all)

        Returns:
            List of SweepCandidate objects
        """
        if definitions is None:
            definitions = self.get_all_definitions()

        candidates: List[SweepCandidate] = []
        candidate_idx = 0

        for track_path in track_paths:
            track_name = track_path.split("/")[-1].rsplit(".", 1)[0]

            for defn in definitions:
                if defn.frequencies:
                    # EQ sweeps with frequency variants
                    for freq in defn.frequencies:
                        for step in defn.steps:
                            candidate_id = f"C{candidate_idx:04d}"
                            candidates.append(SweepCandidate(
                                candidate_id=candidate_id,
                                track_name=track_name,
                                track_path=track_path,
                                processor=defn.processor,
                                parameter=defn.parameter,
                                value=step,
                                unit=defn.unit,
                                frequency_hz=freq,
                                q=defn.q,
                                status=CalibrationStatus.PENDING,
                            ))
                            candidate_idx += 1
                else:
                    # Non-EQ sweeps
                    for step in defn.steps:
                        candidate_id = f"C{candidate_idx:04d}"
                        candidates.append(SweepCandidate(
                            candidate_id=candidate_id,
                            track_name=track_name,
                            track_path=track_path,
                            processor=defn.processor,
                            parameter=defn.parameter,
                            value=step,
                            unit=defn.unit,
                            status=CalibrationStatus.PENDING,
                        ))
                        candidate_idx += 1

        log("INFO", f"[sweep] Generated {len(candidates)} sweep candidates")
        return candidates

    def generate_registry_report(self) -> Dict:
        """Generate JSON report of sweep registry."""
        return {
            "total_definitions": len(self.definitions),
            "total_sweep_points": sum(d.total_points() for d in self.definitions.values()),
            "definitions": [
                {
                    "sweep_id": d.sweep_id,
                    "processor": d.processor,
                    "parameter": d.parameter,
                    "steps": d.steps,
                    "unit": d.unit,
                    "frequencies": d.frequencies,
                    "q": d.q,
                    "primary_profile": d.primary_profile,
                    "primary_features": d.primary_features,
                    "total_points": d.total_points(),
                }
                for d in self.definitions.values()
            ],
        }
