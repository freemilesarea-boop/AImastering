#!/usr/bin/env python3
"""
Python 오디오 처리 엔진 진입점 — ⚠️ LEGACY (v3.1 이하)

이 모듈은 v3.2 부터 deprecated 입니다.
신규 활성 엔진: `aimaster-desktop/services/python-audio/app/main.py`
참조 가이드:    `/python/LEGACY.md`

프로토콜:
  입력 (stdin): {"id": "uuid", "method": "...", "params": {...}}\n
  출력 (stdout): {"id": "uuid", "result": {...}}\n
               또는 {"id": "uuid", "error": "message"}\n
  진행률 (stdout): {"type": "progress", "jobId": "...", "percent": 50, "stage": "..."}\n
  준비 신호 (stderr): READY
"""
import sys
import os
import json
import traceback
from typing import Dict, Any

# v3.2 — legacy 진입점 사용 시 stderr 로 경고.
# AIM_SUPPRESS_LEGACY_WARNING=1 로 비활성화 가능.
if os.environ.get("AIM_SUPPRESS_LEGACY_WARNING") != "1":
    sys.stderr.write(
        "[DEPRECATED] python/main.py 는 LEGACY 엔진입니다. "
        "활성 엔진 (aimaster-desktop/services/python-audio/) 사용을 권장합니다. "
        "참조: python/LEGACY.md\n"
    )
    sys.stderr.flush()

# 패키지 경로 설정
script_dir = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(script_dir))

from python.pipeline.analyzer import analyze_file
from python.pipeline.mastering import run_mastering
from python.analysis.qc_checker import run_qc
from python.utils.logger import get_logger

logger = get_logger('main')

# stdout 버퍼링 비활성화 (라인별 즉시 출력)
sys.stdout.reconfigure(line_buffering=True)  # type: ignore


def send_result(request_id: str, result: Any) -> None:
    """JSON-RPC 성공 응답 전송"""
    msg = json.dumps({'id': request_id, 'result': result}, ensure_ascii=False)
    print(msg, flush=True)


def send_error(request_id: str, error: str) -> None:
    """JSON-RPC 에러 응답 전송"""
    msg = json.dumps({'id': request_id, 'error': error}, ensure_ascii=False)
    print(msg, flush=True)


def send_progress(job_id: str, percent: int, stage: str) -> None:
    """진행률 이벤트 전송"""
    msg = json.dumps({
        'type': 'progress',
        'jobId': job_id,
        'percent': percent,
        'stage': stage,
    }, ensure_ascii=False)
    print(msg, flush=True)


def handle_analyze(params: Dict[str, Any]) -> Any:
    """audio:analyze 처리"""
    file_path    = params['filePath']
    ffmpeg_path  = params.get('ffmpegPath',  'ffmpeg')
    ffprobe_path = params.get('ffprobePath', 'ffprobe')
    return analyze_file(file_path, ffmpeg_path, ffprobe_path)


def handle_master(params: Dict[str, Any]) -> Any:
    """audio:master 처리"""
    job_id       = params['jobId']
    input_path   = params['inputPath']
    options      = params.get('options', {})
    ffmpeg_path  = params.get('ffmpegPath',  'ffmpeg')
    ffprobe_path = params.get('ffprobePath', 'ffprobe')
    temp_dir     = params.get('tempDir',     '/tmp')

    # 출력 경로
    output_path = options.get('outputPath')
    if not output_path:
        raise ValueError("outputPath가 필요합니다")

    # 진행률 콜백
    def on_progress(jid: str, pct: int, stage: str):
        send_progress(jid, pct, stage)

    return run_mastering(
        job_id=job_id,
        input_path=input_path,
        output_path=output_path,
        options=options,
        ffmpeg_path=ffmpeg_path,
        ffprobe_path=ffprobe_path,
        temp_dir=temp_dir,
        on_progress=on_progress,
    )


def handle_qc_check(params: Dict[str, Any]) -> Any:
    """audio:qc 처리"""
    file_path   = params['filePath']
    ffmpeg_path = params.get('ffmpegPath', 'ffmpeg')
    return run_qc(file_path, ffmpeg_path)


# ─────────────────────────────────────────
# 메서드 라우터
# ─────────────────────────────────────────
HANDLERS = {
    'analyze':   handle_analyze,
    'master':    handle_master,
    'qc_check':  handle_qc_check,
}


def main():
    """메인 이벤트 루프: stdin 한 줄 = 요청 한 개"""

    # 준비 신호 (Node.js가 이 문자열을 보고 ready로 판단)
    print('READY', file=sys.stderr, flush=True)
    logger.info('Python audio engine started and ready')

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        request_id = None
        try:
            request = json.loads(line)
            request_id = request.get('id', 'unknown')
            method     = request.get('method', '')
            params     = request.get('params', {})

            logger.info(f"Request [{request_id}]: {method}")

            handler = HANDLERS.get(method)
            if not handler:
                send_error(request_id, f"Unknown method: {method}")
                continue

            result = handler(params)
            send_result(request_id, result)

        except Exception as e:
            err_msg = f"{type(e).__name__}: {str(e)}"
            logger.error(f"Error handling request [{request_id}]: {err_msg}")
            logger.debug(traceback.format_exc())
            send_error(request_id or 'unknown', err_msg)

    logger.info('Python engine stdin closed, shutting down')


if __name__ == '__main__':
    main()
