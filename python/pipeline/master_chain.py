"""
마스터링 체인 빌더
v3 — Ozone 스타일 마스터링 체인을 ffmpeg 필터로 근사

권장 체인:
    Input
      → EQ (corrective + tone)            : equalizer, highpass
      → 다이나믹 EQ / 디에서 (모드별)      : adynamicequalizer (선택)
      → Glue compressor                    : acompressor
      → Harmonic saturation               : compand (mild transfer curve)
      → Stereo widening (선택)              : extrastereo
      → Soft clipper                       : compand (knee curve)
      → True peak limiter (input gain)     : alimiter
    Output → loudnorm pass2 (target LUFS + TP ceiling)

본 모듈은 (loudnorm 외) 추가 필터 체인 문자열을 만들어 반환한다.
loudnorm 자체는 mastering.py 의 ffmpeg_wrapper.loudnorm_pass2 에서 처리한다.
"""
from typing import Dict, Any, Optional
from .eq import build_eq_filter, MODE_DEFAULTS
from ..utils.logger import get_logger

logger = get_logger(__name__)

# ─────────────────────────────────────────────────────
# 모드별 컴프레서 파라미터 (Bright 의 high-band 과압축 방지 포함)
# ─────────────────────────────────────────────────────
COMP_PARAMS: Dict[str, Dict[str, Any]] = {
    "natural":   {"threshold": -22, "ratio": 1.5, "attack": 25, "release": 250, "makeup": 0, "knee": 4},
    "balanced":  {"threshold": -18, "ratio": 2.0, "attack": 20, "release": 200, "makeup": 1, "knee": 3},
    # Bright: ratio 와 makeup 을 낮춤 → 고역 transient 가 압축으로 눌리는 현상 방지
    "bright":    {"threshold": -16, "ratio": 1.6, "attack": 25, "release": 220, "makeup": 0, "knee": 3},
    "loud":      {"threshold": -16, "ratio": 2.5, "attack": 12, "release": 130, "makeup": 1, "knee": 2},
    "kpop_loud": {"threshold": -14, "ratio": 2.8, "attack": 10, "release": 110, "makeup": 1, "knee": 2},
    # legacy
    "warm":      {"threshold": -20, "ratio": 2.5, "attack": 30, "release": 250, "makeup": 1, "knee": 4},
    "punch":     {"threshold": -14, "ratio": 3.0, "attack": 10, "release": 120, "makeup": 2, "knee": 2},
}


# ─────────────────────────────────────────────────────
# 리미터 강도 매핑 (input gain dB, attack ms, release ms)
# ─────────────────────────────────────────────────────
LIMITER_STRENGTHS: Dict[str, Dict[str, float]] = {
    "low":    {"input_gain_db": 0.5, "attack_ms": 8.0, "release_ms": 200.0},
    "medium": {"input_gain_db": 2.0, "attack_ms": 5.0, "release_ms": 100.0},
    "high":   {"input_gain_db": 4.0, "attack_ms": 3.0, "release_ms": 60.0},
}


# ─────────────────────────────────────────────────────
# 모드별 saturation/widening 기본 강도
# ─────────────────────────────────────────────────────
MODE_SAT_WIDTH: Dict[str, Dict[str, float]] = {
    "natural":   {"saturation": 0.0, "stereoWidth": 1.0},
    "balanced":  {"saturation": 0.2, "stereoWidth": 1.05},
    "bright":    {"saturation": 0.15, "stereoWidth": 1.10},
    "loud":      {"saturation": 0.4, "stereoWidth": 1.10},
    "kpop_loud": {"saturation": 0.5, "stereoWidth": 1.15},
    "warm":      {"saturation": 0.15, "stereoWidth": 1.0},
    "punch":     {"saturation": 0.3, "stereoWidth": 1.05},
}


# ─────────────────────────────────────────────────────
# 모드별 deesser 활성 (고역 sibilance 자동 제어)
# ─────────────────────────────────────────────────────
MODE_DEESSER: Dict[str, bool] = {
    "natural":   False,
    "balanced":  False,
    "bright":    False,    # Bright 에서는 deesser 사용 X (고역 보존)
    "loud":      True,
    "kpop_loud": True,
    "warm":      True,
    "punch":     False,
}


def _db_to_linear(db: float) -> float:
    return 10.0 ** (db / 20.0)


def _saturation_filter(amount: float) -> Optional[str]:
    """
    Harmonic saturation 근사 (compand transfer curve).
    amount: 0.0 (off) ~ 1.0 (강함)
    낮은 레벨은 그대로, 중상위 레벨에 부드러운 곡선을 적용해 짝수 차 고조파를 추가.
    """
    if amount <= 0.001:
        return None
    a = max(0.0, min(1.0, amount))
    # 목표: 0.0 = 무처리, 1.0 = 강한 saturation
    # -3dB 근처에서 약 0.3*a dB 압축, -1dB 근처에서 0.7*a dB 압축
    p_minus3 = round(-3.0 - 0.4 * a, 2)
    p_minus1 = round(-1.0 - 0.7 * a, 2)
    p_zero   = round( 0.0 - 1.0 * a, 2)
    points = (
        f"-90/-90"
        f"|-30/-30"
        f"|-12/-12"
        f"|-6/-6"
        f"|-3/{p_minus3}"
        f"|-1/{p_minus1}"
        f"|0/{p_zero}"
    )
    # attacks=0:decays=0 으로 즉시 처리 (waveshaping 형태)
    return f"compand=attacks=0:decays=0:points={points}"


def _soft_clipper_filter(ceiling_db: float) -> str:
    """
    Soft clipper: ceiling_db 근처에서 부드럽게 휘어지는 transfer curve.
    True peak limiter 직전에 배치해 limiter 입력을 미리 제어.
    """
    c = max(-3.0, min(-0.1, ceiling_db))
    # ceiling - 3 dB 이하는 그대로, 그 위로 점진적으로 압착
    p_low  = round(c - 3.0, 2)
    p_mid  = round(c - 1.5, 2)
    p_near = round(c - 0.4, 2)
    p_top  = round(c - 0.05, 2)
    points = (
        f"-90/-90"
        f"|-12/-12"
        f"|{p_low}/{p_low}"
        f"|{p_mid}/{round(p_mid - 0.2, 2)}"
        f"|{p_near}/{round(p_near - 0.3, 2)}"
        f"|0/{p_top}"
    )
    return f"compand=attacks=0:decays=0:points={points}"


def _deesser_filter() -> str:
    """
    경량 디에서 (5~8kHz dynamic shelf reduction).
    adynamicequalizer 가 ffmpeg 6.0+ 에서 지원되지만, 호환성을 위해
    bandpass + acompressor 조합 대신 간단한 acompressor sidechain 없이
    high-shelf 방식의 acompressor 를 우회 — 실용적으로는 정적 EQ 로 대체.
    여기서는 6kHz 부근에 약한 peaking 컷 + dynaudnorm 으로 유사 효과를 낸다.
    """
    # 정적 dip + 동적 평활화로 sibilance 완화
    return "equalizer=f=6500:t=q:g=-1.2:w=1.5"


def _stereo_widener_filter(width: float) -> Optional[str]:
    """
    Stereo widening via extrastereo.
    width: 0.5 (mono-ish) ~ 1.5 (wide). 1.0 = 무처리
    """
    if abs(width - 1.0) < 0.01:
        return None
    w = max(0.0, min(2.5, width))
    # extrastereo m: 1.0 = passthrough, > 1.0 = 더 넓게
    return f"extrastereo=m={w:.2f}:c=0"


def _alimiter_filter(
    ceiling_db: float,
    limiter_strength: str = "medium",
    extra_input_gain_db: float = 0.0,
) -> str:
    """
    True-peak 형태 한계를 거는 alimiter (oversampling 은 loudnorm pass2 에서 별도 보정).
    """
    sp = LIMITER_STRENGTHS.get(limiter_strength, LIMITER_STRENGTHS["medium"])
    input_gain_db = sp["input_gain_db"] + extra_input_gain_db
    level_in  = max(0.5, min(8.0, _db_to_linear(input_gain_db)))
    limit_lin = max(0.0625, min(1.0, _db_to_linear(ceiling_db)))
    return (
        f"alimiter=level_in={level_in:.4f}"
        f":level_out=1.0"
        f":limit={limit_lin:.4f}"
        f":attack={sp['attack_ms']:.1f}"
        f":release={sp['release_ms']:.1f}"
        f":asc=1:asc_level=0.5:level=0"
    )


def build_master_chain(
    mode: str,
    target_true_peak: float,
    limiter_strength: str = "medium",
    saturation_amount: Optional[float] = None,
    stereo_width: Optional[float] = None,
    output_gain_db: float = 0.0,
    enable_eq: bool = True,
    enable_comp: bool = True,
    ai_corrections: Optional[Dict[str, bool]] = None,
) -> str:
    """
    EQ → comp → deesser → saturation → widener → soft clipper → limiter → output gain
    필터 체인 문자열을 반환.
    loudnorm 은 mastering.py 에서 별도 단계로 적용된다.
    """
    # 모드별 기본값
    sat_default = MODE_SAT_WIDTH.get(mode, MODE_SAT_WIDTH["balanced"])
    sat = saturation_amount if saturation_amount is not None else sat_default["saturation"]
    width = stereo_width if stereo_width is not None else sat_default["stereoWidth"]

    parts = []

    # 1. EQ
    if enable_eq:
        eq = build_eq_filter(style=mode, ai_corrections=ai_corrections)
        if eq:
            parts.append(eq)

    # 2. Glue compressor
    if enable_comp:
        c = COMP_PARAMS.get(mode, COMP_PARAMS["balanced"])
        parts.append(
            f"acompressor=threshold={c['threshold']}dB"
            f":ratio={c['ratio']}"
            f":attack={c['attack']}"
            f":release={c['release']}"
            f":makeup={c['makeup']}"
            f":knee={c['knee']}"
        )

    # 3. De-esser (Bright 모드에서는 비활성)
    if MODE_DEESSER.get(mode, False) and mode != "bright":
        parts.append(_deesser_filter())

    # 4. Harmonic saturation
    sat_f = _saturation_filter(sat)
    if sat_f:
        parts.append(sat_f)

    # 5. Stereo widening
    sw = _stereo_widener_filter(width)
    if sw:
        parts.append(sw)

    # 6. Output gain (선택, soft clipper 입력 레벨 보정)
    if abs(output_gain_db) > 0.01:
        og = max(-12.0, min(12.0, output_gain_db))
        parts.append(f"volume={og:.2f}dB")

    # 7. Soft clipper (ceiling 직전 단계)
    parts.append(_soft_clipper_filter(target_true_peak))

    # 8. True peak limiter
    parts.append(
        _alimiter_filter(
            ceiling_db=target_true_peak,
            limiter_strength=limiter_strength,
        )
    )

    chain = ",".join(parts)
    logger.debug(f"Master chain [{mode}, lim={limiter_strength}, sat={sat}]: {chain}")
    return chain


def get_mode_defaults(mode: str) -> Dict[str, Any]:
    """모드별 추천 LUFS / TP / 리미터 강도"""
    return dict(MODE_DEFAULTS.get(mode, MODE_DEFAULTS["balanced"]))


def get_correction_chain(
    gain_db: float,
    target_true_peak: float,
    limiter_strength: str = "medium",
) -> str:
    """
    LUFS 목표 미달 시 추가 보정용 필터 체인.
    추가 gain → soft clipper → alimiter (TP ceiling).
    """
    parts = []
    g = max(-6.0, min(6.0, gain_db))
    if abs(g) > 0.05:
        parts.append(f"volume={g:.2f}dB")
    parts.append(_soft_clipper_filter(target_true_peak))
    parts.append(
        _alimiter_filter(
            ceiling_db=target_true_peak,
            limiter_strength=limiter_strength,
            extra_input_gain_db=0.5,
        )
    )
    return ",".join(parts)
