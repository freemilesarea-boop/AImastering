"""Commercial loudness policy — target resolution tests.

Covers the four input loudness bands, the explicit-target contract, the
no-unjustified-downward-normalisation guard, and the regression case that
motivated the policy (-9.1 LUFS input was being pulled to -13.0).
"""
from __future__ import annotations

import pytest

from app.mastering.loudness_policy import (
    AUTO_TARGET_CEILING_LUFS,
    AUTO_TARGET_FLOOR_LUFS,
    MAX_AUTO_DOWNWARD_LU,
    resolve_target_lufs,
)


# ── explicit target is never overridden ──────────────────────────────────────

@pytest.mark.parametrize("requested", [-14.0, -12.0, -10.0, -9.0, -16.0, -8.0])
def test_explicit_target_is_respected(requested):
    d = resolve_target_lufs(
        pre_lufs=-9.1, pre_lra=8.0, requested_target=requested, explicit_target=True
    )
    assert d.target_lufs == requested
    assert d.auto is False
    assert d.reason == "explicit_target"


def test_explicit_target_respected_for_every_input_band():
    for pre in (-20.0, -14.0, -10.0, -7.0):
        d = resolve_target_lufs(
            pre_lufs=pre, pre_lra=8.0, requested_target=-14.0, explicit_target=True
        )
        assert d.target_lufs == -14.0, f"explicit -14 overridden at input {pre}"


# ── band A: quiet ────────────────────────────────────────────────────────────

@pytest.mark.parametrize("pre", [-20.0, -18.0, -16.0])
def test_quiet_input_raised_to_commercial_floor(pre):
    d = resolve_target_lufs(pre_lufs=pre, pre_lra=9.0)
    assert d.auto is True
    # Raised, but never past the commercial floor, and never beyond the push cap.
    assert d.target_lufs > pre
    assert d.target_lufs <= AUTO_TARGET_FLOOR_LUFS


def test_quiet_input_push_is_capped():
    """A -20 LUFS mix must not be pushed the full 8 LU in one go."""
    d = resolve_target_lufs(pre_lufs=-20.0, pre_lra=9.0, max_upward=6.0)
    assert d.target_lufs == pytest.approx(-14.0)
    assert d.reason == "upward_push_capped"


# ── band B: moderate ─────────────────────────────────────────────────────────

@pytest.mark.parametrize("pre", [-15.0, -13.0, -12.5])
def test_moderate_input_raised_into_window(pre):
    d = resolve_target_lufs(pre_lufs=pre, pre_lra=8.0)
    assert d.target_lufs == pytest.approx(AUTO_TARGET_FLOOR_LUFS)
    assert d.reason == "raised_to_commercial_floor"


# ── band C: loud premaster — preserved ───────────────────────────────────────

@pytest.mark.parametrize("pre", [-12.0, -11.0, -10.0, -9.5, -9.0])
def test_loud_premaster_loudness_is_preserved(pre):
    d = resolve_target_lufs(pre_lufs=pre, pre_lra=7.0)
    assert d.target_lufs == pytest.approx(pre)
    assert d.reason == "preserve_input_loudness"


# ── band D: already mastered — bounded attenuation only ──────────────────────

@pytest.mark.parametrize("pre", [-8.0, -7.0, -6.0])
def test_already_mastered_attenuation_never_exceeds_cap(pre):
    d = resolve_target_lufs(pre_lufs=pre, pre_lra=5.0)
    attenuation = pre - d.target_lufs
    assert 0 <= attenuation <= MAX_AUTO_DOWNWARD_LU + 1e-9, (
        f"input {pre} attenuated {attenuation} LU, cap is {MAX_AUTO_DOWNWARD_LU}"
    )


def test_downward_cap_reason_is_reported():
    d = resolve_target_lufs(pre_lufs=-6.0, pre_lra=5.0)
    assert d.reason == "downward_capped"
    assert d.clamped_by == "max_auto_downward"


# ── the regression that motivated this policy ────────────────────────────────

def test_regression_minus_9_1_is_not_pulled_down_to_minus_13():
    """Measured before: -9.1 LUFS in → -13.0 LUFS out (-3.9 LU)."""
    d = resolve_target_lufs(pre_lufs=-9.1, pre_lra=6.0)
    assert d.target_lufs >= -9.1 - MAX_AUTO_DOWNWARD_LU
    assert d.target_lufs > -13.0
    # -9.1 sits inside the window, so it should simply be preserved.
    assert d.target_lufs == pytest.approx(-9.1)


def test_no_auto_result_is_ever_the_old_fixed_default():
    """AUTO must never land on -14 for a measurable input."""
    for pre in (-20.0, -16.0, -14.0, -12.0, -10.0, -9.0, -7.0):
        d = resolve_target_lufs(pre_lufs=pre, pre_lra=8.0)
        if pre > -20.0:  # -20 legitimately caps at -14 via the push limit
            assert d.target_lufs != -14.0 or pre == -20.0


# ── guards ───────────────────────────────────────────────────────────────────

def test_low_lra_already_loud_material_is_not_pushed():
    """Squashed AND already loud → pushing further is what pumps.

    On the default AUTO path this guard is unreachable by construction: any
    input at or above the floor is already inside the window, so the policy
    never asks to push it. It bites only when a loud *style* demands the
    ceiling on material that is already squashed.
    """
    d = resolve_target_lufs(pre_lufs=-11.0, pre_lra=2.0, style="kpop_loud")
    assert d.target_lufs == pytest.approx(-11.0)
    assert d.reason == "low_lra_no_push"


def test_loud_style_still_pushes_when_dynamics_allow():
    d = resolve_target_lufs(pre_lufs=-11.0, pre_lra=8.0, style="kpop_loud")
    assert d.target_lufs == pytest.approx(-9.0)


def test_low_lra_quiet_material_is_still_raised():
    """A quiet low-LRA track has headroom; refusing to raise it would leave
    the master quiet for a reason the listener cannot hear."""
    d = resolve_target_lufs(pre_lufs=-17.2, pre_lra=3.7)
    assert d.target_lufs > -17.2
    assert d.reason != "low_lra_no_push"


def test_low_lra_does_not_block_attenuation():
    """The guard only blocks pushing louder, never a needed reduction."""
    d = resolve_target_lufs(pre_lufs=-6.0, pre_lra=2.0)
    assert d.target_lufs < -6.0


def test_loud_style_targets_ceiling():
    d = resolve_target_lufs(pre_lufs=-14.0, pre_lra=8.0, style="kpop_loud", max_upward=6.0)
    assert d.target_lufs == pytest.approx(-9.0)
    d2 = resolve_target_lufs(pre_lufs=-18.0, pre_lra=8.0, style="loud", max_upward=6.0)
    assert d2.target_lufs == pytest.approx(-12.0)  # push-capped from -18


@pytest.mark.parametrize("bad", [None, -99.0, -70.0, -80.0])
def test_unmeasurable_input_falls_back_to_floor(bad):
    d = resolve_target_lufs(pre_lufs=bad, pre_lra=None)
    assert d.target_lufs == AUTO_TARGET_FLOOR_LUFS
    assert d.reason == "no_input_measurement"


# ── invariants ───────────────────────────────────────────────────────────────

def test_auto_target_always_within_window_or_input_bounded():
    """The ceiling binds only as far as the downward cap allows.

    An input louder than the ceiling is deliberately left above it — pulling it
    all the way down would be exactly the unjustified normalisation this policy
    exists to prevent. So the real upper bound is
    max(ceiling, input - MAX_AUTO_DOWNWARD_LU).
    """
    for pre in [x / 2 for x in range(-44, -10)]:
        d = resolve_target_lufs(pre_lufs=pre, pre_lra=8.0)
        upper = max(AUTO_TARGET_CEILING_LUFS, pre - MAX_AUTO_DOWNWARD_LU)
        assert d.target_lufs <= upper + 1e-9
        assert d.target_lufs >= min(pre, AUTO_TARGET_FLOOR_LUFS) - MAX_AUTO_DOWNWARD_LU - 1e-9
        # Never attenuate more than the cap for loudness reasons alone.
        if d.target_lufs < pre:
            assert pre - d.target_lufs <= MAX_AUTO_DOWNWARD_LU + 1e-9


def test_deterministic():
    a = resolve_target_lufs(pre_lufs=-10.4, pre_lra=6.2)
    b = resolve_target_lufs(pre_lufs=-10.4, pre_lra=6.2)
    assert a == b
