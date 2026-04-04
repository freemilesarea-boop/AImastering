"""
Full 6-stage commercial mastering pipeline.

Stage 1 — Input analysis + spectral balance measurement
Stage 2 — Preprocessing warnings (DC, sample rate, mono, clipping)
Stage 3 — Adaptive low-end + mid/high EQ (streaming-optimized)
Stage 4 — Bus compression (glue, not limiting)
Stage 5 — Loudness normalization (loudnorm 2-pass, target -14.5 LUFS, TP=-1.5)
Stage 6 — Brickwall true-peak limiter (ceiling -1.0 dBTP)

Design principles:
  - Do NOT blindly push LUFS — perceived loudness > numeric LUFS
  - Over-compression is forbidden — LRA must stay above 4 LU
  - If track already exceeds -14 LUFS, reduce gain instead of limiting harder
  - Spectral analysis drives adaptive EQ so every track gets what it needs
  - loudnorm TP=-1.5 leaves headroom; the limiter catches residual overshoots

Error policy:
  - FFmpegError  → logged in full (stderr saved), user gets Korean message
  - All other exceptions → caught, logged, re-raised with Korean summary
"""
from __future__ import annotations

import os
import time
import tempfile
from typing import Any, Callable

from app.utils.ffmpeg_wrapper import (
    FFmpegError,
    ffprobe_info,
    loudnorm_pass1,
    loudnorm_pass2,
    apply_limiter,
    measure_output,
    export_preview_mp3,
    parse_audio_stream,
    parse_bit_depth,
)
from app.utils.audio_io import analyze_waveform, waveform_stats_to_dict
from app.mastering.eq import build_eq_filter, build_eq_filter_with_report
from app.mastering.dynamics import build_dynamics_filter, describe_dynamics, get_comp_params, estimate_comp_gr
from app.utils.logger import log

# ── Quality-check thresholds ──────────────────────────────────────────────────

_TARGET_LUFS      = -14.5   # streaming target (Spotify/YouTube -14, with buffer)
_TARGET_TP        = -1.0    # final true-peak ceiling (dBTP)
_LOUDNORM_TP      = -1.5    # loudnorm internal TP target (leaves room for limiter)
_LUFS_TOLERANCE   = 1.0     # dB: warn if |result - target| > this
_MIN_LRA          = 4.0     # LU: below this = over-compressed output → warn
_TP_MAX           = -1.0    # hard true-peak requirement after limiting

ProgressCallback = Callable[[str, int, str], None]


def _noop_progress(_job_id: str, _pct: int, _stage: str) -> None:
    pass


# ── Filter chain builder ──────────────────────────────────────────────────────

def _build_filter_chain(
    style: str,
    ai_detections: dict[str, bool],
    apply_ai_corrections: bool,
    input_peak_db: float,
    low_to_mid_db: float,
    high_to_mid_db: float,
) -> tuple[str, list[str], list[dict]]:
    """
    Combine Stage-3 EQ and Stage-4 dynamics into a single ffmpeg filter chain.
    Returns (filter_string, applied_correction_strings, eq_move_dicts).
    """
    applied: list[str] = []

    # Stage 3 — Adaptive streaming EQ (with per-band report)
    eq_chain, eq_moves = build_eq_filter_with_report(
        style,
        low_to_mid_db=low_to_mid_db,
        high_to_mid_db=high_to_mid_db,
        ai_detections=ai_detections,
        apply_ai_corrections=apply_ai_corrections,
    )

    if apply_ai_corrections:
        if ai_detections.get("harshHighMid"):
            applied.append("고음역 거친 주파수 보정 (4 kHz −3 dB)")
        if ai_detections.get("boomyLowEnd"):
            applied.append("저음역 과잉 보정 (120 Hz −4 dB)")

    applied.append("스트리밍 베이스 EQ (80Hz 밀도 +, 250Hz 머드 -, 10kHz 에어 +)")
    if style != "balanced":
        applied.append(f"{style.capitalize()} 스타일 오버레이 적용")

    # Stage 4 — Bus compression
    dyn_chain = build_dynamics_filter(style, input_peak_db)
    applied.append(describe_dynamics(style))

    parts = [p for p in (eq_chain, dyn_chain) if p]
    return ",".join(parts), applied, eq_moves


# ── Main pipeline ─────────────────────────────────────────────────────────────

def run_pipeline(
    input_path: str,
    output_path: str,
    *,
    style: str = "balanced",
    target_lufs: float = _TARGET_LUFS,
    target_tp: float = _TARGET_TP,
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
    Execute the full 6-stage commercial mastering pipeline.

    Returns a result dict compatible with MasteringResult in shared-types, plus:
      preVerify, postVerify, pipelineWarnings, spectralBalance.
    """
    t_start = time.time()
    pipeline_warnings: list[dict[str, str]] = []

    # ═══════════════════════════════════════════════════════════════════════
    # Stage 1 — Input validation + spectral analysis
    # ═══════════════════════════════════════════════════════════════════════
    progress(job_id, 5, "입력 파일 확인 중")
    log("INFO", f"[pipeline] stage1 — validating + spectral analysis: {input_path}")

    if not os.path.exists(input_path):
        raise FFmpegError(f"파일을 찾을 수 없습니다: {os.path.basename(input_path)}")
    if os.path.getsize(input_path) == 0:
        raise FFmpegError("파일 크기가 0입니다. 올바른 오디오 파일을 선택해주세요.")

    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)

    probe = ffprobe_info(input_path)
    audio = parse_audio_stream(probe)
    fmt   = probe.get("format", {})
    input_sample_rate = int(audio.get("sample_rate", 44100))
    input_channels    = int(audio.get("channels", 2))
    input_bit_depth   = parse_bit_depth(audio)
    input_duration    = float(fmt.get("duration") or audio.get("duration") or 0.0)

    # Waveform + spectral balance analysis (soundfile/numpy)
    progress(job_id, 10, "스펙트럴 분석 중")
    waveform = analyze_waveform(input_path)
    input_peak_db = waveform.sample_peak_db if waveform else -3.0

    # Extract spectral balance ratios (used for adaptive EQ)
    if waveform is not None:
        low_to_mid_db  = waveform.low_to_mid_db
        high_to_mid_db = waveform.high_to_mid_db
        log("INFO", f"[pipeline] spectral: low_to_mid={low_to_mid_db:.1f} dB, "
                    f"high_to_mid={high_to_mid_db:.1f} dB")
    else:
        # Defaults represent a typical balanced track
        low_to_mid_db  = -15.0
        high_to_mid_db = -22.0
        log("WARN", "[pipeline] spectral analysis unavailable — using defaults")

    # ═══════════════════════════════════════════════════════════════════════
    # Stage 2 — Preprocessing warnings
    # ═══════════════════════════════════════════════════════════════════════
    progress(job_id, 15, "전처리 분석 중")
    log("INFO", "[pipeline] stage2 — preprocessing warnings")

    _RECOMMENDED_SR = {44100, 48000, 88200, 96000}
    if input_sample_rate not in _RECOMMENDED_SR:
        pipeline_warnings.append({
            "code": "NON_STANDARD_SAMPLE_RATE",
            "level": "warning",
            "userMessage": (
                f"입력 샘플레이트 {input_sample_rate} Hz는 비권장 값입니다. "
                f"출력은 {sample_rate} Hz로 변환됩니다."
            ),
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
    # Stage 3 + 4 — Build adaptive EQ + bus compression filter chain
    # ═══════════════════════════════════════════════════════════════════════
    progress(job_id, 22, "EQ / 컴프레서 체인 구성 중")
    log("INFO", f"[pipeline] stage3+4 — filter chain (style={style}, "
                f"low_to_mid={low_to_mid_db:.1f}, high_to_mid={high_to_mid_db:.1f})")

    ai = ai_detections or {}
    pre_filter, applied_corrections, eq_moves = _build_filter_chain(
        style, ai, apply_ai_corrections, input_peak_db,
        low_to_mid_db, high_to_mid_db,
    )
    log("INFO", f"[pipeline] pre_filter: {pre_filter or '(none)'}")

    # ═══════════════════════════════════════════════════════════════════════
    # Stage 5a — loudnorm pass-1 on FILTERED signal (accurate measurement)
    #
    # CRITICAL: pass1 must measure the signal AFTER the pre_filter is applied
    # so that pass2's measured_I/TP values match the actual input to loudnorm.
    # Running pass1 on raw input gives wrong values when EQ/compressor changes
    # the loudness before normalization.
    # ═══════════════════════════════════════════════════════════════════════
    progress(job_id, 30, "라우드니스 측정 중 (1/2)")
    log("INFO", "[pipeline] stage5a — loudnorm pass1 (with pre_filter)")

    try:
        pass1 = loudnorm_pass1(
            input_path, target_lufs, _LOUDNORM_TP, lra, pre_filter
        )
    except FFmpegError as exc:
        log("ERROR", f"loudnorm pass1 failed: {exc}\nstderr:\n{exc.stderr}")
        raise

    # Measure raw input separately for the "before" stats in the UI
    try:
        pass1_raw = loudnorm_pass1(input_path, target_lufs, _LOUDNORM_TP, lra)
    except FFmpegError:
        pass1_raw = pass1

    pre_lufs = float(pass1_raw.get("input_i", -99.0))
    pre_tp   = float(pass1_raw.get("input_tp", 0.0))
    pre_lra  = float(pass1_raw.get("input_lra", 0.0))
    log("INFO", f"[pipeline] pre-master (raw): LUFS={pre_lufs:.1f}, "
                f"TP={pre_tp:.1f}, LRA={pre_lra:.1f}")

    if pre_lra < 2.5:
        pipeline_warnings.append({
            "code": "BRICKWALL_INPUT",
            "level": "warning",
            "userMessage": (
                f"입력 파일의 LRA가 {pre_lra:.1f} LU로 매우 낮습니다. "
                f"이미 과도한 압축이 적용된 것으로 보입니다."
            ),
        })

    # Smart gain decision:
    # If the track already exceeds the target loudness, DO NOT limit harder —
    # reduce gain instead.  The loudnorm linear mode handles this automatically
    # via negative gain, but we log it clearly for transparency.
    if pre_lufs > target_lufs:
        log("INFO", f"[pipeline] track exceeds target ({pre_lufs:.1f} > {target_lufs}) "
                    f"— reducing gain, not limiting harder")

    # ═══════════════════════════════════════════════════════════════════════
    # Stage 5b — loudnorm pass-2 (EQ+comp → normalize to -14.5 LUFS, TP=-1.5)
    # ═══════════════════════════════════════════════════════════════════════
    progress(job_id, 45, "라우드니스 정규화 중 (2/2)")
    log("INFO", f"[pipeline] stage5b — loudnorm pass2 → intermediate WAV")

    # Use a temp file for the loudnorm output so the limiter gets a clean input
    tmp_fd, tmp_wav = tempfile.mkstemp(suffix="_loudnorm.wav")
    os.close(tmp_fd)

    try:
        loudnorm_pass2(
            input_path,
            tmp_wav,
            pass1,
            target_lufs=target_lufs,
            target_tp=_LOUDNORM_TP,
            lra=lra,
            sample_rate=sample_rate,
            bit_depth=bit_depth,
            pre_filter=pre_filter,
        )
    except FFmpegError as exc:
        log("ERROR", f"loudnorm pass2 failed: {exc}\nstderr:\n{exc.stderr}")
        try:
            os.unlink(tmp_wav)
        except OSError:
            pass
        raise

    # ═══════════════════════════════════════════════════════════════════════
    # Stage 6 — Brickwall true-peak limiter (ceiling -1.0 dBTP)
    # ═══════════════════════════════════════════════════════════════════════
    progress(job_id, 65, "트루 피크 리미터 적용 중")
    log("INFO", f"[pipeline] stage6 — brickwall limiter → {output_path}")

    # Measure pre-limiter peak so we can report actual limiter gain reduction
    try:
        pre_lim_stats   = measure_output(tmp_wav, target_lufs, target_tp)
        pre_lim_peak_db = pre_lim_stats.get("truePeakDbtp", 0.0)
        pre_lim_lufs    = pre_lim_stats.get("integratedLufs", -99.0)
    except FFmpegError:
        pre_lim_peak_db = 0.0
        pre_lim_lufs    = -99.0

    try:
        apply_limiter(
            tmp_wav,
            output_path,
            ceiling_dbfs=target_tp,
            attack_ms=5.0,
            release_ms=50.0,
            sample_rate=sample_rate,
            bit_depth=bit_depth,
        )
    except FFmpegError as exc:
        log("ERROR", f"limiter failed: {exc}\nstderr:\n{exc.stderr}")
        raise
    finally:
        try:
            os.unlink(tmp_wav)
        except OSError:
            pass

    # ═══════════════════════════════════════════════════════════════════════
    # Post-verification — re-measure output
    # ═══════════════════════════════════════════════════════════════════════
    progress(job_id, 78, "출력 파일 검증 중")
    log("INFO", "[pipeline] post-verification")

    try:
        post_stats = measure_output(output_path, target_lufs, target_tp)
    except FFmpegError as exc:
        log("ERROR", f"Post-verification failed: {exc}\nstderr:\n{exc.stderr}")
        post_stats = {
            "integratedLufs": -99.0,
            "truePeakDbtp": 0.0,
            "lra": 0.0,
            "durationSec": 0.0,
        }
        pipeline_warnings.append({
            "code": "POST_VERIFY_FAILED",
            "level": "warning",
            "userMessage": "출력 파일 검증에 실패했습니다. 파일은 저장되었으나 수치 확인이 불가합니다.",
        })

    post_waveform = analyze_waveform(output_path)

    post_lufs = post_stats["integratedLufs"]
    post_tp   = post_stats["truePeakDbtp"]
    post_lra  = post_stats["lra"]

    # ── Quality checks ────────────────────────────────────────────────────

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

    if post_lra < _MIN_LRA and post_lra > 0:
        msg = (
            f"출력 LRA가 {post_lra:.1f} LU로 너무 낮습니다. "
            f"과도한 압축이 적용되었거나 입력 파일이 이미 과압축 상태입니다."
        )
        pipeline_warnings.append({"code": "OUTPUT_OVER_COMPRESSED", "level": "warning", "userMessage": msg})
        log("WARN", msg)

    if post_waveform and post_waveform.clipping_detected:
        pipeline_warnings.append({
            "code": "OUTPUT_CLIPPING",
            "level": "error",
            "userMessage": "출력 파일에 클리핑이 발생했습니다. 입력 신호의 왜곡이 심하거나 처리 설정을 검토해주세요.",
        })

    if post_stats["durationSec"] > 0 and abs(post_stats["durationSec"] - input_duration) > 0.5:
        pipeline_warnings.append({
            "code": "DURATION_MISMATCH",
            "level": "warning",
            "userMessage": (
                f"출력 파일 길이가 입력과 다릅니다 "
                f"(입력 {input_duration:.2f}s → 출력 {post_stats['durationSec']:.2f}s)."
            ),
        })

    log("INFO", f"[pipeline] post-master: LUFS={post_lufs:.1f}, "
                f"TP={post_tp:.1f}, LRA={post_lra:.1f}")

    # ── MP3 preview ───────────────────────────────────────────────────────
    progress(job_id, 90, "프리뷰 MP3 생성 중")
    preview_path = os.path.splitext(output_path)[0] + "_preview.mp3"
    try:
        export_preview_mp3(output_path, preview_path)
        log("INFO", f"[pipeline] preview: {preview_path}")
    except FFmpegError as exc:
        log("ERROR", f"MP3 preview export failed: {exc}")
        preview_path = ""
        pipeline_warnings.append({
            "code": "PREVIEW_EXPORT_FAILED",
            "level": "warning",
            "userMessage": "MP3 프리뷰 생성에 실패했습니다. WAV 파일은 정상적으로 저장되었습니다.",
        })

    progress(job_id, 100, "완료")
    elapsed = round(time.time() - t_start, 2)
    log("INFO", f"[pipeline] done in {elapsed}s")

    # ── Build analysis report ──────────────────────────────────────────────
    comp_params  = get_comp_params(style)
    comp_gr_est  = estimate_comp_gr(style, input_peak_db)
    lim_gr       = round(max(0.0, pre_lim_peak_db - target_tp), 2)
    loudnorm_gain = round(target_lufs - float(pass1_raw.get("input_i", pre_lufs)), 1)

    post_spectral = None
    if post_waveform and hasattr(post_waveform, "low_to_mid_db"):
        post_spectral = {
            "lowToMidDb":  round(post_waveform.low_to_mid_db, 1),
            "highToMidDb": round(post_waveform.high_to_mid_db, 1),
        }

    analysis_report = {
        # Per-band EQ description
        "eqMoves": eq_moves,

        # Compressor
        "compressor": {
            "style":          style,
            "thresholdDb":    comp_params["threshold"],
            "ratio":          comp_params["ratio"],
            "attackMs":       comp_params["attack"],
            "releaseMs":      comp_params["release"],
            "makeupDb":       min(comp_params["makeup"], 3.0),
            "estimatedGrDb":  comp_gr_est,
        },

        # Limiter
        "limiter": {
            "ceilingDbtp":    target_tp,
            "preGainDbtp":    round(pre_lim_peak_db, 2),
            "appliedGrDb":    lim_gr,
            "preLimLufs":     round(pre_lim_lufs, 2),
        },

        # Loudnorm
        "loudnorm": {
            "targetLufs":     target_lufs,
            "measuredBefore": round(pre_lufs, 2),
            "gainAppliedDb":  loudnorm_gain,
        },

        # Spectral before/after
        "spectralBefore": {
            "lowToMidDb":  round(low_to_mid_db, 1),
            "highToMidDb": round(high_to_mid_db, 1),
        } if waveform else None,
        "spectralAfter": post_spectral,

        # Key loudness metrics
        "loudnessBefore": {
            "integratedLufs": round(pre_lufs, 2),
            "truePeakDbtp":   round(pre_tp, 2),
            "lra":            round(pre_lra, 2),
        },
        "loudnessAfter": {
            "integratedLufs": round(post_lufs, 2),
            "truePeakDbtp":   round(post_tp, 2),
            "lra":            round(post_lra, 2),
        },
    }

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

        # Spectral balance info (from input analysis)
        "spectralBalance": {
            "lowToMidDb":  round(low_to_mid_db, 1),
            "highToMidDb": round(high_to_mid_db, 1),
        } if waveform else None,

        # Post-waveform (clipping check on output)
        "postWaveform": waveform_stats_to_dict(post_waveform) if post_waveform else None,

        # Full analysis report (EQ moves, compressor, limiter, spectral before/after)
        "analysisReport": analysis_report,

        # Warnings
        "pipelineWarnings": pipeline_warnings,

        # Timing
        "processingTimeSec": elapsed,
    }
