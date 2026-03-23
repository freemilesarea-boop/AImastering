"""Mastering pipeline: EQ → Compress → Loudnorm → Limit → Export."""
from __future__ import annotations
import os
import subprocess
import tempfile
import time
from typing import Any, Callable

from app.utils.ffmpeg_wrapper import loudnorm_pass1, loudnorm_pass2
from app.utils.logger import log

STYLE_EQ: dict[str, str] = {
    "balanced": "",
    "warm":     "equalizer=f=5000:t=o:w=1.5:g=-1.5,equalizer=f=120:t=o:w=1:g=1.5",
    "bright":   "equalizer=f=10000:t=o:w=1.5:g=2,equalizer=f=200:t=o:w=1:g=-1",
    "punch":    "equalizer=f=80:t=o:w=1:g=2,equalizer=f=3000:t=o:w=1:g=1.5",
}

STYLE_COMP: dict[str, dict[str, Any]] = {
    "balanced": {"threshold": -18, "ratio": 2.5, "attack": 20, "release": 200},
    "warm":     {"threshold": -16, "ratio": 2.0, "attack": 30, "release": 300},
    "bright":   {"threshold": -20, "ratio": 3.0, "attack": 10, "release": 150},
    "punch":    {"threshold": -14, "ratio": 4.0, "attack": 5,  "release": 100},
}


def _build_filter(style: str, ai: dict[str, bool]) -> str:
    parts: list[str] = []

    # AI correction notches
    if ai.get("harshHighMid"):
        parts.append("equalizer=f=4000:t=o:w=2:g=-3")
    if ai.get("boomyLowEnd"):
        parts.append("equalizer=f=120:t=o:w=1:g=-4")

    # Style EQ
    eq = STYLE_EQ.get(style, "")
    if eq:
        parts.append(eq)

    # Compressor
    c = STYLE_COMP.get(style, STYLE_COMP["balanced"])
    parts.append(
        f"acompressor=threshold={c['threshold']}dB:ratio={c['ratio']}:"
        f"attack={c['attack']}:release={c['release']}:makeup=2dB"
    )

    return ",".join(parts)


def _export_preview_mp3(wav_path: str, mp3_path: str) -> None:
    subprocess.run(
        ["ffmpeg", "-y", "-i", wav_path, "-acodec", "libmp3lame", "-b:a", "320k", mp3_path],
        check=True, capture_output=True,
    )


def master_file(
    params: dict[str, Any],
    job_id: str,
    send_progress: Callable[[str, int, str], None],
) -> dict[str, Any]:
    input_path: str = params["input_path"]
    output_path: str = params["output_path"]
    style: str = params.get("style", "balanced")
    target_lufs: float = float(params.get("target_lufs", -14))
    target_tp: float = float(params.get("target_tp", -1.0))
    sample_rate: int = int(params.get("sample_rate", 44100))
    bit_depth: int = int(params.get("bit_depth", 24))
    apply_ai: bool = bool(params.get("apply_ai_corrections", True))
    ai: dict[str, bool] = params.get("ai_detection", {})

    t0 = time.time()
    applied: list[str] = []

    send_progress(job_id, 5, "분석 중")
    pass1 = loudnorm_pass1(input_path, target_lufs, target_tp)

    extra = _build_filter(style, ai if apply_ai else {})
    if apply_ai and ai.get("harshHighMid"):
        applied.append("고음역 거친 주파수 보정 (4 kHz -3 dB)")
    if apply_ai and ai.get("boomyLowEnd"):
        applied.append("저음역 과잉 보정 (120 Hz -4 dB)")
    applied.append(f"{style.capitalize()} 스타일 EQ 적용")

    send_progress(job_id, 40, "라우드니스 정규화")
    loudnorm_pass2(
        input_path, output_path, pass1,
        target_lufs=target_lufs, target_tp=target_tp,
        sample_rate=sample_rate, bit_depth=bit_depth,
        extra_filters=extra,
    )

    send_progress(job_id, 80, "프리뷰 MP3 생성")
    preview_path = os.path.splitext(output_path)[0] + "_preview.mp3"
    _export_preview_mp3(output_path, preview_path)

    send_progress(job_id, 95, "재측정")
    pass1_after = loudnorm_pass1(output_path, target_lufs, target_tp)

    send_progress(job_id, 100, "완료")
    elapsed = time.time() - t0

    log("INFO", f"Mastering done in {elapsed:.1f}s")
    return {
        "outputPath": output_path,
        "previewPath": preview_path,
        "appliedCorrections": applied,
        "loudnessAfter": {
            "integratedLufs": float(pass1_after.get("input_i", target_lufs)),
            "truePeakDbtp": float(pass1_after.get("input_tp", target_tp)),
            "lra": float(pass1_after.get("input_lra", 0)),
            "shortTermMax": float(pass1_after.get("input_thresh", -33)),
        },
        "processingTimeSec": round(elapsed, 2),
    }
