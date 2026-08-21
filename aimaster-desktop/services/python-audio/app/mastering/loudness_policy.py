"""
Commercial loudness policy — dynamic target resolution.

Replaces the fixed -14 LUFS AUTO default. The target is derived from the
input's own loudness so that a already-loud master is preserved rather than
normalised down to a streaming reference level, while a quiet mix is still
raised to a commercial level.

Scope: this module decides *what loudness to aim for*. It performs no DSP and
no I/O. Peak safety (true-peak ceiling, ISP, brickwall limiting) stays entirely
in the existing pipeline stages and is unchanged — those stages may still
attenuate by more than MAX_AUTO_DOWNWARD_LU when a safety invariant demands it,
which is exactly the "justified" downward case.

Policy:
  - Explicit caller target always wins.
  - AUTO target = clamp(input loudness, FLOOR, CEILING).
  - Downward movement for loudness reasons alone is capped at
    MAX_AUTO_DOWNWARD_LU.
  - Upward push is capped at MAX_UPWARD_PUSH_DB to bound limiter gain
    reduction (a bigger push is what drives GR, and GR is what causes pumping).
  - Already-squashed material (low LRA) is not pushed further.

Phase: AI-MASTERING-COMMERCIAL-LOUDNESS-POLICY-IMPLEMENTATION-1
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

# ── Commercial AUTO target range ─────────────────────────────────────────────
# Louder (closer to 0) bound and quieter bound of the automatic target window.
AUTO_TARGET_CEILING_LUFS = -9.0    # loudest the AUTO policy will aim for
AUTO_TARGET_FLOOR_LUFS = -12.0     # quietest the AUTO policy will aim for

# Loudness-only attenuation limit. Safety stages downstream are not bound by it.
MAX_AUTO_DOWNWARD_LU = 1.0

# Upward push limit. Limiter gain reduction scales with how hard we push, so
# bounding the push is how the policy bounds GR without touching the limiter.
MAX_UPWARD_PUSH_DB = 6.0

# Already heavily compressed material — pushing it further pumps.
LOW_LRA_THRESHOLD = 4.0

# Styles whose intent is explicitly "as loud as the policy allows".
LOUD_STYLES = frozenset({"loud", "kpop_loud"})

# Below this, the measurement is meaningless (silence / failed probe).
_INVALID_LUFS = -70.0


@dataclass(frozen=True)
class TargetDecision:
    """Result of target resolution."""
    target_lufs: float
    reason: str
    auto: bool
    input_lufs: Optional[float] = None
    clamped_by: Optional[str] = None

    def to_dict(self) -> dict:
        return {
            "targetLufs": self.target_lufs,
            "reason": self.reason,
            "auto": self.auto,
            "inputLufs": self.input_lufs,
            "clampedBy": self.clamped_by,
        }


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def resolve_target_lufs(
    pre_lufs: Optional[float],
    pre_lra: Optional[float] = None,
    requested_target: Optional[float] = None,
    explicit_target: bool = False,
    style: str = "balanced",
    *,
    floor: float = AUTO_TARGET_FLOOR_LUFS,
    ceiling: float = AUTO_TARGET_CEILING_LUFS,
    max_downward: float = MAX_AUTO_DOWNWARD_LU,
    max_upward: float = MAX_UPWARD_PUSH_DB,
    low_lra_threshold: float = LOW_LRA_THRESHOLD,
) -> TargetDecision:
    """Resolve the loudness target. Pure and deterministic.

    ``explicit_target`` means the caller (user, preset, API) deliberately chose
    ``requested_target``; it is returned untouched.
    """
    # 1. Explicit caller intent always wins.
    if explicit_target and requested_target is not None:
        return TargetDecision(
            target_lufs=float(requested_target),
            reason="explicit_target",
            auto=False,
            input_lufs=pre_lufs,
        )

    # 2. Without a usable measurement, aim at the quiet end of the window —
    #    the conservative choice, and never louder than the caller asked for.
    if pre_lufs is None or pre_lufs <= _INVALID_LUFS:
        return TargetDecision(
            target_lufs=float(floor),
            reason="no_input_measurement",
            auto=True,
            input_lufs=pre_lufs,
        )

    pre_lufs = float(pre_lufs)

    # 3. Base target: preserve the input's loudness inside the commercial window.
    if style in LOUD_STYLES:
        base = ceiling
        reason = "loud_style"
        clamped_by = "style_ceiling"
    else:
        base = _clamp(pre_lufs, floor, ceiling)
        if base > pre_lufs:
            reason, clamped_by = "raised_to_commercial_floor", "floor"
        elif base < pre_lufs:
            reason, clamped_by = "capped_at_commercial_ceiling", "ceiling"
        else:
            reason, clamped_by = "preserve_input_loudness", None

    # 4. No unjustified downward normalisation.
    if base < pre_lufs:
        downward = pre_lufs - base
        if downward > max_downward:
            base = pre_lufs - max_downward
            reason = "downward_capped"
            clamped_by = "max_auto_downward"

    # 5. Bound the upward push so limiter GR stays in a musical range.
    if base > pre_lufs:
        push = base - pre_lufs
        if push > max_upward:
            base = pre_lufs + max_upward
            reason = "upward_push_capped"
            clamped_by = "max_upward_push"

    # 6. Do not push material that is ALREADY loud and already squashed —
    #    that is what pumps. A quiet track with a low LRA is still raised: it
    #    has headroom, and refusing to raise it would leave the master quiet
    #    for a reason the listener cannot hear.
    if (
        pre_lra is not None
        and pre_lra < low_lra_threshold
        and pre_lufs >= floor
        and base > pre_lufs
    ):
        base = pre_lufs
        reason = "low_lra_no_push"
        clamped_by = "low_lra"

    return TargetDecision(
        target_lufs=round(float(base), 2),
        reason=reason,
        auto=True,
        input_lufs=pre_lufs,
        clamped_by=clamped_by,
    )
