"""
DSP Eligibility Resolver for Audio Profile Engine P0.

Determines DSP eligibility based on:
- Confidence scores
- Conflict results
- Profile state

P0 Rule: NO actual DSP processing - only eligibility determination.
"""

from dataclasses import dataclass, field
from typing import Dict, List, Set, Optional

from .constants import (
    DSPEligibility, ProfileState, ConflictSeverity, ConfidenceGrade,
    ELIGIBILITY_THRESHOLD_ELIGIBLE,
    ELIGIBILITY_THRESHOLD_CONDITIONAL,
    ELIGIBILITY_THRESHOLD_MONITOR,
)
from .profile_evaluator import ProfileResult
from .confidence import ConfidenceResult
from .conflict_engine import ConflictReport


@dataclass
class EligibilityResult:
    """Eligibility determination for a single profile."""
    profile_id: str
    eligibility: DSPEligibility
    allowed_actions: List[str]
    blocked_actions: List[str]
    reasons: List[str]
    confidence_factor: bool  # True if confidence affected eligibility
    conflict_factor: bool    # True if conflict affected eligibility
    state_factor: bool       # True if state affected eligibility


@dataclass
class GlobalReadiness:
    """Global mastering readiness assessment."""
    readiness: str  # READY, READY_WITH_LIMITS, MANUAL_REVIEW, UNSAFE_FOR_AUTO
    loudness_readiness: bool
    peak_safety: bool
    tonal_balance_readiness: bool
    dynamic_processing_risk: bool
    texture_stability: bool
    stereo_safety: bool
    critical_issues: List[str]
    warnings: List[str]


class EligibilityResolver:
    """
    Resolves DSP eligibility for each profile.

    Eligibility states:
    - ELIGIBLE: Full DSP processing allowed
    - CONDITIONAL: Reduced intensity processing
    - MONITOR_ONLY: Analysis only, no processing
    - BLOCKED: Processing blocked by conflict
    - N/A: Not applicable (e.g., stereo for mono track)

    P0 Rule: TEXTURE profile is always MONITOR_ONLY or BLOCKED.
    """

    # Potential DSP actions per profile (candidates only, no actual values)
    PROFILE_ACTIONS: Dict[str, List[str]] = {
        "LOUDNESS": [
            "gain_adjustment_candidate",
            "limiter_target_candidate",
            "makeup_gain_candidate",
        ],
        "PEAK_SAFETY": [
            "true_peak_limiter_candidate",
            "ceiling_adjustment_candidate",
            "headroom_management_candidate",
        ],
        "DYNAMIC_RANGE": [
            "compression_candidate",
            "limiting_candidate",
            "expansion_candidate",
        ],
        "BRIGHTNESS": [
            "high_shelf_eq_candidate",
            "tilt_eq_candidate",
            "air_boost_candidate",
            "hf_attenuation_candidate",
        ],
        "PRESENCE": [
            "presence_eq_candidate",
            "brilliance_eq_candidate",
            "multiband_presence_candidate",
        ],
        "WARMTH": [
            "low_mid_eq_candidate",
            "warmth_boost_candidate",
            "body_enhancement_candidate",
        ],
        "LOW_END": [
            "sub_bass_eq_candidate",
            "bass_eq_candidate",
            "low_shelf_candidate",
            "mono_bass_candidate",
        ],
        "MID_CLARITY": [
            "mid_eq_candidate",
            "nasal_cut_candidate",
            "de_essing_candidate",
        ],
        "STEREO_IMAGE": [
            "stereo_width_candidate",
            "ms_processing_candidate",
            "lr_balance_candidate",
        ],
        "TRANSIENT": [
            "transient_shaping_candidate",
            "attack_enhancement_candidate",
            "sustain_control_candidate",
        ],
        "TEXTURE": [],  # NO DSP actions for TEXTURE in P0
    }

    def __init__(self):
        pass

    def resolve_profile(
        self,
        profile_result: ProfileResult,
        confidence_result: ConfidenceResult,
        conflict_report: ConflictReport
    ) -> EligibilityResult:
        """
        Resolve eligibility for a single profile.

        Args:
            profile_result: Profile evaluation result
            confidence_result: Confidence calculation result
            conflict_report: Full conflict report

        Returns:
            EligibilityResult with eligibility and allowed actions
        """
        profile_id = profile_result.profile_id
        reasons = []
        confidence_factor = False
        conflict_factor = False
        state_factor = False

        # Start with all potential actions
        allowed_actions = list(self.PROFILE_ACTIONS.get(profile_id, []))
        blocked_actions = []

        # TEXTURE is always MONITOR_ONLY or BLOCKED in P0
        if profile_id == "TEXTURE":
            return EligibilityResult(
                profile_id=profile_id,
                eligibility=DSPEligibility.MONITOR_ONLY,
                allowed_actions=[],
                blocked_actions=["saturation", "exciter", "hf_attenuation"],
                reasons=["TEXTURE profile is analysis-only in P0"],
                confidence_factor=False,
                conflict_factor=False,
                state_factor=True,
            )

        # Check state
        state = profile_result.state
        if state == ProfileState.INSUFFICIENT_DATA:
            return EligibilityResult(
                profile_id=profile_id,
                eligibility=DSPEligibility.BLOCKED,
                allowed_actions=[],
                blocked_actions=allowed_actions,
                reasons=["Insufficient data for profile evaluation"],
                confidence_factor=False,
                conflict_factor=False,
                state_factor=True,
            )

        if state == ProfileState.UNCALIBRATED:
            return EligibilityResult(
                profile_id=profile_id,
                eligibility=DSPEligibility.MONITOR_ONLY,
                allowed_actions=[],
                blocked_actions=allowed_actions,
                reasons=["Uncalibrated thresholds - monitoring only"],
                confidence_factor=False,
                conflict_factor=False,
                state_factor=True,
            )

        # Check for BLOCK conflicts
        for conflict in conflict_report.results:
            if conflict.triggered and conflict.severity == ConflictSeverity.BLOCK:
                if profile_id in conflict.involved_profiles:
                    blocked_actions.extend(conflict.blocked_actions)
                    reasons.append(f"Conflict {conflict.rule_id}: {conflict.message}")
                    conflict_factor = True

        # Remove blocked actions from allowed
        for blocked in blocked_actions:
            # Map conflict blocked actions to profile actions
            for action in list(allowed_actions):
                if blocked.lower() in action.lower():
                    allowed_actions.remove(action)

        # If all actions blocked by conflicts
        if conflict_factor and len(allowed_actions) == 0:
            return EligibilityResult(
                profile_id=profile_id,
                eligibility=DSPEligibility.BLOCKED,
                allowed_actions=[],
                blocked_actions=blocked_actions,
                reasons=reasons,
                confidence_factor=False,
                conflict_factor=True,
                state_factor=False,
            )

        # Check confidence
        confidence = confidence_result.confidence
        if confidence < ELIGIBILITY_THRESHOLD_MONITOR:
            return EligibilityResult(
                profile_id=profile_id,
                eligibility=DSPEligibility.MONITOR_ONLY,
                allowed_actions=[],
                blocked_actions=allowed_actions,
                reasons=reasons + [f"Low confidence ({confidence:.2f}) - monitoring only"],
                confidence_factor=True,
                conflict_factor=conflict_factor,
                state_factor=False,
            )

        if confidence < ELIGIBILITY_THRESHOLD_CONDITIONAL:
            return EligibilityResult(
                profile_id=profile_id,
                eligibility=DSPEligibility.CONDITIONAL,
                allowed_actions=allowed_actions,
                blocked_actions=blocked_actions,
                reasons=reasons + [f"Medium-low confidence ({confidence:.2f}) - conditional processing"],
                confidence_factor=True,
                conflict_factor=conflict_factor,
                state_factor=False,
            )

        # Check for CONDITIONAL conflicts
        for conflict in conflict_report.results:
            if conflict.triggered and conflict.severity == ConflictSeverity.CONDITIONAL:
                if profile_id in conflict.involved_profiles:
                    reasons.append(f"Conditional conflict {conflict.rule_id}: {conflict.message}")
                    conflict_factor = True

        if conflict_factor and profile_id in conflict_report.conditional_profiles:
            return EligibilityResult(
                profile_id=profile_id,
                eligibility=DSPEligibility.CONDITIONAL,
                allowed_actions=allowed_actions,
                blocked_actions=blocked_actions,
                reasons=reasons,
                confidence_factor=confidence_factor,
                conflict_factor=True,
                state_factor=False,
            )

        if confidence < ELIGIBILITY_THRESHOLD_ELIGIBLE:
            return EligibilityResult(
                profile_id=profile_id,
                eligibility=DSPEligibility.CONDITIONAL,
                allowed_actions=allowed_actions,
                blocked_actions=blocked_actions,
                reasons=reasons + [f"Moderate confidence ({confidence:.2f})"],
                confidence_factor=True,
                conflict_factor=conflict_factor,
                state_factor=False,
            )

        # Full eligibility
        return EligibilityResult(
            profile_id=profile_id,
            eligibility=DSPEligibility.ELIGIBLE,
            allowed_actions=allowed_actions,
            blocked_actions=blocked_actions,
            reasons=reasons if reasons else ["All criteria met"],
            confidence_factor=confidence_factor,
            conflict_factor=conflict_factor,
            state_factor=False,
        )

    def resolve_global_readiness(
        self,
        profile_results: Dict[str, ProfileResult],
        eligibility_results: Dict[str, EligibilityResult],
        conflict_report: ConflictReport
    ) -> GlobalReadiness:
        """
        Determine global mastering readiness.

        Readiness levels:
        - READY: All critical profiles eligible
        - READY_WITH_LIMITS: Some limitations but safe to process
        - MANUAL_REVIEW: Human review recommended
        - UNSAFE_FOR_AUTO: Do not process automatically

        Critical profiles that affect readiness:
        - PEAK_SAFETY: Clipping risk -> UNSAFE_FOR_AUTO
        - TEXTURE: Instability risk -> minimum MANUAL_REVIEW
        - STEREO_IMAGE: Phase risk -> minimum MANUAL_REVIEW
        """
        critical_issues = []
        warnings = []

        # Check PEAK_SAFETY
        peak_result = profile_results.get("PEAK_SAFETY")
        peak_eligibility = eligibility_results.get("PEAK_SAFETY")
        peak_safe = True
        if peak_result and peak_result.state == ProfileState.CLIPPING_RISK:
            critical_issues.append("Peak Safety: Clipping risk detected")
            peak_safe = False

        # Check TEXTURE
        texture_result = profile_results.get("TEXTURE")
        texture_stable = True
        if texture_result and texture_result.state == ProfileState.INSTABILITY_RISK:
            critical_issues.append("Texture: Instability risk detected")
            texture_stable = False
        elif texture_result and texture_result.state == ProfileState.GRAINY_RISK:
            warnings.append("Texture: Grainy texture risk")

        # Check STEREO_IMAGE
        stereo_result = profile_results.get("STEREO_IMAGE")
        stereo_safe = True
        if stereo_result and stereo_result.state == ProfileState.PHASE_RISK:
            critical_issues.append("Stereo Image: Phase issues detected")
            stereo_safe = False

        # Check DYNAMIC_RANGE
        dynamic_result = profile_results.get("DYNAMIC_RANGE")
        dynamic_safe = True
        if dynamic_result and dynamic_result.state == ProfileState.OVER_COMPRESSED:
            warnings.append("Dynamic Range: Over-compressed")

        # Check LOUDNESS
        loudness_result = profile_results.get("LOUDNESS")
        loudness_ok = loudness_result and loudness_result.state != ProfileState.INSUFFICIENT_DATA

        # Check for BLOCK conflicts
        block_conflicts = [c for c in conflict_report.results
                          if c.triggered and c.severity == ConflictSeverity.BLOCK]
        if block_conflicts:
            for conflict in block_conflicts:
                warnings.append(f"Conflict blocked: {conflict.name}")

        # Check confidence distribution
        low_confidence_count = sum(
            1 for e in eligibility_results.values()
            if e.eligibility == DSPEligibility.MONITOR_ONLY
        )
        if low_confidence_count > 3:
            warnings.append(f"{low_confidence_count} profiles have low confidence")

        # Determine readiness
        if not peak_safe:
            readiness = "UNSAFE_FOR_AUTO"
        elif not stereo_safe or not texture_stable:
            readiness = "MANUAL_REVIEW"
        elif len(critical_issues) > 0:
            readiness = "MANUAL_REVIEW"
        elif len(warnings) > 2 or low_confidence_count > 3:
            readiness = "READY_WITH_LIMITS"
        elif len(warnings) > 0:
            readiness = "READY_WITH_LIMITS"
        else:
            readiness = "READY"

        return GlobalReadiness(
            readiness=readiness,
            loudness_readiness=loudness_ok,
            peak_safety=peak_safe,
            tonal_balance_readiness=True,  # Would need full EQ profile analysis
            dynamic_processing_risk=dynamic_result.state == ProfileState.OVER_COMPRESSED if dynamic_result else False,
            texture_stability=texture_stable,
            stereo_safety=stereo_safe,
            critical_issues=critical_issues,
            warnings=warnings,
        )
