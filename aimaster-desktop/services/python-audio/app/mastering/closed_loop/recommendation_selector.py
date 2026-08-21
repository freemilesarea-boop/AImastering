"""
Closed Loop Render Engine P0 - Recommendation Selector

Selects which recommendations to apply based on:
- Priority order
- Confidence thresholds
- Conflict blocks
- Max recommendations per pass

Phase: AI-MASTERING-CLOSED-LOOP-RENDER-P0-1
"""

from typing import Dict, List, Optional, Any
from dataclasses import dataclass

from .constants import (
    PROFILE_PRIORITY_ORDER,
    MAX_RECOMMENDATIONS_PER_PASS,
    MIN_CONFIDENCE_FOR_APPLY,
    SUPPORTED_PROCESSORS,
    ANALYSIS_ONLY_PROFILES,
    APPLICABLE_INTERVENTION_TIERS,
    APPLY_REQUIRES_MAPPING_SOURCES,
)
from .schema import SelectedRecommendation

from app.mastering.decision_engine.constants import DecisionState, MappingSource


@dataclass
class SelectionResult:
    """Result of recommendation selection."""
    selected: List[SelectedRecommendation]
    skipped: List[Dict[str, Any]]
    blocked: List[Dict[str, Any]]
    total_candidates: int
    selection_reason: str


class RecommendationSelector:
    """
    Selects recommendations for application.

    P0 Rules:
    - Only RECOMMEND or allowed CONDITIONAL states
    - Intervention tier in APPLICABLE_INTERVENTION_TIERS (never NONE/WATCH)
    - Confidence >= MIN_CONFIDENCE_FOR_APPLY (derived from the recommend gate)
    - Mapping source in APPLY_REQUIRES_MAPPING_SOURCES (measured evidence only)
    - Max MAX_RECOMMENDATIONS_PER_PASS per pass
    - Respect conflict blocks
    - Prioritize by PROFILE_PRIORITY_ORDER

    This class is the single choke point where an advisory recommendation turns
    into something that will be rendered, so every gate that protects a user's
    audio is enforced here rather than in the callers.
    """

    def select_recommendations(
        self,
        decision_result: Dict[str, Any],
        blocked_actions: List[str] = None,
        already_applied: List[str] = None,
        max_per_pass: int = MAX_RECOMMENDATIONS_PER_PASS,
    ) -> SelectionResult:
        """
        Select recommendations to apply.

        Args:
            decision_result: Result from DSP Decision Engine
            blocked_actions: Actions blocked by conflict engine
            already_applied: Recommendation IDs already applied in previous passes
            max_per_pass: Maximum recommendations per pass

        Returns:
            SelectionResult with selected recommendations
        """
        blocked_actions = blocked_actions or []
        already_applied = already_applied or []

        candidates: List[SelectedRecommendation] = []
        skipped: List[Dict[str, Any]] = []
        blocked: List[Dict[str, Any]] = []

        recommendations = decision_result.get("recommendations", {})

        # Process profiles in priority order
        for priority_idx, profile in enumerate(PROFILE_PRIORITY_ORDER):
            if profile not in recommendations:
                continue

            profile_rec = recommendations[profile]

            # Check state
            state_str = profile_rec.get("state", "")
            if state_str not in ("RECOMMEND", "CONDITIONAL"):
                skipped.append({
                    "profile": profile,
                    "reason": f"State is {state_str}",
                    "state": state_str,
                })
                continue

            # Check if profile is analysis-only
            if profile in ANALYSIS_ONLY_PROFILES:
                skipped.append({
                    "profile": profile,
                    "reason": "Analysis-only profile",
                })
                continue

            # Check intervention tier. Absent tier is treated as NONE: a producer
            # that does not state a tier cannot implicitly earn permission.
            tier = profile_rec.get("intervention_tier", "NONE")
            if tier not in APPLICABLE_INTERVENTION_TIERS:
                skipped.append({
                    "profile": profile,
                    "reason": f"Intervention tier {tier} is not correctable",
                    "intervention_tier": tier,
                })
                continue

            # Check confidence
            confidence = float(profile_rec.get("confidence", 0.0))
            if confidence < MIN_CONFIDENCE_FOR_APPLY:
                skipped.append({
                    "profile": profile,
                    "reason": f"Confidence {confidence:.2f} < {MIN_CONFIDENCE_FOR_APPLY}",
                })
                continue

            # Process individual recommendations
            for rec in profile_rec.get("recommendations", []):
                rule_id = rec.get("rule_id", "")

                # Skip if already applied
                if rule_id in already_applied:
                    skipped.append({
                        "profile": profile,
                        "rule_id": rule_id,
                        "reason": "Already applied in previous pass",
                    })
                    continue

                # Check processor support
                processor = rec.get("processor", "")
                if processor not in SUPPORTED_PROCESSORS:
                    skipped.append({
                        "profile": profile,
                        "rule_id": rule_id,
                        "processor": processor,
                        "reason": f"Unsupported processor: {processor}",
                    })
                    continue

                # Check mapping source
                mapping_source = rec.get("mapping_source", "")
                if mapping_source == "UNSUPPORTED":
                    skipped.append({
                        "profile": profile,
                        "rule_id": rule_id,
                        "reason": "Unsupported mapping source",
                    })
                    continue

                # Evidence gate. DESIGN_CANDIDATE and HEURISTIC mappings remain
                # available as advisory output; they are never rendered, because
                # nothing has measured what they actually do to audio.
                if mapping_source not in APPLY_REQUIRES_MAPPING_SOURCES:
                    skipped.append({
                        "profile": profile,
                        "rule_id": rule_id,
                        "mapping_source": mapping_source,
                        "reason": (
                            f"Mapping source {mapping_source} lacks calibration "
                            "evidence - advisory only"
                        ),
                    })
                    continue

                # Check blocked actions
                is_blocked = self._is_blocked(rec, blocked_actions)
                if is_blocked:
                    blocked.append({
                        "profile": profile,
                        "rule_id": rule_id,
                        "processor": processor,
                        "parameter": rec.get("parameter", ""),
                        "reason": "Blocked by conflict engine",
                    })
                    continue

                # Create selected recommendation
                selected = SelectedRecommendation(
                    profile=profile,
                    recommendation_id=rule_id,
                    processor=processor,
                    parameter=rec.get("parameter", ""),
                    suggested_value=float(rec.get("suggested_value", 0.0)),
                    confidence=confidence,
                    priority=priority_idx,
                    reason=profile_rec.get("state_reason", ""),
                )
                candidates.append(selected)

        # Sort by priority (lower index = higher priority)
        candidates.sort(key=lambda x: x.priority)

        # Limit to max per pass
        selected = candidates[:max_per_pass]

        # Generate selection reason
        if len(selected) == 0:
            if len(blocked) > 0:
                reason = f"All candidates blocked ({len(blocked)} blocked)"
            elif len(skipped) > 0:
                reason = f"All candidates skipped ({len(skipped)} skipped)"
            else:
                reason = "No applicable recommendations"
        else:
            profiles = [s.profile for s in selected]
            reason = f"Selected {len(selected)} recommendations: {', '.join(profiles)}"

        return SelectionResult(
            selected=selected,
            skipped=skipped,
            blocked=blocked,
            total_candidates=len(candidates),
            selection_reason=reason,
        )

    def _is_blocked(self, rec: Dict, blocked_actions: List[str]) -> bool:
        """Check if a recommendation is blocked."""
        processor = rec.get("processor", "").lower()
        parameter = rec.get("parameter", "").lower()

        for action in blocked_actions:
            action_lower = action.lower()
            if processor in action_lower or parameter in action_lower:
                return True
        return False
