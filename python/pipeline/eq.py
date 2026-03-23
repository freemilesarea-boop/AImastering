"""
EQ 필터 구성 모듈
FFmpeg equalizer/highpass/lowshelf/highshelf 필터 체인 생성
"""
from typing import Optional, Dict, Any
from ..utils.logger import get_logger

logger = get_logger(__name__)

# 기본 EQ 설정 (YouTube Music 프로필)
DEFAULT_EQ = {
    'highpassFreq':  30,      # 30Hz 이하 차단 (DC, 초저역 제거)
    'lowShelfFreq':  100,     # 100Hz 로우 쉘프
    'lowShelfGain':  0.5,     # +0.5dB 저역 약간 보강
    'midFreq':       2500,    # 중역 투명도
    'midGain':       0.0,     # 중역 변화 없음 (기본)
    'midQ':          0.7,
    'highShelfFreq': 8000,    # 8kHz 하이 쉘프
    'highShelfGain': 1.0,     # +1.0dB 고역 공기감
    'airFreq':       12000,   # 12kHz 공기감 EQ
    'airGain':       1.5,     # +1.5dB
}


def build_eq_filter(settings: Optional[Dict[str, Any]] = None) -> str:
    """
    FFmpeg 오디오 필터 문자열 생성
    예: "highpass=f=30,equalizer=f=100:t=h:g=0.5,..."

    Args:
        settings: EQ 파라미터 딕셔너리 (None이면 기본값 사용)

    Returns:
        FFmpeg -af 필터 문자열
    """
    s = {**DEFAULT_EQ, **(settings or {})}
    filters = []

    # 1. High-pass filter (DC 및 초저역 제거)
    if s['highpassFreq'] > 0:
        filters.append(f"highpass=f={s['highpassFreq']}:poles=2")

    # 2. Low shelf (저역 보강/감쇄)
    if s['lowShelfGain'] != 0:
        filters.append(
            f"equalizer=f={s['lowShelfFreq']}:t=h:g={s['lowShelfGain']}:w={s['lowShelfFreq'] * 0.7}"
        )

    # 3. Mid EQ (투명도)
    if s['midGain'] != 0:
        filters.append(
            f"equalizer=f={s['midFreq']}:t=q:g={s['midGain']}:w={s['midQ']}"
        )

    # 4. High shelf (고역 공기감)
    if s['highShelfGain'] != 0:
        filters.append(
            f"equalizer=f={s['highShelfFreq']}:t=h:g={s['highShelfGain']}:w={s['highShelfFreq'] * 0.5}"
        )

    # 5. Air EQ (12kHz+ 공기감)
    if s['airGain'] != 0:
        filters.append(
            f"equalizer=f={s['airFreq']}:t=h:g={s['airGain']}:w={s['airFreq'] * 0.8}"
        )

    result = ','.join(filters)
    logger.debug(f"EQ filter chain: {result}")
    return result
