"""
마스터링 파이프라인 메인 모듈 (v3)

출력:
  - Master WAV (유료 라이센스)
  - Preview MP3 320kbps (무료 체험 포함 전체 제공)
  - 분석 리포트 JSON

처리 단계:
  1. Pre-analysis (AI 특화 감지 포함)
  2. AI 자동 보정 플래그 결정
  3. loudnorm pass1 (라우드니스 측정)
  4. master chain 구성 (EQ → comp → saturation → widening → soft clip → limiter)
  5. loudnorm pass2 + master chain → Master 출력
  6. Post-analysis
  7. 목표 미달 시 보정 pass (gain + soft clip + limiter)
  8. Final analysis
  9. Preview MP3 생성
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
from ..utils.ffmpeg_wrapper import (
    loudnorm_pass1,
    loudnorm_pass2,
    run_command,
)
from ..utils.logger import get_logger

logger = get_logger(__name__)

ProgressCallback = Callable[[str, int, str], None]

# 마스터링 결과 허용 오차
LUFS_TOLERANCE = 0.5            # ±0.5 LU
TP_GUARD_DB    = 0.0            # 0.0 = ceiling 정확히 준수, +값은 여유

# Loud 모드용 LUFS 임계값 — 이 이하 (절대값으로 큰) 타깃은 linear=false 모드 사용
LOUDNESS_LINEAR_THRESHOLD = -12.0


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

    enable_eq    = bool(options.get("enableEQ",          True))
    enable_comp  = bool(options.get("enableCompression", True))
    output_fmt   = str(options.get("outputFormat",       "wav"))
    bit_depth    = int(options.get("outputBitDepth",     24))
    sample_rate  = int(options.get("outputSampleRate",   44100))

    # ── 1. Pre-analysis ────────────────────────────────
    progress(5, "파일 분석 중...")
    input_analysis = analyze_file(input_path, ffmpeg_path, ffprobe_path)
    ai_det = input_analysis.get("aiDetection", {})

    ai_corrections = {
        "harsh_highmid": ai_det.get("harshHighmid", False),
        "boomy_low":     ai_det.get("boomyLow",     False),
    }
    applied_corrections = [k for k, v in ai_corrections.items() if v]
    if applied_corrections:
        logger.info(f"AI auto-corrections: {applied_corrections}")
        progress(10, f"AI 자동 보정: {', '.join(applied_corrections)}")

    # 소스 LUFS 가 매우 낮을 경우 강한 모드는 도달 불가능할 수 있음 — 경고 큐
    src_lufs = float(input_analysis.get("lufsIntegrated", -23))
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

    # ── 2. loudnorm Pass 1 (측정) ─────────────────────
    progress(20, "LUFS 측정 중 (Pass 1)...")
    measurements = loudnorm_pass1(
        input_path,
        target_lufs=target_lufs,
        target_lra=target_lra,
        target_tp=target_tp,
        ffmpeg_path=ffmpeg_path,
    )
    logger.info(f"Pass1: {measurements}")

    # ── 3. Master chain 구성 ──────────────────────────
    progress(35, "마스터링 체인 구성 중...")
    chain = build_master_chain(
        mode=mode,
        target_true_peak=target_tp,
        limiter_strength=limiter_strength,
        saturation_amount=saturation_amount,
        stereo_width=stereo_width,
        output_gain_db=output_gain_db,
        enable_eq=enable_eq,
        enable_comp=enable_comp,
        ai_corrections=ai_corrections,
    )

    # ── 4. loudnorm Pass 2 (정규화 + 체인) → Master ────
    progress(50, "라우드니스 정규화 중 (Pass 2)...")
    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)

    # 매우 큰 타깃 LUFS (절대값이 작음, 예: -9, -8) 의 경우 linear 모드는 적절치 않음
    use_linear = target_lufs <= LOUDNESS_LINEAR_THRESHOLD

    loudnorm_pass2(
        input_path=input_path,
        output_path=output_path,
        measurements=measurements,
        target_lufs=target_lufs,
        target_lra=target_lra,
        target_tp=target_tp,
        output_format=output_fmt,
        bit_depth=bit_depth,
        sample_rate=sample_rate,
        ffmpeg_path=ffmpeg_path,
        extra_filters=chain,
        linear=use_linear,
    )
    progress(70, "마스터 출력 완료")

    # ── 5. Post-analysis ──────────────────────────────
    progress(78, "출력 검증 중...")
    output_analysis = analyze_file(output_path, ffmpeg_path, ffprobe_path)

    final_lufs   = float(output_analysis.get("lufsIntegrated", -23))
    final_tp     = float(output_analysis.get("truePeak", -99))
    lufs_delta   = target_lufs - final_lufs
    tp_over      = final_tp - target_tp

    correction_applied = False
    correction_gain    = 0.0

    # ── 6. 보정 pass (목표 미달 시) ──────────────────
    if abs(lufs_delta) > LUFS_TOLERANCE or tp_over > TP_GUARD_DB:
        logger.info(
            f"Correction needed: lufs_delta={lufs_delta:.2f}, tp_over={tp_over:.2f}"
        )
        progress(85, f"보정 적용 중 ({lufs_delta:+.1f} LU 조정)...")

        # gain 은 LUFS 차이를 그대로 적용. 단, 너무 큰 차이는 dynamic 손상 위험.
        correction_gain = max(-6.0, min(6.0, lufs_delta))
        correction_chain = get_correction_chain(
            gain_db=correction_gain,
            target_true_peak=target_tp,
            limiter_strength=limiter_strength,
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

            # 최종 재분석
            output_analysis = analyze_file(output_path, ffmpeg_path, ffprobe_path)
            final_lufs = float(output_analysis.get("lufsIntegrated", -23))
            final_tp   = float(output_analysis.get("truePeak", -99))
            lufs_delta = target_lufs - final_lufs
            tp_over    = final_tp - target_tp

            if abs(lufs_delta) > LUFS_TOLERANCE:
                warnings.append(
                    f"목표 LUFS 도달 한계: 목표 {target_lufs:.1f} / 결과 {final_lufs:.1f} "
                    f"(차이 {lufs_delta:+.1f} LU)"
                )
            if tp_over > TP_GUARD_DB:
                warnings.append(
                    f"True Peak 한계 초과: 한계 {target_tp:.1f} / 결과 {final_tp:.1f} dBTP"
                )
        except Exception as exc:
            logger.warning(f"Correction pass failed: {exc}")
            warnings.append(f"보정 단계 실패: {exc}")
            if os.path.exists(corrected_tmp):
                try: os.remove(corrected_tmp)
                except OSError: pass

    # ── 7. Limiter reduction estimate (계산) ─────────
    applied_gain_db = final_lufs - src_lufs
    # 리미터에 의한 압축 추정 = 입력 푸시 게인 - 실제 LUFS 변화
    pre_push_db = (
        LIMITER_STRENGTHS.get(limiter_strength, LIMITER_STRENGTHS["medium"])["input_gain_db"]
        + (correction_gain if correction_applied else 0.0)
    )
    limiter_reduction_db = max(0.0, pre_push_db - max(0.0, applied_gain_db))

    # ── 8. Preview MP3 생성 ──────────────────────────
    preview_path = _make_preview_path(output_path, temp_dir)
    progress(92, "Preview MP3 생성 중...")
    try:
        _export_preview_mp3(output_path, preview_path, ffmpeg_path)
    except Exception as exc:
        logger.warning(f"Preview MP3 generation failed: {exc}")
        preview_path = None

    processing_time_ms = int((time.time() - start_time) * 1000)
    progress(100, "완료")

    # ── 9. 결과 빌드 ──────────────────────────────────
    target_reached = (
        abs(target_lufs - final_lufs) <= LUFS_TOLERANCE
        and (final_tp - target_tp) <= TP_GUARD_DB
    )

    report = {
        "mode":                  mode,
        "targetLUFS":            target_lufs,
        "targetTruePeak":        target_tp,
        "limiterStrength":       limiter_strength,
        "beforeLUFS":            src_lufs,
        "afterLUFS":             final_lufs,
        "beforeTruePeak":        float(input_analysis.get("truePeak", -99)),
        "afterTruePeak":         final_tp,
        "appliedGainDb":         round(applied_gain_db, 2),
        "limiterReductionDb":    round(limiter_reduction_db, 2),
        "correctionApplied":     correction_applied,
        "correctionGainDb":      round(correction_gain, 2) if correction_applied else 0.0,
        "lufsDelta":             round(lufs_delta, 2),
        "truePeakOverDb":        round(max(0.0, tp_over), 2),
        "targetReached":         target_reached,
        "warnings":              warnings,
        "useLinearLoudnorm":     use_linear,
    }

    result = {
        "success":              True,
        "outputPath":           output_path,
        "previewPath":          preview_path,
        "jobId":                job_id,
        "style":                mode,        # 레거시 호환 (UI 가 'style' 로 읽을 수 있도록)
        "mode":                 mode,
        "inputAnalysis":        input_analysis,
        "outputAnalysis":       output_analysis,
        "processedAt":          _now_iso(),
        "processingTimeMs":     processing_time_ms,
        "aiCorrectionsApplied": applied_corrections,
        "report":               report,
    }

    logger.info(
        f"Mastering complete: {job_id} | mode={mode} | "
        f"LUFS {src_lufs:.1f}→{final_lufs:.1f} (target {target_lufs:.1f}) | "
        f"TP={final_tp:.1f} (limit {target_tp:.1f}) | "
        f"correction={correction_applied} | {processing_time_ms}ms"
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
