"""
Closed Loop Calibration P1 - Candidate Runner

Runs parameter sweep candidates and collects results.

Phase: AI-MASTERING-CLOSED-LOOP-CALIBRATION-P1-1
"""

import os
from typing import Dict, List, Optional, Any
from dataclasses import dataclass

from .constants import (
    CalibrationStatus,
    COLLATERAL_FEATURES,
    PARAMETER_SWEEPS,
)
from .schema import (
    SweepCandidate,
    CandidateResult,
    FeatureResponse,
)
from app.mastering.closed_loop.render_executor import RenderExecutor, RenderResult
from app.mastering.closed_loop.safety_gate import SafetyGate
from app.analyzers.canonical_features import extract_canonical_features
from app.mastering.decision_engine.target_registry import get_target_registry
from app.utils.logger import log


class CandidateRunner:
    """
    Runs sweep candidates and collects feature responses.

    P1 Rules:
    - One variable at a time
    - Each candidate renders from original (no chaining)
    - Rejected candidates excluded from calibration data
    - Safety gate must pass
    """

    def __init__(
        self,
        output_dir: str,
        sample_rate: int = 44100,
        bit_depth: int = 24,
    ):
        self.output_dir = output_dir
        self.sample_rate = sample_rate
        self.bit_depth = bit_depth

        os.makedirs(output_dir, exist_ok=True)

        self.render_executor = RenderExecutor(
            output_dir,
            sample_rate=sample_rate,
            bit_depth=bit_depth,
        )
        self.safety_gate = SafetyGate()
        self.target_registry = get_target_registry()

        # Cache for original features (avoid re-extracting)
        self._original_features_cache: Dict[str, Dict] = {}

    def run_candidate(
        self,
        candidate: SweepCandidate,
    ) -> CandidateResult:
        """
        Run a single sweep candidate.

        Args:
            candidate: SweepCandidate to run

        Returns:
            CandidateResult with all analysis
        """
        log("DEBUG", f"[calibration] Running candidate {candidate.candidate_id}: "
                     f"{candidate.processor}:{candidate.parameter}={candidate.value}")

        # Step 1: Get original features (cached)
        before_features = self._get_original_features(candidate.track_path)
        if not before_features:
            return CandidateResult(
                candidate=candidate,
                status=CalibrationStatus.RENDER_FAILED,
                render_success=False,
                safety_passed=False,
                notes="Failed to extract original features",
            )

        # Step 2: Build filter chain
        filter_chain = self._build_filter_chain(candidate)
        candidate.filter_chain = filter_chain

        if not filter_chain:
            return CandidateResult(
                candidate=candidate,
                status=CalibrationStatus.RENDER_FAILED,
                render_success=False,
                safety_passed=False,
                notes="Failed to build filter chain",
            )

        # Step 3: Render
        output_name = f"{candidate.candidate_id}_{candidate.track_name}"
        render_result = self.render_executor.render(
            candidate.track_path,
            filter_chain,
            output_name,
        )

        if not render_result.success:
            return CandidateResult(
                candidate=candidate,
                status=CalibrationStatus.RENDER_FAILED,
                render_success=False,
                safety_passed=False,
                notes=f"Render failed: {render_result.error_message}",
            )

        candidate.output_path = render_result.output_path
        candidate.status = CalibrationStatus.RENDERED

        # Step 4: Extract post-render features
        try:
            after_features_obj = extract_canonical_features(render_result.output_path)
            after_features = after_features_obj.to_dict()
        except Exception as e:
            return CandidateResult(
                candidate=candidate,
                status=CalibrationStatus.RENDER_FAILED,
                render_success=True,
                safety_passed=False,
                notes=f"Post-render feature extraction failed: {e}",
            )

        candidate.status = CalibrationStatus.ANALYZED

        # Step 5: Safety gate
        safety_result = self.safety_gate.validate(
            render_result.output_path,
            before_features,
            after_features,
            expected_duration_sec=render_result.duration_sec,
            expected_channels=render_result.channels,
        )

        if not safety_result.passed:
            return CandidateResult(
                candidate=candidate,
                status=CalibrationStatus.SAFETY_FAILED,
                render_success=True,
                safety_passed=False,
                safety_failures=safety_result.failure_codes,
                before_features=before_features,
                after_features=after_features,
                notes=f"Safety gate failed: {', '.join(safety_result.failure_codes)}",
            )

        # Step 6: Calculate feature responses
        primary_responses = self._calculate_primary_responses(
            candidate, before_features, after_features,
        )
        collateral_responses = self._calculate_collateral_responses(
            candidate, before_features, after_features,
        )

        # Step 7: Check for overshoot and regression
        overshoot = any(r.improvement_percent < -50 for r in primary_responses)
        regression = any(
            r.delta > 0.2 * abs(r.before_value) if r.before_value != 0 else False
            for r in collateral_responses
        )

        candidate.status = CalibrationStatus.PASSED

        return CandidateResult(
            candidate=candidate,
            status=CalibrationStatus.PASSED,
            render_success=True,
            safety_passed=True,
            before_features=before_features,
            after_features=after_features,
            primary_responses=primary_responses,
            collateral_responses=collateral_responses,
            overshoot=overshoot,
            regression_detected=regression,
        )

    def run_candidates(
        self,
        candidates: List[SweepCandidate],
        max_candidates: Optional[int] = None,
    ) -> List[CandidateResult]:
        """
        Run multiple candidates.

        Args:
            candidates: List of candidates to run
            max_candidates: Optional limit on candidates to run

        Returns:
            List of CandidateResult objects
        """
        if max_candidates:
            candidates = candidates[:max_candidates]

        results: List[CandidateResult] = []
        total = len(candidates)

        for i, candidate in enumerate(candidates):
            if (i + 1) % 50 == 0:
                log("INFO", f"[calibration] Progress: {i + 1}/{total} candidates")

            result = self.run_candidate(candidate)
            results.append(result)

        log("INFO", f"[calibration] Completed {len(results)} candidates")
        return results

    def _get_original_features(self, track_path: str) -> Optional[Dict]:
        """Get original features (cached)."""
        if track_path in self._original_features_cache:
            return self._original_features_cache[track_path]

        try:
            features_obj = extract_canonical_features(track_path)
            features = features_obj.to_dict()
            self._original_features_cache[track_path] = features
            return features
        except Exception as e:
            log("ERROR", f"[calibration] Failed to extract features: {track_path}: {e}")
            return None

    def _build_filter_chain(self, candidate: SweepCandidate) -> str:
        """Build FFmpeg filter chain for candidate."""
        processor = candidate.processor
        parameter = candidate.parameter
        value = candidate.value
        freq = candidate.frequency_hz
        q = candidate.q or 0.7

        if processor == "EQ":
            if "high_shelf" in parameter:
                return f"highshelf=f={freq or 10000}:g={value:+.2f}"
            elif "low_shelf" in parameter:
                return f"lowshelf=f={freq or 80}:g={value:+.2f}"
            elif "bell" in parameter:
                return f"equalizer=f={freq or 1000}:t=q:w={q:.2f}:g={value:+.2f}"
            else:
                return ""

        elif processor == "INPUT_GAIN":
            if abs(value) < 0.01:
                return ""
            return f"volume={value:+.2f}dB"

        elif processor == "STEREO":
            if abs(value - 1.0) < 0.01:
                return ""
            return f"extrastereo=m={value:.3f}:c=0"

        elif processor == "LIMITER":
            limit_linear = 10.0 ** (value / 20.0)
            return f"alimiter=level_in=1:level_out=1:limit={limit_linear:.6f}:attack=5.0:release=50.0:asc=1"

        elif processor == "COMPRESSOR":
            if "ratio" in parameter:
                return f"acompressor=threshold=-18dB:ratio={value:.1f}:attack=30:release=150"
            elif "threshold" in parameter:
                return f"acompressor=threshold={value:.1f}dB:ratio=1.5:attack=30:release=150"
            else:
                return ""

        return ""

    def _calculate_primary_responses(
        self,
        candidate: SweepCandidate,
        before: Dict,
        after: Dict,
    ) -> List[FeatureResponse]:
        """Calculate primary feature responses."""
        responses: List[FeatureResponse] = []

        # Find primary features for this parameter
        param_key = candidate.parameter
        sweep_config = None
        for key, config in PARAMETER_SWEEPS.items():
            if key == param_key or param_key.startswith(key.replace("_warmth", "").replace("_presence", "")):
                sweep_config = config
                break

        if not sweep_config:
            return responses

        primary_features = sweep_config.get("primary_features", [])
        profile = sweep_config.get("primary_profile", "")

        for feature in primary_features:
            before_value = self._get_feature_value(before, feature)
            after_value = self._get_feature_value(after, feature)

            if before_value is None or after_value is None:
                continue

            delta = after_value - before_value

            # Calculate response per unit (e.g., per dB)
            if abs(candidate.value) > 0.001:
                response_per_unit = delta / abs(candidate.value)
            else:
                response_per_unit = 0.0

            # Get target for direction check
            target = self.target_registry.get_target(profile, feature)
            target_median = target.median if target else None
            before_distance = abs(before_value - target_median) if target_median else None
            after_distance = abs(after_value - target_median) if target_median else None

            # Direction check
            direction_correct = False
            if target_median is not None:
                was_below = before_value < target_median
                moved_up = after_value > before_value
                direction_correct = (was_below and moved_up) or (not was_below and not moved_up)

            # Improvement percent
            improvement_percent = 0.0
            if before_distance and before_distance > 0.0001:
                improvement_percent = ((before_distance - after_distance) / before_distance) * 100

            responses.append(FeatureResponse(
                feature=feature,
                before_value=before_value,
                after_value=after_value,
                delta=delta,
                response_per_unit=response_per_unit,
                target_median=target_median,
                before_distance=before_distance,
                after_distance=after_distance,
                direction_correct=direction_correct,
                improvement_percent=improvement_percent,
            ))

        return responses

    def _calculate_collateral_responses(
        self,
        candidate: SweepCandidate,
        before: Dict,
        after: Dict,
    ) -> List[FeatureResponse]:
        """Calculate collateral feature responses."""
        responses: List[FeatureResponse] = []

        # Find collateral features for this parameter's profile
        param_key = candidate.parameter
        sweep_config = None
        for key, config in PARAMETER_SWEEPS.items():
            if key == param_key or param_key.startswith(key.replace("_warmth", "").replace("_presence", "")):
                sweep_config = config
                break

        if not sweep_config:
            return responses

        profile = sweep_config.get("primary_profile", "")
        collateral_features = COLLATERAL_FEATURES.get(profile, [])

        for feature in collateral_features:
            before_value = self._get_feature_value(before, feature)
            after_value = self._get_feature_value(after, feature)

            if before_value is None or after_value is None:
                continue

            delta = after_value - before_value

            responses.append(FeatureResponse(
                feature=feature,
                before_value=before_value,
                after_value=after_value,
                delta=delta,
                response_per_unit=delta / abs(candidate.value) if abs(candidate.value) > 0.001 else 0.0,
            ))

        return responses

    def _get_feature_value(self, features: Dict, feature_name: str) -> Optional[float]:
        """Get feature value from features dict."""
        value = features.get(feature_name)
        if value is None:
            return None
        try:
            f = float(value)
            import math
            if math.isnan(f) or math.isinf(f):
                return None
            return f
        except (TypeError, ValueError):
            return None
