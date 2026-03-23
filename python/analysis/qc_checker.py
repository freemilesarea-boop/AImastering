"""
QC 검사 모듈
플랫폼별 라우드니스 기준 준수 여부 점검
"""
from typing import Dict, List, Any
from ..pipeline.analyzer import analyze_file
from ..utils.logger import get_logger

logger = get_logger(__name__)

# 플랫폼별 기준값
# ※ 이 값들은 마스터링 작업의 일반적인 권장 타깃입니다.
#   각 플랫폼의 정책은 변경될 수 있으므로 공식 문서를 참고하세요.
PLATFORM_SPECS = [
    {
        'platform':    'YouTube Music',
        'targetLUFS':  -14.0,
        'targetTP':    -1.0,
        'tolerance':    1.0,   # ±1.0 LUFS 허용
    },
    {
        'platform':    'Spotify',
        'targetLUFS':  -14.0,
        'targetTP':    -1.0,
        'tolerance':    1.0,
    },
    {
        'platform':    'Apple Music / iTunes',
        'targetLUFS':  -16.0,
        'targetTP':    -1.0,
        'tolerance':    2.0,   # Apple은 -16 ± 2 LUFS 범위를 권장
    },
    {
        'platform':    'Tidal',
        'targetLUFS':  -14.0,
        'targetTP':    -1.0,
        'tolerance':    1.0,
    },
    {
        'platform':    'Amazon Music HD',
        'targetLUFS':  -14.0,
        'targetTP':    -2.0,
        'tolerance':    1.5,
    },
]


def run_qc(
    file_path: str,
    ffmpeg_path: str = 'ffmpeg',
    ffprobe_path: str = 'ffprobe',
) -> Dict[str, Any]:
    """
    QC 검사 실행
    Returns: QCResult 형태의 딕셔너리
    """
    logger.info(f"Running QC: {file_path}")

    # 파일 분석
    analysis = analyze_file(file_path, ffmpeg_path, ffprobe_path)
    measured_lufs = analysis['lufsIntegrated']
    measured_tp   = analysis['truePeak']

    logger.info(f"QC measured: LUFS={measured_lufs:.1f} TP={measured_tp:.1f}")

    # 플랫폼별 검사
    platform_results = []
    for spec in PLATFORM_SPECS:
        issues = []
        lufs_diff = measured_lufs - spec['targetLUFS']
        tp_ok = measured_tp <= spec['targetTP']

        # LUFS 검사
        if abs(lufs_diff) > spec['tolerance']:
            direction = '높음' if lufs_diff > 0 else '낮음'
            issues.append(
                f"LUFS {direction}: {measured_lufs:.1f} (기준 {spec['targetLUFS']} ±{spec['tolerance']})"
            )

        # True Peak 검사
        if not tp_ok:
            issues.append(
                f"True Peak 초과: {measured_tp:.1f} dBTP (한계 {spec['targetTP']} dBTP)"
            )

        # 클리핑 검사
        if analysis.get('clippingDetected'):
            issues.append(f"디지털 클리핑 감지 ({analysis.get('clippingSamples', 0)}샘플)")

        platform_results.append({
            'platform':     spec['platform'],
            'targetLUFS':   spec['targetLUFS'],
            'targetTP':     spec['targetTP'],
            'measuredLUFS': measured_lufs,
            'measuredTP':   measured_tp,
            'passed':       len(issues) == 0,
            'issues':       issues,
        })

    all_passed = all(p['passed'] for p in platform_results)
    pass_count = sum(1 for p in platform_results if p['passed'])

    if all_passed:
        summary = f"모든 플랫폼 기준 충족 (LUFS: {measured_lufs:.1f}, TP: {measured_tp:.1f} dBTP)"
    else:
        failed = [p['platform'] for p in platform_results if not p['passed']]
        summary = f"{pass_count}/{len(platform_results)} 플랫폼 통과. 미충족: {', '.join(failed)}"

    return {
        'passed':    all_passed,
        'platforms': platform_results,
        'summary':   summary,
    }
