"""
Closed Loop Calibration P1 - Curve Builder

Builds response curves from analyzed results.

Phase: AI-MASTERING-CLOSED-LOOP-CALIBRATION-P1-1
"""

from typing import Dict, List, Optional, Any

from .constants import PARAMETER_SWEEPS, MIN_TRACKS_FOR_CURVE
from .schema import (
    CandidateResult,
    ResponseCurve,
    ResponseCurvePoint,
)
from .response_analyzer import ResponseAnalyzer, ResponseAnalysis
from app.utils.logger import log


class CurveBuilder:
    """
    Builds response curves from calibration results.

    Creates:
    - Per-processor/parameter curves
    - Per-feature response statistics
    - Nonlinearity detection
    - Saturation point identification
    - Unsafe zone identification
    """

    def __init__(self):
        self.analyzer = ResponseAnalyzer()

    def build_curves(
        self,
        results: List[CandidateResult],
    ) -> List[ResponseCurve]:
        """
        Build all response curves from results.

        Args:
            results: List of CandidateResult objects

        Returns:
            List of ResponseCurve objects
        """
        # Analyze results
        analyses = self.analyzer.analyze_results(results)

        curves: List[ResponseCurve] = []

        # Group analyses by processor:parameter:feature
        curve_groups: Dict[str, List[ResponseAnalysis]] = {}

        for param_key, analysis_list in analyses.items():
            for analysis in analysis_list:
                # Create curve key
                parts = param_key.split(":")
                processor = parts[0]
                parameter = parts[1]
                freq = parts[2] if len(parts) > 2 else None
                feature = analysis.feature

                curve_key = f"{processor}:{parameter}:{feature}"
                if freq:
                    curve_key += f":{freq}"

                if curve_key not in curve_groups:
                    curve_groups[curve_key] = []
                curve_groups[curve_key].append(analysis)

        # Build curves
        for curve_key, analysis_list in curve_groups.items():
            curve = self._build_curve(curve_key, analysis_list)
            if curve:
                curves.append(curve)

        log("INFO", f"[calibration] Built {len(curves)} response curves")
        return curves

    def _build_curve(
        self,
        curve_key: str,
        analyses: List[ResponseAnalysis],
    ) -> Optional[ResponseCurve]:
        """Build a single response curve."""
        if not analyses:
            return None

        parts = curve_key.split(":")
        processor = parts[0]
        parameter = parts[1]
        feature = parts[2]
        freq_hz = int(parts[3]) if len(parts) > 3 else None

        # Find profile for this parameter
        profile = ""
        unit = ""
        for param_name, config in PARAMETER_SWEEPS.items():
            if param_name == parameter or parameter.startswith(param_name.replace("_warmth", "").replace("_presence", "")):
                profile = config.get("primary_profile", "")
                unit = config.get("unit", "")
                break

        # Build points
        points: List[ResponseCurvePoint] = []
        total_samples = 0
        valid_samples = 0
        rejected_samples = 0

        for analysis in analyses:
            point = self.analyzer.calculate_response_point(analysis)
            points.append(point)
            total_samples += point.sample_count
            valid_samples += point.valid_count
            rejected_samples += point.rejected_count

        # Check minimum sample requirement
        if valid_samples < MIN_TRACKS_FOR_CURVE:
            log("WARN", f"[calibration] Curve {curve_key} has only {valid_samples} valid samples")

        # Sort points by value
        points.sort(key=lambda p: p.value)

        # Detect nonlinearity
        nonlinear = self.analyzer.detect_nonlinearity(points)

        # Find saturation point
        saturation_point = self.analyzer.find_saturation_point(points)

        # Find unsafe point
        unsafe_point = self.analyzer.find_unsafe_point(points)

        # Calculate overall direction correctness
        total_direction_checks = sum(p.sample_count for p in points)
        direction_correct_sum = sum(
            p.direction_correct_rate * p.sample_count
            for p in points
        )
        overall_direction_rate = direction_correct_sum / total_direction_checks if total_direction_checks > 0 else 0.0

        return ResponseCurve(
            processor=processor,
            parameter=parameter,
            feature=feature,
            profile=profile,
            unit=unit,
            frequency_hz=freq_hz,
            points=points,
            total_samples=total_samples,
            valid_samples=valid_samples,
            rejected_samples=rejected_samples,
            overall_direction_correct_rate=overall_direction_rate,
            nonlinear_response=nonlinear,
            saturation_point=saturation_point,
            unsafe_point=unsafe_point,
        )

    def generate_curves_report(
        self,
        curves: List[ResponseCurve],
    ) -> Dict:
        """Generate JSON report of all curves."""
        return {
            "total_curves": len(curves),
            "curves": [curve.to_dict() for curve in curves],
            "summary": {
                "by_processor": self._summarize_by_processor(curves),
                "nonlinear_count": sum(1 for c in curves if c.nonlinear_response),
                "with_saturation": sum(1 for c in curves if c.saturation_point is not None),
                "with_unsafe_zone": sum(1 for c in curves if c.unsafe_point is not None),
            },
        }

    def _summarize_by_processor(
        self,
        curves: List[ResponseCurve],
    ) -> Dict:
        """Summarize curves by processor."""
        summary: Dict[str, Dict] = {}

        for curve in curves:
            processor = curve.processor
            if processor not in summary:
                summary[processor] = {
                    "curve_count": 0,
                    "total_samples": 0,
                    "avg_direction_correct_rate": 0.0,
                    "parameters": set(),
                }

            summary[processor]["curve_count"] += 1
            summary[processor]["total_samples"] += curve.valid_samples
            summary[processor]["avg_direction_correct_rate"] += curve.overall_direction_correct_rate
            summary[processor]["parameters"].add(curve.parameter)

        # Average the rates
        for processor, data in summary.items():
            if data["curve_count"] > 0:
                data["avg_direction_correct_rate"] /= data["curve_count"]
            data["parameters"] = list(data["parameters"])

        return summary
