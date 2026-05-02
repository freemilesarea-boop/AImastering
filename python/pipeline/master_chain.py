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
from typing import Dict, Any, Optional, List
from .eq import build_eq_filter, MODE_DEFAULTS
from .dynamic_eq import build_dynamic_eq_chain, DYNAMIC_EQ_PRESETS
from ..utils.logger import get_logger

logger = get_logger(__name__)

# ─────────────────────────────────────────────────────
# 모드별 컴프레서 파라미터 (Bright 의 high-band 과압축 방지 포함)
# v3.1 — release 시간을 늘려 limiter envelope 와의 chasing 방지
# ─────────────────────────────────────────────────────
COMP_PARAMS: Dict[str, Dict[str, Any]] = {
    "natural":   {"threshold": -22, "ratio": 1.5, "attack": 30, "release": 350, "makeup": 0, "knee": 4},
    "balanced":  {"threshold": -18, "ratio": 2.0, "attack": 25, "release": 300, "makeup": 1, "knee": 3},
    # Bright: ratio 와 makeup 을 낮춤 → 고역 transient 가 압축으로 눌리는 현상 방지
    "bright":    {"threshold": -16, "ratio": 1.6, "attack": 25, "release": 280, "makeup": 0, "knee": 3},
    "loud":      {"threshold": -16, "ratio": 2.2, "attack": 18, "release": 220, "makeup": 1, "knee": 2},
    # KPOP: ratio 완화 + release 연장 (envelope chasing 차단)
    "kpop_loud": {"threshold": -14, "ratio": 2.4, "attack": 15, "release": 200, "makeup": 1, "knee": 2},
    # legacy
    "warm":      {"threshold": -20, "ratio": 2.5, "attack": 30, "release": 280, "makeup": 1, "knee": 4},
    "punch":     {"threshold": -14, "ratio": 3.0, "attack": 12, "release": 200, "makeup": 2, "knee": 2},
}


# ─────────────────────────────────────────────────────
# 리미터 강도 매핑 (input gain dB, attack ms, release ms)
# v3.1 — release 시간 안정화. envelope chasing/breathing 방지.
#       compressor release 와 황금비 (limiter < comp) 유지하되
#       2배 이상 차이 두지 않음.
# ─────────────────────────────────────────────────────
LIMITER_STRENGTHS: Dict[str, Dict[str, float]] = {
    "low":    {"input_gain_db": 0.5, "attack_ms": 10.0, "release_ms": 220.0},
    "medium": {"input_gain_db": 1.5, "attack_ms": 7.0,  "release_ms": 160.0},
    "high":   {"input_gain_db": 3.0, "attack_ms": 5.0,  "release_ms": 130.0},
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

    v3.2: 0 dBFS 입력에서 출력이 ceiling 보다 0.3 dB 아래에서 멈추도록 마진 강화
          (sibilant/percussive 입력의 ISP 누수 방지).
    """
    c = max(-3.0, min(-0.1, ceiling_db))
    p_low  = round(c - 3.0, 2)
    p_mid  = round(c - 1.5, 2)
    p_near = round(c - 0.6, 2)   # 마진 강화 (이전 -0.4)
    p_top  = round(c - 0.3, 2)   # 마진 강화 (이전 -0.05)
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
    # v3.2 안전 마진: alimiter 의 limit 을 ceiling 보다 0.3dB 더 빡빡하게 설정.
    # ffmpeg alimiter 는 ISP oversampling 미지원이라 ceiling 정확 도달 시 ISP 누수 가능.
    safe_ceiling = ceiling_db - 0.3
    limit_lin = max(0.0625, min(1.0, _db_to_linear(safe_ceiling)))
    # v3.1: asc=0 — auto soft clip 의 평균 레벨 적응 동작이 음압 출렁임을 만들 수 있어 비활성화.
    return (
        f"alimiter=level_in={level_in:.4f}"
        f":level_out=1.0"
        f":limit={limit_lin:.4f}"
        f":attack={sp['attack_ms']:.1f}"
        f":release={sp['release_ms']:.1f}"
        f":asc=0:level=0"
    )


def build_master_chain(
    mode: str,
    target_true_peak: float,
    limiter_strength: str = "medium",
    saturation_amount: Optional[float] = None,
    stereo_width: Optional[float] = None,
    output_gain_db: float = 0.0,
    entry_gain_db: float = 0.0,
    enable_eq: bool = True,
    enable_comp: bool = True,
    enable_dynamic_eq: bool = True,
    dynamic_eq_intensity: float = 1.0,
    ffmpeg_supports_adynamic_eq: bool = False,
    ai_corrections: Optional[Dict[str, bool]] = None,
) -> Dict[str, Any]:
    """
    Loudness Match → EQ → Dynamic EQ → Compressor → De-esser → Saturation
                  → Widener → Output Gain → Soft Clipper → Limiter

    체인 문자열과 적용된 처리 단계 목록을 함께 반환.

    v3.2 — Fully Static Chain
      · entry_gain_db: 체인 맨 앞의 정적 loudness match 게인 (volume= 노드).
        loudnorm pass2 를 대체. 시간 기반 게인 변화 없음.
      · output_gain_db: 사용자 추가 트림 (선택, 기존 동작 유지).

    Returns:
        {
          "chain":        ffmpeg -af 문자열,
          "stages":       사람이 읽는 단계 목록 (UI 표시용),
          "dynamic_eq":   적용된 dynamic EQ 모드 ('disabled' 가능),
          "entry_gain_db": 실제 적용된 entry gain (clip 후 값),
        }
    """
    # 모드별 기본값
    sat_default = MODE_SAT_WIDTH.get(mode, MODE_SAT_WIDTH["balanced"])
    sat = saturation_amount if saturation_amount is not None else sat_default["saturation"]
    width = stereo_width if stereo_width is not None else sat_default["stereoWidth"]

    parts: List[str] = []
    stages: List[str] = []

    # 0. Loudness match (정적 입력 게인) — loudnorm pass2 대체
    #    매우 작은 입력(-30 LUFS 이하)에서 큰 push 가 필요할 수 있어 ±24dB 까지 허용.
    #    음수 게인도 가능 (큰 마스터를 작은 타깃으로 다운레벨).
    eg = max(-24.0, min(24.0, float(entry_gain_db)))
    if abs(eg) > 0.01:
        parts.append(f"volume={eg:.2f}dB")
        stages.append(f"Loudness Match ({eg:+.2f} dB)")

    # 1. EQ (정적)
    if enable_eq:
        eq = build_eq_filter(style=mode, ai_corrections=ai_corrections)
        if eq:
            parts.append(eq)
            stages.append("EQ")

    # 1.5. Dynamic EQ (모드 프리셋 기반, 강도 파라미터로 조절)
    dyn_mode_used = "disabled"
    if enable_dynamic_eq:
        dyn = build_dynamic_eq_chain(
            mode=mode,
            intensity=dynamic_eq_intensity,
            use_adynamic_eq=ffmpeg_supports_adynamic_eq,
        )
        if dyn["chain"]:
            parts.append(dyn["chain"])
            stages.append(f"Dynamic EQ ({dyn['preset']})")
            dyn_mode_used = dyn["preset"]

    # 2. Glue compressor
    if enable_comp:
        c = COMP_PARAMS.get(mode, COMP_PARAMS["balanced"])
        # ffmpeg acompressor 의 makeup 범위 [1, 64] — 0 이하는 옵션 자체를 생략한다 (기본=1).
        # threshold 도 entry_gain 가 클 경우 자동으로 올려 push-then-crush 방지.
        comp_threshold = float(c["threshold"])
        if eg > 12.0:
            # 큰 entry gain 에서는 compressor 가 너무 일찍 작동 → 결과 LUFS 미달.
            # entry gain 의 초과분만큼 threshold 를 위로 옮긴다 (덜 압축).
            comp_threshold = min(-2.0, comp_threshold + (eg - 12.0))
        comp_parts = [
            f"acompressor=threshold={comp_threshold:.1f}dB",
            f"ratio={c['ratio']}",
            f"attack={c['attack']}",
            f"release={c['release']}",
            f"knee={c['knee']}",
        ]
        if float(c.get("makeup", 0)) >= 1.0:
            comp_parts.append(f"makeup={c['makeup']}")
        parts.append(":".join(comp_parts))
        stage_label = "Compressor"
        if comp_threshold != float(c["threshold"]):
            stage_label += f" (thr {comp_threshold:.1f} dB, auto)"
        stages.append(stage_label)

    # 3. De-esser (Bright 모드에서는 비활성)
    if MODE_DEESSER.get(mode, False) and mode != "bright":
        parts.append(_deesser_filter())
        stages.append("De-esser")

    # 4. Harmonic saturation
    sat_f = _saturation_filter(sat)
    if sat_f:
        parts.append(sat_f)
        stages.append("Saturation")

    # 5. Stereo widening
    sw = _stereo_widener_filter(width)
    if sw:
        parts.append(sw)
        stages.append("Stereo Widener")

    # 6. Output gain (사용자 추가 트림, 선택)
    if abs(output_gain_db) > 0.01:
        og = max(-12.0, min(12.0, output_gain_db))
        parts.append(f"volume={og:.2f}dB")
        stages.append(f"Output Gain ({og:+.1f} dB)")

    # 7. Soft clipper (ceiling 직전 단계)
    parts.append(_soft_clipper_filter(target_true_peak))
    stages.append("Soft Clipper")

    # 8. True peak limiter
    parts.append(
        _alimiter_filter(
            ceiling_db=target_true_peak,
            limiter_strength=limiter_strength,
        )
    )
    stages.append(f"Limiter ({limiter_strength})")

    chain = ",".join(parts)
    logger.debug(f"Master chain [{mode}, lim={limiter_strength}, entry={eg:+.2f}dB, "
                 f"sat={sat}, dyn_eq={dyn_mode_used}]")
    return {
        "chain":         chain,
        "stages":        stages,
        "dynamic_eq":    dyn_mode_used,
        "entry_gain_db": eg,
    }


def get_mode_defaults(mode: str) -> Dict[str, Any]:
    """모드별 추천 LUFS / TP / 리미터 강도"""
    return dict(MODE_DEFAULTS.get(mode, MODE_DEFAULTS["balanced"]))


def get_correction_chain(
    gain_db: float,
    target_true_peak: float,
    limiter_strength: str = "medium",  # 호환성용 — 더 이상 사용하지 않음
) -> str:
    """
    LUFS 목표 미달 시 추가 보정용 필터 체인.

    v3.2 — 정적 보정 + ISP safety net.
      구조: volume → soft clipper → alimiter (gentle, asc=0)
      기존 1차 alimiter envelope 위에 다시 강한 envelope 을 얹는 것은 출렁임의 원인이라
      여기 alimiter 는 attack/release 둘 다 길게(20/300ms) 두어 ISP 게이트 역할만 한다.
      평균 레벨에는 거의 영향 없음.
    """
    parts: List[str] = []
    g = max(-5.0, min(5.0, gain_db))
    if abs(g) > 0.05:
        parts.append(f"volume={g:.2f}dB")
    parts.append(_soft_clipper_filter(target_true_peak))
    # ISP safety net — envelope 거의 작동 안 하는 매우 부드러운 limiter
    safe_ceiling = target_true_peak - 0.3
    limit_lin = max(0.0625, min(1.0, _db_to_linear(safe_ceiling)))
    parts.append(
        f"alimiter=level_in=1.0:level_out=1.0:limit={limit_lin:.4f}"
        f":attack=20.0:release=300.0:asc=0:level=0"
    )
    return ",".join(parts)
