"""
AI Mastering RC Engine — advisory pre-correction stage.

Release-Candidate integration of the P0/P1 work (canonical features → audio
profiles → DSP decision engine → recommendation selection → parameter
translation) into the desktop mastering runtime, so the improvements can be
A/B listened to against the stable path.

Design constraints:

  - **Opt-in.** Disabled unless the caller asks for it, so the stable path is
    bit-for-bit unchanged by default.
  - **Additive, not a replacement.** RC produces one extra FFmpeg pre-correction
    pass applied to a *copy* of the input. The existing pipeline then runs
    unchanged on that copy, so loudness normalisation, true-peak limiting and
    every other output safety stage still apply exactly as before.
  - **Fail-open to stable.** Any error anywhere in the advisory chain falls back
    to the original input. RC must never be able to break mastering.
  - **No offline machinery at runtime.** The calibration engine, the output and
    runtime validators, and anything that shells out to git are deliberately not
    imported here.

The decision engine's mappings are DESIGN_CANDIDATE — the P1 calibration
promoted none of them — which is precisely why this ships as RC for listening
validation rather than as the default path.
"""
from __future__ import annotations

import os
import shutil
import tempfile
from typing import Any, Dict, Optional

from app.utils.logger import log

RC_ENV_VAR = "AIMASTER_RC_ENGINE"
RC_MODE_RC = "rc"
RC_MODE_STABLE = "stable"


def _truthy(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return False
    return str(value).strip().lower() in {"1", "true", "yes", "on", RC_MODE_RC}


def is_rc_enabled(params: Optional[Dict[str, Any]] = None) -> bool:
    """RC is on when the caller asks for it, or when the env var is set.

    An explicit ``engine_mode`` in params always wins over the environment, so
    a caller can force the stable path even in an RC-flavoured build.
    """
    params = params or {}
    if "engine_mode" in params and params["engine_mode"] is not None:
        return str(params["engine_mode"]).strip().lower() == RC_MODE_RC
    if "rc_engine" in params and params["rc_engine"] is not None:
        return _truthy(params["rc_engine"])
    return _truthy(os.environ.get(RC_ENV_VAR))


def build_precorrection_plan(input_path: str, file_name: str = "") -> Dict[str, Any]:
    """Run the advisory chain and return the pre-correction plan.

    Returns a dict with ``filter_chain`` (possibly empty), the selected
    recommendations and enough summary for logging. Never raises: on failure it
    returns a plan with an empty filter chain and an ``error`` field.
    """
    plan: Dict[str, Any] = {
        "filter_chain": "",
        "recommendations": [],
        "profile_states": {},
        "translated": 0,
        "failed": 0,
        "error": None,
    }

    try:
        # Imported lazily so a stable-path render never pays for these modules.
        from app.analyzers.canonical_features import extract_canonical_features
        from app.mastering.decision_engine import create_engine
        from app.mastering.closed_loop.recommendation_selector import (
            RecommendationSelector,
        )
        from app.mastering.closed_loop.parameter_translator import ParameterTranslator

        features_obj = extract_canonical_features(input_path)
        features = (
            features_obj.to_dict() if hasattr(features_obj, "to_dict") else dict(features_obj)
        )

        engine = create_engine()
        decision = engine.evaluate_track(
            features,
            file_name=file_name or os.path.basename(input_path),
        )
        decision_dict = decision.to_dict()

        plan["profile_states"] = {
            profile: rec.get("state")
            for profile, rec in (decision_dict.get("recommendations") or {}).items()
        }

        selection = RecommendationSelector().select_recommendations(
            decision_dict,
            blocked_actions=decision_dict.get("conflict_report", {}).get(
                "blocked_actions", []
            ),
        )

        if not selection.selected:
            return plan

        # Safety clamping happens inside the translator.
        translation = ParameterTranslator().translate_recommendations(selection.selected)

        plan["filter_chain"] = translation.filter_chain or ""
        plan["translated"] = len(translation.translated)
        plan["failed"] = len(translation.failed)
        plan["recommendations"] = [
            {
                "processor": t.processor,
                "parameter": t.parameter,
                "value": t.value,
                "unit": getattr(t, "unit", None),
                "clamped": getattr(t, "was_clamped", None),
            }
            for t in translation.translated
        ]
        return plan

    except Exception as exc:  # noqa: BLE001 - RC must fail open to stable
        plan["error"] = f"{type(exc).__name__}: {exc}"
        return plan


def apply_precorrection(
    input_path: str,
    *,
    sample_rate: int = 44100,
    bit_depth: int = 24,
    file_name: str = "",
) -> Dict[str, Any]:
    """Render an RC pre-corrected copy of ``input_path``.

    Returns a dict with ``path`` (the input the pipeline should use — the RC
    copy when one was produced, otherwise the original), ``temp_dir`` for the
    caller to clean up, and the plan metadata.

    The original file is only ever read.
    """
    outcome: Dict[str, Any] = {
        "path": input_path,
        "temp_dir": None,
        "applied": False,
        "plan": None,
    }

    plan = build_precorrection_plan(input_path, file_name=file_name)
    outcome["plan"] = plan

    if plan.get("error"):
        log("WARN", f"[rc-engine] advisory chain failed, using stable path: {plan['error']}")
        return outcome

    chain = plan.get("filter_chain") or ""
    if not chain:
        log("INFO", "[rc-engine] no advisory correction recommended — stable path")
        return outcome

    temp_dir = None
    try:
        from app.utils.ffmpeg_wrapper import apply_filter_chain

        temp_dir = tempfile.mkdtemp(prefix="aimaster-rc-")
        stem = os.path.splitext(os.path.basename(input_path))[0]
        rc_path = os.path.join(temp_dir, f"{stem}_rc_precorrected.wav")

        apply_filter_chain(
            input_path,
            rc_path,
            chain,
            sample_rate=sample_rate,
            bit_depth=bit_depth,
        )

        if not os.path.isfile(rc_path) or os.path.getsize(rc_path) == 0:
            raise RuntimeError("RC pre-correction produced no output")

        outcome["path"] = rc_path
        outcome["temp_dir"] = temp_dir
        outcome["applied"] = True
        log("INFO", f"[rc-engine] pre-correction applied: {chain}")
        return outcome

    except Exception as exc:  # noqa: BLE001 - fail open to stable
        log("WARN", f"[rc-engine] pre-correction render failed, using stable path: {exc}")
        if temp_dir:
            shutil.rmtree(temp_dir, ignore_errors=True)
        outcome["path"] = input_path
        outcome["temp_dir"] = None
        outcome["applied"] = False
        return outcome


def log_engine_banner(enabled: bool, plan: Optional[Dict[str, Any]] = None) -> None:
    """Emit the RC identification banner.

    Deliberately free of paths, personal data and secrets.
    """
    if not enabled:
        log("INFO", "Mastering Engine Mode: STABLE")
        return

    log("INFO", "Mastering Engine Mode: RC")
    log("INFO", "Decision Engine: enabled")
    log("INFO", "Safety Clamp: enabled")
    log("INFO", "Closed Loop: enabled (advisory pre-correction)")
    commit = os.environ.get("AIMASTER_BUILD_COMMIT")
    if commit:
        log("INFO", f"Engine Build Commit: {commit}")
    if plan is not None:
        log(
            "INFO",
            f"RC advisory: {plan.get('translated', 0)} parameter(s) translated, "
            f"{plan.get('failed', 0)} unavailable",
        )
