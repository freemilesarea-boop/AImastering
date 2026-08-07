"""RC engine gating, fail-open and isolation tests.

These cover the properties that matter for shipping RC in a user-facing build:
the stable path must be untouched by default, RC must never break mastering,
and the original input must never be modified.
"""
from __future__ import annotations

import os

import pytest

from app.mastering import rc_engine


# ── flag semantics ───────────────────────────────────────────────────────────

def test_rc_disabled_by_default(monkeypatch):
    monkeypatch.delenv(rc_engine.RC_ENV_VAR, raising=False)
    assert rc_engine.is_rc_enabled({}) is False
    assert rc_engine.is_rc_enabled(None) is False


def test_engine_mode_param_enables(monkeypatch):
    monkeypatch.delenv(rc_engine.RC_ENV_VAR, raising=False)
    assert rc_engine.is_rc_enabled({"engine_mode": "rc"}) is True
    assert rc_engine.is_rc_enabled({"engine_mode": "RC"}) is True
    assert rc_engine.is_rc_enabled({"engine_mode": "stable"}) is False


def test_env_var_enables(monkeypatch):
    monkeypatch.setenv(rc_engine.RC_ENV_VAR, "1")
    assert rc_engine.is_rc_enabled({}) is True
    monkeypatch.setenv(rc_engine.RC_ENV_VAR, "false")
    assert rc_engine.is_rc_enabled({}) is False


def test_explicit_param_overrides_env(monkeypatch):
    """A caller must be able to force stable even in an RC-flavoured build."""
    monkeypatch.setenv(rc_engine.RC_ENV_VAR, "1")
    assert rc_engine.is_rc_enabled({"engine_mode": "stable"}) is False


# ── fail-open behaviour ──────────────────────────────────────────────────────

def test_plan_fails_open_on_missing_file():
    plan = rc_engine.build_precorrection_plan("/nonexistent/track.wav")
    assert plan["error"] is not None
    assert plan["filter_chain"] == ""


def test_apply_falls_back_to_original_on_plan_error():
    outcome = rc_engine.apply_precorrection("/nonexistent/track.wav")
    assert outcome["path"] == "/nonexistent/track.wav"
    assert outcome["applied"] is False
    assert outcome["temp_dir"] is None


def test_apply_falls_back_when_no_chain(monkeypatch, tmp_path):
    src = tmp_path / "in.wav"
    src.write_bytes(b"RIFF")
    monkeypatch.setattr(
        rc_engine,
        "build_precorrection_plan",
        lambda *a, **k: {"filter_chain": "", "error": None, "translated": 0, "failed": 0},
    )
    outcome = rc_engine.apply_precorrection(str(src))
    assert outcome["path"] == str(src)
    assert outcome["applied"] is False


def test_apply_falls_back_when_render_raises(monkeypatch, tmp_path):
    """A failing ffmpeg pass must degrade to the stable input, not propagate."""
    src = tmp_path / "in.wav"
    src.write_bytes(b"RIFF")
    monkeypatch.setattr(
        rc_engine,
        "build_precorrection_plan",
        lambda *a, **k: {
            "filter_chain": "volume=-1.00dB",
            "error": None,
            "translated": 1,
            "failed": 0,
        },
    )

    import app.utils.ffmpeg_wrapper as fw

    def boom(*a, **k):
        raise RuntimeError("ffmpeg exploded")

    monkeypatch.setattr(fw, "apply_filter_chain", boom)

    outcome = rc_engine.apply_precorrection(str(src))
    assert outcome["path"] == str(src)
    assert outcome["applied"] is False
    assert outcome["temp_dir"] is None


def test_original_input_never_modified(monkeypatch, tmp_path):
    src = tmp_path / "in.wav"
    src.write_bytes(b"ORIGINAL-BYTES")
    before = src.read_bytes()

    monkeypatch.setattr(
        rc_engine,
        "build_precorrection_plan",
        lambda *a, **k: {
            "filter_chain": "volume=-1.00dB",
            "error": None,
            "translated": 1,
            "failed": 0,
        },
    )

    import app.utils.ffmpeg_wrapper as fw

    def fake_chain(inp, outp, chain, **kwargs):
        with open(outp, "wb") as f:
            f.write(b"RC-RENDERED")
        return outp

    monkeypatch.setattr(fw, "apply_filter_chain", fake_chain)

    outcome = rc_engine.apply_precorrection(str(src))
    assert outcome["applied"] is True
    assert outcome["path"] != str(src)
    assert src.read_bytes() == before


def test_empty_render_output_is_rejected(monkeypatch, tmp_path):
    """A zero-byte RC render must fall back rather than feed the pipeline."""
    src = tmp_path / "in.wav"
    src.write_bytes(b"ORIGINAL")

    monkeypatch.setattr(
        rc_engine,
        "build_precorrection_plan",
        lambda *a, **k: {
            "filter_chain": "volume=-1.00dB",
            "error": None,
            "translated": 1,
            "failed": 0,
        },
    )

    import app.utils.ffmpeg_wrapper as fw

    def empty_chain(inp, outp, chain, **kwargs):
        open(outp, "wb").close()
        return outp

    monkeypatch.setattr(fw, "apply_filter_chain", empty_chain)

    outcome = rc_engine.apply_precorrection(str(src))
    assert outcome["applied"] is False
    assert outcome["path"] == str(src)


# ── runtime isolation ────────────────────────────────────────────────────────

def test_rc_engine_does_not_import_offline_machinery():
    """Calibration and the validators must never load on the audio path."""
    import ast

    path = os.path.join(os.path.dirname(rc_engine.__file__), "rc_engine.py")
    with open(path, encoding="utf-8") as f:
        tree = ast.parse(f.read())

    imported: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.update(a.name for a in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            imported.add(node.module)

    forbidden = ("calibration", "runtime_validator", "output_validator", "subprocess")
    offenders = [m for m in imported if any(f in m for f in forbidden)]
    assert not offenders, f"RC engine must not import offline machinery: {offenders}"


def test_banner_emits_no_paths(monkeypatch):
    """The RC banner must not leak paths or secrets into logs."""
    lines: list[str] = []
    monkeypatch.setattr(rc_engine, "log", lambda level, msg: lines.append(str(msg)))
    monkeypatch.delenv("AIMASTER_BUILD_COMMIT", raising=False)

    rc_engine.log_engine_banner(True, {"translated": 2, "failed": 0})
    joined = "\n".join(lines)

    assert "Mastering Engine Mode: RC" in joined
    assert "Decision Engine: enabled" in joined
    assert "Safety Clamp: enabled" in joined
    assert "/Users/" not in joined
    assert os.sep + "Users" not in joined


def test_banner_stable_mode(monkeypatch):
    lines: list[str] = []
    monkeypatch.setattr(rc_engine, "log", lambda level, msg: lines.append(str(msg)))
    rc_engine.log_engine_banner(False)
    assert lines == ["Mastering Engine Mode: STABLE"]
