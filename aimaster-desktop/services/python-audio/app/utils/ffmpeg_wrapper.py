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
import time
from typing import Any

from app.utils.logger import log

# ── Optional debug recorder hook ─────────────────────────────────────────────
# A pipeline-level DebugRecorder can be installed here and every _run() call
# will mirror its (kind, cmd, stderr, ok, duration) into it.  None disables.

_RECORDER: Any = None  # type: ignore[assignment]


def set_debug_recorder(recorder: Any) -> None:
    """Install (or clear with None) a DebugRecorder for the next ffmpeg calls."""
    global _RECORDER
    _RECORDER = recorder


def _record_invocation(
    kind: str, cmd: list[str], stderr: str,
    ok: bool, duration_sec: float, filter_str: str = "",
) -> None:
    """Best-effort mirror of an ffmpeg/ffprobe invocation into the recorder."""
    rec = _RECORDER
    if rec is None:
        return
    try:
        rec.record_ffmpeg(
            kind=kind,
            cmd=cmd,
            filter_str=filter_str,
            stderr=stderr,
            ok=ok,
            duration_sec=duration_sec,
        )
    except Exception as exc:
        log("DEBUG", f"recorder hook failed: {exc}")


# ── Binary paths ──────────────────────────────────────────────────────────────
# Electron sets these env vars in packaged mode so the engine finds the
# bundled FFmpeg without relying on the user's PATH.

_FFMPEG_BIN  = os.environ.get('AIMASTER_FFMPEG',  'ffmpeg')
_FFPROBE_BIN = os.environ.get('AIMASTER_FFPROBE', 'ffprobe')

log("INFO", f"ffmpeg  binary: {_FFMPEG_BIN}")
log("INFO", f"ffprobe binary: {_FFPROBE_BIN}")


# ── Canonical analysis binary provenance ─────────────────────────────────────
#
# Mastering keeps the resolution above: an unset env var falls back to the bare
# name and PATH, which is what lets the engine run in dev.
#
# Canonical feature analysis may not. Commercial reference targets and runtime
# measurements have to come out of the same binary, and a bare name silently
# resolves to whatever the machine happens to have — here, ffmpeg 6.0 when
# packaged versus 8.1.1 from Homebrew, two major versions apart. Measuring the
# reference with one and the runtime with the other reintroduces exactly the
# incomparability this contract exists to remove, so canonical analysis requires
# an explicit path and fails closed without one. Nothing else changes: existing
# mastering calls keep using _FFMPEG_BIN untouched.

CANONICAL_FFMPEG_ENV = "AIMASTER_FFMPEG"

# Resampler parameters for canonical analysis, in the order they are emitted.
# Every value is stated rather than left to a default, because a default is an
# unrecorded parameter. cutoff stays 0 ("auto") deliberately: the actual figure
# auto resolves to is not readable from the binary, so inventing a number would
# mean silently applying a different filter than auto would. Pinning the binary
# by version and sha256 fixes what auto means instead.
CANONICAL_ARESAMPLE_PARAMS: tuple[tuple[str, str], ...] = (
    ("resampler",      "swr"),
    ("filter_size",    "32"),
    ("phase_shift",    "10"),
    ("linear_interp",  "1"),
    ("exact_rational", "1"),
    ("filter_type",    "kaiser"),
    ("kaiser_beta",    "9"),
    ("cutoff",         "0"),
    ("dither_method",  "0"),
    ("async",          "0"),
)

# Analysis output is float32, whose 24-bit mantissa holds a 24-bit source
# exactly, so no word length is reduced and there is nothing for dither to
# decorrelate. Injecting noise into a measurement signal would perturb the HF
# features and risk non-determinism, hence dither_method=0 above.
CANONICAL_DITHER_POLICY = "none"


class CanonicalProvenanceError(RuntimeError):
    """Canonical analysis cannot prove which ffmpeg binary it would run.

    Deliberately not an FFmpegError: this is not a processing failure with a
    user-facing message, it is a refusal to measure without provenance.
    """


def canonical_aresample_filter(target_sr: int) -> str:
    """The one resampler invocation canonical analysis is allowed to use."""
    parts = [f"osr={int(target_sr)}"]
    parts += [f"{k}={v}" for k, v in CANONICAL_ARESAMPLE_PARAMS]
    return "aresample=" + ":".join(parts)


def resolve_canonical_ffmpeg() -> str:
    """Return an explicit ffmpeg path for canonical analysis, or raise.

    A bare name is rejected even though it would work, because "it worked" is
    not the property we need — we need to know afterwards which binary ran.
    """
    value = os.environ.get(CANONICAL_FFMPEG_ENV, "").strip()
    if not value:
        raise CanonicalProvenanceError(
            f"{CANONICAL_FFMPEG_ENV} is not set. Canonical analysis requires an "
            "explicit ffmpeg binary path so the reference and the runtime can be "
            "shown to have used the same one; PATH resolution is not accepted."
        )
    if os.path.basename(value) == value:
        raise CanonicalProvenanceError(
            f"{CANONICAL_FFMPEG_ENV}={value!r} is a bare name resolved through "
            "PATH. Canonical analysis requires an explicit path."
        )
    resolved = os.path.abspath(value)
    if not os.path.isfile(resolved):
        raise CanonicalProvenanceError(
            f"{CANONICAL_FFMPEG_ENV}={value!r} is not a file: {resolved}"
        )
    if not os.access(resolved, os.X_OK):
        raise CanonicalProvenanceError(
            f"{CANONICAL_FFMPEG_ENV}={value!r} is not executable: {resolved}"
        )
    return resolved


def ffmpeg_version(binary: str | None = None) -> str:
    """Version string of an ffmpeg binary, e.g. "6.0"."""
    bin_path = binary or _FFMPEG_BIN
    stdout, _ = _run([bin_path, "-hide_banner", "-version"], timeout=30, kind="ffmpeg_version")
    first = (stdout or "").splitlines()[0] if stdout else ""
    match = re.match(r"ffmpeg version (\S+)", first)
    if not match:
        raise CanonicalProvenanceError(
            f"could not parse ffmpeg version from: {first!r}"
        )
    return match.group(1)


def ffmpeg_binary_sha256(binary: str | None = None) -> str:
    """sha256 of the ffmpeg binary itself, streamed.

    Version alone does not identify a build: the same version compiled with
    different flags is a different resampler.
    """
    import hashlib

    bin_path = binary or _FFMPEG_BIN
    if os.path.basename(bin_path) == bin_path:
        raise CanonicalProvenanceError(
            f"cannot hash a PATH-resolved binary name: {bin_path!r}"
        )
    digest = hashlib.sha256()
    with open(bin_path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def build_canonical_decode_cmd(
    input_path: str,
    *,
    binary: str,
    target_sr: int | None = None,
) -> list[str]:
    """Command for one canonical decode. Pure: builds argv, runs nothing.

    ``target_sr`` of None means decode only — no resampler is attached at all,
    rather than an aresample that happens to be a no-op. A filter that is not in
    the graph cannot contribute anything to the measurement.

    ``-map 0:a:0 -vn`` is not cosmetic: every track in the commercial reference
    corpus carries an attached PNG cover, so the audio stream is selected
    explicitly instead of relying on ffmpeg's default choice.
    """
    cmd = [
        binary, "-hide_banner", "-nostdin", "-v", "error",
        "-i", input_path,
        "-map", "0:a:0", "-vn",
    ]
    if target_sr is not None:
        cmd += ["-af", canonical_aresample_filter(target_sr)]
    cmd += ["-c:a", "pcm_f32le", "-f", "f32le", "pipe:1"]
    return cmd


def decode_canonical_pcm_f32le(
    input_path: str,
    *,
    channels: int,
    binary: str,
    target_sr: int | None = None,
    timeout: int = 600,
) -> bytes:
    """Decode to raw interleaved float32 on stdout and return the bytes.

    A pipe rather than a temporary WAV: analysis never needs the intermediate to
    persist, and a temp file is one more thing that can be left behind on a
    user's disk after a crash.
    """
    if channels <= 0:
        raise CanonicalProvenanceError(f"invalid channel count: {channels}")

    cmd = build_canonical_decode_cmd(input_path, binary=binary, target_sr=target_sr)
    log("DEBUG", f"exec[canonical_decode]: {' '.join(cmd[:10])} ...")
    t0 = time.time()
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        _record_invocation("canonical_decode", cmd, "<timeout>", False, time.time() - t0)
        raise CanonicalProvenanceError(
            f"canonical decode timed out after {timeout}s: {input_path}"
        )
    except FileNotFoundError:
        _record_invocation("canonical_decode", cmd, "<not found>", False, time.time() - t0)
        raise CanonicalProvenanceError(f"ffmpeg binary not found: {binary}")

    elapsed = time.time() - t0
    stderr = (proc.stderr or b"").decode("utf-8", errors="replace")
    if proc.returncode != 0:
        _record_invocation("canonical_decode", cmd, stderr, False, elapsed)
        raise CanonicalProvenanceError(
            f"canonical decode failed (exit {proc.returncode}): {stderr[-500:]}"
        )

    raw = proc.stdout or b""
    _record_invocation("canonical_decode", cmd, stderr, True, elapsed)

    frame_bytes = 4 * channels
    if len(raw) == 0:
        raise CanonicalProvenanceError(f"canonical decode produced no audio: {input_path}")
    if len(raw) % frame_bytes != 0:
        raise CanonicalProvenanceError(
            f"malformed f32le stream: {len(raw)} bytes is not a multiple of "
            f"{frame_bytes} ({channels}ch x 4 bytes)"
        )
    return raw


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

def _run(
    cmd: list[str],
    *,
    timeout: int = 300,
    kind: str = "ffmpeg",
    filter_str: str = "",
) -> tuple[str, str]:
    """
    Execute a command and return (stdout, stderr).
    Raises FFmpegError on non-zero exit or missing binary.

    `kind` and `filter_str` are forwarded to the optional DebugRecorder so
    a debug bundle can later identify which ffmpeg call produced which log.
    """
    log("DEBUG", f"exec[{kind}]: {' '.join(cmd[:8])}" + (" ..." if len(cmd) > 8 else ""))
    t0 = time.time()
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
        _record_invocation(kind, cmd, "<timeout>", False, time.time() - t0, filter_str)
        raise FFmpegError(
            f"처리 시간이 초과되었습니다 ({timeout}초). 파일이 너무 크거나 시스템이 느릴 수 있습니다."
        )
    except FileNotFoundError:
        bin_name = cmd[0]
        _record_invocation(kind, cmd, "<not found>", False, time.time() - t0, filter_str)
        raise FFmpegError(
            f"'{bin_name}'을 찾을 수 없습니다. FFmpeg가 올바르게 설치되어 있는지 확인해주세요.\n"
            f"설치 방법: brew install ffmpeg (macOS) / apt install ffmpeg (Linux)"
        )

    elapsed = time.time() - t0
    if proc.returncode != 0:
        log("ERROR", f"{cmd[0]} exited {proc.returncode}:\n{proc.stderr[-3000:]}")
        _record_invocation(kind, cmd, proc.stderr or "", False, elapsed, filter_str)
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

    _record_invocation(kind, cmd, proc.stderr or "", True, elapsed, filter_str)
    return proc.stdout, proc.stderr


# ── ffprobe ───────────────────────────────────────────────────────────────────

def ffprobe_info(file_path: str) -> dict[str, Any]:
    """Return full ffprobe JSON for a file (streams + format)."""
    stdout, _ = _run([
        _FFPROBE_BIN, "-v", "quiet",
        "-print_format", "json",
        "-show_streams", "-show_format",
        file_path,
    ], kind="ffprobe")
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


def extract_file_info(probe: dict[str, Any], file_path: str = "") -> dict[str, Any]:
    """
    Build a rich input-file metadata dict from an ffprobe result.

    Captures everything the debug bundle needs to reproduce a user-specific
    quality issue: codec, sample rate, bit depth, channels, duration, file
    size, container, bitrate (declared vs. nominal), and a best-effort
    VBR / CBR classification for compressed inputs.
    """
    audio = parse_audio_stream(probe)
    fmt = probe.get("format", {})
    codec = audio.get("codec_name", "unknown")
    fmt_name = str(fmt.get("format_name", "")).lower()
    long_name = str(fmt.get("format_long_name", ""))

    bit_rate = None
    try:
        if audio.get("bit_rate"):
            bit_rate = int(audio["bit_rate"])
        elif fmt.get("bit_rate"):
            bit_rate = int(fmt["bit_rate"])
    except (TypeError, ValueError):
        bit_rate = None

    size_bytes = None
    try:
        if fmt.get("size"):
            size_bytes = int(fmt["size"])
        elif file_path and os.path.exists(file_path):
            size_bytes = os.path.getsize(file_path)
    except (TypeError, ValueError, OSError):
        size_bytes = None

    duration = 0.0
    try:
        duration = float(fmt.get("duration") or audio.get("duration") or 0.0)
    except (TypeError, ValueError):
        duration = 0.0

    # ── VBR / CBR detection (best-effort) ──
    # · MP3 with Xing/Info VBR header → ffprobe sets tags.encoder_info or
    #   format reports a varying frame size; we fall back to checking whether
    #   computed bitrate (size * 8 / duration) matches declared bitrate.
    vbr: str | None = None
    if codec in ("mp3", "aac", "opus", "vorbis", "ac3", "wma"):
        tags: dict[str, Any] = {}
        tags.update(audio.get("tags") or {})
        tags.update(fmt.get("tags") or {})
        encoder = str(tags.get("encoder", "")).lower()
        if "vbr" in encoder or "lavc" in encoder and "vbr" in encoder:
            vbr = "VBR"
        elif "cbr" in encoder:
            vbr = "CBR"
        elif duration > 0 and size_bytes and bit_rate:
            computed_kbps = (size_bytes * 8.0) / duration / 1000.0
            declared_kbps = bit_rate / 1000.0
            # Ratio close to 1.0 → CBR; > 1.05 difference is typical of VBR
            ratio = abs(computed_kbps - declared_kbps) / max(1.0, declared_kbps)
            vbr = "CBR" if ratio < 0.05 else "VBR-suspected"
        else:
            vbr = "unknown"

    return {
        "path":          file_path,
        "name":          os.path.basename(file_path) if file_path else None,
        "codec":         codec,
        "codecLongName": audio.get("codec_long_name"),
        "sampleRate":    int(audio.get("sample_rate", 0) or 0),
        "channels":      int(audio.get("channels", 0) or 0),
        "channelLayout": audio.get("channel_layout"),
        "bitDepth":      parse_bit_depth(audio),
        "sampleFmt":     audio.get("sample_fmt"),
        "bitRateBps":    bit_rate,
        "sizeBytes":     size_bytes,
        "durationSec":   round(duration, 3),
        "containerFormat": fmt_name,
        "containerLongName": long_name,
        "vbrCbr":        vbr,
        "encoderTag":    (audio.get("tags") or {}).get("encoder")
                         or (fmt.get("tags") or {}).get("encoder"),
    }


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
    ], kind="loudnorm_pass1", filter_str=filter_str)

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
    ], kind="loudnorm_pass2", filter_str=af)
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
    ], kind="limiter", filter_str=limiter)
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
    ], kind="preview_mp3")
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
    ], kind="filter_chain", filter_str=af_chain)
    return output_path
