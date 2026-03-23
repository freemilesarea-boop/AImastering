"""
마스터링 파이프라인 메인 모듈

출력:
  - Master WAV (유료 라이센스)
  - Preview MP3 320kbps (무료 체험 포함 전체 제공)
  - 분석 리포트 JSON

처리 단계:
  1. Pre-analysis (AI 특화 감지 포함)
  2. FFmpeg loudnorm 2-pass (스타일 EQ 필터 포함)
  3. Post-analysis
  4. Preview MP3 생성
"""
import os
import time
import json
from typing import Dict, Any, Optional, Callable
from .analyzer import analyze_file
from .eq import build_eq_filter, STYLE_PRESETS
from ..utils.ffmpeg_wrapper import loudnorm_pass1, loudnorm_pass2, run_command
from ..utils.logger import get_logger

logger = get_logger(__name__)

ProgressCallback = Callable[[str, int, str], None]


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

    Returns:
        MasteringResult {
            success, outputPath, previewPath,
            jobId, inputAnalysis, outputAnalysis,
            processedAt, processingTimeMs,
            aiCorrectionsApplied
        }
    """
    def progress(pct: int, stage: str):
        logger.info(f"[{job_id}] {pct}% — {stage}")
        if on_progress:
            on_progress(job_id, pct, stage)

    start_time = time.time()

    # 옵션 파싱
    style        = str(options.get("style",             "balanced"))
    target_lufs  = float(options.get("targetLUFS",      -14.0))
    target_tp    = float(options.get("targetTruePeak",   -1.0))
    target_lra   = float(options.get("targetLRA",        11.0))
    enable_eq    = bool(options.get("enableEQ",          True))
    enable_comp  = bool(options.get("enableCompression", True))
    output_fmt   = str(options.get("outputFormat",       "wav"))
    bit_depth    = int(options.get("outputBitDepth",     24))
    sample_rate  = int(options.get("outputSampleRate",   44100))

    # 미지원 스타일 폴백
    if style not in STYLE_PRESETS:
        logger.warning(f"Unknown style '{style}', falling back to 'balanced'")
        style = "balanced"

    # ── 1. Pre-analysis ────────────────────────────────
    progress(5, "파일 분석 중...")
    input_analysis = analyze_file(input_path, ffmpeg_path, ffprobe_path)
    ai_det = input_analysis.get("aiDetection", {})

    # ── 2. AI 특화 자동 보정 플래그 결정 ──────────────
    ai_corrections = {
        "harsh_highmid": ai_det.get("harshHighmid", False),
        "boomy_low":     ai_det.get("boomyLow",     False),
    }
    applied_corrections = [k for k, v in ai_corrections.items() if v]
    if applied_corrections:
        logger.info(f"AI auto-corrections: {applied_corrections}")
        progress(10, f"AI 자동 보정 적용: {', '.join(applied_corrections)}")

    # ── 3. loudnorm Pass 1 ─────────────────────────────
    progress(20, "LUFS 측정 중 (Pass 1)...")
    measurements = loudnorm_pass1(
        input_path,
        target_lufs=target_lufs,
        target_lra=target_lra,
        target_tp=target_tp,
        ffmpeg_path=ffmpeg_path,
    )
    logger.info(f"Pass1: {measurements}")

    # ── 4. 필터 체인 구성 ─────────────────────────────
    progress(35, "EQ / 컴프레서 구성 중...")
    extra_filters = []

    if enable_eq:
        eq_filter = build_eq_filter(
            style=style,
            ai_corrections=ai_corrections if enable_eq else None,
        )
        if eq_filter:
            extra_filters.append(eq_filter)

    if enable_comp:
        # 스타일별 컴프레서 설정 차별화
        comp_params = _comp_params_for_style(style)
        extra_filters.append(
            f"acompressor=threshold={comp_params['threshold']}dB:"
            f"ratio={comp_params['ratio']}:attack={comp_params['attack']}:"
            f"release={comp_params['release']}:makeup={comp_params['makeup']}:"
            f"knee={comp_params['knee']}"
        )

    extra_filter_str = ",".join(extra_filters) if extra_filters else None

    # ── 5. loudnorm Pass 2 → Master WAV ───────────────
    progress(50, "라우드니스 정규화 중 (Pass 2)...")
    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)

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
        extra_filters=extra_filter_str,
    )
    progress(75, "마스터 파일 생성 완료")

    # ── 6. Preview MP3 생성 (항상 생성) ───────────────
    preview_path = _make_preview_path(output_path, temp_dir)
    progress(80, "Preview MP3 생성 중...")
    try:
        _export_preview_mp3(output_path, preview_path, ffmpeg_path)
    except Exception as exc:
        logger.warning(f"Preview MP3 generation failed: {exc}")
        preview_path = None

    # ── 7. Post-analysis ──────────────────────────────
    progress(90, "출력 파일 검증 중...")
    output_analysis = analyze_file(output_path, ffmpeg_path, ffprobe_path)

    processing_time_ms = int((time.time() - start_time) * 1000)
    progress(100, "완료!")

    result = {
        "success":              True,
        "outputPath":           output_path,
        "previewPath":          preview_path,
        "jobId":                job_id,
        "style":                style,
        "inputAnalysis":        input_analysis,
        "outputAnalysis":       output_analysis,
        "processedAt":          _now_iso(),
        "processingTimeMs":     processing_time_ms,
        "aiCorrectionsApplied": applied_corrections,
    }

    logger.info(
        f"Mastering complete: {job_id} | style={style} | "
        f"LUFS {input_analysis['lufsIntegrated']:.1f}→{output_analysis['lufsIntegrated']:.1f} | "
        f"TP={output_analysis['truePeak']:.1f} | {processing_time_ms}ms"
    )
    return result


# ─────────────────────────────────────────────────────
# 헬퍼
# ─────────────────────────────────────────────────────

def _comp_params_for_style(style: str) -> Dict[str, Any]:
    """스타일별 컴프레서 파라미터"""
    params = {
        "balanced": {"threshold": -18, "ratio": 2.0, "attack": 20, "release": 200, "makeup": 1, "knee": 3},
        "warm":     {"threshold": -20, "ratio": 2.5, "attack": 30, "release": 250, "makeup": 1, "knee": 4},
        "bright":   {"threshold": -16, "ratio": 1.8, "attack": 15, "release": 150, "makeup": 1, "knee": 2},
        "punch":    {"threshold": -14, "ratio": 3.0, "attack": 10, "release": 120, "makeup": 2, "knee": 2},
    }
    return params.get(style, params["balanced"])


def _make_preview_path(master_path: str, temp_dir: str) -> str:
    """Preview MP3 출력 경로 결정"""
    base = os.path.splitext(os.path.basename(master_path))[0]
    preview_dir = os.path.dirname(master_path)   # Master와 같은 폴더
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
