"""
Tests for the v3.3 gain-staging architectural fix.

Covers:
  · LIMITER_STRENGTHS push reduction
  · Compressor makeup gain cap
  · _STATIC_ENTRY_GAIN_MAX clamp
  · build_gain_staging_report verdict logic
  · Pipeline preserves transients when gain push is small
"""
from __future__ import annotations

import pytest


# ── Push-default audits ──────────────────────────────────────────────────────

def test_limiter_strengths_no_longer_push_loudly():
    """Limiter is now peak-safety only — input_gain_db must be small (≤ 1.5 dB)."""
    from app.mastering.pipeline import LIMITER_STRENGTHS
    assert LIMITER_STRENGTHS["low"]["input_gain_db"] <= 0.0
    assert LIMITER_STRENGTHS["medium"]["input_gain_db"] <= 0.5
    assert LIMITER_STRENGTHS["high"]["input_gain_db"] <= 1.5


def test_compressor_makeup_gain_capped():
    """Compressor is glue/색 only — makeup ≤ 1 dB across all modes."""
    from app.mastering.dynamics import _STYLE_COMP, _MAX_MAKEUP_DB
    assert _MAX_MAKEUP_DB <= 1.0
    for mode, params in _STYLE_COMP.items():
        assert params["makeup"] <= 1.0, f"{mode} makeup={params['makeup']} > 1.0"


def test_static_entry_gain_max_capped_to_6db():
    """Pre-limiter loudness push must never exceed +6 dB (correction handles rest)."""
    from app.mastering.pipeline import _STATIC_ENTRY_GAIN_MAX
    assert _STATIC_ENTRY_GAIN_MAX <= 6.0


def test_kpop_loud_compressor_preserves_transients():
    """KPOP loud must not have aggressive ratio + fast attack that crushes vocals."""
    from app.mastering.dynamics import _STYLE_COMP
    p = _STYLE_COMP["kpop_loud"]
    # ratio relaxed (was 2.8; must not be > 2.5)
    assert p["ratio"] <= 2.5
    # attack slower (was 10ms; must allow ≥ 12 ms for vocal pick to survive)
    assert p["attack"] >= 12


# ── gain_staging report ────────────────────────────────────────────────────

def test_gain_staging_report_flags_crest_collapse():
    from app.qc.gain_staging import build_gain_staging_report
    rep = build_gain_staging_report(
        input_metrics  = {"crestFactor": 14.0, "lra": 8.0},
        output_metrics = {"crestFactor": 4.0,  "lra": 7.0},
        input_path     = "/nonexistent.wav",
        output_path    = "/nonexistent.wav",
        pipeline_stages = {"compressorMakeupDb": 0.5, "preGainDb": 5.0},
    )
    # Crest factor dropped 71% → danger
    assert rep["verdict"] == "danger"
    assert rep["crestFactorDropPct"] is not None
    assert rep["crestFactorDropPct"] > 0.55
    assert "low_limit" in rep["recommendations"]


def test_gain_staging_report_flags_excessive_pre_push():
    """preGainDb > 6 dB is a yellow flag even without other symptoms."""
    from app.qc.gain_staging import build_gain_staging_report
    rep = build_gain_staging_report(
        input_metrics  = {"crestFactor": 12.0, "lra": 9.0},
        output_metrics = {"crestFactor": 11.0, "lra": 8.0},
        input_path     = "/nonexistent.wav",
        output_path    = "/nonexistent.wav",
        pipeline_stages = {"preGainDb": 8.0},
    )
    assert rep["verdict"] in ("warn", "danger")
    assert "low_limit" in rep["recommendations"]


def test_gain_staging_report_total_applied_gain_sum():
    """totalAppliedGainDb must be the sum of every push stage."""
    from app.qc.gain_staging import build_gain_staging_report
    rep = build_gain_staging_report(
        input_metrics={}, output_metrics={},
        input_path="/x.wav", output_path="/x.wav",
        pipeline_stages={
            "compressorMakeupDb": 0.5,
            "preGainDb":          4.0,
            "limiterInputGainDb": 0.5,
            "correctionGainDb":   1.0,
            "ispCorrectionDb":   -0.3,
        },
    )
    assert rep["stages"]["totalAppliedGainDb"] == pytest.approx(5.7, abs=0.01)


def test_gain_staging_report_passes_clean_master():
    from app.qc.gain_staging import build_gain_staging_report
    rep = build_gain_staging_report(
        input_metrics  = {"crestFactor": 12.0, "lra": 8.0},
        output_metrics = {"crestFactor": 11.0, "lra": 7.0},
        input_path     = "/nonexistent.wav",
        output_path    = "/nonexistent.wav",
        pipeline_stages = {"preGainDb": 3.0, "compressorMakeupDb": 0.5},
    )
    assert rep["verdict"] == "ok"
    assert not rep["issues"]


def test_gain_staging_report_handles_missing_metrics():
    """When input/output metrics are absent, verdict must default to ok (no false alarm)."""
    from app.qc.gain_staging import build_gain_staging_report
    rep = build_gain_staging_report(
        input_metrics=None, output_metrics=None,
        input_path="/nonexistent.wav", output_path="/nonexistent.wav",
        pipeline_stages={},
    )
    # No data → no issues
    assert rep["verdict"] == "ok"
    assert rep["crestFactorDropPct"] is None
    assert rep["lraDropPct"] is None


# ── Filter-chain composition (architectural fix) ───────────────────────────

def test_build_filter_chain_excludes_softclip_from_pre_filter():
    """Soft clipper must NOT be embedded in pre_filter (pipeline inserts it later)."""
    from app.mastering.pipeline import _build_filter_chain
    pre, applied, _moves, _dyn = _build_filter_chain(
        style="kpop_loud",
        ai_detections={}, apply_ai_corrections=False,
        input_peak_db=-3.0,
        low_to_mid_db=-15.0, high_to_mid_db=-22.0,
    )
    # _build_filter_chain itself never appends soft_clipper anymore
    assert "compand" not in pre or "saturation" in str(applied).lower(), \
        "soft-clipper must not be inside pre_filter; it goes after entry_gain"


# ── The loudness-policy reason is a string, and `stages` is decibels ──────────
#
# `pipeline.py` recorded the policy's reason — "explicit_target" — inside
# `gain_stages`, which is a dict of dB that the report turns into floats one by
# one.  `float("explicit_target")` raises, the caller catches every exception
# and logs a warning, and the report came back None.  The gain-staging panel
# was therefore empty on EVERY job, and nothing failed to say so.

def test_report_survives_every_policy_reason():
    """The reason must reach the report without taking it down."""
    from app.qc.gain_staging import build_gain_staging_report
    from app.mastering.loudness_policy import resolve_target_lufs

    stages = {
        "compressorMakeupDb": 0.5, "preGainDb": 2.0, "limiterInputGainDb": 1.0,
        "correctionGainDb": 0.0, "ispCorrectionDb": 0.0,
    }
    # Every reason the policy can actually produce, taken from the policy
    # rather than written out here, so a new one is covered the day it exists.
    reasons = {
        resolve_target_lufs(pre_lufs=-9.1, requested_target=-14.0,
                            explicit_target=True).reason,
        resolve_target_lufs(pre_lufs=None).reason,
        resolve_target_lufs(pre_lufs=-9.1, style="loud").reason,
        resolve_target_lufs(pre_lufs=-9.1, style="balanced").reason,
        resolve_target_lufs(pre_lufs=-30.0, style="balanced").reason,
    }
    assert "explicit_target" in reasons, "the reason that broke it is still reachable"

    for reason in reasons:
        report = build_gain_staging_report(
            input_metrics={}, output_metrics={},
            input_path="/nonexistent-in.wav", output_path="/nonexistent-out.wav",
            pipeline_stages=stages, loudness_policy_reason=reason,
        )
        assert report, f"report empty for reason={reason}"
        assert report["loudnessPolicyReason"] == reason
        assert report["stages"]["totalAppliedGainDb"] == 3.5


def test_stages_holds_only_numbers():
    """`stages` is a table of dB — a stray non-number is skipped, not fatal.

    The guard, not the fix: the fix is that the reason has its own field.  This
    is what stops the NEXT string somebody records from emptying the panel.
    """
    from app.qc.gain_staging import build_gain_staging_report

    stages = {
        "compressorMakeupDb": 0.5, "preGainDb": 2.0, "limiterInputGainDb": 1.0,
        "correctionGainDb": 0.0, "ispCorrectionDb": 0.0,
        "somebodysNote": "not a number",
        "aNan": float("nan"),
        "anInfinity": float("inf"),
        "aFlag": True,
    }
    report = build_gain_staging_report(
        input_metrics={}, output_metrics={},
        input_path="/nonexistent-in.wav", output_path="/nonexistent-out.wav",
        pipeline_stages=stages,
    )
    assert report, "a stray value must not empty the report"
    for key, value in report["stages"].items():
        assert isinstance(value, (int, float)) and not isinstance(value, bool), \
            f"stages[{key}] = {value!r} is not a number"
        assert value == value, f"stages[{key}] is NaN"
    assert "somebodysNote" not in report["stages"]
    assert "aFlag" not in report["stages"], "a bool is not a decibel"
    assert report["stages"]["totalAppliedGainDb"] == 3.5


def test_pipeline_does_not_put_the_reason_in_the_dB_table():
    """The regression guard on the line that caused it.

    `gain_stages` is annotated `dict[str, float]` and is handed straight to the
    report.  If the reason goes back in there, this fails — which is the point,
    because the failure mode is silent.
    """
    from pathlib import Path
    import app.mastering.pipeline as pipeline_mod

    source = Path(pipeline_mod.__file__).read_text(encoding="utf-8")
    assert 'gain_stages["loudnessPolicyReason"]' not in source, (
        "the policy reason is back inside the dB table — it raises ValueError "
        "inside build_gain_staging_report, which is caught and logged, so the "
        "gain-staging panel silently empties on every job"
    )
    assert "loudness_policy_reason = _target_decision.reason" in source, (
        "the reason should still be captured — into its own variable"
    )
