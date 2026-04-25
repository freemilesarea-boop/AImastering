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
from app.mastering.effects import (
    saturation_filter,
    stereo_width_filter,
    soft_clipper_filter,
    deesser_filter,
    get_mode_defaults as get_effects_defaults,
)
from app.utils.logger import log

# ── Quality-check thresholds ──────────────────────────────────────────────────

_TARGET_LUFS      = -14.0   # streaming target
_TARGET_TP        = -1.0    # default limiter ceiling
_LUFS_TOLERANCE   = 0.5     # dB: tighter than before — correction pass kicks in if exceeded
_MIN_LRA          = 4.0     # LU
_TP_GUARD_DB      = 0.0     # dBTP: max acceptable overshoot before warning

# ── Limiter strength → input gain (dB) + attack/release ──────────────────────
LIMITER_STRENGTHS: dict[str, dict[str, float]] = {
    "low":    {"input_gain_db": 0.5, "attack_ms": 8.0, "release_ms": 200.0},
    "medium": {"input_gain_db": 2.0, "attack_ms": 4.0, "release_ms":  80.0},
    "high":   {"input_gain_db": 4.0, "attack_ms": 2.0, "release_ms":  40.0},
}

# 절대값이 작은 (= 큰 라우드니스) 타깃은 loudnorm linear 모드로 도달 불가 → dynamic 사용
_LOUDNORM_DYNAMIC_THRESHOLD = -12.0

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
    *,
    saturation_amount: float | None = None,
    stereo_width: float | None = None,
    output_gain_db: float = 0.0,
) -> tuple[str, list[str], list[dict]]:
    """
    Combine Stage-3 EQ → Stage-4 dynamics → Stage-4.5 effects (deesser /
    saturation / stereo widening / output gain) into a single ffmpeg filter
    chain.  Loudnorm + brickwall limiter are added by the caller.
    Returns (filter_string, applied_correction_strings, eq_move_dicts).
    """
    applied: list[str] = []

    # Stage 3 — Adaptive streaming EQ
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

    applied.append("스트리밍 베이스 EQ (80Hz 밀도 +, 250Hz 머드 -, 12kHz 에어 +)")
    if style != "balanced":
        applied.append(f"{style.capitalize()} 스타일 오버레이 적용")

    # Stage 4 — Bus compression
    dyn_chain = build_dynamics_filter(style, input_peak_db)
    applied.append(describe_dynamics(style))

    # Stage 4.5 — effects
    defaults = get_effects_defaults(style)
    sat = saturation_amount if saturation_amount is not None else defaults["saturation"]
    width = stereo_width if stereo_width is not None else defaults["stereo_width"]
    use_deesser = bool(defaults.get("deesser", False))

    deesser_str   = deesser_filter()        if use_deesser    else ""
    saturation_str = saturation_filter(sat) if sat > 0.001    else ""
    width_str     = stereo_width_filter(width)
    gain_str      = (f"volume={max(-12.0, min(12.0, output_gain_db)):.2f}dB"
                     if abs(output_gain_db) > 0.01 else "")

    if deesser_str:
        applied.append("De-esser 6.5kHz −1.5dB")
    if saturation_str:
        applied.append(f"Harmonic saturation (강도 {sat:.2f})")
    if width_str:
        applied.append(f"Stereo width ×{width:.2f}")
    if gain_str:
        applied.append(f"Output gain {output_gain_db:+.1f} dB")

    parts = [p for p in (eq_chain, dyn_chain, deesser_str, saturation_str,
                         width_str, gain_str) if p]
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
    limiter_strength: str = "medium",
    saturation_amount: float | None = None,
    stereo_width: float | None = None,
    output_gain_db: float = 0.0,
    # Optional pre-measured loudness from the Node-side analyze step.
    # When provided, the pipeline skips its own raw loudnorm pass1
    # (saves ~20% of master time).
    pre_loudness: dict[str, float] | None = None,
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
        saturation_amount=saturation_amount,
        stereo_width=stereo_width,
        output_gain_db=output_gain_db,
    )

    # Add soft clipper just before loudnorm (only when limiter will engage hard)
    if limiter_strength in ("medium", "high") and style != "bright":
        sc = soft_clipper_filter(target_tp)
        if sc:
            pre_filter = f"{pre_filter},{sc}" if pre_filter else sc
            applied_corrections.append("Soft clipper (limiter 직전)")

    log("INFO", f"[pipeline] pre_filter: {pre_filter or '(none)'}")
    log("INFO", f"[pipeline] limiter strength: {limiter_strength}, "
                f"target LUFS: {target_lufs}, TP: {target_tp}")

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

    # Loudnorm 내부 TP 는 후단 brickwall limiter 에 0.5 dB 여유를 남겨둔다
    loudnorm_tp_internal = target_tp - 0.5

    # 매우 큰 LUFS 타깃 (예: -10, -9, -8) 은 linear 로는 도달 불가 → dynamic
    use_linear_loudnorm = target_lufs <= _LOUDNORM_DYNAMIC_THRESHOLD

    try:
        pass1 = loudnorm_pass1(
            input_path, target_lufs, loudnorm_tp_internal, lra, pre_filter
        )
    except FFmpegError as exc:
        log("ERROR", f"loudnorm pass1 failed: {exc}\nstderr:\n{exc.stderr}")
        raise

    # "Before" 라우드니스 통계.
    # 1) Node analyze 단계가 측정해서 pre_loudness 로 넘겨주면 그대로 사용 (가장 빠름).
    # 2) 없으면 원본에 대해 별도로 loudnorm pass1 을 한 번 더 돌린다 (느림).
    pass1_raw: dict[str, float] | None = None
    if pre_loudness is not None:
        pre_lufs = float(pre_loudness.get("integratedLufs", pre_loudness.get("input_i", -99.0)))
        pre_tp   = float(pre_loudness.get("truePeakDbtp",  pre_loudness.get("input_tp",   0.0)))
        pre_lra  = float(pre_loudness.get("lra",            pre_loudness.get("input_lra",  0.0)))
        log("INFO", "[pipeline] using pre-measured loudness from analyze step "
                    f"(saved one pass1 round-trip)")
    else:
        try:
            pass1_raw = loudnorm_pass1(input_path, target_lufs, loudnorm_tp_internal, lra)
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
            target_tp=loudnorm_tp_internal,
            lra=lra,
            sample_rate=sample_rate,
            bit_depth=bit_depth,
            pre_filter=pre_filter,
            linear=use_linear_loudnorm,
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

    lim_strength = LIMITER_STRENGTHS.get(limiter_strength, LIMITER_STRENGTHS["medium"])
    try:
        apply_limiter(
            tmp_wav,
            output_path,
            ceiling_dbfs=target_tp,
            attack_ms=lim_strength["attack_ms"],
            release_ms=lim_strength["release_ms"],
            sample_rate=sample_rate,
            bit_depth=bit_depth,
            level_in_db=lim_strength["input_gain_db"],
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

    # ── Correction pass (목표 LUFS / TP 미달 시 자동 보정) ──────────────
    correction_applied = False
    correction_gain_db = 0.0
    if post_lufs > -90.0:
        lufs_delta = target_lufs - post_lufs   # 양수 = 더 키워야 함
        tp_over    = post_tp - target_tp        # 양수 = TP 초과
        if abs(lufs_delta) > _LUFS_TOLERANCE or tp_over > _TP_GUARD_DB:
            correction_gain_db = max(-6.0, min(6.0, lufs_delta))
            log("INFO", f"[pipeline] correction pass: gain={correction_gain_db:+.2f} dB, "
                        f"tp_over={tp_over:+.2f} dB")
            progress(job_id, 84, f"보정 패스 적용 중 ({correction_gain_db:+.1f} dB)")

            corr_chain_parts = []
            if abs(correction_gain_db) > 0.05:
                corr_chain_parts.append(f"volume={correction_gain_db:.2f}dB")
            sc = soft_clipper_filter(target_tp)
            if sc:
                corr_chain_parts.append(sc)
            corr_chain = ",".join(corr_chain_parts) if corr_chain_parts else ""

            corr_fd, corr_tmp = tempfile.mkstemp(suffix="_corr.wav")
            os.close(corr_fd)
            try:
                # output_path 를 다시 ffmpeg 으로 통과시키며 보정
                #   volume (correction_gain_db) → soft clip → alimiter (TP ceiling)
                from app.utils.ffmpeg_wrapper import _run, _FFMPEG_BIN
                codec = "pcm_s16le" if bit_depth == 16 else "pcm_s24le"
                lim_ls = LIMITER_STRENGTHS.get(limiter_strength, LIMITER_STRENGTHS["medium"])
                lim_in_lin  = 10.0 ** (lim_ls["input_gain_db"] / 20.0)
                lim_out_lin = 10.0 ** (target_tp / 20.0)
                af = (
                    (corr_chain + "," if corr_chain else "")
                    + f"alimiter=level_in={lim_in_lin:.4f}:level_out=1:limit={lim_out_lin:.6f}"
                    + f":attack={lim_ls['attack_ms']}:release={lim_ls['release_ms']}:asc=1"
                )
                _run([
                    _FFMPEG_BIN, "-hide_banner", "-y",
                    "-i", output_path,
                    "-af", af,
                    "-ar", str(sample_rate),
                    "-acodec", codec,
                    corr_tmp,
                ])
                os.replace(corr_tmp, output_path)
                correction_applied = True
                applied_corrections.append(
                    f"보정 패스 ({correction_gain_db:+.2f} dB + soft clip + limiter)"
                )
                # 재측정
                try:
                    post_stats = measure_output(output_path, target_lufs, target_tp)
                    post_lufs  = post_stats["integratedLufs"]
                    post_tp    = post_stats["truePeakDbtp"]
                    post_lra   = post_stats["lra"]
                    log("INFO", f"[pipeline] post-correction: LUFS={post_lufs:.1f}, "
                                f"TP={post_tp:.1f}, LRA={post_lra:.1f}")
                except FFmpegError:
                    pass
            except Exception as exc:
                log("ERROR", f"correction pass failed: {exc}")
                pipeline_warnings.append({
                    "code": "CORRECTION_FAILED",
                    "level": "warning",
                    "userMessage": f"자동 보정 패스가 실패했습니다: {exc}",
                })
            finally:
                try:
                    if os.path.exists(corr_tmp):
                        os.unlink(corr_tmp)
                except OSError:
                    pass

    # ── Quality checks ────────────────────────────────────────────────────

    lufs_diff = abs(post_lufs - target_lufs)
    if lufs_diff > _LUFS_TOLERANCE:
        msg = (
            f"출력 라우드니스가 목표값과 {lufs_diff:.1f} LU 차이 납니다 "
            f"(목표 {target_lufs:.1f} LUFS, 결과 {post_lufs:.1f} LUFS). "
            f"원본이 매우 작거나 dynamic range 가 극단적일 때 발생할 수 있습니다."
        )
        pipeline_warnings.append({"code": "LUFS_DEVIATION", "level": "warning", "userMessage": msg})
        log("WARN", msg)

    if post_tp - target_tp > _TP_GUARD_DB:
        msg = (
            f"출력 트루 피크가 {post_tp:.1f} dBTP 로 한계({target_tp:.1f} dBTP)를 초과합니다. "
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
    loudnorm_gain = round(target_lufs - pre_lufs, 1)

    post_spectral = None
    if post_waveform and hasattr(post_waveform, "low_to_mid_db"):
        post_spectral = {
            "lowToMidDb":  round(post_waveform.low_to_mid_db, 1),
            "highToMidDb": round(post_waveform.high_to_mid_db, 1),
        }

    # 적용된 게인(원본 → 출력 LUFS 차이) 및 리미터 압축량 추정
    applied_gain_db = round(post_lufs - pre_lufs, 2) if pre_lufs > -90 else 0.0
    pre_push_db = (
        LIMITER_STRENGTHS.get(limiter_strength, LIMITER_STRENGTHS["medium"])["input_gain_db"]
        + (correction_gain_db if correction_applied else 0.0)
    )
    limiter_reduction_db = round(max(0.0, pre_push_db - max(0.0, applied_gain_db)), 2)
    target_reached = (
        abs(post_lufs - target_lufs) <= _LUFS_TOLERANCE
        and (post_tp - target_tp) <= _TP_GUARD_DB
    )

    analysis_report = {
        # Mastering meta (v3) — UI report panel 에서 사용
        "mastering": {
            "mode":                 style,
            "targetLufs":           target_lufs,
            "targetTruePeak":       target_tp,
            "limiterStrength":      limiter_strength,
            "appliedGainDb":        applied_gain_db,
            "limiterReductionDb":   limiter_reduction_db,
            "correctionApplied":    correction_applied,
            "correctionGainDb":     round(correction_gain_db, 2) if correction_applied else 0.0,
            "useLinearLoudnorm":    use_linear_loudnorm,
            "targetReached":        target_reached,
        },

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
