"""
Tests for v3.3.1 vocal-protection engine guards.

The protection module must:
  · Clamp 1.5–5 kHz dynamic-EQ cuts to ≤ 2.5 dB
  · Clamp compressor ratio ≤ 2.0, attack ≥ 25 ms, makeup ≤ 0.7 dB
  · Clamp entry gain ≤ +6 dB
  · Clamp limiter level_in ≤ +0.5 dB
  · Classify vocal-loss readings into ok / warn / danger correctly
  · Record every applied clamp in VocalProtectionReport.appliedClamps
"""
from __future__ import annotations

import pytest


# ── Constant audit ─────────────────────────────────────────────────────────

def test_vocal_protection_constants_match_spec():
    from app.utils.vocal_protection import VOCAL_PROTECTION as VP
    assert VP.BAND_LOW_HZ           == 1500.0
    assert VP.BAND_HIGH_HZ          == 5000.0
    assert VP.MAX_VOCAL_BAND_CUT_DB == 2.5
    assert VP.MAX_RATIO             == 2.0
    assert VP.MIN_ATTACK_MS         == 25.0
    assert VP.MAX_MAKEUP_DB         == 0.7
    assert VP.MAX_ENTRY_GAIN_DB     == 6.0
    assert VP.MAX_LIMITER_INPUT_GAIN_DB == 0.5


# ── Clamp helpers ──────────────────────────────────────────────────────────

def test_clamp_vocal_band_cut_clamps_in_band():
    from app.utils.vocal_protection import clamp_vocal_band_cut
    # 3.0 dB cut at 3 kHz (vocal band) → clamped to 2.5
    assert clamp_vocal_band_cut(3000.0, 3.0, "cut") == 2.5
    # 3.0 dB cut at 200 Hz (low band) → unchanged
    assert clamp_vocal_band_cut(200.0,  3.0, "cut") == 3.0
    # boost mode is never clamped
    assert clamp_vocal_band_cut(3000.0, 3.0, "boost") == 3.0


def test_clamp_compressor_params_records_each_clamp():
    from app.utils.vocal_protection import clamp_compressor_params
    aggressive = {"ratio": 2.8, "attack": 10, "makeup": 2.0,
                  "threshold": -14, "release": 80, "knee": 3.0}
    out, clamps = clamp_compressor_params(aggressive)
    assert out["ratio"]  == 2.0
    assert out["attack"] == 25
    assert out["makeup"] == 0.7
    where = {c["where"] for c in clamps}
    assert "compressor.ratio" in where
    assert "compressor.attack" in where
    assert "compressor.makeup" in where


def test_clamp_compressor_params_no_clamp_when_safe():
    from app.utils.vocal_protection import clamp_compressor_params
    safe = {"ratio": 1.6, "attack": 35, "makeup": 0.5,
            "threshold": -20, "release": 150, "knee": 8.0}
    out, clamps = clamp_compressor_params(safe)
    assert clamps == []
    assert out == safe


def test_clamp_entry_gain_db_above_6():
    from app.utils.vocal_protection import clamp_entry_gain_db
    val, clamp = clamp_entry_gain_db(8.0)
    assert val == 6.0 and clamp is not None
    assert clamp["where"] == "static_chain.entry_gain"
    val, clamp = clamp_entry_gain_db(4.5)
    assert val == 4.5 and clamp is None


def test_clamp_limiter_input_gain_above_05():
    from app.utils.vocal_protection import clamp_limiter_input_gain_db
    val, clamp = clamp_limiter_input_gain_db(2.0)
    assert val == 0.5 and clamp is not None
    val, clamp = clamp_limiter_input_gain_db(0.0)
    assert val == 0.0 and clamp is None


# ── Severity classifier ───────────────────────────────────────────────────

def test_classify_vocal_loss():
    from app.utils.vocal_protection import classify_vocal_loss
    assert classify_vocal_loss(None) == "ok"
    assert classify_vocal_loss(0.5)  == "ok"
    assert classify_vocal_loss(1.5)  == "warn"
    assert classify_vocal_loss(2.0)  == "warn"
    assert classify_vocal_loss(3.0)  == "danger"
    assert classify_vocal_loss(5.0)  == "danger"


# ── Integration with dynamic_eq.build_dynamic_eq_chain ─────────────────────

def test_build_dynamic_eq_chain_clamps_vocal_band_cut():
    """A kpop_loud band that asks for −3 dB at 3.8 kHz must be clamped to −2.5."""
    from app.mastering.dynamic_eq import build_dynamic_eq_chain
    log: list[dict] = []
    rep = build_dynamic_eq_chain("kpop_loud", intensity=1.5, protection_log=log)
    # Find the harsh_highmid band (3.8 kHz, in vocal range)
    harsh = next((b for b in rep["bands"] if b["name"] == "harsh_highmid"), None)
    if harsh is None:
        pytest.skip("kpop_loud preset changed — band not present")
    assert harsh["reduction"] <= 2.5
    # The clamp must have been logged
    assert any("dynamic_eq.harsh_highmid" in c["where"] for c in log)


def test_build_dynamics_filter_records_clamps_for_aggressive_mode():
    from app.mastering.dynamics import build_dynamics_filter
    log: list[dict] = []
    # kpop_loud has been softened in v3.3 (ratio 2.2, attack 15 ms) — both
    # outside the protection clamps so we expect 2 clamps logged.
    _ = build_dynamics_filter("kpop_loud", input_peak_db=-3.0, protection_log=log)
    where = {c["where"] for c in log}
    assert "compressor.ratio"  in where
    assert "compressor.attack" in where


def test_build_dynamics_filter_no_clamps_for_safe_mode():
    from app.mastering.dynamics import build_dynamics_filter
    log: list[dict] = []
    _ = build_dynamics_filter("balanced", input_peak_db=-3.0, protection_log=log)
    # balanced is already vocal-safe (ratio 1.6, attack 40 ms, makeup 0.5 dB)
    assert log == []


# ── VocalProtectionReport ─────────────────────────────────────────────────

def test_vocal_protection_report_to_dict_has_user_message():
    from app.utils.vocal_protection import VocalProtectionReport
    r = VocalProtectionReport()
    r.record_clamp(where="compressor.ratio", original=2.8, clamped=2.0,
                   reason="vocal protection: ratio > 2.0 crushes vocal transients")
    d = r.to_dict()
    assert d["enabled"] is True
    assert d["active"] is True
    assert "보컬 보호 모드 적용됨" in d["userMessage"]
    assert d["config"]["maxRatio"] == 2.0


def test_vocal_protection_report_inactive_user_message():
    from app.utils.vocal_protection import VocalProtectionReport
    r = VocalProtectionReport()
    d = r.to_dict()
    assert d["active"] is False
    assert "추가 보정 불필요" in d["userMessage"]


def test_vocal_protection_report_auto_fallback_flag():
    from app.utils.vocal_protection import VocalProtectionReport
    r = VocalProtectionReport()
    r.vocalLossDb = 3.5
    r.vocalLossSeverity = "danger"
    r.autoFallbackTriggered = True
    r.autoFallbackReason = "test"
    d = r.to_dict()
    assert d["autoFallbackTriggered"] is True
    assert "자동으로 보수화" in d["userMessage"]
