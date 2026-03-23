"""
마스터링 파이프라인 메인 모듈
단계:
  1. Pre-analysis
  2. FFmpeg loudnorm 2-pass (EQ 필터 체인 포함)
  3. Post-analysis
  4. QC 검증
"""
import os
import time
import json
from typing import Dict, Any, Optional, Callable
from .analyzer import analyze_file
from .eq import build_eq_filter
from ..utils.ffmpeg_wrapper import loudnorm_pass1, loudnorm_pass2
from ..utils.logger import get_logger

logger = get_logger(__name__)

# 진행률 콜백 타입: (jobId, percent, stage) → None
ProgressCallback = Callable[[str, int, str], None]


def run_mastering(
    job_id: str,
    input_path: str,
    output_path: str,
    options: Dict[str, Any],
    ffmpeg_path: str = 'ffmpeg',
    ffprobe_path: str = 'ffprobe',
    temp_dir: str = '/tmp',
    on_progress: Optional[ProgressCallback] = None,
) -> Dict[str, Any]:
    """
    마스터링 파이프라인 실행
    Returns: MasteringResult 형태의 딕셔너리
    """
    def progress(pct: int, stage: str):
        logger.info(f"[{job_id}] {pct}% - {stage}")
        if on_progress:
            on_progress(job_id, pct, stage)

    start_time = time.time()

    target_lufs  = float(options.get('targetLUFS',     -14.0))
    target_tp    = float(options.get('targetTruePeak',  -1.0))
    target_lra   = float(options.get('targetLRA',       11.0))
    enable_eq    = bool(options.get('enableEQ',          True))
    enable_comp  = bool(options.get('enableCompression', True))
    output_fmt   = str(options.get('outputFormat',      'wav'))
    bit_depth    = int(options.get('outputBitDepth',      24))
    sample_rate  = int(options.get('outputSampleRate', 44100))

    # ── 1. Pre-analysis ────────────────────────────
    progress(5, '사전 분석 중...')
    input_analysis = analyze_file(input_path, ffmpeg_path, ffprobe_path)

    # ── 2. loudnorm Pass 1 (측정) ─────────────────
    progress(20, 'LUFS 측정 중 (Pass 1)...')
    measurements = loudnorm_pass1(
        input_path,
        target_lufs=target_lufs,
        target_lra=target_lra,
        target_tp=target_tp,
        ffmpeg_path=ffmpeg_path,
    )
    logger.info(f"Pass1 measurements: {measurements}")

    # ── 3. EQ/압축 필터 체인 구성 ─────────────────
    progress(35, 'EQ/컴프레서 구성 중...')
    extra_filters = []

    if enable_eq:
        eq_filter = build_eq_filter(options.get('eqSettings'))
        extra_filters.append(eq_filter)
        logger.info(f"EQ filter: {eq_filter}")

    if enable_comp:
        # FFmpeg acompressor 필터 (글루 컴프레서)
        comp_filter = (
            "acompressor="
            "threshold=-18dB:ratio=2:attack=20:release=200:"
            "makeup=1:knee=3"
        )
        extra_filters.append(comp_filter)

    extra_filter_str = ','.join(extra_filters) if extra_filters else None

    # ── 4. loudnorm Pass 2 (처리 + 출력) ──────────
    progress(50, '라우드니스 정규화 중 (Pass 2)...')

    # 출력 디렉토리 생성
    os.makedirs(os.path.dirname(output_path), exist_ok=True) if os.path.dirname(output_path) else None

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
    progress(80, '출력 파일 생성 완료')

    # ── 5. Post-analysis ───────────────────────────
    progress(90, '출력 파일 검증 중...')
    output_analysis = analyze_file(output_path, ffmpeg_path, ffprobe_path)

    processing_time_ms = int((time.time() - start_time) * 1000)
    progress(100, '완료!')

    result = {
        'success':           True,
        'outputPath':        output_path,
        'jobId':             job_id,
        'inputAnalysis':     input_analysis,
        'outputAnalysis':    output_analysis,
        'processedAt':       _now_iso(),
        'processingTimeMs':  processing_time_ms,
    }

    logger.info(
        f"Mastering complete: {job_id} "
        f"LUFS: {input_analysis['lufsIntegrated']:.1f} → {output_analysis['lufsIntegrated']:.1f} "
        f"TP: {output_analysis['truePeak']:.1f} "
        f"time={processing_time_ms}ms"
    )
    return result


def _now_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()
