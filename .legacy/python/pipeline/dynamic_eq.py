"""
Dynamic EQ 체인 빌더 (v3.1)

이 모듈은 모드별 Dynamic EQ 프리셋을 제공한다.
ffmpeg 6.0+ 의 `adynamicequalizer` 필터가 있으면 우선 사용하고,
없으면 정적 `equalizer` + sidechain 없는 `compand` 조합으로 fallback.

지원 모드 프리셋:
  · natural   — 거의 개입하지 않음 (sibilance 만)
  · balanced  — sibilance + harsh + boomy 최소 개입
  · bright    — sibilance 우선, 고역 살림
  · loud      — boomy 와 muddy 강하게, sibilance 중간
  · kpop      — vocal presence + sibilance + boomy + muddy 모두 적용

추후 UI 에서 강도(intensity) 슬라이더로 게인을 일괄 스케일.
"""
from typing import Dict, Any, List, Optional
from ..utils.logger import get_logger

logger = get_logger(__name__)


# ─────────────────────────────────────────────────────
# Dynamic EQ 밴드 정의
#
# 각 밴드는 다음 4가지 의미를 가짐:
#   freq      — 중심 주파수 (Hz)
#   q         — Q (대역폭)
#   threshold — 이 레벨 이상에서 작동 (dBFS)
#   reduction — 임계 초과 시 감쇠량 (dB)
#   mode      — "cut"  : 임계 초과 시 감쇠 (de-esser, harsh tamer 등)
#               "boost": 임계 미달 시 부스트 (presence enhancer)
# ─────────────────────────────────────────────────────
DYNAMIC_EQ_PRESETS: Dict[str, List[Dict[str, Any]]] = {
    "natural": [
        {"name": "sibilance",    "freq": 7500, "q": 1.6, "threshold": -22, "reduction": 1.5, "mode": "cut"},
    ],
    "balanced": [
        {"name": "sibilance",    "freq": 7500, "q": 1.6, "threshold": -22, "reduction": 2.0, "mode": "cut"},
        {"name": "harsh_highmid","freq": 3500, "q": 1.4, "threshold": -20, "reduction": 1.5, "mode": "cut"},
        {"name": "muddy_lowmid", "freq":  300, "q": 1.0, "threshold": -18, "reduction": 1.5, "mode": "cut"},
    ],
    "bright": [
        {"name": "sibilance",    "freq": 7500, "q": 1.8, "threshold": -20, "reduction": 2.5, "mode": "cut"},
        {"name": "air_dynamic",  "freq":12000, "q": 1.0, "threshold": -28, "reduction": 1.0, "mode": "boost"},
    ],
    "loud": [
        {"name": "boomy_low",    "freq":   90, "q": 1.2, "threshold": -16, "reduction": 2.5, "mode": "cut"},
        {"name": "muddy_lowmid", "freq":  280, "q": 1.0, "threshold": -16, "reduction": 2.0, "mode": "cut"},
        {"name": "sibilance",    "freq": 7000, "q": 1.6, "threshold": -20, "reduction": 2.0, "mode": "cut"},
    ],
    "kpop_loud": [
        {"name": "boomy_low",    "freq":  100, "q": 1.2, "threshold": -16, "reduction": 2.5, "mode": "cut"},
        {"name": "muddy_lowmid", "freq":  300, "q": 1.0, "threshold": -16, "reduction": 2.0, "mode": "cut"},
        {"name": "harsh_highmid","freq": 3800, "q": 1.4, "threshold": -18, "reduction": 2.0, "mode": "cut"},
        {"name": "sibilance",    "freq": 7500, "q": 1.8, "threshold": -20, "reduction": 2.5, "mode": "cut"},
        {"name": "vocal_presence","freq": 2500,"q": 1.0, "threshold": -26, "reduction": 1.0, "mode": "boost"},
    ],
    # legacy 매핑
    "warm":  [
        {"name": "sibilance",    "freq": 7500, "q": 1.4, "threshold": -22, "reduction": 1.5, "mode": "cut"},
        {"name": "muddy_lowmid", "freq":  280, "q": 1.0, "threshold": -18, "reduction": 1.5, "mode": "cut"},
    ],
    "punch": [
        {"name": "boomy_low",    "freq":  100, "q": 1.2, "threshold": -16, "reduction": 2.0, "mode": "cut"},
        {"name": "harsh_highmid","freq": 3500, "q": 1.4, "threshold": -18, "reduction": 1.5, "mode": "cut"},
    ],
}


# UI 표시용 라벨
BAND_LABELS = {
    "sibilance":      "치찰음 제어 (7~8kHz)",
    "harsh_highmid":  "고역 자극 제어 (3~5kHz)",
    "muddy_lowmid":   "탁한 저중역 제어 (250~350Hz)",
    "boomy_low":      "저역 부풀음 제어 (80~110Hz)",
    "vocal_presence": "보컬 존재감 부스트 (2~3kHz)",
    "air_dynamic":    "공기감 부스트 (12kHz)",
}


def build_dynamic_eq_chain(
    mode: str,
    intensity: float = 1.0,
    use_adynamic_eq: bool = False,
) -> Dict[str, Any]:
    """
    모드 프리셋 기반 Dynamic EQ ffmpeg 필터 체인 생성.

    Args:
        mode: 마스터링 모드 (natural / balanced / bright / loud / kpop_loud / 등)
        intensity: 0.0 ~ 2.0 — 모든 밴드의 reduction/boost 양을 곱해 강도 조절
        use_adynamic_eq: True 면 ffmpeg adynamicequalizer 사용,
                         False 면 equalizer + compand fallback 사용

    Returns:
        {
          "chain":  ffmpeg 필터 문자열 ("" 가능),
          "preset": 적용된 프리셋 이름 ('disabled' 가능),
          "bands":  적용된 밴드 메타데이터 리스트 (UI 표시용)
        }
    """
    bands = DYNAMIC_EQ_PRESETS.get(mode, [])
    if not bands:
        return {"chain": "", "preset": "disabled", "bands": []}

    intensity = max(0.0, min(2.0, float(intensity)))
    if intensity <= 0.001:
        return {"chain": "", "preset": "disabled", "bands": []}

    parts: List[str] = []
    band_meta: List[Dict[str, Any]] = []

    for band in bands:
        scaled_reduction = round(band["reduction"] * intensity, 2)
        if scaled_reduction < 0.05:
            continue

        if use_adynamic_eq:
            f = _adynamic_band(band, scaled_reduction)
        else:
            f = _fallback_band(band, scaled_reduction)

        if f:
            parts.append(f)
            band_meta.append({
                "name":      band["name"],
                "label":     BAND_LABELS.get(band["name"], band["name"]),
                "freq":      band["freq"],
                "q":         band["q"],
                "threshold": band["threshold"],
                "reduction": scaled_reduction,
                "mode":      band["mode"],
                "engine":    "adynamicequalizer" if use_adynamic_eq else "fallback",
            })

    return {
        "chain":  ",".join(parts),
        "preset": mode,
        "bands":  band_meta,
    }


def _adynamic_band(band: Dict[str, Any], reduction: float) -> Optional[str]:
    """
    ffmpeg adynamicequalizer 한 밴드 표현.

    중요: ffmpeg 의 threshold 옵션은 dBFS 가 아니라 amplitude percentage (0~100).
    프리셋의 threshold(dBFS, 음수) 를 percentage 로 변환해야 한다.
        threshold_pct = 10^(threshold_db / 20) * 100
    예) -20 dBFS → 10.0 %, -16 dBFS → 15.85 %, -22 dBFS → 7.94 %.

    파라미터 범위:
        threshold: 0 ~ 100        (amplitude percentage)
        ratio:     0 ~ 30
        makeup:    0 ~ 100 dB
        range:     1 ~ 200 dB
        mode:      cut / boost / listen
    """
    threshold_db = float(band["threshold"])
    pct = (10.0 ** (threshold_db / 20.0)) * 100.0
    threshold_pct = max(0.1, min(99.9, pct))

    mode_str = "cut" if band["mode"] == "cut" else "boost"
    # ratio: reduction 양에 비례. 1=무처리, 더 클수록 강한 처리. 0~30 한도.
    ratio = max(1.0, min(8.0, 1.0 + reduction / 2.0))
    # range: 최대 게인 변화량 (dB). reduction 의 1.5x 정도로 안전 마진.
    rng = max(2.0, min(24.0, reduction * 1.5))
    return (
        f"adynamicequalizer=dfrequency={band['freq']}:dqfactor={band['q']}"
        f":tfrequency={band['freq']}:tqfactor={band['q']}"
        f":threshold={threshold_pct:.2f}:ratio={ratio:.2f}:range={rng:.2f}"
        f":attack=20:release=200:mode={mode_str}"
    )


def _fallback_band(band: Dict[str, Any], reduction: float) -> Optional[str]:
    """
    adynamicequalizer 가 없는 환경에서의 fallback.
    동적 동작이 어려우므로 정적 equalizer 로 평균 효과의 절반 정도만 적용.
    이렇게 하면 sustain 구간에서의 출렁임 없이 일관된 톤을 만든다.
    """
    if reduction < 0.05:
        return None
    # 정적 EQ 는 동적의 절반 효과로 보수적용
    static_gain = -reduction * 0.6 if band["mode"] == "cut" else +reduction * 0.6
    return (
        f"equalizer=f={band['freq']}:t=q:g={static_gain:.2f}:w={band['q']}"
    )
