"""
FFmpeg / FFprobe wrappers for AIMASTER.

Binary resolution order:
  1. AIMASTER_FFMPEG / AIMASTER_FFPROBE env vars  (set by Electron in packaged mode)
  2. System PATH (dev mode / fallback)

Error policy:
  - Developer detail  → app.utils.logger (→ stderr, log files)
  - User-facing msg   → FFmpegError.user_msg (Korean, shown in UI)
  - FFmpeg stderr     → FFmpegError.stderr (stored for debugging)
"""
from __future__ import annotations

import json
import os
import re
import subprocess
from typing import Any

from app.utils.logger import log


# ── Binary paths ──────────────────────────────────────────────────────────────
# Electron sets these env vars in packaged mode so the engine finds the
# bundled FFmpeg without relying on the user's PATH.

_FFMPEG_BIN  = os.environ.get('AIMASTER_FFMPEG',  'ffmpeg')
_FFPROBE_BIN = os.environ.get('AIMASTER_FFPROBE', 'ffprobe')

log("INFO", f"ffmpeg  binary: {_FFMPEG_BIN}")
log("INFO", f"ffprobe binary: {_FFPROBE_BIN}")


# ── Custom exception ──────────────────────────────────────────────────────────

class FFmpegError(RuntimeError):
    """
    Raised when ffmpeg/ffprobe fails.
    Attributes:
      user_msg : Korean message suitable for display in the UI
      stderr   : raw ffmpeg/ffprobe stderr for developer logging
    """
    def __init__(self, user_msg: str, stderr: str = "") -> None:
        super().__init__(user_msg)
        self.user_msg = user_msg
        self.stderr = stderr


# ── Internal runner ───────────────────────────────────────────────────────────

def _run(cmd: list[str], *, timeout: int = 300) -> tuple[str, str]:
    """
    Execute a command and return (stdout, stderr).
    Raises FFmpegError on non-zero exit or missing binary.
    """
    log("DEBUG", f"exec: {' '.join(cmd[:8])}" + (" ..." if len(cmd) > 8 else ""))
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            encoding='utf-8',
            errors='replace',
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        raise FFmpegError(
            f"처리 시간이 초과되었습니다 ({timeout}초). 파일이 너무 크거나 시스템이 느릴 수 있습니다."
        )
    except FileNotFoundError:
        bin_name = cmd[0]
        raise FFmpegError(
            f"'{bin_name}'을 찾을 수 없습니다. FFmpeg가 올바르게 설치되어 있는지 확인해주세요.\n"
            f"설치 방법: brew install ffmpeg (macOS) / apt install ffmpeg (Linux)"
        )

    if proc.returncode != 0:
        log("ERROR", f"{cmd[0]} exited {proc.returncode}:\n{proc.stderr[-3000:]}")
        stderr_lower = proc.stderr.lower()
        if "no such file" in stderr_lower or "does not exist" in stderr_lower:
            user_msg = "파일을 찾을 수 없습니다. 파일이 이동되거나 삭제되었는지 확인해주세요."
        elif "invalid data" in stderr_lower or "moov atom" in stderr_lower:
            user_msg = "파일이 손상되었거나 지원하지 않는 형식입니다."
        elif "encoder" in stderr_lower and "not found" in stderr_lower:
            user_msg = "필요한 오디오 코덱을 찾을 수 없습니다. FFmpeg 빌드에 libmp3lame이 포함되어 있는지 확인해주세요."
        else:
            user_msg = "오디오 처리 중 오류가 발생했습니다. 파일 형식이나 내용을 확인해주세요."
        raise FFmpegError(user_msg, proc.stderr)

    return proc.stdout, proc.stderr


# ── ffprobe ───────────────────────────────────────────────────────────────────

def ffprobe_info(file_path: str) -> dict[str, Any]:
    """Return full ffprobe JSON for a file (streams + format)."""
    stdout, _ = _run([
        _FFPROBE_BIN, "-v", "quiet",
        "-print_format", "json",
        "-show_streams", "-show_format",
        file_path,
    ])
    try:
        return json.loads(stdout)
    except json.JSONDecodeError as exc:
        raise FFmpegError(
            "파일 정보를 읽을 수 없습니다. 파일이 손상되었을 수 있습니다."
        ) from exc


def parse_audio_stream(probe: dict[str, Any]) -> dict[str, Any]:
    """Extract the first audio stream dict from ffprobe output."""
    return next(
        (s for s in probe.get("streams", []) if s.get("codec_type") == "audio"),
        {},
    )


def parse_bit_depth(audio_stream: dict[str, Any]) -> int:
    """Best-effort bit depth extraction from an ffprobe audio stream dict."""
    for key in ("bits_per_raw_sample", "bits_per_sample"):
        val = audio_stream.get(key)
        if val and str(val) not in ("0", ""):
            return int(val)
    codec = audio_stream.get("codec_name", "")
    if "s16" in codec:
        return 16
    if any(x in codec for x in ("s24", "s32", "f32", "f64")):
        return 24
    return 16


# ── loudnorm pass 1 (measure only) ───────────────────────────────────────────

def loudnorm_pass1(
    file_path: str,
    target_lufs: float = -14.5,
    target_tp: float = -1.5,
    lra: float = 11.0,
    pre_filter: str = "",
) -> dict[str, str]:
    """
    Run loudnorm pass 1 (measurement only, no output written).

    pre_filter: optional comma-joined filter chain applied BEFORE loudnorm.
                Pass the same pre_filter used in pass2 so the measurements
                reflect the actual filtered signal and loudnorm hits the target.

    Returns dict with keys from ffmpeg loudnorm JSON:
      input_i, input_lra, input_tp, input_thresh, target_offset
    """
    loudnorm_filter = (
        f"loudnorm=I={target_lufs}:TP={target_tp}:LRA={lra}:print_format=json"
    )
    filter_str = f"{pre_filter},{loudnorm_filter}" if pre_filter else loudnorm_filter

    _, stderr = _run([
        _FFMPEG_BIN, "-hide_banner",
        "-i", file_path,
        "-af", filter_str,
        "-f", "null", "-",
    ])

    # loudnorm JSON is embedded in stderr — find the LAST complete {...} block
    last_close = stderr.rfind("}")
    match_text: str | None = None
    if last_close != -1:
        depth, start = 0, -1
        for i in range(last_close, -1, -1):
            if stderr[i] == "}":
                depth += 1
            elif stderr[i] == "{":
                depth -= 1
                if depth == 0:
                    start = i
                    break
        if start != -1:
            match_text = stderr[start: last_close + 1]

    if match_text is None:
        log("ERROR", f"loudnorm pass1 full stderr:\n{stderr}")
        raise FFmpegError(
            "라우드니스 측정에 실패했습니다. 오디오가 너무 짧거나 완전한 무음 파일일 수 있습니다.",
            stderr,
        )
    try:
        data = json.loads(match_text)
    except json.JSONDecodeError:
        raise FFmpegError("라우드니스 측정 결과를 읽을 수 없습니다.", stderr)

    if data.get("input_i") in ("-inf", "inf", None):
        raise FFmpegError(
            "오디오 신호가 감지되지 않았습니다. 파일이 완전한 무음이거나 손상되어 있습니다.",
            stderr,
        )
    return data


# ── loudnorm pass 2 (apply) ───────────────────────────────────────────────────

def loudnorm_pass2(
    input_path: str,
    output_path: str,
    pass1: dict[str, str],
    *,
    target_lufs: float = -14.5,
    target_tp: float = -1.5,
    lra: float = 11.0,
    sample_rate: int = 44100,
    bit_depth: int = 24,
    pre_filter: str = "",
    linear: bool = True,
) -> str:
    """
    Apply loudnorm using pass-1 measurements.

    linear=True   — 측정값 기반 정확한 1차 게인 (기본).
                    -14 LUFS 같은 일반 타깃에 적합.
    linear=False  — dynamic 모드.  목표값이 -10 LUFS 처럼 매우 큰 경우
                    (절대값이 작은 경우) 강한 압축으로 도달시킨다.

    target_tp 는 기본 -1.5 로 두어 후단 brickwall limiter 에 0.5 dB 여유를 남긴다.

    pre_filter: comma-joined ffmpeg audio filter string applied BEFORE loudnorm
                (EQ → compressor chain goes here).
    Returns output_path on success.
    """
    linear_str = "true" if linear else "false"
    loudnorm = (
        f"loudnorm=I={target_lufs}:TP={target_tp}:LRA={lra}:linear={linear_str}"
        f":measured_I={pass1['input_i']}"
        f":measured_LRA={pass1['input_lra']}"
        f":measured_TP={pass1['input_tp']}"
        f":measured_thresh={pass1['input_thresh']}"
        f":offset={pass1['target_offset']}"
        f":print_format=none"
    )
    af = f"{pre_filter},{loudnorm}" if pre_filter else loudnorm
    codec = "pcm_s16le" if bit_depth == 16 else "pcm_s24le"

    _, stderr = _run([
        _FFMPEG_BIN, "-hide_banner", "-y",
        "-i", input_path,
        "-af", af,
        "-ar", str(sample_rate),
        "-acodec", codec,
        output_path,
    ])
    log("DEBUG", f"pass2 stderr tail:\n{stderr[-400:]}")
    return output_path


# ── Brickwall true-peak limiter ───────────────────────────────────────────────

def apply_limiter(
    input_path: str,
    output_path: str,
    *,
    ceiling_dbfs: float = -1.0,
    attack_ms: float = 5.0,
    release_ms: float = 50.0,
    sample_rate: int = 44100,
    bit_depth: int = 24,
    level_in_db: float = 0.0,
) -> str:
    """
    Apply a brickwall peak limiter as the final mastering stage.

    Args:
        ceiling_dbfs: output ceiling in dBFS (default -1.0)
        attack_ms:    limiter attack time in milliseconds (default 5 ms)
        release_ms:   limiter release time in milliseconds (default 50 ms)
        level_in_db:  pre-limiter input gain in dB (limiter strength).  0 = passthrough,
                      +2 dB ≈ medium, +4 dB ≈ high — pushes more material into
                      gain reduction for greater perceived loudness.

    Returns output_path on success.
    """
    limit_linear    = 10.0 ** (ceiling_dbfs / 20.0)
    level_in_linear = 10.0 ** (max(-6.0, min(8.0, level_in_db)) / 20.0)

    limiter = (
        f"alimiter="
        f"level_in={level_in_linear:.4f}"
        f":level_out=1"
        f":limit={limit_linear:.6f}"
        f":attack={attack_ms}"
        f":release={release_ms}"
        f":asc=1"
    )
    codec = "pcm_s16le" if bit_depth == 16 else "pcm_s24le"

    _, stderr = _run([
        _FFMPEG_BIN, "-hide_banner", "-y",
        "-i", input_path,
        "-af", limiter,
        "-ar", str(sample_rate),
        "-acodec", codec,
        output_path,
    ])
    log("DEBUG", f"limiter stderr tail:\n{stderr[-200:]}")
    return output_path


# ── Post-verification re-measurement ─────────────────────────────────────────

def measure_output(
    file_path: str,
    target_lufs: float = -14.5,
    target_tp: float = -1.0,
) -> dict[str, float]:
    """
    Re-measure an output file after mastering.
    Returns: integratedLufs, truePeakDbtp, lra, durationSec
    """
    p1 = loudnorm_pass1(file_path, target_lufs, target_tp)
    probe = ffprobe_info(file_path)
    duration = float(probe.get("format", {}).get("duration", 0.0))
    return {
        "integratedLufs": float(p1.get("input_i", -99.0)),
        "truePeakDbtp":   float(p1.get("input_tp", 0.0)),
        "lra":            float(p1.get("input_lra", 0.0)),
        "durationSec":    duration,
    }


# ── MP3 preview export ────────────────────────────────────────────────────────

def export_preview_mp3(wav_path: str, mp3_path: str, bitrate: str = "320k") -> str:
    """Encode a 320 kbps MP3 preview from the master WAV."""
    _run([
        _FFMPEG_BIN, "-hide_banner", "-y",
        "-i", wav_path,
        "-acodec", "libmp3lame",
        "-b:a", bitrate,
        mp3_path,
    ])
    return mp3_path


# ── Generic filter chain re-render ────────────────────────────────────────────

def apply_filter_chain(
    input_path: str,
    output_path: str,
    af_chain: str,
    *,
    sample_rate: int = 44100,
    bit_depth: int = 24,
) -> str:
    """
    Re-render `input_path` to `output_path` through an arbitrary `-af` chain.
    Used by the v3 correction pass.  No loudnorm involved here — just a single
    ffmpeg pass with the provided filter graph and a PCM WAV codec.
    """
    codec = "pcm_s16le" if bit_depth == 16 else "pcm_s24le"
    _run([
        _FFMPEG_BIN, "-hide_banner", "-y",
        "-i", input_path,
        "-af", af_chain,
        "-ar", str(sample_rate),
        "-acodec", codec,
        output_path,
    ])
    return output_path
