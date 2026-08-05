"""
Recommendation Engine for DSP Decision Engine P0.

Generates DSP recommendations based on feature deltas and mapping rules.
All recommendations are advisory-only - NO actual DSP processing.
"""

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Any

from .constants import (
    DecisionState, Direction, Severity, MappingSource,
    MAPPING_CONFIDENCE_CEILING,
    CONFIDENCE_THRESHOLD_RECOMMEND,
    CONFIDENCE_THRESHOLD_CONDITIONAL,
    PROFILE_ORDER,
)
from .delta_engine import DeltaEngine, ProfileDelta, FeatureDelta
from .mapping_registry import get_mapping_registry, MappingRule
from .safety_clamp import get_safety_clamp


@dataclass
class DSPRecommendation:
    """Single DSP parameter recommendation."""
    processor: str
    parameter: str
    suggested_value: float
    safe_min: float
    safe_max: float
    unit: str
    mode: str = "ADVISORY_ONLY"  # Always advisory in P0
    clamped: bool = False
    original_value: Optional[float] = None  # Value before clamping
    frequency_hz: Optional[int] = None  # For EQ
    q: Optional[float] = None  # For EQ
    rule_id: str = ""
    mapping_source: str = ""

    def to_dict(self) -> Dict:
        """Convert to dictionary."""
        result = {
            "processor": self.processor,
            "parameter": self.parameter,
            "suggested_value": self.suggested_value,
            "safe_min": self.safe_min,
            "safe_max": self.safe_max,
            "unit": self.unit,
            "mode": self.mode,
            "clamped": self.clamped,
            "rule_id": self.rule_id,
            "mapping_source": self.mapping_source,
        }
        if self.original_value is not None:
            result["original_value"] = self.original_value
        if self.frequency_hz is not None:
            result["frequency_hz"] = self.frequency_hz
        if self.q is not None:
            result["q"] = self.q
        return result


@dataclass
class RecommendationReason:
    """Reason for a recommendation."""
    primary_feature: str
    supporting_features: List[str]
    direction: Direction
    severity: Severity
    delta_details: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict:
        return {
            "primary_feature": self.primary_feature,
            "supporting_features": self.supporting_features,
            "direction": self.direction.value,
            "severity": self.severity.value,
            "delta_details": self.delta_details,
        }


@dataclass
class SafetyInfo:
    """Safety information for a recommendation."""
    clamped: bool
    blocked_by: List[str]
    requires_reanalysis: bool
    clamp_details: List[Dict] = field(default_factory=list)

    def to_dict(self) -> Dict:
        return {
            "clamped": self.clamped,
            "blocked_by": self.blocked_by,
            "requires_reanalysis": self.requires_reanalysis,
            "clamp_details": self.clamp_details,
        }


@dataclass
class ProfileRecommendation:
    """Complete recommendation for a profile."""
    profile: str
    state: DecisionState
    confidence: float
    reason: Optional[RecommendationReason]
    recommendations: List[DSPRecommendation]
    safety: SafetyInfo
    state_reason: str = ""

    def to_dict(self) -> Dict:
        return {
            "profile": self.profile,
            "state": self.state.value,
            "confidence": self.confidence,
            "state_reason": self.state_reason,
            "reason": self.reason.to_dict() if self.reason else None,
            "recommendations": [r.to_dict() for r in self.recommendations],
            "safety": self.safety.to_dict(),
        }


class RecommendationEngine:
    """
    Generates DSP recommendations from feature deltas.

    P0 Rules:
    - All recommendations are ADVISORY_ONLY
    - Recommendations are clamped to safe ranges
    - Low confidence results in CONDITIONAL or BLOCKED
    - UNSUPPORTED mappings result in UNCALIBRATED
    - Missing features result in INSUFFICIENT_DATA
    """

    def __init__(self):
        self.delta_engine = DeltaEngine()
        self.mapping_registry = get_mapping_registry()
        self.safety_clamp = get_safety_clamp()

    def generate_recommendation(
        self,
        profile: str,
        features: Dict[str, Any],
        blocked_actions: List[str] = None,
    ) -> ProfileRecommendation:
        """
        Generate recommendation for a single profile.

        Args:
            profile: Profile ID
            features: Feature dictionary
            blocked_actions: Actions blocked by conflict engine

        Returns:
            ProfileRecommendation
        """
        blocked_actions = blocked_actions or []

        # Calculate profile delta
        profile_delta = self.delta_engine.calculate_profile_delta(profile, features)

        # Check for insufficient data
        if profile_delta.confidence_factor == 0:
            return self._make_insufficient_data(profile, profile_delta.missing_features)

        # Check for no data-derived targets
        if not profile_delta.has_data_derived_target:
            return self._make_uncalibrated(profile, "No data-derived targets available")

        # Check if in normal range (NO_ACTION)
        if profile_delta.primary_direction == Direction.IN_RANGE:
            return self._make_no_action(profile, profile_delta)

        # Get applicable mapping rules
        rules = self.mapping_registry.get_applicable_rules(
            profile, profile_delta.primary_direction
        )

        # Check for unsupported mapping
        if not rules or all(r.source == MappingSource.UNSUPPORTED for r in rules):
            return self._make_uncalibrated(profile, "No supported mapping rules")

        # Generate recommendations from rules
        recommendations = []
        any_clamped = False
        clamp_details = []

        for rule in rules:
            if rule.source == MappingSource.UNSUPPORTED:
                continue

            # Check if blocked by conflict
            if self._is_blocked(rule, blocked_actions):
                continue

            # Get suggested value from mapping
            suggested = rule.map_delta_to_value(
                profile_delta.feature_deltas[0].distance_normalized if profile_delta.feature_deltas else 0,
                profile_delta.overall_severity,
            )

            if suggested is None:
                continue

            # Apply safety clamp
            clamped_value, was_clamped, original = self.safety_clamp.clamp(
                rule.processor.value, rule.parameter, suggested
            )

            if was_clamped:
                any_clamped = True
                clamp_details.append({
                    "parameter": rule.parameter,
                    "original": original,
                    "clamped": clamped_value,
                })

            rec = DSPRecommendation(
                processor=rule.processor.value,
                parameter=rule.parameter,
                suggested_value=clamped_value,
                safe_min=rule.safe_min,
                safe_max=rule.safe_max,
                unit=rule.unit,
                clamped=was_clamped,
                original_value=original,
                frequency_hz=rule.extra_params.get("frequency_hz"),
                q=rule.extra_params.get("q"),
                rule_id=rule.rule_id,
                mapping_source=rule.source.value,
            )
            recommendations.append(rec)

        # Calculate confidence
        confidence = self._calculate_confidence(profile_delta, rules)

        # Determine state based on confidence and recommendations
        state, state_reason = self._determine_state(
            confidence, recommendations, blocked_actions
        )

        # Build reason
        reason = self._build_reason(profile_delta)

        # Build safety info
        safety = SafetyInfo(
            clamped=any_clamped,
            blocked_by=[a for a in blocked_actions if self._action_affects_profile(a, profile)],
            requires_reanalysis=any_clamped,
            clamp_details=clamp_details,
        )

        return ProfileRecommendation(
            profile=profile,
            state=state,
            confidence=round(confidence, 3),
            reason=reason,
            recommendations=recommendations,
            safety=safety,
            state_reason=state_reason,
        )

    def _make_insufficient_data(
        self, profile: str, missing: List[str]
    ) -> ProfileRecommendation:
        """Create INSUFFICIENT_DATA recommendation."""
        return ProfileRecommendation(
            profile=profile,
            state=DecisionState.INSUFFICIENT_DATA,
            confidence=0.0,
            reason=None,
            recommendations=[],
            safety=SafetyInfo(clamped=False, blocked_by=[], requires_reanalysis=False),
            state_reason=f"Missing features: {', '.join(missing)}",
        )

    def _make_uncalibrated(
        self, profile: str, reason: str
    ) -> ProfileRecommendation:
        """Create UNCALIBRATED recommendation."""
        return ProfileRecommendation(
            profile=profile,
            state=DecisionState.UNCALIBRATED,
            confidence=0.0,
            reason=None,
            recommendations=[],
            safety=SafetyInfo(clamped=False, blocked_by=[], requires_reanalysis=False),
            state_reason=reason,
        )

    def _make_no_action(
        self, profile: str, profile_delta: ProfileDelta
    ) -> ProfileRecommendation:
        """Create NO_ACTION recommendation."""
        return ProfileRecommendation(
            profile=profile,
            state=DecisionState.NO_ACTION,
            confidence=1.0,
            reason=RecommendationReason(
                primary_feature=profile_delta.feature_deltas[0].feature if profile_delta.feature_deltas else "",
                supporting_features=[],
                direction=Direction.IN_RANGE,
                severity=Severity.NONE,
            ),
            recommendations=[],
            safety=SafetyInfo(clamped=False, blocked_by=[], requires_reanalysis=False),
            state_reason="Feature within target range",
        )

    def _is_blocked(self, rule: MappingRule, blocked_actions: List[str]) -> bool:
        """Check if a rule is blocked by conflict actions."""
        for action in blocked_actions:
            action_lower = action.lower()
            if rule.processor.value.lower() in action_lower:
                return True
            if rule.parameter.lower() in action_lower:
                return True
        return False

    def _action_affects_profile(self, action: str, profile: str) -> bool:
        """Check if a blocked action affects this profile."""
        action_lower = action.lower()
        profile_lower = profile.lower()

        # Check common action-profile relationships
        mapping = {
            "stereo": "stereo_image",
            "widening": "stereo_image",
            "compression": "dynamic_range",
            "limiting": ["dynamic_range", "loudness", "peak_safety"],
            "bass": "low_end",
            "transient": "transient",
        }

        for keyword, profiles in mapping.items():
            if keyword in action_lower:
                if isinstance(profiles, list):
                    if profile_lower in [p.lower() for p in profiles]:
                        return True
                elif profile_lower == profiles.lower():
                    return True

        return False

    def _calculate_confidence(
        self,
        profile_delta: ProfileDelta,
        rules: List[MappingRule],
    ) -> float:
        """Calculate confidence for the recommendation."""
        if not rules:
            return 0.0

        # Base confidence from feature completeness
        base_confidence = profile_delta.confidence_factor

        # Apply mapping source ceiling
        sources = [r.source for r in rules if r.source != MappingSource.UNSUPPORTED]
        if not sources:
            return 0.0

        # Use lowest ceiling among applicable rules
        ceilings = [MAPPING_CONFIDENCE_CEILING[s.value] for s in sources]
        source_ceiling = min(ceilings)

        # Apply data-derived bonus
        if profile_delta.has_data_derived_target:
            data_bonus = 1.0
        else:
            data_bonus = 0.5

        confidence = base_confidence * source_ceiling * data_bonus

        return min(confidence, source_ceiling)

    def _determine_state(
        self,
        confidence: float,
        recommendations: List[DSPRecommendation],
        blocked_actions: List[str],
    ) -> tuple:
        """Determine decision state based on confidence and recommendations."""
        if not recommendations:
            if blocked_actions:
                return (DecisionState.BLOCKED, "All recommendations blocked by conflicts")
            return (DecisionState.UNCALIBRATED, "No applicable recommendations")

        if confidence >= CONFIDENCE_THRESHOLD_RECOMMEND:
            return (DecisionState.RECOMMEND, "High confidence recommendation")
        elif confidence >= CONFIDENCE_THRESHOLD_CONDITIONAL:
            return (DecisionState.CONDITIONAL, "Medium confidence - proceed with caution")
        else:
            return (DecisionState.BLOCKED, f"Low confidence ({confidence:.2f}) - recommendation blocked")

    def _build_reason(self, profile_delta: ProfileDelta) -> Optional[RecommendationReason]:
        """Build recommendation reason from delta."""
        if not profile_delta.feature_deltas:
            return None

        primary = profile_delta.feature_deltas[0]
        supporting = [fd.feature for fd in profile_delta.feature_deltas[1:]]

        return RecommendationReason(
            primary_feature=primary.feature,
            supporting_features=supporting,
            direction=profile_delta.primary_direction,
            severity=profile_delta.overall_severity,
            delta_details={
                "primary_delta": primary.delta_absolute,
                "primary_position": primary.position,
                "normalized_distance": primary.distance_normalized,
            },
        )

    def generate_all_recommendations(
        self,
        features: Dict[str, Any],
        blocked_actions: List[str] = None,
    ) -> Dict[str, ProfileRecommendation]:
        """
        Generate recommendations for all profiles.

        Args:
            features: Feature dictionary
            blocked_actions: Actions blocked by conflict engine

        Returns:
            Dictionary mapping profile ID to recommendation
        """
        results = {}
        for profile in PROFILE_ORDER:
            results[profile] = self.generate_recommendation(
                profile, features, blocked_actions
            )
        return results
