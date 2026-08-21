"""
Closed Loop Calibration P1 - Response Analyzer

Analyzes feature responses from sweep candidates.

Phase: AI-MASTERING-CLOSED-LOOP-CALIBRATION-P1-1
"""

import statistics
from typing import Dict, List, Optional, Any
from dataclasses import dataclass

from .constants import (
    CalibrationStatus,
    DIRECTION_CORRECTNESS_MIN_DESIGN,
    SAFETY_PASS_RATE_MIN,
    OVERSHOOT_RATE_MAX,
)
from .schema import (
    CandidateResult,
    FeatureResponse,
    ResponseCurvePoint,
    ResponseCurve,
)
from app.utils.logger import log


@dataclass
class ResponseAnalysis:
    """Analysis of responses for a specific parameter value."""
    value: float
    frequency_hz: Optional[int]
    feature: str
    responses: List[FeatureResponse]
    valid_count: int
    rejected_count: int


class ResponseAnalyzer:
    """
    Analyzes feature responses and builds response statistics.

    Calculates:
    - Mean/median response per parameter step
    - Response variance across tracks
    - Direction correctness rate
    - Safety pass rate
    - Overshoot rate
    """

    def analyze_results(
        self,
        results: List[CandidateResult],
    ) -> Dict[str, List[ResponseAnalysis]]:
        """
        Analyze all candidate results.

        Args:
            results: List of CandidateResult objects

        Returns:
            Dict mapping parameter to list of ResponseAnalysis
        """
        # Group by parameter and value
        grouped: Dict[str, Dict[float, List[CandidateResult]]] = {}

        for result in results:
            if result.status not in (CalibrationStatus.PASSED, CalibrationStatus.SAFETY_FAILED):
                continue

            param_key = f"{result.candidate.processor}:{result.candidate.parameter}"
            if result.candidate.frequency_hz:
                param_key += f":{result.candidate.frequency_hz}"

            if param_key not in grouped:
                grouped[param_key] = {}

            value = result.candidate.value
            if value not in grouped[param_key]:
                grouped[param_key][value] = []

            grouped[param_key][value].append(result)

        # Build analyses
        analyses: Dict[str, List[ResponseAnalysis]] = {}

        for param_key, value_groups in grouped.items():
            analyses[param_key] = []

            for value, results_at_value in value_groups.items():
                # Extract frequency if present
                parts = param_key.split(":")
                freq_hz = int(parts[2]) if len(parts) > 2 else None

                # Collect all responses for this value
                all_responses: Dict[str, List[FeatureResponse]] = {}

                for result in results_at_value:
                    for resp in result.primary_responses:
                        if resp.feature not in all_responses:
                            all_responses[resp.feature] = []
                        all_responses[resp.feature].append(resp)

                # Create analysis for each feature
                valid_count = sum(1 for r in results_at_value if r.status == CalibrationStatus.PASSED)
                rejected_count = sum(1 for r in results_at_value if r.status != CalibrationStatus.PASSED)

                for feature, responses in all_responses.items():
                    analyses[param_key].append(ResponseAnalysis(
                        value=value,
                        frequency_hz=freq_hz,
                        feature=feature,
                        responses=responses,
                        valid_count=valid_count,
                        rejected_count=rejected_count,
                    ))

        return analyses

    def calculate_response_point(
        self,
        analysis: ResponseAnalysis,
    ) -> ResponseCurvePoint:
        """
        Calculate statistics for a single response point.

        Args:
            analysis: ResponseAnalysis for a single parameter value

        Returns:
            ResponseCurvePoint with statistics
        """
        responses = analysis.responses

        if not responses:
            return ResponseCurvePoint(
                value=analysis.value,
                frequency_hz=analysis.frequency_hz,
                sample_count=0,
                valid_count=0,
                rejected_count=analysis.rejected_count,
            )

        # Extract response values
        deltas = [r.delta for r in responses if r.delta is not None]
        response_per_units = [r.response_per_unit for r in responses if r.response_per_unit is not None]
        direction_correct_flags = [r.direction_correct for r in responses]
        improvement_percents = [r.improvement_percent for r in responses]

        if not deltas:
            return ResponseCurvePoint(
                value=analysis.value,
                frequency_hz=analysis.frequency_hz,
                sample_count=len(responses),
                valid_count=analysis.valid_count,
                rejected_count=analysis.rejected_count,
            )

        # Calculate statistics
        mean_response = statistics.mean(deltas)
        median_response = statistics.median(deltas)
        std_response = statistics.stdev(deltas) if len(deltas) > 1 else 0.0

        # Percentiles
        sorted_deltas = sorted(deltas)
        n = len(sorted_deltas)
        p25_idx = int(n * 0.25)
        p75_idx = int(n * 0.75)
        p25_response = sorted_deltas[p25_idx] if p25_idx < n else sorted_deltas[-1]
        p75_response = sorted_deltas[p75_idx] if p75_idx < n else sorted_deltas[-1]

        # Direction correctness rate
        direction_correct_rate = sum(direction_correct_flags) / len(direction_correct_flags) if direction_correct_flags else 0.0

        # Improvement rate (> 5% improvement)
        improvement_rate = sum(1 for p in improvement_percents if p > 5.0) / len(improvement_percents) if improvement_percents else 0.0

        # Overshoot rate (< -50% improvement means overshoot)
        overshoot_rate = sum(1 for p in improvement_percents if p < -50) / len(improvement_percents) if improvement_percents else 0.0

        return ResponseCurvePoint(
            value=analysis.value,
            frequency_hz=analysis.frequency_hz,
            sample_count=len(responses),
            valid_count=analysis.valid_count,
            rejected_count=analysis.rejected_count,
            mean_response=mean_response,
            median_response=median_response,
            std_response=std_response,
            p25_response=p25_response,
            p75_response=p75_response,
            min_response=min(deltas),
            max_response=max(deltas),
            direction_correct_rate=direction_correct_rate,
            improvement_rate=improvement_rate,
            safety_pass_rate=analysis.valid_count / (analysis.valid_count + analysis.rejected_count) if (analysis.valid_count + analysis.rejected_count) > 0 else 0.0,
            overshoot_rate=overshoot_rate,
        )

    def detect_nonlinearity(
        self,
        points: List[ResponseCurvePoint],
    ) -> bool:
        """
        Detect if response curve is nonlinear.

        Returns True if response doesn't scale linearly with parameter.
        """
        if len(points) < 3:
            return False

        # Check if median response doesn't scale with value
        sorted_points = sorted(points, key=lambda p: p.value)

        # Compare response ratio to value ratio
        for i in range(1, len(sorted_points) - 1):
            p_low = sorted_points[i - 1]
            p_mid = sorted_points[i]
            p_high = sorted_points[i + 1]

            if abs(p_mid.value - p_low.value) < 0.001 or abs(p_high.value - p_mid.value) < 0.001:
                continue

            # Expected linear response
            value_ratio = (p_mid.value - p_low.value) / (p_high.value - p_low.value)

            if abs(p_high.median_response - p_low.median_response) < 0.001:
                continue

            response_ratio = (p_mid.median_response - p_low.median_response) / (p_high.median_response - p_low.median_response)

            # If ratio differs by more than 30%, consider nonlinear
            if abs(value_ratio - response_ratio) > 0.3:
                return True

        return False

    def find_saturation_point(
        self,
        points: List[ResponseCurvePoint],
    ) -> Optional[float]:
        """
        Find point where response saturates (diminishing returns).

        Returns parameter value where saturation begins, or None.
        """
        if len(points) < 3:
            return None

        sorted_points = sorted(points, key=lambda p: abs(p.value))

        # Look for diminishing response
        prev_response_per_unit = None
        for point in sorted_points:
            if abs(point.value) < 0.001:
                continue

            response_per_unit = abs(point.median_response / point.value) if abs(point.value) > 0.001 else 0

            if prev_response_per_unit is not None:
                # Response per unit decreased by more than 50%
                if response_per_unit < prev_response_per_unit * 0.5:
                    return point.value

            prev_response_per_unit = response_per_unit

        return None

    def find_unsafe_point(
        self,
        points: List[ResponseCurvePoint],
    ) -> Optional[float]:
        """
        Find point where safety rate drops below threshold.

        Returns parameter value that becomes unsafe, or None.
        """
        for point in points:
            if point.safety_pass_rate < SAFETY_PASS_RATE_MIN:
                return point.value

        return None
