"""
Tests for the debug-quality system added in v3.3:
  · DebugRecorder + env_info  (P0)
  · run_limiter_check         (P1)
  · compute_segment_timeseries (P2)
  · safe_modes overrides + recommendations (P3, P5)
  · debug_bundle export        (P4)
"""
from __future__ import annotations

import json
import os
import tempfile
import zipfile

import pytest


# ── env_info / DebugRecorder ────────────────────────────────────────────────

def test_env_info_collects_basic_fields():
    from app.utils.env_info import collect_env_info, is_debug_mode
    info = collect_env_info(use_cache=False)
    assert "os" in info and info["os"]["system"]
    assert "python" in info and info["python"]["version"]
    assert "cpu" in info
    assert "ffmpeg" in info
    assert isinstance(info["ffmpegBundled"], bool)
    assert isinstance(is_debug_mode(), bool)


def test_debug_recorder_collects_events_and_summary():
    from app.utils.debug_logger import DebugRecorder
    rec = DebugRecorder("job123")
    rec.event("INFO", "started", style="balanced")
    rec.stage("stage1", x=1)
    rec.set_input_info({"codec": "wav", "sampleRate": 44100})
    rec.set_filter_chain(preFilter="a,b,c")
    rec.add_suspect_segment(1.0, 2.5, "excessive_limiter_reduction", "warn", "details")
    rec.add_recommendation("low_limit", "test reason", "warn")
    rec.set_metrics({"lra": 8.0}, {"lra": 3.0})

    summary = rec.to_summary()
    assert summary["jobId"] == "job123"
    assert "stage1" in summary["stages"]
    assert summary["filterChain"]["preFilter"] == "a,b,c"
    assert len(summary["suspectSegments"]) == 1
    assert summary["recommendations"][0]["mode"] == "low_limit"

    full = rec.to_dict()
    assert full["input"]["codec"] == "wav"
    assert full["metricsBefore"]["lra"] == 8.0
    assert full["metricsAfter"]["lra"] == 3.0


def test_debug_recorder_is_resilient_to_bad_inputs():
    """All public mutators must swallow exceptions (mastering must keep running)."""
    from app.utils.debug_logger import DebugRecorder
    rec = DebugRecorder()
    # None / weird inputs should not raise
    rec.set_input_info(None)        # type: ignore[arg-type]
    rec.set_filter_chain()
    rec.set_metrics(None, None)     # type: ignore[arg-type]
    rec.add_suspect_segment("oops", 1.0, "x", "warn", "")  # type: ignore[arg-type]
    summary = rec.to_summary()
    assert summary["jobId"]


# ── safe_modes ──────────────────────────────────────────────────────────────

def test_safe_mode_overrides_merge_conservatively():
    from app.mastering.safe_modes import build_safe_mode_overrides
    o = build_safe_mode_overrides(["safe", "low_limit"])
    # Both modes target dynamic_eq_intensity; lower wins
    assert o["dynamic_eq_intensity"] == 0.0
    # Both clamp limiter_input_gain_clamp; lower wins
    assert o["limiter_input_gain_clamp"] == 1.0
    # target_lufs_clamp intersection: max(lo), min(hi). safe→(-16,-12.5), low_limit→(-16,-12).
    lo, hi = o["target_lufs_clamp"]
    assert lo == -16.0 and hi == -12.5
    assert "_appliedModes" in o


def test_safe_mode_apply_clamps_target_lufs_and_limiter():
    from app.mastering.safe_modes import (
        build_safe_mode_overrides, apply_overrides_to_pipeline_args,
    )
    overrides = build_safe_mode_overrides(["low_limit"])
    kw = {"target_lufs": -8.0, "limiter_strength": "high"}
    apply_overrides_to_pipeline_args(kw, overrides)
    # target LUFS clamped into [-16, -12]
    assert kw["target_lufs"] == -12.0
    # limiter downgraded
    assert kw["limiter_strength"] == "low"


def test_safe_mode_apply_does_not_raise_limiter_strength():
    from app.mastering.safe_modes import (
        build_safe_mode_overrides, apply_overrides_to_pipeline_args,
    )
    overrides = build_safe_mode_overrides(["safe"])  # sets low
    kw = {"limiter_strength": "low"}
    apply_overrides_to_pipeline_args(kw, overrides)
    assert kw["limiter_strength"] == "low"   # stays low, never raised


def test_recommend_modes_picks_low_limit_for_brickwall():
    from app.mastering.safe_modes import recommend_modes
    recs = recommend_modes(
        quality_check=None,
        limiter_check={
            "overall": "warn",
            "recommendations": ["low_limiting_mode"],
            "metrics": {"crestDelta": -5},
        },
        suspect_segments=[{"reason": "brickwall_flat"}],
        input_info={"codec": "wav"},
    )
    modes = [r["mode"] for r in recs]
    assert "low_limit" in modes
    assert "vocal_safe" in modes


def test_recommend_modes_suggests_wav_for_mp3_input():
    from app.mastering.safe_modes import recommend_modes
    recs = recommend_modes(
        quality_check=None, limiter_check=None, suspect_segments=[],
        input_info={"codec": "mp3", "vbrCbr": "VBR"},
    )
    modes = [r["mode"] for r in recs]
    assert "convert_to_wav" in modes


# ── limiter_check ───────────────────────────────────────────────────────────

def test_limiter_check_flags_low_crest_and_lra_loss():
    from app.qc.limiter_check import run_limiter_check
    out = run_limiter_check(
        output_path="/nonexistent.wav",  # won't be read in this scenario
        target_lufs=-9.0,
        target_tp=-1.0,
        input_metrics={"lra": 12.0, "crestFactor": 11.0},
        output_metrics={"lra": 1.5, "crestFactor": 3.5, "integratedLufs": -9.0},
        isp_correction_db=-2.5,
        limiter_strength="high",
    )
    assert out["overall"] == "danger"
    # crest factor < 4 dB → danger
    statuses = {it["name"]: it["status"] for it in out["items"]}
    assert statuses.get("Crest Factor") == "danger"
    # LRA reduction 87.5% → danger
    assert statuses.get("LRA 감소") == "danger"
    # ISP correction -2.5 dB → warn (between -2 and -4)
    assert statuses.get("ISP 보정") in ("warn", "danger")
    # high limiter is flagged
    assert statuses.get("Limiter 강도") == "warn"
    # Recommendations include low_limiting_mode
    assert "low_limiting_mode" in out["recommendations"]


def test_limiter_check_passes_clean_master():
    from app.qc.limiter_check import run_limiter_check
    out = run_limiter_check(
        output_path="/nonexistent.wav",
        target_lufs=-14.0, target_tp=-1.0,
        input_metrics={"lra": 9.0, "crestFactor": 13.0},
        output_metrics={"lra": 7.5, "crestFactor": 11.0, "integratedLufs": -14.0},
        isp_correction_db=0.0,
        limiter_strength="medium",
    )
    assert out["overall"] in ("ok", "warn")  # ceiling check may warn but no danger
    assert not any(i["status"] == "danger" for i in out["items"])


# ── segment_analysis ───────────────────────────────────────────────────────

def test_segment_analysis_handles_missing_file_gracefully():
    from app.analysis.segment_analysis import compute_segment_timeseries
    out = compute_segment_timeseries("/nonexistent/file.wav")
    assert out["windows"] == []
    assert out["suspectSegments"] == []
    assert out.get("skipped")


# ── debug_bundle ────────────────────────────────────────────────────────────

def test_debug_bundle_zip_contents():
    from app.utils.debug_bundle import export_debug_bundle
    rec = {
        "jobId": "x",
        "environment": {"os": {"system": "Linux"}, "appVersion": "test"},
        "input": {"codec": "wav", "name": "a.wav"},
        "masteringSettings": {"style": "balanced"},
        "filterChain": {"full": "loudnorm=I=-14,alimiter", "preFilter": "x"},
        "metricsBefore": {"lra": 9.0}, "metricsAfter": {"lra": 7.0},
        "suspectSegments": [{"start": 0, "end": 1, "reason": "x", "severity": "warn", "details": ""}],
        "recommendations": [],
        "outputPath": "",
    }
    with tempfile.TemporaryDirectory() as d:
        zip_path = os.path.join(d, "bundle.zip")
        result = export_debug_bundle(
            rec, zip_path,
            quality_check={"overall": "ok"},
            limiter_check={"overall": "warn"},
        )
        assert os.path.isfile(zip_path)
        assert result["sizeBytes"] > 0
        assert not result["includedAudio"]
        with zipfile.ZipFile(zip_path) as z:
            names = set(z.namelist())
        for required in (
            "README.txt", "input.json", "environment.json",
            "mastering_settings.json", "filter_chain.txt",
            "filter_chain.json", "metrics_before.json", "metrics_after.json",
            "quality_check.json", "limiter_check.json",
            "suspect_segments.json", "debug.json",
        ):
            assert required in names, f"missing {required} in {names}"


def test_debug_bundle_refuses_audio_without_consent():
    """Audio must NOT be included unless include_audio AND user_consent_audio."""
    from app.utils.debug_bundle import export_debug_bundle
    with tempfile.TemporaryDirectory() as d:
        # Create a fake input file
        in_path = os.path.join(d, "song.wav")
        with open(in_path, "wb") as f:
            f.write(b"RIFF....fake wav data")
        rec = {"jobId": "x", "input": {"path": in_path}, "outputPath": in_path}
        zip_path = os.path.join(d, "bundle.zip")
        # include_audio=True but user_consent_audio=False → still no audio
        r = export_debug_bundle(
            rec, zip_path, include_audio=True, user_consent_audio=False,
        )
        assert not r["includedAudio"]
        with zipfile.ZipFile(zip_path) as z:
            assert not any(n.startswith("audio/") for n in z.namelist())
