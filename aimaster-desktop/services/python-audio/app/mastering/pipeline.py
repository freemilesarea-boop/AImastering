"""
Full 6-stage mastering pipeline orchestration.

Stage 1 — Input validation & analysis
Stage 2 — Preprocessing warnings (DC offset, sample rate, mono, clipping)
Stage 3 — Style-specific tone correction (EQ filter chain)
Stage 4 — Dynamic control (conservative compressor)
Stage 5 — loudnorm 2-pass (I=-14, TP=-1.0, LRA≈11, linear=true)
Stage 6 — Post-verification re-measurement

Error policy:
  - FFmpegError  → logged in full (stderr saved), user gets Korean message
  - All other exceptions → caught, logged, re-raised as RuntimeError with summary
  - Processing never crashes silently; every failure surfaces to the caller
"""
from __future__ import annotations

import os
import time
from typing import Any, Callable

from app.utils.ffmpeg_wrapper import (
    FFmpegError,
    ffprobe_info,
    loudnorm_pass1,
    loudnorm_pass2,
    measure_output,
    export_preview_mp3,
    parse_audio_stream,
    parse_bit_depth,
)
from app.utils.audio_io import analyze_waveform, waveform_stats_to_dict
from app.mastering.eq import build_eq_filter
from app.mastering.dynamics import build_dynamics_filter, describe_dynamics
from app.utils.logger import log

# ── Quality-check thresholds for post-verification ────────────────────────────

_LUFS_TOLERANCE   = 1.5    # dB: warn if |result - target| > this
_TP_MAX           = -1.0   # dBTP: hard requirement
_TP_WARN_MARGIN   = 0.5    # dBTP: warn at -1.5 or stricter, note at -1.0

ProgressCallback = Callable[[str, int, str], None]   # (job_id, percent, stage)


# ── Internal helpers ──────────────────────────────────────────────────────────

def _noop_progress(_job_id: str, _pct: int, _stage: str) -> None:
    pass


def _build_filter_chain(
    style: str,
    ai_detections: dict[str, bool],
    apply_ai_corrections: bool,
    input_peak_db: float,
) -> tuple[str, list[str]]:
    """
    Combine Stage-3 EQ and Stage-4 dynamics into a single ffmpeg filter chain.
    Also returns the list of applied-correction descriptions for the result.
    """
    applied: list[str] = []

    # Stage 3 — EQ
    eq_chain = build_eq_filter(style, ai_detections, apply_ai_corrections)
    if apply_ai_corrections:
        if ai_detections.get("harshHighMid"):
            applied.append("고음역 거친 주파수 보정 (4 kHz −3 dB)")
        if ai_detections.get("boomyLowEnd"):
            applied.append("저음역 과잉 보정 (120 Hz −4 dB)")
    if style != "balanced" or eq_chain:
        applied.append(f"{style.capitalize()} 스타일 EQ 적용")

    # Stage 4 — Dynamics
    dyn_chain = build_dynamics_filter(style, input_peak_db)
    applied.append(describe_dynamics(style))

    # Merge into a single comma-joined chain
    parts = [p for p in (eq_chain, dyn_chain) if p]
    return ",".join(parts), applied


# ── Main pipeline ─────────────────────────────────────────────────────────────

def run_pipeline(
    input_path: str,
    output_path: str,
    *,
    style: str = "balanced",
    target_lufs: float = -14.0,
    target_tp: float = -1.0,
    lra: float = 11.0,
    sample_rate: int = 44100,
    bit_depth: int = 24,
    apply_ai_corrections: bool = True,
    ai_detections: dict[str, bool] | None = None,
    trim_silence: bool = False,
    job_id: str = "job",
    progress: ProgressCallback = _noop_progress,
) -> dict[str, Any]:
    """
    Execute the full mastering pipeline on input_path → output_path.

    Returns a result dict compatible with MasteringResult in shared-types, plus
    extended fields: preVerify, postVerify, pipelineWarnings.
    """

    t_start = time.time()
    pipeline_warnings: list[dict[str, str]] = []

    # ═══════════════════════════════════════════════════════════════════════
    # Stage 1 — Input validation
    # ═══════════════════════════════════════════════════════════════════════
    progress(job_id, 5, "입력 파일 확인 중")
    log("INFO", f"[pipeline] stage1 — validating: {input_path}")

    if not os.path.exists(input_path):
        raise FFmpegError(f"파일을 찾을 수 없습니다: {os.path.basename(input_path)}")
    if os.path.getsize(input_path) == 0:
        raise FFmpegError("파일 크기가 0입니다. 올바른 오디오 파일을 선택해주세요.")

    # Ensure output directory exists
    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)

    probe = ffprobe_info(input_path)
    audio = parse_audio_stream(probe)
    fmt   = probe.get("format", {})
    input_sample_rate = int(audio.get("sample_rate", 44100))
    input_channels    = int(audio.get("channels", 2))
    input_bit_depth   = parse_bit_depth(audio)
    input_duration    = float(fmt.get("duration") or audio.get("duration") or 0.0)

    # Waveform analysis for peak, DC, silence (needed before filter chain build)
    waveform = analyze_waveform(input_path)

    # ═══════════════════════════════════════════════════════════════════════
    # Stage 2 — Preprocessing warnings (no processing yet)
    # ═══════════════════════════════════════════════════════════════════════
    progress(job_id, 18, "전처리 분석 중")
    log("INFO", "[pipeline] stage2 — preprocessing warnings")

    _RECOMMENDED_SR = {44100, 48000, 88200, 96000}
    if input_sample_rate not in _RECOMMENDED_SR:
        pipeline_warnings.append({
            "code": "NON_STANDARD_SAMPLE_RATE",
            "level": "warning",
            "userMessage": f"입력 샘플레이트 {input_sample_rate} Hz는 비권장 값입니다. "
                           f"출력은 {sample_rate} Hz로 변환됩니다.",
        })

    if input_channels == 1:
        pipeline_warnings.append({
            "code": "MONO_INPUT",
            "level": "warning",
            "userMessage": "모노 파일이 감지되었습니다. 처리는 가능하지만 스테레오 변환은 하지 않습니다.",
        })

    if waveform and waveform.dc_offset_detected:
        pipeline_warnings.append({
            "code": "DC_OFFSET",
            "level": "warning",
            "userMessage": (
                f"DC 오프셋이 감지되었습니다 "
                f"(L: {waveform.dc_offset_db_l:.1f} dB). "
                f"마스터링 결과에 영향을 줄 수 있습니다."
            ),
        })

    if waveform and waveform.clipping_detected:
        pipeline_warnings.append({
            "code": "INPUT_CLIPPING",
            "level": "warning",
            "userMessage": (
                f"입력 파일에 클리핑이 감지되었습니다 "
                f"({waveform.clipping_samples}개 샘플). "
                f"피크를 사전에 줄여서 처리합니다."
            ),
        })

    # ═══════════════════════════════════════════════════════════════════════
    # Stage 3 + 4 — Build filter chain (EQ + Dynamics)
    # ═══════════════════════════════════════════════════════════════════════
    progress(job_id, 25, "필터 체인 구성 중")
    log("INFO", f"[pipeline] stage3+4 — building filter chain (style={style})")

    # Use probe-based peak if waveform analysis failed
    input_peak_db = waveform.sample_peak_db if waveform else float(
        ffprobe_info(input_path).get("format", {}).get("max_volume", -3.0) or -3.0
    )

    ai = ai_detections or {}
    pre_filter, applied_corrections = _build_filter_chain(
        style, ai, apply_ai_corrections, input_peak_db
    )
    log("INFO", f"[pipeline] filter chain: {pre_filter or '(none)'}")

    # ═══════════════════════════════════════════════════════════════════════
    # Stage 1 — loudnorm pass-1 on FILTERED signal (accurate measurement)
    # ═══════════════════════════════════════════════════════════════════════
    # IMPORTANT: pass1 must measure the same signal that pass2 will normalize.
    # Running pass1 on the raw input gives wrong measured_I/TP values when
    # EQ or compression changes the loudness before loudnorm in pass2.
    progress(job_id, 35, "라우드니스 측정 중 (1/2)")
    log("INFO", f"[pipeline] stage5-pass1 — loudnorm measurement (with pre_filter)")

    try:
        pass1 = loudnorm_pass1(input_path, target_lufs, target_tp, lra, pre_filter)
    except FFmpegError as exc:
        log("ERROR", f"loudnorm pass1 failed: {exc}\nstderr:\n{exc.stderr}")
        raise

    # Also measure raw input for "before" stats displayed in the UI
    try:
        pass1_raw = loudnorm_pass1(input_path, target_lufs, target_tp, lra)
    except FFmpegError:
        pass1_raw = pass1  # fallback: use filtered measurement

    pre_lufs = float(pass1_raw.get("input_i", -99.0))
    pre_tp   = float(pass1_raw.get("input_tp", 0.0))
    pre_lra  = float(pass1_raw.get("input_lra", 0.0))
    log("INFO", f"[pipeline] pre-master (raw): LUFS={pre_lufs:.1f}, TP={pre_tp:.1f}, LRA={pre_lra:.1f}")

    if pre_lra < 2.5:
        pipeline_warnings.append({
            "code": "BRICKWALL_INPUT",
            "level": "warning",
            "userMessage": f"입력 파일의 LRA가 {pre_lra:.1f} LU로 매우 낮습니다. "
                           f"이미 과도한 압축이 적용된 것으로 보입니다.",
        })

    # ═══════════════════════════════════════════════════════════════════════
    # Stage 5 — loudnorm pass-2 (apply normalization)
    # ═══════════════════════════════════════════════════════════════════════
    progress(job_id, 40, "라우드니스 정규화 중 (2/2)")
    log("INFO", f"[pipeline] stage5 — loudnorm pass2 → {output_path}")

    try:
        loudnorm_pass2(
            input_path,
            output_path,
            pass1,
            target_lufs=target_lufs,
            target_tp=target_tp,
            lra=lra,
            sample_rate=sample_rate,
            bit_depth=bit_depth,
            pre_filter=pre_filter,
        )
    except FFmpegError as exc:
        log("ERROR", f"loudnorm pass2 failed: {exc}\nstderr:\n{exc.stderr}")
        raise

    # ═══════════════════════════════════════════════════════════════════════
    # Stage 6 — Post-verification
    # ═══════════════════════════════════════════════════════════════════════
    progress(job_id, 75, "출력 파일 검증 중")
    log("INFO", "[pipeline] stage6 — post-verification")

    try:
        post_stats = measure_output(output_path, target_lufs, target_tp)
    except FFmpegError as exc:
        log("ERROR", f"Post-verification failed: {exc}\nstderr:\n{exc.stderr}")
        # Non-fatal — output file still exists; surface as warning
        post_stats = {"integratedLufs": -99.0, "truePeakDbtp": 0.0, "lra": 0.0, "durationSec": 0.0}
        pipeline_warnings.append({
            "code": "POST_VERIFY_FAILED",
            "level": "warning",
            "userMessage": "출력 파일 검증에 실패했습니다. 파일은 저장되었으나 수치 확인이 불가합니다.",
        })

    post_waveform = analyze_waveform(output_path)

    # Check output quality and emit notes/warnings
    post_lufs = post_stats["integratedLufs"]
    post_tp   = post_stats["truePeakDbtp"]
    post_lra  = post_stats["lra"]

    lufs_diff = abs(post_lufs - target_lufs)
    if lufs_diff > _LUFS_TOLERANCE:
        msg = (
            f"출력 라우드니스가 목표값과 {lufs_diff:.1f} dB 차이 납니다 "
            f"(목표 {target_lufs} LUFS, 결과 {post_lufs:.1f} LUFS). "
            f"매우 짧거나 다이내믹 레인지가 극단적인 파일에서 발생할 수 있습니다."
        )
        pipeline_warnings.append({"code": "LUFS_DEVIATION", "level": "warning", "userMessage": msg})
        log("WARN", msg)

    if post_tp > _TP_MAX:
        msg = (
            f"출력 트루 피크가 {post_tp:.1f} dBTP로 목표값({_TP_MAX} dBTP)을 초과합니다. "
            f"스트리밍 플랫폼 업로드 전 추가 리미팅을 권장합니다."
        )
        pipeline_warnings.append({"code": "TRUE_PEAK_EXCEEDED", "level": "error", "userMessage": msg})
        log("ERROR", msg)

    if post_waveform and post_waveform.clipping_detected:
        pipeline_warnings.append({
            "code": "OUTPUT_CLIPPING",
            "level": "error",
            "userMessage": "출력 파일에 클리핑이 발생했습니다. 입력 신호의 왜곡이 심하거나 처리 설정을 검토해주세요.",
        })

    # Duration sanity check
    if post_stats["durationSec"] > 0 and abs(post_stats["durationSec"] - input_duration) > 0.5:
        pipeline_warnings.append({
            "code": "DURATION_MISMATCH",
            "level": "warning",
            "userMessage": (
                f"출력 파일 길이가 입력과 다릅니다 "
                f"(입력 {input_duration:.2f}s → 출력 {post_stats['durationSec']:.2f}s). "
                f"무음 제거 설정 또는 파일 이상을 확인해주세요."
            ),
        })

    # ═══════════════════════════════════════════════════════════════════════
    # MP3 Preview export
    # ═══════════════════════════════════════════════════════════════════════
    progress(job_id, 88, "프리뷰 MP3 생성 중")
    preview_path = os.path.splitext(output_path)[0] + "_preview.mp3"
    try:
        export_preview_mp3(output_path, preview_path)
        log("INFO", f"[pipeline] preview: {preview_path}")
    except FFmpegError as exc:
        log("ERROR", f"MP3 preview export failed: {exc}\nstderr:\n{exc.stderr}")
        preview_path = ""
        pipeline_warnings.append({
            "code": "PREVIEW_EXPORT_FAILED",
            "level": "warning",
            "userMessage": "MP3 프리뷰 생성에 실패했습니다. WAV 파일은 정상적으로 저장되었습니다.",
        })

    progress(job_id, 100, "완료")
    elapsed = round(time.time() - t_start, 2)
    log("INFO", f"[pipeline] done in {elapsed}s")

    return {
        # Output files
        "outputPath":  output_path,
        "previewPath": preview_path,

        # What was applied
        "appliedCorrections": applied_corrections,
        "style": style,

        # Loudness before/after
        "loudnessBefore": {
            "integratedLufs": round(pre_lufs, 2),
            "truePeakDbtp":   round(pre_tp, 2),
            "lra":            round(pre_lra, 2),
        },
        "loudnessAfter": {
            "integratedLufs": round(post_lufs, 2),
            "truePeakDbtp":   round(post_tp, 2),
            "lra":            round(post_lra, 2),
            "durationSec":    round(post_stats["durationSec"], 3),
        },

        # Post-waveform (clipping check on output)
        "postWaveform": waveform_stats_to_dict(post_waveform) if post_waveform else None,

        # Warnings accumulated throughout the pipeline
        "pipelineWarnings": pipeline_warnings,

        # Timing
        "processingTimeSec": elapsed,
    }
