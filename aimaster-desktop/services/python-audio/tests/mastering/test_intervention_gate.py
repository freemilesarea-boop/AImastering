"""Intervention tier + evidence gate — safety invariants.

These tests exist because of defect D6: the apply gate (0.40) sat below the
recommend gate (0.75), so a DESIGN_CANDIDATE mapping whose confidence is capped
at 0.65 could never be RECOMMENDed yet still reached real audio through the
CONDITIONAL state. A 25-track audit found 5 such corrections being rendered.

Every test here pins a property that must hold for a user's audio to be safe,
not an implementation detail. If one of them fails, an unvalidated correction
can reach a render.
"""
from __future__ import annotations

import pytest

from app.mastering.decision_engine.constants import (
    CONFIDENCE_THRESHOLD_RECOMMEND,
    CORRECTABLE_INTERVENTION_TIERS,
    EVIDENCE_MAPPING_SOURCES,
    Direction,
    InterventionTier,
    MappingSource,
    Severity,
)
from app.mastering.decision_engine.delta_engine import resolve_intervention_tier
from app.mastering.closed_loop.constants import (
    APPLICABLE_INTERVENTION_TIERS,
    APPLY_REQUIRES_MAPPING_SOURCES,
    MIN_CONFIDENCE_FOR_APPLY,
)
from app.mastering.closed_loop.recommendation_selector import RecommendationSelector


# ── the invariant that D6 violated ───────────────────────────────────────────

def test_apply_gate_is_never_looser_than_recommend_gate():
    """The whole point of the repair. Must hold for every future edit."""
    assert MIN_CONFIDENCE_FOR_APPLY >= CONFIDENCE_THRESHOLD_RECOMMEND


def test_design_candidate_ceiling_cannot_reach_the_apply_gate():
    """DESIGN_CANDIDATE confidence is capped at 0.65 by MAPPING_CONFIDENCE_CEILING.

    With the apply gate derived from the recommend gate (0.75), that ceiling can
    never satisfy it - which is the property that stops the 5 observed
    corrections from rendering.
    """
    from app.mastering.decision_engine.constants import MAPPING_CONFIDENCE_CEILING

    assert MAPPING_CONFIDENCE_CEILING["DESIGN_CANDIDATE"] < MIN_CONFIDENCE_FOR_APPLY
    assert MAPPING_CONFIDENCE_CEILING["HEURISTIC"] < MIN_CONFIDENCE_FOR_APPLY


def test_only_data_derived_may_be_applied():
    assert APPLY_REQUIRES_MAPPING_SOURCES == EVIDENCE_MAPPING_SOURCES
    assert APPLY_REQUIRES_MAPPING_SOURCES == frozenset({MappingSource.DATA_DERIVED.value})
    for source in ("DESIGN_CANDIDATE", "HEURISTIC", "UNSUPPORTED"):
        assert source not in APPLY_REQUIRES_MAPPING_SOURCES


def test_only_candidate_and_act_tiers_are_correctable():
    assert APPLICABLE_INTERVENTION_TIERS == CORRECTABLE_INTERVENTION_TIERS
    assert InterventionTier.NONE.value not in APPLICABLE_INTERVENTION_TIERS
    assert InterventionTier.WATCH.value not in APPLICABLE_INTERVENTION_TIERS


# ── tier resolution ──────────────────────────────────────────────────────────

@pytest.mark.parametrize("severity", list(Severity))
def test_in_range_is_always_tier_none(severity):
    assert resolve_intervention_tier(Direction.IN_RANGE, severity) is InterventionTier.NONE


@pytest.mark.parametrize("severity", list(Severity))
def test_unknown_direction_is_always_tier_none(severity):
    assert resolve_intervention_tier(Direction.UNKNOWN, severity) is InterventionTier.NONE


@pytest.mark.parametrize("direction", [Direction.TOO_LOW, Direction.TOO_HIGH])
@pytest.mark.parametrize("severity", list(Severity))
def test_too_low_high_is_act(direction, severity):
    assert resolve_intervention_tier(direction, severity) is InterventionTier.ACT


@pytest.mark.parametrize("direction", [Direction.SLIGHTLY_LOW, Direction.SLIGHTLY_HIGH])
@pytest.mark.parametrize("severity", [Severity.NONE, Severity.LOW, Severity.MEDIUM])
def test_small_slight_deviation_is_watch(direction, severity):
    assert resolve_intervention_tier(direction, severity) is InterventionTier.WATCH


@pytest.mark.parametrize("direction", [Direction.SLIGHTLY_LOW, Direction.SLIGHTLY_HIGH])
@pytest.mark.parametrize("severity", [Severity.HIGH, Severity.CRITICAL])
def test_large_slight_deviation_is_candidate(direction, severity):
    assert resolve_intervention_tier(direction, severity) is InterventionTier.CANDIDATE


def test_tier_resolution_is_total_and_deterministic():
    for d in Direction:
        for s in Severity:
            a = resolve_intervention_tier(d, s)
            b = resolve_intervention_tier(d, s)
            assert isinstance(a, InterventionTier)
            assert a is b


def test_slightly_is_never_relabelled_as_too():
    """The forbidden shortcut: SLIGHTLY_* must not become TOO_*.

    Tiering classifies a deviation; it must not rewrite the measurement. ACT is
    reachable only from a genuine TOO_* direction.
    """
    for severity in Severity:
        for direction in (Direction.SLIGHTLY_LOW, Direction.SLIGHTLY_HIGH):
            assert resolve_intervention_tier(direction, severity) is not InterventionTier.ACT


# ── selector enforcement ─────────────────────────────────────────────────────

def _decision(state="RECOMMEND", tier=InterventionTier.ACT.value,
              confidence=1.0, source=MappingSource.DATA_DERIVED.value,
              profile="BRIGHTNESS"):
    """Minimal decision-engine-shaped payload for the selector."""
    return {
        "recommendations": {
            profile: {
                "state": state,
                "confidence": confidence,
                "state_reason": "test",
                "intervention_tier": tier,
                "recommendations": [{
                    "processor": "EQ",
                    "parameter": "high_shelf_gain_db",
                    "suggested_value": -1.5,
                    "rule_id": "TEST_001",
                    "mapping_source": source,
                }],
            }
        }
    }


def _select(**kwargs):
    return RecommendationSelector().select_recommendations(_decision(**kwargs))


def test_fully_qualified_recommendation_is_selectable():
    """Guard against the gates being vacuously true: something must still pass."""
    assert len(_select().selected) == 1


@pytest.mark.parametrize("tier", [InterventionTier.NONE.value, InterventionTier.WATCH.value])
def test_none_and_watch_tiers_are_never_applied(tier):
    assert _select(tier=tier).selected == []


def test_absent_tier_is_never_applied():
    """A payload that states no tier must not inherit permission by omission."""
    d = _decision()
    del d["recommendations"]["BRIGHTNESS"]["intervention_tier"]
    assert RecommendationSelector().select_recommendations(d).selected == []


@pytest.mark.parametrize("source", ["DESIGN_CANDIDATE", "HEURISTIC", "UNSUPPORTED"])
def test_sources_without_evidence_are_never_applied(source):
    assert _select(source=source).selected == []


@pytest.mark.parametrize("tier", [InterventionTier.CANDIDATE.value, InterventionTier.ACT.value])
def test_correctable_tier_without_evidence_is_still_not_applied(tier):
    """ACT does not mean apply. Evidence is a separate, additional gate."""
    assert _select(tier=tier, source="DESIGN_CANDIDATE").selected == []


def test_data_derived_below_apply_threshold_is_not_applied():
    below = MIN_CONFIDENCE_FOR_APPLY - 0.01
    assert _select(confidence=below).selected == []


def test_data_derived_at_apply_threshold_is_applied():
    assert len(_select(confidence=MIN_CONFIDENCE_FOR_APPLY).selected) == 1


def test_the_exact_defect_d6_shape_is_blocked():
    """The observed production case: CONDITIONAL + DESIGN_CANDIDATE + 0.65.

    This is precisely what was rendering -1.5 dB of high shelf onto user audio.
    """
    result = _select(state="CONDITIONAL", confidence=0.65, source="DESIGN_CANDIDATE")
    assert result.selected == []
    assert result.total_candidates == 0
