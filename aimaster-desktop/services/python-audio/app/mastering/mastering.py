"""
Mastering entry point — thin adapter between JSON-RPC params and pipeline.py.

Translates the JSON-RPC 'master' method params into pipeline.run_pipeline()
arguments, then formats the result for the caller.

Error handling:
  - FFmpegError  → user_msg surfaced to caller, full stderr logged to file
  - Any other exception → wrapped with a Korean summary message + logged
"""
from __future__ import annotations

import traceback
from typing import Any, Callable

from app.mastering.pipeline import run_pipeline
from app.mastering.iterative import run_iterative_mastering
from app.mastering.safe_modes import (
    apply_overrides_to_pipeline_args,
    build_safe_mode_overrides,
)
from app.utils.ffmpeg_wrapper import FFmpegError
from app.utils.logger import log


def master_file(
    params: dict[str, Any],
    job_id: str,
    send_progress: Callable[[str, int, str], None],
) -> dict[str, Any]:
    """
    JSON-RPC 'master' handler.

    Expected params keys:
      input_path          str   (required)
      output_path         str   (required)
      style               str   "balanced"|"warm"|"bright"|"punch"
      target_lufs         float default -14.0
      target_tp           float default -1.0
      lra                 float default 11.0
      sample_rate         int   default 44100
      bit_depth           int   16 | 24
      apply_ai_corrections bool  default True
      ai_detections       dict  {harshHighMid, boomyLowEnd, ...} — from analyze step
    """
    input_path  = params["input_path"]
    output_path = params["output_path"]
    style       = str(params.get("style", "balanced"))
    target_lufs = float(params.get("target_lufs", -14.0))
    target_tp   = float(params.get("target_tp", -1.0))
    lra         = float(params.get("lra", 11.0))
    sample_rate = int(params.get("sample_rate", 44100))
    bit_depth   = int(params.get("bit_depth", 24))
    apply_ai    = bool(params.get("apply_ai_corrections", True))
    ai_dets     = params.get("ai_detections") or {}

    # v3 신규 파라미터 (모두 optional — 누락 시 모드별 기본값 사용)
    limiter_strength  = str(params.get("limiter_strength", "medium")).lower()
    saturation_amount = params.get("saturation_amount")
    stereo_width      = params.get("stereo_width")
    output_gain_db    = float(params.get("output_gain_db", 0.0))
    # v3.2 신규
    dyn_eq_intensity  = float(params.get("dynamic_eq_intensity", 1.0))
    gen_waveforms     = bool(params.get("generate_waveforms", True))
    # Node analyze 단계가 측정해서 넘겨주는 사전 라우드니스 (선택).
    pre_loudness      = params.get("pre_loudness") or None

    # v3.3 — debug-quality system params
    safe_modes_raw  = params.get("safe_modes") or []
    if isinstance(safe_modes_raw, str):
        safe_modes_raw = [safe_modes_raw]
    debug_logging   = params.get("debug_logging")  # None = use env

    pipeline_kwargs: dict[str, Any] = {
        "style": style,
        "target_lufs": target_lufs,
        "target_tp": target_tp,
        "lra": lra,
        "sample_rate": sample_rate,
        "bit_depth": bit_depth,
        "apply_ai_corrections": apply_ai,
        "ai_detections": ai_dets,
        "limiter_strength": limiter_strength,
        "saturation_amount": (float(saturation_amount) if saturation_amount is not None else None),
        "stereo_width": (float(stereo_width) if stereo_width is not None else None),
        "output_gain_db": output_gain_db,
        "dynamic_eq_intensity": dyn_eq_intensity,
        "generate_waveforms": gen_waveforms,
        "pre_loudness": (dict(pre_loudness) if isinstance(pre_loudness, dict) else None),
        "debug_logging": (None if debug_logging is None else bool(debug_logging)),
    }

    overrides = build_safe_mode_overrides(list(safe_modes_raw))
    apply_overrides_to_pipeline_args(pipeline_kwargs, overrides)

    log("INFO", f"master_file: style={style}, target={pipeline_kwargs['target_lufs']} LUFS / "
                f"{target_tp} dBTP, limiter={pipeline_kwargs['limiter_strength']}, "
                f"sr={sample_rate}, bits={bit_depth}, ai={apply_ai}, "
                f"safe_modes={safe_modes_raw}")

    try:
        result = run_pipeline(
            input_path,
            output_path,
            job_id=job_id,
            progress=send_progress,
            **pipeline_kwargs,
        )
        # Echo back the exact safe-mode set that was applied so the UI can
        # display the resulting chip / banner.
        if safe_modes_raw:
            result["appliedSafeModes"] = list(safe_modes_raw)
        return result

    except FFmpegError as exc:
        # Log full developer detail, surface Korean message to caller
        log("ERROR", f"FFmpegError in master_file:\n{traceback.format_exc()}")
        if exc.stderr:
            log("ERROR", f"ffmpeg stderr:\n{exc.stderr[-4000:]}")
        raise RuntimeError(exc.user_msg) from exc

    except Exception as exc:
        log("ERROR", f"Unexpected error in master_file:\n{traceback.format_exc()}")
        raise RuntimeError(
            f"마스터링 중 예상치 못한 오류가 발생했습니다: {type(exc).__name__}"
        ) from exc


def master_with_reference(
    params: dict[str, Any],
    job_id: str,
    send_progress: Callable[[str, int, str], None],
) -> dict[str, Any]:
    """
    JSON-RPC 'master_with_reference' handler — Ozone-style iterative
    reference-matching mastering.

    Required params:
      input_path, output_path, reference_path

    Optional params:
      style, target_lufs (override reference LUFS), target_tp,
      max_iterations (default 3), accept_threshold (default 90.0),
      safe_modes, sample_rate, bit_depth, etc.  All other params follow
      the same shape as 'master'.
    """
    input_path     = params["input_path"]
    output_path    = params["output_path"]
    reference_path = params.get("reference_path")
    target_profile = params.get("target_profile")  # alternative to reference_path

    if not reference_path and not target_profile:
        raise ValueError(
            "params.reference_path or params.target_profile is required"
        )

    style       = str(params.get("style", "balanced"))
    target_lufs_override = params.get("target_lufs")  # caps reference LUFS if set
    target_tp   = float(params.get("target_tp", -1.0))
    sample_rate = int(params.get("sample_rate", 44100))
    bit_depth   = int(params.get("bit_depth", 24))
    apply_ai    = bool(params.get("apply_ai_corrections", True))
    ai_dets     = params.get("ai_detections") or {}
    limiter_strength  = str(params.get("limiter_strength", "medium")).lower()
    saturation_amount = params.get("saturation_amount")
    stereo_width      = params.get("stereo_width")
    output_gain_db    = float(params.get("output_gain_db", 0.0))
    dyn_eq_intensity  = float(params.get("dynamic_eq_intensity", 1.0))
    gen_waveforms     = bool(params.get("generate_waveforms", True))
    max_iters         = int(params.get("max_iterations", 3))
    accept_threshold  = float(params.get("accept_threshold", 90.0))

    safe_modes_raw = params.get("safe_modes") or []
    if isinstance(safe_modes_raw, str):
        safe_modes_raw = [safe_modes_raw]

    pipeline_kwargs: dict[str, Any] = {
        "style": style,
        "target_tp": target_tp,
        "sample_rate": sample_rate,
        "bit_depth": bit_depth,
        "apply_ai_corrections": apply_ai,
        "ai_detections": ai_dets,
        "limiter_strength": limiter_strength,
        "saturation_amount": (float(saturation_amount) if saturation_amount is not None else None),
        "stereo_width": (float(stereo_width) if stereo_width is not None else None),
        "output_gain_db": output_gain_db,
        "dynamic_eq_intensity": dyn_eq_intensity,
        "generate_waveforms": gen_waveforms,
    }
    if target_lufs_override is not None:
        pipeline_kwargs["target_lufs"] = float(target_lufs_override)

    overrides = build_safe_mode_overrides(list(safe_modes_raw))
    apply_overrides_to_pipeline_args(pipeline_kwargs, overrides)

    log("INFO",
        f"master_with_reference: style={style}, ref={reference_path}, "
        f"max_iters={max_iters}, threshold={accept_threshold}, "
        f"safe_modes={safe_modes_raw}")

    try:
        result = run_iterative_mastering(
            input_path, output_path,
            reference_path=reference_path,
            target_profile_override=target_profile,
            target_lufs_override=(
                float(target_lufs_override) if target_lufs_override is not None else None
            ),
            max_iterations=max_iters,
            accept_threshold=accept_threshold,
            job_id=job_id,
            progress=send_progress,
            **pipeline_kwargs,
        )
        if safe_modes_raw:
            result["appliedSafeModes"] = list(safe_modes_raw)
        return result

    except FFmpegError as exc:
        log("ERROR", f"FFmpegError in master_with_reference:\n{traceback.format_exc()}")
        if exc.stderr:
            log("ERROR", f"ffmpeg stderr:\n{exc.stderr[-4000:]}")
        raise RuntimeError(exc.user_msg) from exc

    except Exception as exc:
        log("ERROR", f"Unexpected error in master_with_reference:\n{traceback.format_exc()}")
        raise RuntimeError(
            f"레퍼런스 매칭 마스터링 중 오류 발생: {type(exc).__name__}: {exc}"
        ) from exc
