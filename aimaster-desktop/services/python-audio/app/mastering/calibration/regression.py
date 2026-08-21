"""
Closed Loop Calibration - Regression measurement.

``MappingCalibrator`` used to report ``regression_rate=0.0`` as a literal with a
``# TODO: implement regression tracking`` beside it, while ``REGRESSION_RATE_MAX``
was defined but never consulted. Promotion therefore had no regression axis at
all: a mapping that reliably moved its primary feature in the right direction
could be promoted no matter what it did to everything else.

Three independent regression definitions are implemented here, each answering a
different question:

  R1 - collateral: did a feature we were not aiming at leave its normal range?
  R2 - safety: did the render newly break a safety invariant?
  R3 - overcorrection: did we shoot past the target and land further away?

R1 and R3 are rates and aggregate into ``regression_rate = max(R1, R3)``.
R2 is deliberately NOT a rate: averaging safety failures across candidates would
let a rule with one clipping render still look acceptable. It is counted, and a
single violation is disqualifying.

Everything in this module is pure and deterministic: it reads measurements and
returns verdicts. No I/O, no rendering, no global state.

Phase: AI-MASTERING-REGRESSION-TRACKING-IMPLEMENTATION-1
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence, Tuple

from .constants import COLLATERAL_FEATURES, PARAMETER_SWEEPS
from app.mastering.decision_engine.constants import PROFILE_ORDER
from app.mastering.decision_engine.target_registry import (
    TargetStatistics,
    get_target_registry,
)
from app.mastering.closed_loop.constants import (
    SAFETY_CLIPPING_MAX_SAMPLES,
    SAFETY_MONO_COMPATIBILITY_MIN,
    SAFETY_TRUE_PEAK_MAX_DBTP,
)


# ── feature keys used by the safety axis ─────────────────────────────────────
FEATURE_TRUE_PEAK = "input_tp"
FEATURE_SAMPLE_PEAK = "sample_peak_dbfs"
FEATURE_CLIPPING = "clipping_sample_count"
FEATURE_MONO_COMPAT = "mono_compatibility_score"

# Inter-sample overshoot is how far the true (inter-sample) peak sits above the
# sample peak. A gain change moves both equally and so does not register here;
# only a render that genuinely adds inter-sample content does. The tolerance
# keeps measurement noise from being reported as a safety regression.
ISP_OVERSHOOT_TOLERANCE_DB = 0.1

# R2 violation codes.
R2_CLIPPING = "CLIPPING_INTRODUCED"
R2_TRUE_PEAK = "TRUE_PEAK_CEILING_EXCEEDED"
R2_ISP = "ISP_OVERSHOOT_WORSENED"
R2_MONO = "MONO_COMPATIBILITY_LOST"


# ── result types ─────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class CollateralRegression:
    """One monitored collateral feature, before vs after."""
    feature: str
    before_value: float
    after_value: float
    before_in_range: bool
    after_in_range: bool

    @property
    def regressed(self) -> bool:
        """Normal before, abnormal after. Leaving an already-abnormal value
        abnormal is not a regression - it was not us who put it there."""
        return self.before_in_range and not self.after_in_range


@dataclass(frozen=True)
class OvercorrectionRegression:
    """One primary feature checked for shooting past the target."""
    feature: str
    before_value: float
    after_value: float
    target_median: float

    @property
    def crossed_target(self) -> bool:
        before_side = self.before_value - self.target_median
        after_side = self.after_value - self.target_median
        if before_side == 0.0 or after_side == 0.0:
            return False
        return (before_side > 0) != (after_side > 0)

    @property
    def further_away(self) -> bool:
        return abs(self.after_value - self.target_median) > abs(
            self.before_value - self.target_median
        )

    @property
    def overcorrected(self) -> bool:
        return self.crossed_target and self.further_away


@dataclass(frozen=True)
class CandidateRegression:
    """Regression verdict for a single calibration candidate."""
    r1_monitored: int = 0
    r1_regressed: int = 0
    r1_details: Tuple[CollateralRegression, ...] = ()
    r2_violations: Tuple[str, ...] = ()
    r3_overcorrected: bool = False
    r3_details: Tuple[OvercorrectionRegression, ...] = ()

    @property
    def r1_rate(self) -> float:
        """Regressed share of the collateral features we could actually judge.

        Zero monitored features means zero measured regression, not a pass by
        default - ``r1_monitored`` is reported so an empty denominator stays
        visible rather than looking like a clean result.
        """
        if self.r1_monitored == 0:
            return 0.0
        return self.r1_regressed / self.r1_monitored

    @property
    def r2_violated(self) -> bool:
        return len(self.r2_violations) > 0

    def to_dict(self) -> Dict[str, Any]:
        return {
            "r1_monitored": self.r1_monitored,
            "r1_regressed": self.r1_regressed,
            "r1_rate": self.r1_rate,
            "r1_details": [
                {
                    "feature": d.feature,
                    "before": d.before_value,
                    "after": d.after_value,
                    "before_in_range": d.before_in_range,
                    "after_in_range": d.after_in_range,
                    "regressed": d.regressed,
                }
                for d in self.r1_details
            ],
            "r2_violations": list(self.r2_violations),
            "r2_violated": self.r2_violated,
            "r3_overcorrected": self.r3_overcorrected,
            "r3_details": [
                {
                    "feature": d.feature,
                    "before": d.before_value,
                    "after": d.after_value,
                    "target_median": d.target_median,
                    "crossed_target": d.crossed_target,
                    "further_away": d.further_away,
                    "overcorrected": d.overcorrected,
                }
                for d in self.r3_details
            ],
        }


@dataclass(frozen=True)
class RuleRegression:
    """Regression verdict aggregated over every candidate for one mapping rule."""
    candidate_count: int = 0
    r1_rate: float = 0.0
    r3_rate: float = 0.0
    r2_violation_count: int = 0

    @property
    def regression_rate(self) -> float:
        """The worse of the two rate axes.

        Max rather than mean: a rule that never touches collateral features but
        overshoots half the time is not half as bad as it looks.
        """
        return max(self.r1_rate, self.r3_rate)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "candidate_count": self.candidate_count,
            "r1_rate": self.r1_rate,
            "r3_rate": self.r3_rate,
            "regression_rate": self.regression_rate,
            "r2_violation_count": self.r2_violation_count,
        }


# ── helpers ──────────────────────────────────────────────────────────────────

def _as_float(value: Any) -> Optional[float]:
    """Coerce a measurement to float, or None when it is not a real number."""
    if value is None or isinstance(value, bool):
        return None
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    if result != result or result in (float("inf"), float("-inf")):  # NaN / inf
        return None
    return result


def find_target(feature: str) -> Optional[TargetStatistics]:
    """Find the commercial target for a feature, whichever profile owns it.

    Collateral features belong to a different profile than the one being swept,
    so the lookup cannot assume the source profile. PROFILE_ORDER is iterated in
    its declared order to keep the result deterministic.
    """
    registry = get_target_registry()
    for profile in PROFILE_ORDER:
        target = registry.get_target(profile, feature)
        if target is not None:
            return target
    return None


def feature_in_normal_range(feature: str, value: Optional[float]) -> Optional[bool]:
    """True/False if the feature has a target, None if it cannot be judged."""
    numeric = _as_float(value)
    if numeric is None:
        return None
    target = find_target(feature)
    if target is None:
        return None
    return target.in_normal_range(numeric)


def sweep_profile_for_parameter(parameter: str) -> Optional[str]:
    """Profile a swept parameter belongs to, from the sweep registry itself."""
    config = PARAMETER_SWEEPS.get(parameter)
    if config is None:
        return None
    return config.get("primary_profile") or None


# ── R1: collateral feature regression ────────────────────────────────────────

def detect_collateral_regression(
    profile: str,
    before_features: Dict[str, Any],
    after_features: Dict[str, Any],
) -> List[CollateralRegression]:
    """Collateral features that were normal before and are abnormal after.

    Only features with a commercial target are monitored - without a normal
    range there is nothing to leave.
    """
    monitored: List[CollateralRegression] = []

    for feature in COLLATERAL_FEATURES.get(profile, []):
        before = _as_float(before_features.get(feature))
        after = _as_float(after_features.get(feature))
        if before is None or after is None:
            continue

        before_in = feature_in_normal_range(feature, before)
        after_in = feature_in_normal_range(feature, after)
        if before_in is None or after_in is None:
            continue

        monitored.append(CollateralRegression(
            feature=feature,
            before_value=before,
            after_value=after,
            before_in_range=before_in,
            after_in_range=after_in,
        ))

    return monitored


# ── R2: safety regression ────────────────────────────────────────────────────

def detect_safety_regression(
    before_features: Dict[str, Any],
    after_features: Dict[str, Any],
) -> Tuple[str, ...]:
    """Safety invariants the render newly broke.

    "Newly" is the operative word: a track that already clipped before we
    touched it is not evidence that this mapping is unsafe. Each check therefore
    compares the after state against both the invariant and the before state.

    Returned as a tuple of codes rather than a rate - see the module docstring.
    """
    violations: List[str] = []

    # Clipping introduced where there was none.
    before_clip = _as_float(before_features.get(FEATURE_CLIPPING))
    after_clip = _as_float(after_features.get(FEATURE_CLIPPING))
    if after_clip is not None and after_clip > SAFETY_CLIPPING_MAX_SAMPLES:
        if before_clip is None or before_clip <= SAFETY_CLIPPING_MAX_SAMPLES:
            violations.append(R2_CLIPPING)

    # True peak pushed over the ceiling when it was under it.
    before_tp = _as_float(before_features.get(FEATURE_TRUE_PEAK))
    after_tp = _as_float(after_features.get(FEATURE_TRUE_PEAK))
    if after_tp is not None and after_tp > SAFETY_TRUE_PEAK_MAX_DBTP:
        if before_tp is None or before_tp <= SAFETY_TRUE_PEAK_MAX_DBTP:
            violations.append(R2_TRUE_PEAK)

    # Inter-sample overshoot worsened. Independent of the ceiling check above:
    # this catches a render adding inter-sample content while still under it.
    before_sp = _as_float(before_features.get(FEATURE_SAMPLE_PEAK))
    after_sp = _as_float(after_features.get(FEATURE_SAMPLE_PEAK))
    if None not in (before_tp, after_tp, before_sp, after_sp):
        before_overshoot = before_tp - before_sp
        after_overshoot = after_tp - after_sp
        if after_overshoot > before_overshoot + ISP_OVERSHOOT_TOLERANCE_DB:
            violations.append(R2_ISP)

    # Mono compatibility dropped below the safety floor from above it.
    before_mono = _as_float(before_features.get(FEATURE_MONO_COMPAT))
    after_mono = _as_float(after_features.get(FEATURE_MONO_COMPAT))
    if after_mono is not None and after_mono < SAFETY_MONO_COMPATIBILITY_MIN:
        if before_mono is None or before_mono >= SAFETY_MONO_COMPATIBILITY_MIN:
            violations.append(R2_MONO)

    return tuple(violations)


# ── R3: overcorrection regression ────────────────────────────────────────────

def detect_overcorrection(
    feature: str,
    before_value: Optional[float],
    after_value: Optional[float],
    target_median: Optional[float],
) -> Optional[OvercorrectionRegression]:
    """Build the overcorrection check for one primary feature.

    Returns None when the check cannot be made (missing measurement or target),
    so an unmeasurable candidate is never silently counted as clean.
    """
    before = _as_float(before_value)
    after = _as_float(after_value)
    median = _as_float(target_median)
    if before is None or after is None or median is None:
        return None
    return OvercorrectionRegression(
        feature=feature,
        before_value=before,
        after_value=after,
        target_median=median,
    )


# ── per-candidate and per-rule evaluation ────────────────────────────────────

def evaluate_candidate_regression(candidate_result: Any) -> CandidateRegression:
    """Full R1/R2/R3 verdict for one ``CandidateResult``.

    Typed as Any to avoid importing the schema module here: this keeps the
    regression maths independent of the calibration data classes, and lets the
    tests drive it with plain fixtures.
    """
    before = getattr(candidate_result, "before_features", None) or {}
    after = getattr(candidate_result, "after_features", None) or {}
    candidate = getattr(candidate_result, "candidate", None)
    parameter = getattr(candidate, "parameter", "") if candidate else ""

    # R1
    profile = sweep_profile_for_parameter(parameter) or ""
    collateral = detect_collateral_regression(profile, before, after) if profile else []
    regressed = [c for c in collateral if c.regressed]

    # R2
    violations = detect_safety_regression(before, after)

    # R3
    overcorrections: List[OvercorrectionRegression] = []
    for response in getattr(candidate_result, "primary_responses", None) or []:
        check = detect_overcorrection(
            getattr(response, "feature", ""),
            getattr(response, "before_value", None),
            getattr(response, "after_value", None),
            getattr(response, "target_median", None),
        )
        if check is not None:
            overcorrections.append(check)

    return CandidateRegression(
        r1_monitored=len(collateral),
        r1_regressed=len(regressed),
        r1_details=tuple(collateral),
        r2_violations=violations,
        r3_overcorrected=any(o.overcorrected for o in overcorrections),
        r3_details=tuple(overcorrections),
    )


def aggregate_rule_regression(
    candidate_regressions: Sequence[CandidateRegression],
) -> RuleRegression:
    """Aggregate per-candidate verdicts into the rule-level regression record."""
    count = len(candidate_regressions)
    if count == 0:
        return RuleRegression()

    r1_rate = sum(c.r1_rate for c in candidate_regressions) / count
    r3_rate = sum(1 for c in candidate_regressions if c.r3_overcorrected) / count
    r2_count = sum(1 for c in candidate_regressions if c.r2_violated)

    return RuleRegression(
        candidate_count=count,
        r1_rate=r1_rate,
        r3_rate=r3_rate,
        r2_violation_count=r2_count,
    )


def rule_regression_for_candidates(candidate_results: Sequence[Any]) -> RuleRegression:
    """Convenience: evaluate every candidate and aggregate in one call."""
    return aggregate_rule_regression(
        [evaluate_candidate_regression(c) for c in candidate_results]
    )
