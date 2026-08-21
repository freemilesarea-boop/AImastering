"""
Closed Loop Calibration P1 - No-Action Auditor

Audits NO_ACTION decisions to check for sensitivity issues.

Phase: AI-MASTERING-CLOSED-LOOP-CALIBRATION-P1-1
"""

from typing import Dict, List, Optional, Any

from .constants import NO_ACTION_AUDIT_FEATURES
from .schema import NoActionAuditResult
from app.mastering.decision_engine import DSPDecisionEngine
from app.mastering.decision_engine.target_registry import get_target_registry
from app.mastering.decision_engine.constants import DecisionState
from app.analyzers.canonical_features import extract_canonical_features
from app.utils.logger import log


class NoActionAuditor:
    """
    Audits NO_ACTION decisions for sensitivity issues.

    Checks:
    - Are features actually within P25-P75?
    - Is confidence threshold too high?
    - Are targets too broad?
    - Is there a legitimate NO_ACTION or false negative?
    """

    def __init__(self):
        self.decision_engine = DSPDecisionEngine()
        self.target_registry = get_target_registry()

    def audit_tracks(
        self,
        track_paths: List[str],
    ) -> List[NoActionAuditResult]:
        """
        Audit all tracks for NO_ACTION sensitivity.

        Args:
            track_paths: List of track file paths

        Returns:
            List of NoActionAuditResult objects
        """
        results: List[NoActionAuditResult] = []

        for track_path in track_paths:
            track_audits = self._audit_track(track_path)
            results.extend(track_audits)

        log("INFO", f"[calibration] Audited {len(results)} NO_ACTION decisions")
        return results

    def _audit_track(
        self,
        track_path: str,
    ) -> List[NoActionAuditResult]:
        """Audit a single track."""
        results: List[NoActionAuditResult] = []
        track_name = track_path.split("/")[-1].rsplit(".", 1)[0]

        # Extract features
        try:
            features_obj = extract_canonical_features(track_path)
            features = features_obj.to_dict()
        except Exception as e:
            log("ERROR", f"[calibration] Failed to extract features for audit: {track_path}: {e}")
            return results

        # Run decision engine
        try:
            decision_result = self.decision_engine.evaluate_track(features, track_name)
            decision_dict = decision_result.to_dict()
        except Exception as e:
            log("ERROR", f"[calibration] Decision engine failed for audit: {track_path}: {e}")
            return results

        # Check each profile
        recommendations = decision_dict.get("recommendations", {})

        for profile, audit_features in NO_ACTION_AUDIT_FEATURES.items():
            if profile not in recommendations:
                continue

            profile_rec = recommendations[profile]
            state = profile_rec.get("state", "")

            # Get feature values
            feature_values: Dict[str, float] = {}
            target_ranges: Dict[str, Dict] = {}

            for feature in audit_features:
                value = features.get(feature)
                if value is not None:
                    try:
                        feature_values[feature] = float(value)
                    except (TypeError, ValueError):
                        continue

                # Get target
                target = self.target_registry.get_target(profile, feature)
                if target:
                    target_ranges[feature] = {
                        "median": target.median,
                        "p25": target.p25,
                        "p75": target.p75,
                        "p5": target.p5,
                        "p95": target.p95,
                    }

            # Determine range status
            in_p25_p75 = True
            in_p5_p95 = True
            max_distance = 0.0

            for feature, value in feature_values.items():
                if feature not in target_ranges:
                    continue

                target = target_ranges[feature]
                median = target["median"]
                p25 = target["p25"]
                p75 = target["p75"]
                p5 = target.get("p5")
                p95 = target.get("p95")

                # Check P25-P75
                if not (p25 <= value <= p75):
                    in_p25_p75 = False

                # Check P5-P95
                if p5 is not None and p95 is not None:
                    if not (p5 <= value <= p95):
                        in_p5_p95 = False

                # Calculate normalized distance
                if median != 0:
                    distance = abs(value - median) / abs(median)
                    max_distance = max(max_distance, distance)

            # Determine audit result
            confirmed_no_action = state == DecisionState.NO_ACTION.value and in_p25_p75
            possible_false = state == DecisionState.NO_ACTION.value and not in_p25_p75

            audit_reason = self._determine_audit_reason(
                state=state,
                in_p25_p75=in_p25_p75,
                in_p5_p95=in_p5_p95,
                max_distance=max_distance,
            )

            results.append(NoActionAuditResult(
                track_name=track_name,
                profile=profile,
                original_state=state,
                feature_values=feature_values,
                target_ranges=target_ranges,
                in_p25_p75=in_p25_p75,
                in_p5_p95=in_p5_p95,
                distance_from_median=max_distance,
                confirmed_no_action=confirmed_no_action,
                possible_false_no_action=possible_false,
                audit_reason=audit_reason,
            ))

        return results

    def _determine_audit_reason(
        self,
        state: str,
        in_p25_p75: bool,
        in_p5_p95: bool,
        max_distance: float,
    ) -> str:
        """Determine audit reason."""
        if state != DecisionState.NO_ACTION.value:
            return f"State is {state}, not NO_ACTION"

        if in_p25_p75:
            return "CONFIRMED: Features within P25-P75 normal range"

        if in_p5_p95:
            return f"POSSIBLE_FALSE: Features within P5-P95 but outside P25-P75 (distance={max_distance:.2%})"

        return f"LIKELY_FALSE: Features outside P5-P95 (distance={max_distance:.2%})"

    def generate_audit_report(
        self,
        audits: List[NoActionAuditResult],
    ) -> Dict:
        """Generate NO_ACTION audit report."""
        total = len(audits)
        no_action_count = sum(1 for a in audits if a.original_state == DecisionState.NO_ACTION.value)
        confirmed = sum(1 for a in audits if a.confirmed_no_action)
        possible_false = sum(1 for a in audits if a.possible_false_no_action)

        # Group by profile
        by_profile: Dict[str, Dict] = {}
        for audit in audits:
            profile = audit.profile
            if profile not in by_profile:
                by_profile[profile] = {
                    "total": 0,
                    "no_action": 0,
                    "confirmed": 0,
                    "possible_false": 0,
                }
            by_profile[profile]["total"] += 1
            if audit.original_state == DecisionState.NO_ACTION.value:
                by_profile[profile]["no_action"] += 1
            if audit.confirmed_no_action:
                by_profile[profile]["confirmed"] += 1
            if audit.possible_false_no_action:
                by_profile[profile]["possible_false"] += 1

        return {
            "total_audits": total,
            "no_action_count": no_action_count,
            "confirmed_no_action": confirmed,
            "possible_false_no_action": possible_false,
            "no_action_rate": no_action_count / total if total > 0 else 0.0,
            "false_positive_rate": possible_false / no_action_count if no_action_count > 0 else 0.0,
            "by_profile": by_profile,
            "audits": [
                {
                    "track_name": a.track_name,
                    "profile": a.profile,
                    "original_state": a.original_state,
                    "in_p25_p75": a.in_p25_p75,
                    "in_p5_p95": a.in_p5_p95,
                    "distance_from_median": a.distance_from_median,
                    "confirmed_no_action": a.confirmed_no_action,
                    "possible_false_no_action": a.possible_false_no_action,
                    "audit_reason": a.audit_reason,
                }
                for a in audits
            ],
        }
