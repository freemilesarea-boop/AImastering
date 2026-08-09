"""
Closed Loop Calibration P1 - Mapping Calibrator

Calibrates mapping rules based on response curves.

Phase: AI-MASTERING-CLOSED-LOOP-CALIBRATION-P1-1
"""

from typing import Any, Dict, List, Optional, Tuple

from .constants import (
    MappingChangeType,
    MappingSourceCandidate,
    MIN_TRACKS_FOR_PROMOTION,
    DIRECTION_CORRECTNESS_MIN_DERIVED,
    DIRECTION_CORRECTNESS_MIN_DESIGN,
    SAFETY_PASS_RATE_MIN,
    OVERSHOOT_RATE_MAX,
    REGRESSION_RATE_MAX,
)
from .regression import (
    RuleRegression,
    evaluate_candidate_regression,
    aggregate_rule_regression,
    sweep_profile_for_parameter,
)
from .schema import (
    ResponseCurve,
    MappingCalibrationResult,
)
from app.mastering.decision_engine.mapping_registry import get_mapping_registry, MappingRule
from app.mastering.decision_engine.constants import MappingSource
from app.utils.logger import log


class MappingCalibrator:
    """
    Calibrates mapping rules based on measured response curves.

    P1 Rules:
    - Does NOT modify existing registry
    - Creates calibration candidates only
    - DATA_DERIVED_CANDIDATE requires listening test
    - Existing rules can be NARROWED but not BLOCKED without evidence
    """

    def __init__(self):
        self.mapping_registry = get_mapping_registry()

    def calibrate_mappings(
        self,
        curves: List[ResponseCurve],
        candidate_results: Optional[List[Any]] = None,
    ) -> List[MappingCalibrationResult]:
        """
        Calibrate mapping rules based on response curves.

        Args:
            curves: List of ResponseCurve objects
            candidate_results: CandidateResult objects the curves were built
                from. Regression is measured per candidate (it needs the
                before/after features of an individual render, which a curve has
                already averaged away), so without them the regression axis is
                unmeasured and every rule stays promotion-ineligible.

        Returns:
            List of MappingCalibrationResult objects
        """
        results: List[MappingCalibrationResult] = []
        regression_by_rule = self._regression_by_rule(candidate_results or [])

        # Get all existing mapping rules
        audit = self.mapping_registry.generate_audit_report()
        existing_rules = audit.get("entries", [])

        # Map curves by processor:parameter
        curve_map: Dict[str, List[ResponseCurve]] = {}
        for curve in curves:
            key = f"{curve.processor}:{curve.parameter}"
            if key not in curve_map:
                curve_map[key] = []
            curve_map[key].append(curve)

        # Calibrate each rule
        for rule_entry in existing_rules:
            rule_id = rule_entry["rule_id"]
            profile = rule_entry["profile"]
            processor = rule_entry["processor"]
            parameter = rule_entry["parameter"]
            safe_min = rule_entry["safe_min"]
            safe_max = rule_entry["safe_max"]
            source = rule_entry["source"]

            # Find matching curves
            key = f"{processor}:{parameter}"
            matching_curves = curve_map.get(key, [])

            if not matching_curves:
                results.append(MappingCalibrationResult(
                    rule_id=rule_id,
                    profile=profile,
                    processor=processor,
                    parameter=parameter,
                    existing_range={"min": safe_min, "max": safe_max},
                    calibrated_range={"min": safe_min, "max": safe_max},
                    change_type=MappingChangeType.INSUFFICIENT_DATA,
                    source_candidate=MappingSourceCandidate.DESIGN_CANDIDATE,
                    notes="No matching response curves",
                ))
                continue

            # Aggregate curve statistics
            calibration = self._calibrate_rule(
                rule_id=rule_id,
                profile=profile,
                processor=processor,
                parameter=parameter,
                safe_min=safe_min,
                safe_max=safe_max,
                source=source,
                curves=matching_curves,
                regression=regression_by_rule.get((processor, profile)),
            )
            results.append(calibration)

        log("INFO", f"[calibration] Calibrated {len(results)} mapping rules")
        return results

    def _calibrate_rule(
        self,
        rule_id: str,
        profile: str,
        processor: str,
        parameter: str,
        safe_min: float,
        safe_max: float,
        source: str,
        curves: List[ResponseCurve],
        regression: Optional[RuleRegression] = None,
    ) -> MappingCalibrationResult:
        """Calibrate a single mapping rule."""
        # Aggregate statistics from all curves
        total_valid = sum(c.valid_samples for c in curves)
        total_rejected = sum(c.rejected_samples for c in curves)

        # Calculate aggregate rates
        direction_correct_rate = sum(
            c.overall_direction_correct_rate * c.valid_samples
            for c in curves
        ) / total_valid if total_valid > 0 else 0.0

        # Safety pass rate
        safety_rate = total_valid / (total_valid + total_rejected) if (total_valid + total_rejected) > 0 else 0.0

        # Overshoot rate from points
        overshoot_count = 0
        total_points = 0
        for curve in curves:
            for point in curve.points:
                total_points += point.sample_count
                overshoot_count += int(point.overshoot_rate * point.sample_count)
        overshoot_rate = overshoot_count / total_points if total_points > 0 else 0.0

        # Find unsafe points
        unsafe_points = [c.unsafe_point for c in curves if c.unsafe_point is not None]

        # Determine calibrated range
        calibrated_min = safe_min
        calibrated_max = safe_max

        if unsafe_points:
            # Narrow range to exclude unsafe points
            min_unsafe = min(abs(p) for p in unsafe_points)
            if calibrated_max > 0:
                calibrated_max = min(calibrated_max, min_unsafe * 0.8)
            if calibrated_min < 0:
                calibrated_min = max(calibrated_min, -min_unsafe * 0.8)

        # Determine change type
        change_type = MappingChangeType.UNCHANGED
        if calibrated_min != safe_min or calibrated_max != safe_max:
            if abs(calibrated_max - calibrated_min) < abs(safe_max - safe_min):
                change_type = MappingChangeType.NARROWED
            elif unsafe_points:
                change_type = MappingChangeType.BLOCKED
        elif total_valid < MIN_TRACKS_FOR_PROMOTION:
            change_type = MappingChangeType.INSUFFICIENT_DATA

        # Determine source candidate promotion
        source_candidate = self._determine_source_promotion(
            current_source=source,
            valid_tracks=total_valid,
            direction_correctness=direction_correct_rate,
            safety_pass_rate=safety_rate,
            overshoot_rate=overshoot_rate,
        )

        # Calculate confidence score
        confidence = self._calculate_confidence(
            valid_tracks=total_valid,
            direction_correctness=direction_correct_rate,
            safety_pass_rate=safety_rate,
            overshoot_rate=overshoot_rate,
        )

        # Regression axis. An absent measurement is not a pass: a rule whose
        # regression was never measured must not be promotable, so the unmeasured
        # case is represented explicitly rather than defaulting to zero.
        regression_measured = regression is not None and regression.candidate_count > 0
        regression_rate = regression.regression_rate if regression_measured else 0.0
        r2_violation_count = regression.r2_violation_count if regression_measured else 0

        # Promotion eligibility. The pre-existing conditions are unchanged; the
        # regression conditions are added on top of them.
        promotion_eligible = (
            source_candidate == MappingSourceCandidate.DATA_DERIVED_CANDIDATE and
            confidence >= 0.70 and
            regression_measured and
            regression_rate <= REGRESSION_RATE_MAX and
            r2_violation_count == 0
        )

        notes = self._build_notes(
            total_valid=total_valid,
            direction_correctness=direction_correct_rate,
            safety_rate=safety_rate,
            overshoot_rate=overshoot_rate,
            change_type=change_type,
            regression=regression if regression_measured else None,
        )

        return MappingCalibrationResult(
            rule_id=rule_id,
            profile=profile,
            processor=processor,
            parameter=parameter,
            existing_range={"min": safe_min, "max": safe_max},
            calibrated_range={"min": calibrated_min, "max": calibrated_max},
            change_type=change_type,
            source_candidate=source_candidate,
            valid_tracks=total_valid,
            direction_correctness=direction_correct_rate,
            safety_pass_rate=safety_rate,
            overshoot_rate=overshoot_rate,
            regression_rate=regression_rate,
            regression_measured=regression_measured,
            r1_rate=regression.r1_rate if regression_measured else 0.0,
            r3_rate=regression.r3_rate if regression_measured else 0.0,
            r2_violation_count=r2_violation_count,
            confidence_score=confidence,
            promotion_eligible=promotion_eligible,
            notes=notes,
        )

    def _regression_by_rule(
        self,
        candidate_results: List[Any],
    ) -> Dict[Tuple[str, str], RuleRegression]:
        """Group candidates by (processor, profile) and aggregate regression.

        Rules are matched on the profile the swept parameter belongs to rather
        than on the parameter string. The sweep registry names bell sweeps
        ``bell_gain_db_warmth`` / ``bell_gain_db_presence`` while the mapping
        rules both call the parameter ``bell_gain_db``, so a string match would
        credit WARMTH candidates to the PRESENCE rule and vice versa.
        """
        grouped: Dict[Tuple[str, str], List[Any]] = {}

        for result in candidate_results:
            candidate = getattr(result, "candidate", None)
            if candidate is None:
                continue
            profile = sweep_profile_for_parameter(getattr(candidate, "parameter", ""))
            if not profile:
                continue
            key = (getattr(candidate, "processor", ""), profile)
            grouped.setdefault(key, []).append(result)

        return {
            key: aggregate_rule_regression(
                [evaluate_candidate_regression(r) for r in results]
            )
            for key, results in grouped.items()
        }

    def _determine_source_promotion(
        self,
        current_source: str,
        valid_tracks: int,
        direction_correctness: float,
        safety_pass_rate: float,
        overshoot_rate: float,
    ) -> MappingSourceCandidate:
        """Determine source promotion eligibility."""
        # Check for DATA_DERIVED_CANDIDATE promotion
        if (valid_tracks >= MIN_TRACKS_FOR_PROMOTION and
            direction_correctness >= DIRECTION_CORRECTNESS_MIN_DERIVED and
            safety_pass_rate >= SAFETY_PASS_RATE_MIN and
            overshoot_rate <= OVERSHOOT_RATE_MAX):
            return MappingSourceCandidate.DATA_DERIVED_CANDIDATE

        # Check for DESIGN_CANDIDATE maintenance
        if (valid_tracks >= 5 and
            direction_correctness >= DIRECTION_CORRECTNESS_MIN_DESIGN and
            safety_pass_rate >= 0.90):
            return MappingSourceCandidate.DESIGN_CANDIDATE

        # Safety failures block promotion
        if safety_pass_rate < 0.85:
            return MappingSourceCandidate.BLOCKED

        return MappingSourceCandidate.HEURISTIC

    def _calculate_confidence(
        self,
        valid_tracks: int,
        direction_correctness: float,
        safety_pass_rate: float,
        overshoot_rate: float,
    ) -> float:
        """Calculate calibration confidence score."""
        # Sample size component (0-0.25)
        sample_score = min(valid_tracks / 20.0, 1.0) * 0.25

        # Direction correctness (0-0.35)
        direction_score = direction_correctness * 0.35

        # Safety score (0-0.25)
        safety_score = safety_pass_rate * 0.25

        # Overshoot penalty (0-0.15)
        overshoot_penalty = max(0, 0.15 - overshoot_rate * 0.5)

        return sample_score + direction_score + safety_score + overshoot_penalty

    def _build_notes(
        self,
        total_valid: int,
        direction_correctness: float,
        safety_rate: float,
        overshoot_rate: float,
        change_type: MappingChangeType,
        regression: Optional[RuleRegression] = None,
    ) -> str:
        """Build human-readable notes."""
        parts = []

        parts.append(f"n={total_valid}")
        parts.append(f"dir={direction_correctness:.1%}")
        parts.append(f"safety={safety_rate:.1%}")

        if overshoot_rate > 0.05:
            parts.append(f"overshoot={overshoot_rate:.1%}")

        if regression is None:
            parts.append("regression=UNMEASURED")
        else:
            parts.append(
                f"regression={regression.regression_rate:.1%}"
                f" (R1={regression.r1_rate:.1%}, R3={regression.r3_rate:.1%})"
            )
            if regression.r2_violation_count:
                parts.append(f"R2_SAFETY_VIOLATIONS={regression.r2_violation_count}")

        if change_type == MappingChangeType.NARROWED:
            parts.append("RANGE_NARROWED")
        elif change_type == MappingChangeType.BLOCKED:
            parts.append("BLOCKED_UNSAFE")

        return "; ".join(parts)

    def generate_mapping_diff(
        self,
        calibrations: List[MappingCalibrationResult],
    ) -> Dict:
        """Generate diff between existing and calibrated mappings."""
        diff = {
            "total_rules": len(calibrations),
            "unchanged": 0,
            "narrowed": 0,
            "blocked": 0,
            "insufficient_data": 0,
            "promotion_candidates": 0,
            "changes": [],
        }

        for cal in calibrations:
            if cal.change_type == MappingChangeType.UNCHANGED:
                diff["unchanged"] += 1
            elif cal.change_type == MappingChangeType.NARROWED:
                diff["narrowed"] += 1
            elif cal.change_type == MappingChangeType.BLOCKED:
                diff["blocked"] += 1
            elif cal.change_type == MappingChangeType.INSUFFICIENT_DATA:
                diff["insufficient_data"] += 1

            if cal.promotion_eligible:
                diff["promotion_candidates"] += 1

            if cal.change_type != MappingChangeType.UNCHANGED:
                diff["changes"].append({
                    "rule_id": cal.rule_id,
                    "profile": cal.profile,
                    "processor": cal.processor,
                    "parameter": cal.parameter,
                    "change_type": cal.change_type.value,
                    "existing_range": cal.existing_range,
                    "calibrated_range": cal.calibrated_range,
                    "source_candidate": cal.source_candidate.value,
                    "confidence": cal.confidence_score,
                    "notes": cal.notes,
                })

        return diff
