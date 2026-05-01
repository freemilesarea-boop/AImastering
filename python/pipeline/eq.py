"""
EQ 필터 구성 모듈
v3 — 5종 마스터링 모드 + 2종 레거시 호환 + AI 음원 특화 보정

마스터링 모드 (v3):
  natural    — 원본 보존, 약한 EQ, 약한 컴프레션
  balanced   — 기본값. 적당한 EQ/comp/saturation
  bright     — 고역 선명도. 과압축 금지, air band 살리되 harsh 하지 않게
  loud       — 음압 강화. soft clipping + limiter 적극 사용
  kpop_loud  — 체감 볼륨 우선. low-end 정리 + mid/high clarity + 강한 limiter

레거시 호환 (v2):
  warm       — 고역 자극 완화, 저중역 보강
  punch      — 타격감, 저역 밀도 강화
"""
from typing import Optional, Dict, Any
from ..utils.logger import get_logger

logger = get_logger(__name__)

# ─────────────────────────────────────────────────────
# 모드별 EQ 파라미터 (v3)
# ─────────────────────────────────────────────────────

STYLE_PRESETS: Dict[str, Dict[str, Any]] = {
    # ─── Natural ───────────────────────────────────────
    # 가장 약한 개입. AI 원음을 그대로 살리고 싶을 때.
    "natural": {
        "highpassFreq":   28,
        "lowShelfFreq":   80,
        "lowShelfGain":   0.0,
        "midFreq":        3000,
        "midGain":        0.0,
        "midQ":           1.0,
        "presenceFreq":   5000,
        "presenceGain":   0.0,
        "highShelfFreq":  10000,
        "highShelfGain":  0.0,
        "airFreq":        14000,
        "airGain":        0.5,
        "harshmidNotch":  False,
    },

    # ─── Balanced (기본값) ────────────────────────────
    # 적당한 EQ + saturation. K-POP 외 일반 발매용 추천.
    "balanced": {
        "highpassFreq":   30,
        "lowShelfFreq":   80,
        "lowShelfGain":   0.7,
        "midFreq":        3000,
        "midGain":        0.0,
        "midQ":           1.0,
        "presenceFreq":   5000,
        "presenceGain":   0.7,
        "highShelfFreq":  9000,
        "highShelfGain":  0.8,
        "airFreq":        14000,
        "airGain":        1.2,
        "harshmidNotch":  False,
    },

    # ─── Bright ────────────────────────────────────────
    # v2 대비 수정 사항 (고역 눌림 문제 해결):
    #   highShelfGain : 2.5 → 1.6 (과한 부스트 완화)
    #   airGain       : 2.0 → 1.5
    #   presenceGain  : 2.0 → 1.4
    # 그리고 컴프/리미터 단에서 high band ratio 를 별도로 낮춰
    # 고역 transient 가 찌그러지지 않게 함 (master_chain.py 참조)
    "bright": {
        "highpassFreq":   35,
        "lowShelfFreq":   80,
        "lowShelfGain":   -0.3,    # 저역 살짝 정리
        "midFreq":        3500,
        "midGain":        0.6,     # 중역 미세 존재감
        "midQ":           1.0,
        "presenceFreq":   6000,
        "presenceGain":   1.4,     # 선명도 (v2: 2.0)
        "highShelfFreq":  10000,
        "highShelfGain":  1.6,     # 고역 (v2: 2.5)
        "airFreq":        14000,
        "airGain":        1.5,     # 공기감 (v2: 2.0)
        "harshmidNotch":  False,
    },

    # ─── Loud ──────────────────────────────────────────
    # 음압 강화. saturation/limiter 적극 사용.
    "loud": {
        "highpassFreq":   34,
        "lowShelfFreq":   100,
        "lowShelfGain":   1.0,
        "midFreq":        500,
        "midGain":        0.6,
        "midQ":           0.7,
        "presenceFreq":   4000,
        "presenceGain":   1.0,
        "highShelfFreq":  9000,
        "highShelfGain":  0.8,
        "airFreq":        13000,
        "airGain":        1.0,
        "harshmidNotch":  False,
    },

    # ─── KPOP Loud ─────────────────────────────────────
    # 체감 볼륨 우선. low-end 정리 + mid/high clarity + saturation.
    "kpop_loud": {
        "highpassFreq":   38,      # 초저역 보다 단호하게 정리
        "lowShelfFreq":   90,
        "lowShelfGain":   -0.8,    # 80~90Hz 살짝 컷 (boomy 방지)
        "midFreq":        2500,
        "midGain":        0.8,     # 보컬 존재감
        "midQ":           1.1,
        "presenceFreq":   5500,
        "presenceGain":   1.5,     # 고역 clarity
        "highShelfFreq":  9500,
        "highShelfGain":  1.2,
        "airFreq":        13500,
        "airGain":        1.3,
        "harshmidNotch":  False,   # 기본 비활성, AI 보정으로 동적 활성화
    },

    # ─── Legacy (v2 호환) ─────────────────────────────
    "warm": {
        "highpassFreq":   30,
        "lowShelfFreq":   120,
        "lowShelfGain":   1.5,
        "midFreq":        2500,
        "midGain":        -1.0,
        "midQ":           0.8,
        "presenceFreq":   5000,
        "presenceGain":   -0.5,
        "highShelfFreq":  8000,
        "highShelfGain":  -1.5,
        "airFreq":        12000,
        "airGain":        -1.0,
        "harshmidNotch":  True,
    },
    "punch": {
        "highpassFreq":   50,
        "lowShelfFreq":   100,
        "lowShelfGain":   2.0,
        "midFreq":        200,
        "midGain":        1.5,
        "midQ":           0.6,
        "presenceFreq":   4000,
        "presenceGain":   1.5,
        "highShelfFreq":  8000,
        "highShelfGain":  1.0,
        "airFreq":        13000,
        "airGain":        1.0,
        "harshmidNotch":  False,
    },
}


# 모드 → 권장 LUFS / TP / 리미터 강도 (UI 추천 값으로 사용)
# v3.1 — 안정화 업데이트
#   · True Peak 한도를 -1.0 dBTP 로 통일 (Spotify/YT 기준 정합)
#   · KPOP Loud 타깃 LUFS -9.0 → -10.0 (출렁임 + 스트리밍 자동 감쇠 회피)
#   · Loud 타깃은 -10.0 그대로 유지하되 limiter를 medium 으로 완화
MODE_DEFAULTS: Dict[str, Dict[str, Any]] = {
    "natural":   {"targetLUFS": -14.0, "targetTruePeak": -1.0, "limiterStrength": "low"},
    "balanced":  {"targetLUFS": -12.0, "targetTruePeak": -1.0, "limiterStrength": "medium"},
    "bright":    {"targetLUFS": -12.0, "targetTruePeak": -1.0, "limiterStrength": "medium"},
    "loud":      {"targetLUFS": -10.0, "targetTruePeak": -1.0, "limiterStrength": "medium"},
    "kpop_loud": {"targetLUFS": -10.0, "targetTruePeak": -1.0, "limiterStrength": "high"},
    "warm":      {"targetLUFS": -14.0, "targetTruePeak": -1.0, "limiterStrength": "low"},
    "punch":     {"targetLUFS": -11.0, "targetTruePeak": -1.0, "limiterStrength": "high"},
}


def build_eq_filter(
    style: str = "balanced",
    custom_settings: Optional[Dict[str, Any]] = None,
    ai_corrections: Optional[Dict[str, bool]] = None,
) -> str:
    """
    FFmpeg 오디오 필터 문자열 생성

    Args:
        style:           프리셋 이름
        custom_settings: 사용자 정의 파라미터 (프리셋 위에 덮어씀)
        ai_corrections:  AI 음원 특화 보정 플래그

    Returns:
        FFmpeg -af 필터 체인 문자열 (콤마 구분)
    """
    base = STYLE_PRESETS.get(style, STYLE_PRESETS["balanced"]).copy()
    if custom_settings:
        base.update(custom_settings)

    s = base
    ai = ai_corrections or {}
    filters = []

    # 1. High-pass (DC + 초저역 제거)
    if s["highpassFreq"] > 0:
        filters.append(f"highpass=f={s['highpassFreq']}:poles=2")

    # 2. AI 특화: boomy low-end 감지 시 80Hz 부근 추가 컷
    if ai.get("boomy_low"):
        logger.info("AI fix: boomy low-end — applying low-shelf cut")
        filters.append("equalizer=f=80:t=h:g=-2.0:w=60")

    # 3. Low shelf
    if s["lowShelfGain"] != 0:
        filters.append(
            f"equalizer=f={s['lowShelfFreq']}:t=h"
            f":g={s['lowShelfGain']}:w={int(s['lowShelfFreq'] * 0.7)}"
        )

    # 4. Mid EQ
    if s["midGain"] != 0:
        filters.append(
            f"equalizer=f={s['midFreq']}:t=q"
            f":g={s['midGain']}:w={s['midQ']}"
        )

    # 5. AI 특화: harsh high-mid 자동 노치
    #    Bright 모드에서는 매우 약하게만 (선명도 보존)
    apply_harsh_notch = (ai.get("harsh_highmid") or s.get("harshmidNotch"))
    if apply_harsh_notch and style != "bright":
        logger.info("AI fix: harsh high-mid — applying notch")
        filters.append("equalizer=f=3800:t=q:g=-2.0:w=1.5")
        filters.append("equalizer=f=5200:t=q:g=-1.2:w=1.2")
    elif apply_harsh_notch and style == "bright":
        logger.info("AI fix: harsh detected on bright mode — very mild notch")
        filters.append("equalizer=f=3800:t=q:g=-1.0:w=2.0")

    # 6. Presence
    if s.get("presenceGain", 0) != 0:
        filters.append(
            f"equalizer=f={s['presenceFreq']}:t=q:g={s['presenceGain']}:w=1.0"
        )

    # 7. High shelf
    if s["highShelfGain"] != 0:
        filters.append(
            f"equalizer=f={s['highShelfFreq']}:t=h"
            f":g={s['highShelfGain']}:w={int(s['highShelfFreq'] * 0.5)}"
        )

    # 8. Air EQ
    if s["airGain"] != 0:
        filters.append(
            f"equalizer=f={s['airFreq']}:t=h"
            f":g={s['airGain']}:w={int(s['airFreq'] * 0.8)}"
        )

    result = ",".join(filters)
    logger.debug(f"EQ filter [{style}]: {result}")
    return result


def get_preset_description(style: str) -> str:
    """프리셋 설명 (UI 폴백용)"""
    descriptions = {
        "natural":   "Natural — 원본 보존, 최소 개입",
        "balanced":  "Balanced — 기본값. 적당한 EQ/comp/saturation",
        "bright":    "Bright — 고역 선명도 강조 (과압축 없음)",
        "loud":      "Loud — 음압 강화. 강한 limiter",
        "kpop_loud": "KPOP Loud — 체감 볼륨 + low-end 정리",
        "warm":      "Warm — 고역 자극 완화 (legacy)",
        "punch":     "Punch — 타격감·저역 강화 (legacy)",
    }
    return descriptions.get(style, "")
