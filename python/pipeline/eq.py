"""
EQ 필터 구성 모듈
4가지 마스터링 스타일 프리셋 + AI 음원 특화 보정 필터 지원

스타일 프리셋:
  balanced  — 기본 추천. 과도한 색채 변화 없이 밸런스 중심
  warm      — 고역 자극 완화, 저중역 살짝 보강
  bright    — 선명도 강조, 존재감 보강
  punch     — 타격감/에너지 강조, 저역 정리 + 밀도 강화
"""
from typing import Optional, Dict, Any
from ..utils.logger import get_logger

logger = get_logger(__name__)

# ─────────────────────────────────────────────────────
# 스타일별 EQ 파라미터 정의
# ─────────────────────────────────────────────────────

STYLE_PRESETS: Dict[str, Dict[str, Any]] = {
    "balanced": {
        # 기본 추천: 최소 개입, 밸런스 중심
        "highpassFreq":   30,     # DC + 초저역 제거
        "lowShelfFreq":   80,
        "lowShelfGain":   0.5,    # 저역 살짝 보강
        "midFreq":        3000,
        "midGain":        0.0,    # 중역 무개입
        "midQ":           1.0,
        "presenceFreq":   5000,
        "presenceGain":   0.5,    # 존재감 미세 보강
        "highShelfFreq":  8000,
        "highShelfGain":  0.5,    # 고역 약간 보강
        "airFreq":        14000,
        "airGain":        1.0,    # 공기감
        "harshmidNotch":  False,  # AI 특화 harsh 감쇄 비활성
    },
    "warm": {
        # Warm: 고역 자극 완화, 저중역 보강 → AI 음원 특유의 고역 날카로움 완화
        "highpassFreq":   30,
        "lowShelfFreq":   120,
        "lowShelfGain":   1.5,    # 저역 보강
        "midFreq":        2500,
        "midGain":        -1.0,   # 상위 중역(harsh zone) 감쇄
        "midQ":           0.8,
        "presenceFreq":   5000,
        "presenceGain":   -0.5,   # 다소 따뜻하게
        "highShelfFreq":  8000,
        "highShelfGain":  -1.5,   # 고역 축소
        "airFreq":        12000,
        "airGain":        -1.0,   # 에어 감쇄
        "harshmidNotch":  True,   # AI 특화 harsh 감쇄 활성
    },
    "bright": {
        # Bright: 선명도 강조, 존재감 보강
        "highpassFreq":   40,
        "lowShelfFreq":   80,
        "lowShelfGain":   -0.5,   # 저역 미세 정리
        "midFreq":        3500,
        "midGain":        1.0,    # 중역 존재감
        "midQ":           1.2,
        "presenceFreq":   6000,
        "presenceGain":   2.0,    # 선명도 강조
        "highShelfFreq":  10000,
        "highShelfGain":  2.5,    # 고역 강조
        "airFreq":        14000,
        "airGain":        2.0,    # 공기감 강조
        "harshmidNotch":  False,
    },
    "punch": {
        # Punch: 타격감/에너지, 저역 밀도 강화
        "highpassFreq":   50,     # 초저역 더 단호하게 제거
        "lowShelfFreq":   100,
        "lowShelfGain":   2.0,    # 저역 강조
        "midFreq":        200,
        "midGain":        1.5,    # 상위 저역 에너지 보강
        "midQ":           0.6,
        "presenceFreq":   4000,
        "presenceGain":   1.5,    # 존재감 + 공격성
        "highShelfFreq":  8000,
        "highShelfGain":  1.0,
        "airFreq":        13000,
        "airGain":        1.0,
        "harshmidNotch":  False,
    },
}


def build_eq_filter(
    style: str = "balanced",
    custom_settings: Optional[Dict[str, Any]] = None,
    ai_corrections: Optional[Dict[str, bool]] = None,
) -> str:
    """
    FFmpeg 오디오 필터 문자열 생성

    Args:
        style:           프리셋 이름 (balanced/warm/bright/punch)
        custom_settings: 사용자 정의 파라미터 (프리셋 위에 덮어씀)
        ai_corrections:  AI 음원 특화 보정 플래그 딕셔너리

    Returns:
        FFmpeg -af 필터 체인 문자열
    """
    # 프리셋 파라미터 로드
    base = STYLE_PRESETS.get(style, STYLE_PRESETS["balanced"]).copy()
    if custom_settings:
        base.update(custom_settings)

    s = base
    ai = ai_corrections or {}
    filters = []

    # ── 1. High-pass (DC + 초저역 제거) ──────────────────
    if s["highpassFreq"] > 0:
        filters.append(f"highpass=f={s['highpassFreq']}:poles=2")

    # ── 2. AI 특화: boomy low-end 감지 시 저역 추가 정리 ──
    if ai.get("boomy_low"):
        logger.info("AI fix: boomy low-end detected — applying low-shelf cut")
        filters.append("equalizer=f=80:t=h:g=-2.0:w=60")   # 80Hz 근방 감쇄

    # ── 3. Low shelf ─────────────────────────────────────
    if s["lowShelfGain"] != 0:
        filters.append(
            f"equalizer=f={s['lowShelfFreq']}:t=h:g={s['lowShelfGain']}:w={int(s['lowShelfFreq'] * 0.7)}"
        )

    # ── 4. Mid EQ ─────────────────────────────────────────
    if s["midGain"] != 0:
        filters.append(
            f"equalizer=f={s['midFreq']}:t=q:g={s['midGain']}:w={s['midQ']}"
        )

    # ── 5. AI 특화: harsh high-mid 자동 노치 ──────────────
    #    3~5kHz 대역에 나타나는 AI 특유의 금속성 노이즈 감쇄
    if ai.get("harsh_highmid") or s.get("harshmidNotch"):
        logger.info("AI fix: harsh high-mid detected — applying notch")
        filters.append("equalizer=f=3800:t=q:g=-2.5:w=1.5")
        filters.append("equalizer=f=5200:t=q:g=-1.5:w=1.2")

    # ── 6. Presence ────────────────────────────────────────
    if s.get("presenceGain", 0) != 0:
        filters.append(
            f"equalizer=f={s['presenceFreq']}:t=q:g={s['presenceGain']}:w=1.0"
        )

    # ── 7. High shelf ──────────────────────────────────────
    if s["highShelfGain"] != 0:
        filters.append(
            f"equalizer=f={s['highShelfFreq']}:t=h:g={s['highShelfGain']}:w={int(s['highShelfFreq'] * 0.5)}"
        )

    # ── 8. Air EQ (12kHz+) ─────────────────────────────────
    if s["airGain"] != 0:
        filters.append(
            f"equalizer=f={s['airFreq']}:t=h:g={s['airGain']}:w={int(s['airFreq'] * 0.8)}"
        )

    result = ",".join(filters)
    logger.debug(f"EQ filter [{style}]: {result}")
    return result


def get_preset_description(style: str) -> str:
    """프리셋 설명 반환"""
    descriptions = {
        "balanced": "기본 추천 — 최소 개입, 전체 밸런스 유지",
        "warm":     "Warm — 고역 자극 완화, AI 음원 날카로움 보정",
        "bright":   "Bright — 선명도·존재감 강조",
        "punch":    "Punch — 타격감·저역 에너지 강화",
    }
    return descriptions.get(style, "")
