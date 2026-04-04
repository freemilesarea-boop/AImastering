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
    target_lufs = float(params.get("target_lufs", -14.5))
    target_tp   = float(params.get("target_tp", -1.0))
    lra         = float(params.get("lra", 11.0))
    sample_rate = int(params.get("sample_rate", 44100))
    bit_depth   = int(params.get("bit_depth", 24))
    apply_ai    = bool(params.get("apply_ai_corrections", True))
    ai_dets     = params.get("ai_detections") or {}

    log("INFO", f"master_file: style={style}, target={target_lufs} LUFS / {target_tp} dBTP, "
                f"sr={sample_rate}, bits={bit_depth}, ai={apply_ai}")

    try:
        result = run_pipeline(
            input_path,
            output_path,
            style=style,
            target_lufs=target_lufs,
            target_tp=target_tp,
            lra=lra,
            sample_rate=sample_rate,
            bit_depth=bit_depth,
            apply_ai_corrections=apply_ai,
            ai_detections=ai_dets,
            job_id=job_id,
            progress=send_progress,
        )
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
