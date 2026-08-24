"""
The inter-sample-peak safety device is allowed to be unavailable.  It is not
allowed to be unavailable QUIETLY.

`apply_isp_safety` returns None rather than raising when numpy/soundfile are
missing or the output cannot be read back — which is exactly the case on a
machine where the Python deps were not installed.  The stage-6 alimiter leaves
only 0.3 dB of headroom for inter-sample peaks, so when this device does not
run, a dense loud master can sit well above the ceiling it promises.  That has
to reach `pipelineWarnings`, because that is the only channel the desktop app
shows the user.

Run:
    cd services/python-audio
    pytest tests/test_isp_safety_warning.py -v
"""
from __future__ import annotations

import pytest

from app.mastering import pipeline
from app.mastering.pipeline import run_pipeline


def _codes(result) -> set[str]:
    return {w["code"] for w in result.get("pipelineWarnings", [])}


class TestIspSafetyIsAudible:
    def test_unavailable_device_is_reported(self, sine_wav, tmp_path, monkeypatch):
        monkeypatch.setattr(pipeline, "apply_isp_safety", lambda *a, **k: None)
        result = run_pipeline(sine_wav, str(tmp_path / "out.wav"), style="balanced")
        assert "ISP_SAFETY_UNAVAILABLE" in _codes(result)

    def test_failed_device_is_reported(self, sine_wav, tmp_path, monkeypatch):
        def boom(*_a, **_k):
            raise RuntimeError("no soundfile")
        monkeypatch.setattr(pipeline, "apply_isp_safety", boom)
        result = run_pipeline(sine_wav, str(tmp_path / "out.wav"), style="balanced")
        assert "ISP_SAFETY_FAILED" in _codes(result)

    def test_the_message_names_the_ceiling_it_could_not_hold(
        self, sine_wav, tmp_path, monkeypatch,
    ):
        # A warning that says "something went wrong" tells the user nothing they
        # can act on.  The number they are about to fail is the point.
        monkeypatch.setattr(pipeline, "apply_isp_safety", lambda *a, **k: None)
        result = run_pipeline(
            sine_wav, str(tmp_path / "out.wav"), style="balanced", target_tp=-1.0,
        )
        msg = next(w["userMessage"] for w in result["pipelineWarnings"]
                   if w["code"] == "ISP_SAFETY_UNAVAILABLE")
        assert "-1.0 dBTP" in msg

    def test_a_working_device_says_nothing(self, sine_wav, tmp_path, monkeypatch):
        # 0.0 means "measured, inside the ceiling, no action" — the common case.
        # It must not be confused with "could not measure".
        monkeypatch.setattr(pipeline, "apply_isp_safety", lambda *a, **k: 0.0)
        result = run_pipeline(sine_wav, str(tmp_path / "out.wav"), style="balanced")
        assert "ISP_SAFETY_UNAVAILABLE" not in _codes(result)
        assert "ISP_SAFETY_FAILED" not in _codes(result)

    def test_fast_mode_is_a_choice_not_a_failure(self, sine_wav, tmp_path):
        # skip_isp_safety is the caller deliberately trading the guard for RAM.
        # That is not something to warn about — it was asked for.
        result = run_pipeline(
            sine_wav, str(tmp_path / "out.wav"), style="balanced",
            skip_isp_safety=True,
        )
        assert "ISP_SAFETY_UNAVAILABLE" not in _codes(result)
