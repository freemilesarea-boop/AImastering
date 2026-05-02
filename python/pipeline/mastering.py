"""
마스터링 파이프라인 메인 모듈 (v3.2 — Fully Static Chain)

출력:
  - Master WAV (유료 라이센스)
  - Preview MP3 320kbps (무료 체험 포함 전체 제공)
  - Before/After waveform PNG (선택, 실패해도 마스터링은 성공 처리)
  - 분석 리포트 JSON (전/후 metrics, quality check)

처리 단계:
  1. Pre-analysis (AI 특화 감지 포함)
  2. AI 자동 보정 플래그 결정
  3. loudnorm pass1 (라우드니스 측정 전용 — pass2 미사용)
  4. Loudness match gain 계산 (target_lufs - measured_i)
  5. Master chain 구성 (volume(match) → EQ → Dynamic EQ → comp → ...
                          → soft clip → limiter)
  6. Static chain 적용 (★ loudnorm 사용 안 함) → Master 출력
  7. Post-analysis
  8. 정적 보정 pass (필요 시 — volume + soft clipper, limiter 없음)
  9. Final analysis + before/after metrics + quality check
 10. Preview MP3 + waveform 이미지 생성 (실패 fallback 보장)
 11. Mastering report 작성

v3.2 핵심 변경
  · loudnorm pass2 완전 제거. loudnorm 은 pass1 측정 전용.
  · 최종 loudness 는 체인 시작부의 volume= 노드(정적 게인)로 매칭.
  · 시간 기반 게인 변화 0 — 모든 처리가 정적 transfer / 정적 게인.
  · short-term LUFS 변동의 외부 변동 요인 제거.
  · 보정 패스도 그대로 정적 (volume + soft clipper).

v3.1 에서 유지되는 변경
  · alimiter asc=0 (ASC 적응 동작 비활성)
  · correction pass 에 limiter envelope 없음
  · compressor / limiter release 시간 정렬
  · Dynamic EQ, waveform, before/after metrics, quality check 통합
"""
import os
import re
import time
from typing import Dict, Any, Optional, Callable, List
from .analyzer import analyze_file
from .master_chain import (
    build_master_chain,
    get_correction_chain,
    get_mode_defaults,
    LIMITER_STRENGTHS,
    MODE_DEFAULTS,
)
from .eq import STYLE_PRESETS
from .waveform import (
    generate_waveform_png,
    generate_waveform_dual_png,
    WaveformGenerationError,
)
from ..analysis.metrics import compute_metrics, build_metric_comparison
from ..analysis.quality_check import run_quality_check
from ..analysis.report import build_mastering_report
from ..analysis.isp_safety import apply_isp_safety
from ..utils.ffmpeg_wrapper import (
    loudnorm_pass1,
    apply_chain_static,
    detect_adynamicequalizer_support,
    run_command,
)
from ..utils.logger import get_logger

logger = get_logger(__name__)

ProgressCallback = Callable[[str, int, str], None]

# 마스터링 결과 허용 오차
LUFS_TOLERANCE = 0.5            # ±0.5 LU
TP_GUARD_DB    = 0.0            # 0.0 = ceiling 정확히 준수, +값은 여유


def run_mastering(
    job_id: str,
    input_path: str,
    output_path: str,
    options: Dict[str, Any],
    ffmpeg_path:  str = "ffmpeg",
    ffprobe_path: str = "ffprobe",
    temp_dir: str = "/tmp",
    on_progress: Optional[ProgressCallback] = None,
) -> Dict[str, Any]:
    """
    마스터링 파이프라인 전체 실행
    """
    def progress(pct: int, stage: str):
        logger.info(f"[{job_id}] {pct}% — {stage}")
        if on_progress:
            on_progress(job_id, pct, stage)

    start_time = time.time()
    warnings: List[str] = []
    stage_log: List[Dict[str, Any]] = []

    def _log_stage(name: str, ok: bool, detail: str = "") -> None:
        stage_log.append({"name": name, "ok": ok, "detail": detail})
        logger.info(f"[stage] {name} | {'OK' if ok else 'FAIL'} | {detail}")

    # ── 옵션 파싱 ─────────────────────────────────────
    # 'style' 은 v2 호환 키. v3 에서는 'mode' 사용.
    mode = str(options.get("mode") or options.get("style") or "balanced").lower()
    if mode not in STYLE_PRESETS:
        logger.warning(f"Unknown mode '{mode}', falling back to 'balanced'")
        warnings.append(f"알 수 없는 모드 '{mode}' — Balanced 로 대체")
        mode = "balanced"

    mode_def = get_mode_defaults(mode)

    target_lufs       = float(options.get("targetLUFS",      mode_def["targetLUFS"]))
    target_tp         = float(options.get("targetTruePeak",  mode_def["targetTruePeak"]))
    target_lra        = float(options.get("targetLRA",       11.0))
    limiter_strength  = str(options.get("limiterStrength",   mode_def["limiterStrength"])).lower()
    if limiter_strength not in LIMITER_STRENGTHS:
        warnings.append(f"알 수 없는 limiterStrength '{limiter_strength}' — 'medium' 으로 대체")
        limiter_strength = "medium"

    saturation_amount = options.get("saturationAmount")     # None 이면 모드 기본값
    stereo_width      = options.get("stereoWidth")          # None 이면 모드 기본값
    output_gain_db    = float(options.get("outputGainDb",    0.0))

    enable_eq          = bool(options.get("enableEQ",            True))
    enable_comp        = bool(options.get("enableCompression",   True))
    enable_dynamic_eq  = bool(options.get("enableDynamicEQ",     True))
    dynamic_eq_intensity = float(options.get("dynamicEQIntensity", 1.0))
    enable_waveform    = bool(options.get("enableWaveform",      True))
    output_fmt   = str(options.get("outputFormat",       "wav"))
    bit_depth    = int(options.get("outputBitDepth",     24))
    sample_rate  = int(options.get("outputSampleRate",   44100))

    # ffmpeg adynamicequalizer 지원 여부 (자동 감지, 실패 시 fallback)
    try:
        adyn_supported = detect_adynamicequalizer_support(ffmpeg_path)
    except Exception as exc:
        logger.warning(f"adynamicequalizer 감지 실패: {exc}")
        adyn_supported = False

    # ── 1. Pre-analysis ────────────────────────────────
    progress(5, "파일 분석 중...")
    try:
        input_analysis = analyze_file(input_path, ffmpeg_path, ffprobe_path)
        _log_stage("pre_analysis", True,
                   f"LUFS={input_analysis.get('lufsIntegrated')}, TP={input_analysis.get('truePeak')}")
    except Exception as exc:
        _log_stage("pre_analysis", False, str(exc))
        raise

    ai_det = input_analysis.get("aiDetection", {}) or {}
    ai_corrections = {
        "harsh_highmid": ai_det.get("harshHighmid", False),
        "boomy_low":     ai_det.get("boomyLow",     False),
    }
    applied_corrections = [k for k, v in ai_corrections.items() if v]
    if applied_corrections:
        logger.info(f"AI auto-corrections: {applied_corrections}")
        progress(10, f"AI 자동 보정: {', '.join(applied_corrections)}")

    # 소스 LUFS 가 매우 낮을 경우 강한 모드는 도달 불가능할 수 있음 — 경고 큐
    src_lufs = float(input_analysis.get("lufsIntegrated", -23) or -23)
    required_gain = target_lufs - src_lufs
    if required_gain > 14.0 and mode in ("loud", "kpop_loud"):
        warnings.append(
            f"원본이 매우 작습니다 ({src_lufs:.1f} LUFS). "
            f"목표 {target_lufs:.1f} LUFS 도달 시 dynamics 손상 가능."
        )
    if input_analysis.get("clippingDetected"):
        warnings.append(
            f"원본에 클리핑이 감지되었습니다 ({input_analysis.get('clippingSamples', 0)} 샘플). "
            f"마스터링 후에도 흔적이 남을 수 있습니다."
        )

    # ── 2. loudnorm Pass 1 (측정 전용) ────────────────
    # v3.2: loudnorm 은 입력 LUFS 측정용으로만 사용. pass2 는 호출하지 않는다.
    progress(20, "LUFS 측정 중 (Pass 1)...")
    try:
        measurements = loudnorm_pass1(
            input_path,
            target_lufs=target_lufs,
            target_lra=target_lra,
            target_tp=target_tp,
            ffmpeg_path=ffmpeg_path,
        )
        _log_stage("loudnorm_pass1", True, str(measurements))
    except Exception as exc:
        _log_stage("loudnorm_pass1", False, str(exc))
        raise
    logger.info(f"Pass1 (measurement-only): {measurements}")

    # ── 3. Loudness match 계산 ────────────────────────
    # 체인 맨 앞의 정적 volume 노드 게인 = 목표 LUFS - 측정 LUFS.
    # 이 값이 limiter 입력 푸시(level_in) 와 합쳐져 최종 라우드니스를 결정.
    import math as _math
    raw_measured = measurements.get("measured_i")
    try:
        measured_i_for_gain = float(raw_measured) if raw_measured is not None else float(src_lufs)
    except (TypeError, ValueError):
        measured_i_for_gain = float(src_lufs)
    # -inf / NaN / 너무 작은 무음 → -70 으로 cap (그 이상이면 측정 신뢰 부족)
    if not _math.isfinite(measured_i_for_gain) or measured_i_for_gain <= -70.0:
        measured_i_for_gain = -70.0
        warnings.append("입력이 거의 무음입니다 — loudness match 게인을 추정값으로 적용합니다.")
    raw_match_gain = target_lufs - measured_i_for_gain
    # 너무 작은 입력 + 매우 큰 타깃 조합에서 24dB 이상 푸시되는 경우 경고 후 클램프
    if raw_match_gain > 24.0:
        warnings.append(
            f"입력이 너무 작아 +{raw_match_gain:.1f} dB 푸시가 필요합니다. "
            f"+24 dB 로 제한합니다."
        )
    if raw_match_gain < -24.0:
        warnings.append(
            f"입력이 매우 커서 {raw_match_gain:.1f} dB 다운레벨이 필요합니다. "
            f"-24 dB 로 제한합니다."
        )
    entry_gain_db = max(-24.0, min(24.0, raw_match_gain))
    logger.info(
        f"Loudness match: measured={measured_i_for_gain:.2f} LUFS, "
        f"target={target_lufs:.2f}, entry_gain={entry_gain_db:+.2f} dB"
    )

    # ── 4. Master chain 구성 (정적) ──────────────────
    progress(35, "마스터링 체인 구성 중...")
    chain_info = build_master_chain(
        mode=mode,
        target_true_peak=target_tp,
        limiter_strength=limiter_strength,
        saturation_amount=saturation_amount,
        stereo_width=stereo_width,
        output_gain_db=output_gain_db,
        entry_gain_db=entry_gain_db,
        enable_eq=enable_eq,
        enable_comp=enable_comp,
        enable_dynamic_eq=enable_dynamic_eq,
        dynamic_eq_intensity=dynamic_eq_intensity,
        ffmpeg_supports_adynamic_eq=adyn_supported,
        ai_corrections=ai_corrections,
    )
    chain     = chain_info["chain"]
    stages    = list(chain_info["stages"])
    dyn_mode  = chain_info["dynamic_eq"]
    _log_stage("build_master_chain", True, f"entry={entry_gain_db:+.2f}dB stages={stages}")

    # ── 5. Static chain 적용 → Master ────────────────
    # ★ v3.2: loudnorm 사용 안 함. 완전한 정적 처리.
    progress(50, "정적 마스터 체인 적용 중...")
    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)

    try:
        apply_chain_static(
            input_path=input_path,
            output_path=output_path,
            af_chain=chain,
            output_format=output_fmt,
            bit_depth=bit_depth,
            sample_rate=sample_rate,
            ffmpeg_path=ffmpeg_path,
        )
        _log_stage("static_chain", True, f"entry_gain={entry_gain_db:+.2f}dB")
    except Exception as exc:
        _log_stage("static_chain", False, str(exc))
        raise

    progress(70, "마스터 출력 완료")

    # ── 5. Post-analysis ──────────────────────────────
    progress(78, "출력 검증 중...")
    try:
        output_analysis = analyze_file(output_path, ffmpeg_path, ffprobe_path)
        _log_stage("post_analysis", True,
                   f"LUFS={output_analysis.get('lufsIntegrated')}, TP={output_analysis.get('truePeak')}")
    except Exception as exc:
        _log_stage("post_analysis", False, str(exc))
        raise

    final_lufs   = float(output_analysis.get("lufsIntegrated", -23) or -23)
    final_tp     = float(output_analysis.get("truePeak", -99) or -99)
    lufs_delta   = target_lufs - final_lufs
    tp_over      = final_tp - target_tp

    correction_applied = False
    correction_gain    = 0.0

    # ── 6. 정적 보정 pass (목표 미달 시, 최대 2회 반복) ──
    # v3.2 — limiter envelope 없는 정적 보정.
    #         첫 패스 후에도 |Δ| > tolerance 이면 한 번 더 (cumulative gain 추적).
    MAX_CORRECTION_ITERATIONS = 2
    iteration = 0
    cumulative_correction_gain = 0.0
    while (abs(lufs_delta) > LUFS_TOLERANCE or tp_over > TP_GUARD_DB) \
            and iteration < MAX_CORRECTION_ITERATIONS:
        iteration += 1
        logger.info(
            f"Correction iter {iteration}: lufs_delta={lufs_delta:.2f}, tp_over={tp_over:.2f}"
        )
        progress(85 + iteration, f"보정 {iteration}회차 ({lufs_delta:+.1f} LU 조정)...")

        # gain 보정 한도: 한 번에 ±5dB. 누적 한도 ±8dB.
        step_gain = max(-5.0, min(5.0, lufs_delta))
        if abs(cumulative_correction_gain + step_gain) > 8.0:
            step_gain = 8.0 * (1 if step_gain > 0 else -1) - cumulative_correction_gain
        if abs(step_gain) < 0.05:
            break

        correction_chain = get_correction_chain(
            gain_db=step_gain,
            target_true_peak=target_tp,
        )

        corrected_tmp = _correction_tmp_path(output_path, temp_dir)
        try:
            _apply_filter_in_place(
                output_path,
                corrected_tmp,
                correction_chain,
                bit_depth=bit_depth,
                sample_rate=sample_rate,
                output_format=output_fmt,
                ffmpeg_path=ffmpeg_path,
            )
            os.replace(corrected_tmp, output_path)
            correction_applied = True
            cumulative_correction_gain += step_gain
            stages.append(f"Static Correction #{iteration} ({step_gain:+.1f} dB)")
            _log_stage(f"correction_pass_{iteration}", True, f"step_gain={step_gain:+.2f}")

            # 최종 재분석
            output_analysis = analyze_file(output_path, ffmpeg_path, ffprobe_path)
            final_lufs = float(output_analysis.get("lufsIntegrated", -23) or -23)
            final_tp   = float(output_analysis.get("truePeak", -99) or -99)
            lufs_delta = target_lufs - final_lufs
            tp_over    = final_tp - target_tp
        except Exception as exc:
            logger.warning(f"Correction pass {iteration} failed: {exc}")
            warnings.append(f"보정 단계 {iteration}회차 실패: {exc}")
            _log_stage(f"correction_pass_{iteration}", False, str(exc))
            if os.path.exists(corrected_tmp):
                try: os.remove(corrected_tmp)
                except OSError: pass
            break

    correction_gain = cumulative_correction_gain

    # ── 6.5 ISP safety post-processor ──────────────────
    # ffmpeg alimiter 는 oversampling 미지원이라 sample peak 가 ceiling 을 살짝 넘는
    # 경우가 있다. numpy 로 직접 측정해 정적 down-gain (envelope 없음).
    isp_correction_db = 0.0
    try:
        gain = apply_isp_safety(output_path, ceiling_db=target_tp, headroom_db=0.1)
        if gain is not None and abs(gain) > 0.01:
            isp_correction_db = gain
            stages.append(f"ISP Safety ({gain:+.2f} dB)")
            _log_stage("isp_safety", True, f"applied={gain:+.3f} dB")
            # 재분석
            output_analysis = analyze_file(output_path, ffmpeg_path, ffprobe_path)
            final_lufs = float(output_analysis.get("lufsIntegrated", -23) or -23)
            final_tp   = float(output_analysis.get("truePeak", -99) or -99)
            lufs_delta = target_lufs - final_lufs
            tp_over    = final_tp - target_tp
        else:
            _log_stage("isp_safety", True, "no action needed")
    except Exception as exc:
        logger.warning(f"ISP safety failed (무시): {exc}")
        _log_stage("isp_safety", False, str(exc))

    # 최종 도달 평가 + 경고
    if abs(lufs_delta) > LUFS_TOLERANCE:
        warnings.append(
            f"목표 LUFS 도달 한계: 목표 {target_lufs:.1f} / 결과 {final_lufs:.1f} "
            f"(차이 {lufs_delta:+.1f} LU, 보정 {iteration}회 시도)"
        )
    if tp_over > TP_GUARD_DB:
        warnings.append(
            f"True Peak 한계 초과: 한계 {target_tp:.1f} / 결과 {final_tp:.1f} dBTP"
        )

    # ── 7. Limiter reduction estimate (계산) ─────────
    # v3.2: 입력 매치 게인(entry_gain_db) + 리미터 input gain 푸시 합산이
    #       실제 적용 게인(applied_gain_db) 보다 큰 만큼이 limiter 가 깎은 양.
    applied_gain_db = final_lufs - src_lufs
    pre_push_db = (
        entry_gain_db
        + LIMITER_STRENGTHS.get(limiter_strength, LIMITER_STRENGTHS["medium"])["input_gain_db"]
        + (correction_gain if correction_applied else 0.0)
    )
    limiter_reduction_db = max(0.0, pre_push_db - max(0.0, applied_gain_db))

    # ── 8. Before/After metrics + quality check ──────
    progress(88, "분석 데이터 계산 중...")
    try:
        input_metrics  = compute_metrics(input_path,  input_analysis)
        output_metrics = compute_metrics(output_path, output_analysis)
        metric_comparison = build_metric_comparison(input_metrics, output_metrics, target_tp)
        _log_stage("metrics", True, f"in={input_metrics.get('rms')}/out={output_metrics.get('rms')}")
    except Exception as exc:
        logger.warning(f"Metrics computation failed: {exc}")
        input_metrics = output_metrics = {}
        metric_comparison = []
        _log_stage("metrics", False, str(exc))

    try:
        quality_check = run_quality_check(
            output_path=output_path,
            output_analysis=output_analysis,
            output_metrics=output_metrics,
            target_true_peak=target_tp,
            ffmpeg_path=ffmpeg_path,
        )
        _log_stage("quality_check", True,
                   f"overall={quality_check.get('overall')}, items={len(quality_check.get('items', []))}")
    except Exception as exc:
        logger.warning(f"Quality check failed: {exc}")
        quality_check = {
            "overall": "warning",
            "summary": f"품질 검사 실패: {exc}",
            "items":   [],
        }
        _log_stage("quality_check", False, str(exc))

    # ── 9. Preview MP3 + waveform 이미지 ─────────────
    preview_path = _make_preview_path(output_path, temp_dir)
    progress(92, "Preview MP3 생성 중...")
    try:
        _export_preview_mp3(output_path, preview_path, ffmpeg_path)
        _log_stage("preview_mp3", True, preview_path)
    except Exception as exc:
        logger.warning(f"Preview MP3 generation failed: {exc}")
        preview_path = None
        _log_stage("preview_mp3", False, str(exc))

    # waveform 이미지 (실패해도 마스터링 성공)
    before_wave_path = None
    after_wave_path  = None
    dual_wave_path   = None
    if enable_waveform:
        progress(95, "Waveform 이미지 생성 중...")
        before_wave_path = _wave_path(output_path, temp_dir, "_before")
        after_wave_path  = _wave_path(output_path, temp_dir, "_after")
        dual_wave_path   = _wave_path(output_path, temp_dir, "_compare")
        try:
            generate_waveform_png(input_path, before_wave_path, color="#9ca3af")
            _log_stage("waveform_before", True, before_wave_path)
        except WaveformGenerationError as exc:
            logger.warning(f"Before waveform 생성 실패 (무시): {exc}")
            before_wave_path = None
            _log_stage("waveform_before", False, str(exc))

        try:
            generate_waveform_png(output_path, after_wave_path, color="#a78bfa")
            _log_stage("waveform_after", True, after_wave_path)
        except WaveformGenerationError as exc:
            logger.warning(f"After waveform 생성 실패 (무시): {exc}")
            after_wave_path = None
            _log_stage("waveform_after", False, str(exc))

        if before_wave_path and after_wave_path:
            try:
                generate_waveform_dual_png(
                    input_path=input_path,
                    output_path_audio=output_path,
                    image_path=dual_wave_path,
                )
                _log_stage("waveform_dual", True, dual_wave_path)
            except WaveformGenerationError as exc:
                logger.warning(f"Dual waveform 생성 실패 (무시): {exc}")
                dual_wave_path = None
                _log_stage("waveform_dual", False, str(exc))
        else:
            dual_wave_path = None

    processing_time_ms = int((time.time() - start_time) * 1000)
    progress(100, "완료")

    # ── 10. 결과 빌드 ─────────────────────────────────
    target_reached = (
        abs(target_lufs - final_lufs) <= LUFS_TOLERANCE
        and (final_tp - target_tp) <= TP_GUARD_DB
    )

    report = build_mastering_report(
        mode=mode,
        target_lufs=target_lufs,
        target_tp=target_tp,
        target_lra=target_lra,
        limiter_strength=limiter_strength,
        before_lufs=src_lufs,
        after_lufs=final_lufs,
        before_tp=float(input_analysis.get("truePeak", -99) or -99),
        after_tp=final_tp,
        applied_gain_db=applied_gain_db,
        limiter_reduction_db=limiter_reduction_db,
        correction_applied=correction_applied,
        correction_gain_db=correction_gain,
        isp_correction_db=isp_correction_db,
        target_reached=target_reached,
        warnings=warnings,
        stages=stages,
        dynamic_eq_mode=dyn_mode,
        adynamic_eq_supported=adyn_supported,
        metric_comparison=metric_comparison,
        quality_check=quality_check,
        entry_gain_db=entry_gain_db,
        loudnorm_used=False,
    )

    result = {
        "success":              True,
        "outputPath":           output_path,
        "previewPath":          preview_path,
        "originalPath":         input_path,            # UI 비교 플레이어용
        "beforeWaveformPath":   before_wave_path,
        "afterWaveformPath":    after_wave_path,
        "compareWaveformPath":  dual_wave_path,
        "jobId":                job_id,
        "style":                mode,        # 레거시 호환
        "mode":                 mode,
        "inputAnalysis":        input_analysis,
        "outputAnalysis":       output_analysis,
        "inputMetrics":         input_metrics,
        "outputMetrics":        output_metrics,
        "metricComparison":     metric_comparison,
        "qualityCheck":         quality_check,
        "processingChain":      stages,
        "stageLog":             stage_log,
        "processedAt":          _now_iso(),
        "processingTimeMs":     processing_time_ms,
        "aiCorrectionsApplied": applied_corrections,
        "report":               report,
    }

    logger.info(
        f"Mastering complete: {job_id} | mode={mode} | "
        f"LUFS {src_lufs:.1f}→{final_lufs:.1f} (target {target_lufs:.1f}) | "
        f"TP={final_tp:.1f} (limit {target_tp:.1f}) | "
        f"correction={correction_applied} | dyn_eq={dyn_mode} | "
        f"qc={quality_check.get('overall')} | {processing_time_ms}ms"
    )
    return result


# ─────────────────────────────────────────────────────
# 헬퍼
# ─────────────────────────────────────────────────────

def _correction_tmp_path(output_path: str, temp_dir: str) -> str:
    """보정 단계 임시 파일 경로 (출력과 동일 확장자)"""
    base = os.path.splitext(os.path.basename(output_path))[0]
    ext  = os.path.splitext(output_path)[1] or ".wav"
    safe_base = re.sub(r"[^A-Za-z0-9가-힣_\-]+", "_", base)
    return os.path.join(temp_dir, f"{safe_base}_correction{ext}")


def _wave_path(master_path: str, temp_dir: str, suffix: str) -> str:
    """waveform PNG 출력 경로 (Windows/macOS 양쪽 안전)"""
    base = os.path.splitext(os.path.basename(master_path))[0]
    safe_base = re.sub(r"[^A-Za-z0-9가-힣_\-]+", "_", base)
    return os.path.join(temp_dir, f"{safe_base}{suffix}.png")


def _apply_filter_in_place(
    input_path: str,
    output_path: str,
    af_chain: str,
    bit_depth: int,
    sample_rate: int,
    output_format: str,
    ffmpeg_path: str,
) -> None:
    """필터 체인을 적용해 새 출력 파일을 생성 (원본과 동일 포맷)"""
    pcm_codec = {16: "pcm_s16le", 24: "pcm_s24le", 32: "pcm_s32le"}.get(bit_depth, "pcm_s24le")

    if output_format == "wav":
        codec_args = ["-c:a", pcm_codec]
    elif output_format == "flac":
        codec_args = ["-c:a", "flac"]
    elif output_format == "mp3":
        codec_args = ["-c:a", "libmp3lame", "-b:a", "320k"]
    else:
        codec_args = ["-c:a", pcm_codec]

    cmd = [
        ffmpeg_path,
        "-nostdin", "-y",
        "-i", input_path,
        "-af", af_chain,
        "-ar", str(sample_rate),
        *codec_args,
        output_path,
    ]
    code, _, stderr = run_command(cmd, timeout=300)
    if code != 0:
        raise RuntimeError(f"correction pass failed (code={code}):\n{stderr[-500:]}")


def _make_preview_path(master_path: str, temp_dir: str) -> str:
    """Preview MP3 출력 경로"""
    base = os.path.splitext(os.path.basename(master_path))[0]
    preview_dir = os.path.dirname(master_path)
    return os.path.join(preview_dir, f"{base}_preview.mp3")


def _export_preview_mp3(input_path: str, output_path: str, ffmpeg_path: str) -> None:
    """Preview MP3 320kbps 생성"""
    cmd = [
        ffmpeg_path,
        "-nostdin", "-y",
        "-i", input_path,
        "-c:a", "libmp3lame",
        "-b:a", "320k",
        "-id3v2_version", "3",
        output_path,
    ]
    code, _, stderr = run_command(cmd, timeout=120)
    if code != 0:
        raise RuntimeError(f"MP3 export failed: {stderr[-300:]}")
    logger.info(f"Preview MP3 saved: {output_path}")


def _now_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()
