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
    apply_filter_chain,
    measure_output,
    export_preview_mp3,
    parse_audio_stream,
    parse_bit_depth,
    extract_file_info,
    set_debug_recorder,
)
from app.utils.audio_io import analyze_waveform, waveform_stats_to_dict
from app.utils.isp_safety import apply_isp_safety
from app.utils.waveform_image import (
    generate_waveform_png,
    generate_waveform_dual_png,
    WaveformImageError,
)
from app.utils.debug_logger import DebugRecorder
from app.utils.env_info import is_debug_mode
from app.mastering.eq import build_eq_filter, build_eq_filter_with_report
from app.mastering.dynamics import build_dynamics_filter, describe_dynamics, get_comp_params, estimate_comp_gr
from app.mastering.dynamic_eq import build_dynamic_eq_chain
from app.mastering.effects import (
    saturation_filter,
    stereo_width_filter,
    soft_clipper_filter,
    deesser_filter,
    get_mode_defaults as get_effects_defaults,
)
from app.mastering.safe_modes import recommend_modes
from app.analysis.metrics import compute_metrics, build_metric_comparison
from app.analysis.segment_analysis import compute_segment_timeseries
from app.qc.quality_check import run_quality_check
from app.qc.limiter_check import run_limiter_check
from app.qc.gain_staging import build_gain_staging_report
from app.utils.logger import log

# ── Quality-check thresholds ──────────────────────────────────────────────────

_TARGET_LUFS      = -14.0   # streaming target
_TARGET_TP        = -1.0    # default limiter ceiling
_LUFS_TOLERANCE   = 0.5     # dB: tighter than before — correction pass kicks in if exceeded
_MIN_LRA          = 4.0     # LU
_TP_GUARD_DB      = 0.0     # dBTP: max acceptable overshoot before warning

# ── Limiter strength → input gain (dB) + attack/release ──────────────────────
# v3.3 — limiter is now a peak-safety device, not a loudness-pushing device.
# input_gain_db only adds *small* push to compensate for measurement error;
# loudness matching is done by the explicit volume= node BEFORE this stage.
# Values were previously {0.5, 2.0, 4.0} which combined with entry_gain (up to
# +24 dB) caused brickwalling on vocals.  See "급긴급 엔진 구조 개선" (v3.3).
LIMITER_STRENGTHS: dict[str, dict[str, float]] = {
    "low":    {"input_gain_db": 0.0, "attack_ms": 8.0, "release_ms": 200.0},
    "medium": {"input_gain_db": 0.5, "attack_ms": 5.0, "release_ms": 120.0},
    "high":   {"input_gain_db": 1.5, "attack_ms": 3.0, "release_ms":  60.0},
}

# 절대값이 작은 (= 큰 라우드니스) 타깃은 loudnorm linear 모드로 도달 불가 → dynamic 사용
_LOUDNORM_DYNAMIC_THRESHOLD = -12.0

# v3.2 — high-LUFS 모드 식별. dynamic loudnorm 의 short-term envelope 가 만드는
# 출렁임/펌핑을 막기 위해 정적 체인 (volume 노드 + alimiter) 으로 우회한다.
_STATIC_CHAIN_STYLES = {"loud", "kpop_loud"}
# v3.3 — 정적 체인 entry gain 한도.  과거 +24 dB 까지 허용했으나 그 결과
# 메인 멜로디 transient 가 limiter 에서 brickwall 되고 background 가
# 상대적으로 올라오는 문제 발생.  +6 dB 로 제한하고 부족분은 correction
# pass 가 단계적으로 채운다 (각 단계마다 safety limiter 가 더 부드럽게 작동).
_STATIC_ENTRY_GAIN_MAX = 6.0    # dB  (was 24.0)
_STATIC_ENTRY_GAIN_MIN = -12.0  # dB  (was -24.0)
# 정적 체인이 단일 패스로 도달 못한 양만큼 correction pass 가 메꾸므로
# 두 단계의 push 가 각자 더 적고 limiter GR 도 분산된다.


def _should_use_static_chain(target_lufs: float, style: str) -> bool:
    """
    high-LUFS 모드 (loud, kpop_loud) 또는 target_lufs > -12 → 정적 체인 사용.
    정적 체인은 loudnorm pass2 대신 단일 volume 노드로 라우드니스 매칭하므로
    dynamic loudnorm 의 시간 가변 게인이 만드는 short-term spread (= 출렁임)
    가 발생하지 않는다.
    """
    if style in _STATIC_CHAIN_STYLES:
        return True
    return target_lufs > _LOUDNORM_DYNAMIC_THRESHOLD


def _static_entry_gain_db(target_lufs: float, pre_lufs: float) -> tuple[float, str | None]:
    """
    정적 체인의 loudness match 게인 (target_lufs - pre_lufs) + clamp.
    한도 초과 시 correction pass 가 잡아주므로 push 부족은 자동 보정된다.
    Returns (gain_db, warning_message_or_None).
    """
    if pre_lufs is None or pre_lufs != pre_lufs or pre_lufs <= -90.0:
        return 0.0, "입력이 거의 무음입니다 — loudness match 게인을 적용할 수 없습니다."
    desired = target_lufs - pre_lufs
    clamped = max(_STATIC_ENTRY_GAIN_MIN, min(_STATIC_ENTRY_GAIN_MAX, desired))
    if abs(desired - clamped) > 0.01:
        return clamped, (f"입력이 너무 작아 {desired:+.1f} dB 푸시가 필요합니다. "
                         f"{clamped:+.1f} dB 로 제한합니다.")
    return clamped, None


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
    dynamic_eq_intensity: float = 1.0,
    safe_mode_overrides: dict[str, Any] | None = None,
) -> tuple[str, list[str], list[dict], dict]:
    """
    Combine Stage-3 EQ → Stage-3.5 Dynamic EQ → Stage-4 dynamics → Stage-4.5
    effects (deesser / saturation / stereo widening / output gain) into a
    single ffmpeg filter chain.  Loudnorm + brickwall limiter are added by
    the caller.

    Returns:
        (filter_string, applied_correction_strings, eq_move_dicts, dyn_eq_report)
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

    # Stage 3.5 — Dynamic EQ (모드 프리셋, ffmpeg adynamicequalizer 우선)
    dyn_eq_report = build_dynamic_eq_chain(style, intensity=dynamic_eq_intensity)

    # Vocal Safe Mode: drop bands whose centre frequency lies in the 2-6 kHz
    # vocal range so heavy cuts can't crush vocal presence.
    so = safe_mode_overrides or {}
    if so.get("vocal_band_protection"):
        kept_bands = []
        kept_parts = []
        for band, part in zip(dyn_eq_report.get("bands", []),
                              (dyn_eq_report.get("chain") or "").split(",")):
            f = float(band.get("freq", 0))
            if 2000.0 <= f <= 6000.0 and band.get("mode") == "cut":
                continue  # skip this cut
            kept_bands.append(band)
            if part:
                kept_parts.append(part)
        dyn_eq_report = {
            **dyn_eq_report,
            "bands": kept_bands,
            "chain": ",".join(kept_parts),
        }

    dyn_eq_chain = dyn_eq_report.get("chain", "")
    if dyn_eq_chain and dyn_eq_report.get("bands"):
        engine = dyn_eq_report.get("engine", "fallback")
        n_bands = len(dyn_eq_report.get("bands", []))
        applied.append(
            f"Dynamic EQ ({n_bands} 밴드, "
            f"{'동적' if engine == 'adynamicequalizer' else '정적 fallback'})"
        )

    # Stage 4 — Bus compression
    dyn_chain = build_dynamics_filter(style, input_peak_db)
    applied.append(describe_dynamics(style))

    # Stage 4.5 — effects
    defaults = get_effects_defaults(style)
    sat = saturation_amount if saturation_amount is not None else defaults["saturation"]
    width = stereo_width if stereo_width is not None else defaults["stereo_width"]
    use_deesser = bool(defaults.get("deesser", False))
    if so.get("deesser_disabled"):
        use_deesser = False

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

    parts = [p for p in (eq_chain, dyn_eq_chain, dyn_chain, deesser_str,
                         saturation_str, width_str, gain_str) if p]
    return ",".join(parts), applied, eq_moves, dyn_eq_report


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
    # v3.2 P3 — Dynamic EQ 강도 (0.0 ~ 2.0).  0 = 비활성, 1.0 = 모드 기본.
    dynamic_eq_intensity: float = 1.0,
    # v3.2 P2 — 출력 waveform PNG 생성 여부.  False 일 때는 path 키 누락.
    generate_waveforms: bool = True,
    # Optional pre-measured loudness from the Node-side analyze step.
    # When provided, the pipeline skips its own raw loudnorm pass1
    # (saves ~20% of master time).
    pre_loudness: dict[str, float] | None = None,
    # debug-quality system (v3.3): override settings produced by safe_modes
    # build_safe_mode_overrides().  When present, the pipeline clamps a
    # subset of parameters before running.
    safe_mode_overrides: dict[str, Any] | None = None,
    # Force-enable structured debug recorder (else env AIMASTER_DEBUG decides).
    debug_logging: bool | None = None,
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

    # ── v3.3 — gain-staging tracker.  Every dB the pipeline adds (compressor
    # makeup, entry gain, limiter input gain, correction gain, ISP gain) is
    # recorded here for the gain_staging QC + UI gain-staging panel.
    gain_stages: dict[str, float] = {
        "compressorMakeupDb":  0.0,
        "preGainDb":           0.0,
        "limiterInputGainDb":  0.0,
        "correctionGainDb":    0.0,
        "ispCorrectionDb":     0.0,
    }

    # ── Debug recorder (P0: input/env/ffmpeg/filter chain logging) ────────
    debug_enabled = bool(debug_logging) if debug_logging is not None else is_debug_mode()
    recorder = DebugRecorder(job_id=job_id, debug_mode=debug_enabled)
    set_debug_recorder(recorder)
    recorder.event("INFO", "pipeline started", style=style, debug=debug_enabled)
    recorder.set_mastering_settings({
        "style":            style,
        "targetLufs":       target_lufs,
        "targetTruePeak":   target_tp,
        "lra":              lra,
        "sampleRate":       sample_rate,
        "bitDepth":         bit_depth,
        "limiterStrength":  limiter_strength,
        "saturationAmount": saturation_amount,
        "stereoWidth":      stereo_width,
        "outputGainDb":     output_gain_db,
        "dynamicEqIntensity": dynamic_eq_intensity,
        "applyAiCorrections": apply_ai_corrections,
        "safeModeOverrides": safe_mode_overrides or {},
    })

    # ── Apply safe-mode overrides to local clamps ────────────────────────
    overrides = safe_mode_overrides or {}
    static_entry_gain_max = float(overrides.get("static_entry_gain_max", _STATIC_ENTRY_GAIN_MAX))
    correction_gain_clamp = float(overrides.get("correction_gain_clamp", 12.0))
    limiter_input_gain_clamp = (
        float(overrides["limiter_input_gain_clamp"])
        if "limiter_input_gain_clamp" in overrides else None
    )
    if overrides:
        recorder.event("INFO", "safe-mode overrides active",
                       modes=overrides.get("_appliedModes"),
                       limiterInputGainClamp=limiter_input_gain_clamp,
                       staticEntryGainMax=static_entry_gain_max,
                       correctionGainClamp=correction_gain_clamp)

    # ═══════════════════════════════════════════════════════════════════════
    # Stage 1 — Input validation + spectral analysis
    # ═══════════════════════════════════════════════════════════════════════
    progress(job_id, 5, "입력 파일 확인 중")
    log("INFO", f"[pipeline] stage1 — validating + spectral analysis: {input_path}")
    recorder.stage("stage1_input_validation", inputPath=input_path)

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

    # Rich input metadata for debug bundle (codec, bitrate, VBR/CBR, container)
    rich_input_info = extract_file_info(probe, input_path)
    recorder.set_input_info(rich_input_info)
    log("INFO", f"[pipeline] input: codec={rich_input_info['codec']} "
                f"sr={rich_input_info['sampleRate']} ch={rich_input_info['channels']} "
                f"bits={rich_input_info['bitDepth']} bitrate={rich_input_info['bitRateBps']} "
                f"vbr={rich_input_info['vbrCbr']} container={rich_input_info['containerFormat']}")

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
    pre_filter, applied_corrections, eq_moves, dyn_eq_report = _build_filter_chain(
        style, ai, apply_ai_corrections, input_peak_db,
        low_to_mid_db, high_to_mid_db,
        saturation_amount=saturation_amount,
        stereo_width=stereo_width,
        output_gain_db=output_gain_db,
        dynamic_eq_intensity=dynamic_eq_intensity,
        safe_mode_overrides=overrides,
    )

    # v3.3 — Soft clipper is now applied AFTER the loudness-match gain push
    # (in the static chain) so it actually rounds the post-push peaks before
    # the brickwall limiter sees them.  Previously it was inside pre_filter,
    # i.e. BEFORE entry_gain, which made it ineffective at high LUFS targets.
    soft_clip_filter_str = ""
    if limiter_strength in ("medium", "high") and style != "bright":
        soft_clip_filter_str = soft_clipper_filter(target_tp) or ""
        if soft_clip_filter_str:
            applied_corrections.append("Soft clipper (entry-gain → limiter 사이)")

    log("INFO", f"[pipeline] pre_filter: {pre_filter or '(none)'}")
    log("INFO", f"[pipeline] limiter strength: {limiter_strength}, "
                f"target LUFS: {target_lufs}, TP: {target_tp}")

    # Record compressor makeup gain (capped) into the gain-staging tracker
    _comp_params = get_comp_params(style)
    gain_stages["compressorMakeupDb"] = round(min(float(_comp_params.get("makeup", 0.0)), 1.0), 2)

    recorder.set_filter_chain(
        preFilter=pre_filter,
        softClip=soft_clip_filter_str,
        appliedCorrections=list(applied_corrections),
        eqMoves=list(eq_moves),
        dynamicEq=dyn_eq_report,
        limiterStrength=limiter_strength,
    )
    recorder.stage("stage3_filter_chain_built",
                   length=len(pre_filter), parts=len(applied_corrections))

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
    # Stage 5b/6 — Loudness 매칭 + Limiter
    # ═══════════════════════════════════════════════════════════════════════
    use_static_chain = _should_use_static_chain(target_lufs, style)
    static_entry_gain_db = 0.0  # populated below in static branch
    pre_lim_peak_db = 0.0
    pre_lim_lufs    = -99.0

    if use_static_chain:
        # ── 정적 체인: volume= 노드로 라우드니스 매칭 후 단일 ffmpeg pass ──
        # 흐름: pre_filter (EQ+comp+sat+width+softclip) → volume → alimiter → output
        # loudnorm pass2 의 dynamic gain envelope 가 만드는 short-term 출렁임 제거.
        progress(job_id, 45, "정적 체인 마스터링 중")
        log("INFO", "[pipeline] stage5/6 (static chain) — single ffmpeg pass")

        entry_gain, gain_warning = _static_entry_gain_db(target_lufs, pre_lufs)
        # Safe-mode tighter clamp on entry gain (low_limit / safe modes)
        if static_entry_gain_max < _STATIC_ENTRY_GAIN_MAX:
            clamped = max(-static_entry_gain_max, min(static_entry_gain_max, entry_gain))
            if abs(clamped - entry_gain) > 0.01:
                recorder.event("INFO", "entry gain clamped by safe mode",
                               original=entry_gain, clamped=clamped, max=static_entry_gain_max)
                entry_gain = clamped
        static_entry_gain_db = entry_gain
        if gain_warning:
            pipeline_warnings.append({
                "code": "STATIC_GAIN_CLAMPED",
                "level": "warning",
                "userMessage": gain_warning,
            })
            log("WARN", f"[pipeline] static chain: {gain_warning}")

        # 안전 마진을 위해 alimiter limit 을 ceiling - 0.3 dB 로 (ISP oversample 부재 보완)
        lim_strength = LIMITER_STRENGTHS.get(limiter_strength, LIMITER_STRENGTHS["medium"])
        # Safe-mode clamp on limiter input gain (low_limit / safe modes)
        lim_input_gain_db = lim_strength["input_gain_db"]
        if limiter_input_gain_clamp is not None and lim_input_gain_db > limiter_input_gain_clamp:
            recorder.event("INFO", "limiter input gain clamped by safe mode",
                           original=lim_input_gain_db, clamped=limiter_input_gain_clamp)
            lim_input_gain_db = float(limiter_input_gain_clamp)
        lim_in_lin  = 10.0 ** (lim_input_gain_db / 20.0)
        safe_ceiling = target_tp - 0.3
        lim_out_lin = 10.0 ** (safe_ceiling / 20.0)

        # v3.3 — corrected gain staging order:
        #   1. pre_filter   : EQ → Dynamic EQ → glue compressor → saturation → width
        #   2. entry_gain   : SINGLE static gain to match target LUFS (clamped ±6 dB)
        #   3. soft_clip    : gentle peak rounding for the new push (was upstream, ineffective)
        #   4. alimiter     : peak-safety only (level_in ≈ 1.0 — no extra push)
        chain_parts: list[str] = []
        if pre_filter:
            chain_parts.append(pre_filter)
        if abs(entry_gain) > 0.05:
            chain_parts.append(f"volume={entry_gain:.2f}dB")
        if soft_clip_filter_str:
            chain_parts.append(soft_clip_filter_str)
        chain_parts.append(
            f"alimiter=level_in={lim_in_lin:.4f}:level_out=1:limit={lim_out_lin:.6f}"
            f":attack={lim_strength['attack_ms']}:release={lim_strength['release_ms']}:asc=0"
        )
        static_chain_filter = ",".join(chain_parts)
        log("INFO", f"[pipeline] static chain filter: {static_chain_filter[:200]}…")
        gain_stages["preGainDb"]          = round(float(entry_gain), 2)
        gain_stages["limiterInputGainDb"] = round(float(lim_input_gain_db), 2)
        recorder.event(
            "INFO", "static chain composed",
            entryGainDb=round(entry_gain, 2),
            limiterInputGainDb=round(lim_input_gain_db, 2),
            ceilingDbtp=safe_ceiling,
        )

        try:
            apply_filter_chain(
                input_path,
                output_path,
                static_chain_filter,
                sample_rate=sample_rate,
                bit_depth=bit_depth,
            )
        except FFmpegError as exc:
            log("ERROR", f"static chain failed: {exc}\nstderr:\n{exc.stderr}")
            raise

        applied_corrections.append(
            f"정적 체인 (entry gain {entry_gain:+.2f} dB + limiter)"
        )
    else:
        # ── 기존 loudnorm 2-pass 흐름 (target_lufs ≤ -12 의 ‘natural / balanced /
        # bright / warm / punch’ 같은 streaming 타깃) ──
        progress(job_id, 45, "라우드니스 정규화 중 (2/2)")
        log("INFO", f"[pipeline] stage5b — loudnorm pass2 → intermediate WAV")

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

        progress(job_id, 65, "트루 피크 리미터 적용 중")
        log("INFO", f"[pipeline] stage6 — brickwall limiter → {output_path}")

        try:
            pre_lim_stats   = measure_output(tmp_wav, target_lufs, target_tp)
            pre_lim_peak_db = pre_lim_stats.get("truePeakDbtp", 0.0)
            pre_lim_lufs    = pre_lim_stats.get("integratedLufs", -99.0)
        except FFmpegError:
            pass

        lim_strength = LIMITER_STRENGTHS.get(limiter_strength, LIMITER_STRENGTHS["medium"])
        lim_input_gain_db = lim_strength["input_gain_db"]
        if limiter_input_gain_clamp is not None and lim_input_gain_db > limiter_input_gain_clamp:
            recorder.event("INFO", "limiter input gain clamped by safe mode",
                           original=lim_input_gain_db, clamped=limiter_input_gain_clamp)
            lim_input_gain_db = float(limiter_input_gain_clamp)
        gain_stages["limiterInputGainDb"] = round(float(lim_input_gain_db), 2)
        try:
            apply_limiter(
                tmp_wav,
                output_path,
                ceiling_dbfs=target_tp,
                attack_ms=lim_strength["attack_ms"],
                release_ms=lim_strength["release_ms"],
                sample_rate=sample_rate,
                bit_depth=bit_depth,
                level_in_db=lim_input_gain_db,
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
    isp_correction_db = 0.0  # populated below if ISP safety triggers

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
            # v3.2 R1: ±12 dB 까지 허용 — push 부족 / 과다 양방향 안전.
            # alimiter level_in=1.0 (보정 단계에서 추가 push 없음) 과 결합되어
            # 정확한 LUFS 도달을 보장.  Safe-mode 가 활성이면 clamp 더 좁힘.
            corr_clamp = float(correction_gain_clamp)
            correction_gain_db = max(-corr_clamp, min(corr_clamp, lufs_delta))
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

            # Output 와 같은 디렉토리에 임시 파일을 만든다 (Windows: os.replace 는
            # cross-volume 시 실패할 수 있으므로 같은 볼륨을 보장).
            output_dir = os.path.dirname(os.path.abspath(output_path)) or "."
            corr_fd, corr_tmp = tempfile.mkstemp(
                suffix="_corr.wav",
                prefix="aimaster_",
                dir=output_dir,
            )
            os.close(corr_fd)
            try:
                # 보정 패스의 alimiter 는 ceiling 가드 only.
                # v3.2 R1 fix: input gain (+4 dB high) 을 더하면 -4 dB 보정이
                # 상쇄되어 LUFS 가 target 에 도달하지 못한다.  이미 1차에서
                # limiter 가 적용된 신호이므로 보정 단계에는 input gain 불필요.
                lim_ls = LIMITER_STRENGTHS.get(limiter_strength, LIMITER_STRENGTHS["medium"])
                lim_out_lin = 10.0 ** (target_tp / 20.0)
                af = (
                    (corr_chain + "," if corr_chain else "")
                    + f"alimiter=level_in=1.0:level_out=1:limit={lim_out_lin:.6f}"
                    + f":attack={lim_ls['attack_ms']}:release={lim_ls['release_ms']}:asc=1"
                )
                apply_filter_chain(
                    output_path,
                    corr_tmp,
                    af,
                    sample_rate=sample_rate,
                    bit_depth=bit_depth,
                )
                os.replace(corr_tmp, output_path)
                correction_applied = True
                gain_stages["correctionGainDb"] = round(float(correction_gain_db), 2)
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

    # ── ISP safety (numpy 4× FFT oversample, static down-gain) ───────────
    # ffmpeg alimiter is not oversampled, so inter-sample peaks can overshoot
    # the ceiling even when sample peak is inside.  Apply a static gain
    # reduction (envelope-free) when ISP exceeds the ceiling.
    try:
        isp_gain = apply_isp_safety(output_path, ceiling_dbtp=target_tp, headroom_db=0.1)
        if isp_gain is not None and abs(isp_gain) > 0.01:
            isp_correction_db = isp_gain
            gain_stages["ispCorrectionDb"] = round(float(isp_gain), 3)
            applied_corrections.append(f"ISP safety ({isp_gain:+.2f} dB)")
            log("INFO", f"[pipeline] ISP safety applied: {isp_gain:+.2f} dB")
            # 재측정
            try:
                post_stats = measure_output(output_path, target_lufs, target_tp)
                post_lufs  = post_stats["integratedLufs"]
                post_tp    = post_stats["truePeakDbtp"]
                post_lra   = post_stats["lra"]
                log("INFO", f"[pipeline] post-ISP: LUFS={post_lufs:.1f}, "
                            f"TP={post_tp:.1f}, LRA={post_lra:.1f}")
            except FFmpegError:
                pass
    except Exception as exc:
        log("WARN", f"[pipeline] ISP safety skipped: {exc}")

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
    progress(job_id, 88, "프리뷰 MP3 생성 중")
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

    # ── v3.2 P2 — Waveform PNG 생성 (before / after / compare) ─────────────
    before_wave_path: str = ""
    after_wave_path:  str = ""
    compare_wave_path: str = ""
    if generate_waveforms:
        progress(job_id, 92, "waveform 이미지 생성 중")
        out_root = os.path.splitext(output_path)[0]
        before_wave_path  = f"{out_root}_before.png"
        after_wave_path   = f"{out_root}_after.png"
        compare_wave_path = f"{out_root}_compare.png"
        try:
            generate_waveform_png(input_path, before_wave_path)
        except WaveformImageError as exc:
            log("WARN", f"[pipeline] before waveform 실패: {exc}")
            before_wave_path = ""
            pipeline_warnings.append({
                "code": "WAVEFORM_BEFORE_FAILED", "level": "warning",
                "userMessage": "before waveform 이미지 생성에 실패했습니다. 마스터링 결과는 정상입니다.",
            })
        try:
            generate_waveform_png(output_path, after_wave_path)
        except WaveformImageError as exc:
            log("WARN", f"[pipeline] after waveform 실패: {exc}")
            after_wave_path = ""
            pipeline_warnings.append({
                "code": "WAVEFORM_AFTER_FAILED", "level": "warning",
                "userMessage": "after waveform 이미지 생성에 실패했습니다.",
            })
        if before_wave_path and after_wave_path:
            try:
                generate_waveform_dual_png(input_path, output_path, compare_wave_path)
            except WaveformImageError as exc:
                log("WARN", f"[pipeline] compare waveform 실패: {exc}")
                compare_wave_path = ""

    # ── v3.2 P2 — Metrics + before/after 비교 ──────────────────────────────
    progress(job_id, 95, "전/후 비교 metrics 계산 중")
    metric_comparison: list[dict] = []
    quality_check_report: dict | None = None
    output_metrics: dict = {}
    input_metrics:  dict = {}
    try:
        before_loudness = {
            "integratedLufs": pre_lufs,
            "truePeakDbtp":   pre_tp,
            "lra":            pre_lra,
        }
        after_loudness = {
            "integratedLufs": post_lufs,
            "truePeakDbtp":   post_tp,
            "lra":            post_lra,
        }
        input_metrics  = compute_metrics(input_path,  before_loudness)
        output_metrics = compute_metrics(output_path, after_loudness)
        metric_comparison = build_metric_comparison(
            input_metrics, output_metrics, target_true_peak=target_tp
        )
    except Exception as exc:
        log("WARN", f"[pipeline] metric_comparison 실패: {exc}")
        pipeline_warnings.append({
            "code": "METRICS_FAILED", "level": "warning",
            "userMessage": "전/후 비교 지표 계산에 실패했습니다. 기본 라우드니스 정보만 제공됩니다.",
        })

    # ── v3.2 P2 — Quality check (마스터링 결과 자동 검사) ──────────────────
    progress(job_id, 96, "품질 자동 검사 중")
    try:
        quality_check_report = run_quality_check(
            output_path,
            output_metrics,
            target_true_peak=target_tp,
            target_lufs=target_lufs,
            input_metrics=input_metrics,
        )
    except Exception as exc:
        log("WARN", f"[pipeline] quality_check 실패: {exc}")
        pipeline_warnings.append({
            "code": "QC_FAILED", "level": "warning",
            "userMessage": "품질 자동 검사에 실패했습니다.",
        })

    # ── v3.3 P1 — Limiter excess check ─────────────────────────────────────
    limiter_check_report: dict[str, Any] | None = None
    try:
        recorder.stage("limiter_check")
        limiter_check_report = run_limiter_check(
            output_path,
            target_lufs=target_lufs,
            target_tp=target_tp,
            input_metrics=input_metrics,
            output_metrics=output_metrics,
            isp_correction_db=isp_correction_db,
            limiter_strength=limiter_strength,
        )
        recorder.set_limiter_qc(limiter_check_report)
    except Exception as exc:
        log("WARN", f"[pipeline] limiter_check 실패: {exc}")
        pipeline_warnings.append({
            "code": "LIMITER_QC_FAILED", "level": "warning",
            "userMessage": "리미터 과다 검사에 실패했습니다.",
        })

    # ── v3.3 P2 — Time-series suspect segment detection ────────────────────
    segment_report: dict[str, Any] = {"windowSec": 0.5, "windows": [], "suspectSegments": [], "summary": None}
    try:
        recorder.stage("segment_analysis")
        segment_report = compute_segment_timeseries(
            output_path,
            window_sec=0.5,
            ceiling_dbtp=target_tp,
        )
        for seg in segment_report.get("suspectSegments", []):
            recorder.add_suspect_segment(**seg)
        # When debug mode is on, dump the per-window time series to disk so
        # the bundle includes it; it's too large to ship through JSON-RPC.
        if debug_enabled and segment_report.get("windows"):
            try:
                import json as _json
                import os as _os
                d = recorder._ensure_artifact_dir()  # noqa: SLF001 — internal helper
                with open(_os.path.join(d, "segment_timeseries.json"), "w",
                          encoding="utf-8") as f:
                    _json.dump(segment_report, f, ensure_ascii=False)
            except Exception as exc2:
                log("WARN", f"[pipeline] segment dump 실패: {exc2}")
    except Exception as exc:
        log("WARN", f"[pipeline] segment analysis 실패: {exc}")

    # ── v3.3 — gain-staging report (vocal/background band balance, crest/LRA) ──
    gain_staging_report: dict[str, Any] | None = None
    try:
        recorder.stage("gain_staging_report")
        gain_staging_report = build_gain_staging_report(
            input_metrics  = input_metrics,
            output_metrics = output_metrics,
            input_path     = input_path,
            output_path    = output_path,
            pipeline_stages = gain_stages,
        )
        # Promote vocal/background issues to pipeline_warnings so the UI
        # banner reflects the user-reported "main melody pressed / background
        # boosted" symptom directly.
        if gain_staging_report.get("verdict") in ("warn", "danger"):
            for issue in gain_staging_report.get("issues", []):
                pipeline_warnings.append({
                    "code":  "GAIN_STAGING_IMBALANCE",
                    "level": "warning" if gain_staging_report["verdict"] == "warn" else "error",
                    "userMessage": issue,
                })
    except Exception as exc:
        log("WARN", f"[pipeline] gain_staging report 실패: {exc}")

    # ── v3.3 P5 — Mode recommendations ─────────────────────────────────────
    try:
        mode_recs = recommend_modes(
            quality_check    = quality_check_report,
            limiter_check    = limiter_check_report,
            suspect_segments = segment_report.get("suspectSegments"),
            input_info       = rich_input_info,
        )
        # Fold gain-staging recommendations into the main rec list so users
        # see "Vocal Safe Mode 추천" when the band-balance check trips.
        gs_recs = (gain_staging_report or {}).get("recommendations") or []
        existing_modes = {r["mode"] for r in mode_recs}
        for r in gs_recs:
            if r in existing_modes:
                continue
            reason = {
                "vocal_safe": "보컬/메인 멜로디가 눌리고 배경 대역이 상대적으로 커졌습니다.",
                "low_limit":  "Limiter 가 transient 를 강하게 눌렀습니다 (crest factor 손실).",
                "safe":       "다이내믹 손실이 큽니다 (LRA 가 입력 대비 크게 줄었습니다).",
            }.get(r, f"{r} 모드 권장")
            mode_recs.append({
                "mode": r, "reason": reason, "severity": "warn",
                "evidence": ["gain_staging_report"],
            })
        for rec in mode_recs:
            recorder.add_recommendation(rec["mode"], rec["reason"], rec["severity"])
    except Exception as exc:
        log("WARN", f"[pipeline] mode recommendation 실패: {exc}")
        mode_recs = []

    # Capture before/after metrics into recorder for the debug bundle
    recorder.set_metrics(input_metrics, output_metrics)
    recorder.output_path = output_path

    # In debug mode, persist debug.json + dispose the recorder hook
    if debug_enabled:
        recorder.persist()
    set_debug_recorder(None)

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
            "ispCorrectionDb":      round(isp_correction_db, 3),
            "staticChain":          bool(use_static_chain),
            "useLinearLoudnorm":    bool(use_linear_loudnorm and not use_static_chain),
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

    result: dict[str, Any] = {
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

        # v3.2 P2 — before/after metric 비교 + 자동 품질 검사
        "metricComparison": metric_comparison,
        "qualityCheck":     quality_check_report,

        # v3.3 — debug-quality system
        "limiterCheck":     limiter_check_report,
        "suspectSegments":  segment_report.get("suspectSegments", []),
        "segmentAnalysis":  {
            "windowSec":  segment_report.get("windowSec"),
            "summary":    segment_report.get("summary"),
            "windowCount": len(segment_report.get("windows", [])),
        },
        "gainStaging":      gain_staging_report,
        "modeRecommendations": mode_recs,
        "debugSummary":     recorder.to_summary(),
        "inputFileInfo":    rich_input_info,

        # v3.2 P3 — Dynamic EQ 리포트 (적용 밴드, 엔진 종류)
        "dynamicEq": {
            "preset": dyn_eq_report.get("preset"),
            "engine": dyn_eq_report.get("engine"),
            "bands":  dyn_eq_report.get("bands", []),
        },

        # Warnings
        "pipelineWarnings": pipeline_warnings,

        # Timing
        "processingTimeSec": elapsed,
    }

    # v3.2 P2 — waveform PNG 경로 (생성 성공한 것만 포함)
    if before_wave_path:
        result["beforeWaveformPath"]  = before_wave_path
    if after_wave_path:
        result["afterWaveformPath"]   = after_wave_path
    if compare_wave_path:
        result["compareWaveformPath"] = compare_wave_path

    return result
