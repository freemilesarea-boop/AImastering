"""
Closed Loop Render Engine P0 - Accept/Reject Logic

Determines whether a render should be accepted, partially accepted,
or rejected based on validation results.

Phase: AI-MASTERING-CLOSED-LOOP-RENDER-P0-1
"""

from typing import Dict, List, Any, Tuple
from dataclasses import dataclass

from .constants import RenderStatus, ValidationResult
from .schema import (
    MovementResult,
    RegressionResult,
    SafetyGateResult,
    SelectedRecommendation,
)


@dataclass
class AcceptRejectDecision:
    """Decision on whether to accept the render."""
    status: RenderStatus
    accepted_recommendation_ids: List[str]
    rejected_recommendation_ids: List[str]
    reason: str
    details: Dict[str, Any]


class AcceptRejectEngine:
    """
    Determines accept/reject status based on validation results.

    Decision logic:
    - ACCEPTED: All improvements, no regressions, safety passed
    - PARTIALLY_ACCEPTED: Some improvements, some neutral/minor issues
    - REJECTED: Movement wrong, major regression, or safety failed
    - BLOCKED: Recommendations were blocked before render
    """

    def decide(
        self,
        applied_recommendations: List[SelectedRecommendation],
        movement_results: List[MovementResult],
        regression_results: List[RegressionResult],
        safety_result: SafetyGateResult,
    ) -> AcceptRejectDecision:
        """
        Make accept/reject decision.

        Args:
            applied_recommendations: Recommendations that were applied
            movement_results: Results of movement validation
            regression_results: Results of regression detection
            safety_result: Result of safety gate

        Returns:
            AcceptRejectDecision with final status
        """
        # 1. Check safety first - critical failures are automatic reject
        if not safety_result.passed:
            return AcceptRejectDecision(
                status=RenderStatus.REJECTED,
                accepted_recommendation_ids=[],
                rejected_recommendation_ids=[
                    r.recommendation_id for r in applied_recommendations
                ],
                reason="Safety gate failed",
                details={
                    "failure_codes": safety_result.failure_codes,
                    "critical_failures": safety_result.critical_failures,
                },
            )

        # 2. Check for blocking regressions
        blocking_regressions = [
            r for r in regression_results if r.is_blocking
        ]
        if blocking_regressions:
            return AcceptRejectDecision(
                status=RenderStatus.REJECTED,
                accepted_recommendation_ids=[],
                rejected_recommendation_ids=[
                    r.recommendation_id for r in applied_recommendations
                ],
                reason="Blocking collateral regression detected",
                details={
                    "blocking_profiles": [r.affected_profile for r in blocking_regressions],
                    "blocking_features": [r.feature for r in blocking_regressions],
                },
            )

        # 3. Analyze movement results per recommendation
        rec_results: Dict[str, Dict] = {}
        for rec in applied_recommendations:
            rec_id = rec.recommendation_id
            rec_results[rec_id] = {
                "profile": rec.profile,
                "improved": False,
                "regressed": False,
                "neutral": True,
                "movements": [],
            }

        for mr in movement_results:
            # Find matching recommendation
            for rec in applied_recommendations:
                if rec.profile == mr.profile:
                    rec_id = rec.recommendation_id
                    if rec_id in rec_results:
                        rec_results[rec_id]["movements"].append(mr)
                        if mr.validation_result == ValidationResult.PASS:
                            rec_results[rec_id]["improved"] = True
                            rec_results[rec_id]["neutral"] = False
                        elif mr.validation_result == ValidationResult.FAIL:
                            rec_results[rec_id]["regressed"] = True
                            rec_results[rec_id]["neutral"] = False

        # 4. Categorize recommendations
        accepted_ids = []
        rejected_ids = []

        for rec_id, result in rec_results.items():
            if result["regressed"]:
                rejected_ids.append(rec_id)
            elif result["improved"]:
                accepted_ids.append(rec_id)
            else:
                # Neutral - consider as accepted if no issues
                accepted_ids.append(rec_id)

        # 5. Determine final status
        total = len(applied_recommendations)
        accepted_count = len(accepted_ids)
        rejected_count = len(rejected_ids)

        # Check for warnings
        warning_count = sum(
            1 for mr in movement_results
            if mr.validation_result == ValidationResult.WARN
        )
        minor_regressions = len([
            r for r in regression_results if not r.is_blocking
        ])

        if rejected_count == 0 and warning_count == 0 and minor_regressions == 0:
            # All good
            status = RenderStatus.ACCEPTED
            reason = f"All {accepted_count} recommendations improved target distance"

        elif rejected_count == 0:
            # Some warnings but no rejections
            if warning_count > 0 or minor_regressions > 0:
                status = RenderStatus.ACCEPTED
                reason = f"Accepted with {warning_count} warnings, {minor_regressions} minor regressions"
            else:
                status = RenderStatus.ACCEPTED
                reason = "Improvements achieved"

        elif accepted_count > 0 and rejected_count > 0:
            # Mixed results
            status = RenderStatus.PARTIALLY_ACCEPTED
            reason = f"{accepted_count} accepted, {rejected_count} rejected"

        else:
            # All rejected
            status = RenderStatus.REJECTED
            reason = f"All {rejected_count} recommendations failed validation"

        return AcceptRejectDecision(
            status=status,
            accepted_recommendation_ids=accepted_ids,
            rejected_recommendation_ids=rejected_ids,
            reason=reason,
            details={
                "total_recommendations": total,
                "accepted_count": accepted_count,
                "rejected_count": rejected_count,
                "warning_count": warning_count,
                "minor_regressions": minor_regressions,
                "safety_warnings": safety_result.warning_count,
            },
        )

    def should_continue_to_next_pass(
        self,
        decision: AcceptRejectDecision,
        pass_number: int,
        max_passes: int,
    ) -> Tuple[bool, str]:
        """
        Determine if we should continue to next pass.

        Args:
            decision: Current pass decision
            pass_number: Current pass number (1-indexed)
            max_passes: Maximum allowed passes

        Returns:
            Tuple of (should_continue, reason)
        """
        if pass_number >= max_passes:
            return False, f"Maximum passes ({max_passes}) reached"

        if decision.status == RenderStatus.REJECTED:
            return False, "Previous pass was rejected"

        if decision.status == RenderStatus.BLOCKED:
            return False, "Recommendations blocked"

        if decision.status == RenderStatus.ACCEPTED:
            # Could continue if there are more improvements to make
            # For P0, we stop after acceptance
            return False, "Render accepted, no further passes needed"

        if decision.status == RenderStatus.PARTIALLY_ACCEPTED:
            # Continue to try rejected recommendations
            return True, "Partial acceptance - attempting remaining improvements"

        return False, "No continuation needed"
