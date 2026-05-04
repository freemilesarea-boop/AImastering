"""
Dynamic EQ 체인 빌더 (v3.2 P3).

ffmpeg 6.0+ 의 `adynamicequalizer` 가 가용하면 우선 사용하고, 없으면
정적 `equalizer` (보수적인 절반 게인) 로 fallback.  pipeline.py 가
pre_filter 직전에 합성하는 단일 ffmpeg 필터 문자열을 반환한다.

설계 근거 (legacy v3.1 의 dynamic_eq.py 와 동일):
  · 모드별 4~5 개 밴드의 동적 보정
  · adynamicequalizer 의 threshold 는 amplitude-percent 단위이므로
    dBFS (음수) 를 % 로 변환해 전달
  · fallback 정적 EQ 는 동적의 60% 강도로 적용해 sustain 구간 출렁임 방지

가용성 검사: import-time 1회 ffmpeg -filters 호출 후 cached.  Windows /
macOS / Linux 모두에서 동일 동작.
"""
from __future__ import annotations

import subprocess
from typing import Any

from app.utils.ffmpeg_wrapper import _FFMPEG_BIN
from app.utils.logger import log
from app.utils.vocal_protection import clamp_vocal_band_cut, VOCAL_PROTECTION


# ── adynamicequalizer 가용성 검사 (1회 cached) ──────────────────────────────
_ADYN_EQ_AVAILABLE: bool | None = None
_ADYN_EQ_MODE_ENUM: dict[str, str] | None = None


def has_adynamic_equalizer() -> bool:
    """ffmpeg 빌드에 adynamicequalizer 필터가 포함되어 있는지 확인."""
    global _ADYN_EQ_AVAILABLE
    if _ADYN_EQ_AVAILABLE is not None:
        return _ADYN_EQ_AVAILABLE
    try:
        proc = subprocess.run(
            [_FFMPEG_BIN, "-hide_banner", "-filters"],
            capture_output=True, text=True, timeout=10,
        )
        text = (proc.stdout or "") + (proc.stderr or "")
        _ADYN_EQ_AVAILABLE = "adynamicequalizer" in text
    except (FileNotFoundError, subprocess.TimeoutExpired) as exc:
        log("WARN", f"adynamicequalizer 검사 실패: {exc}")
        _ADYN_EQ_AVAILABLE = False
    log("INFO", f"adynamicequalizer available: {_ADYN_EQ_AVAILABLE}")
    return _ADYN_EQ_AVAILABLE


def _resolve_adyn_eq_mode_enum() -> dict[str, str]:
    """
    `adynamicequalizer` 의 mode enum 은 ffmpeg 6.x 와 7.x 에서 다르다.
      · 6.x : `cut` / `boost`
      · 7.x : `cutbelow` / `cutabove` / `boostbelow` / `boostabove`
    `ffmpeg -h filter=adynamicequalizer` 출력을 1회 파싱해 호환되는
    이름을 캐시한다.  enum 검출 실패 시 7.x 기본값을 가정.
    """
    global _ADYN_EQ_MODE_ENUM
    if _ADYN_EQ_MODE_ENUM is not None:
        return _ADYN_EQ_MODE_ENUM
    try:
        proc = subprocess.run(
            [_FFMPEG_BIN, "-hide_banner", "-h", "filter=adynamicequalizer"],
            capture_output=True, text=True, timeout=10,
        )
        text = (proc.stdout or "") + (proc.stderr or "")
    except (FileNotFoundError, subprocess.TimeoutExpired):
        text = ""
    cut_name   = "cutbelow"   if "cutbelow"   in text else "cut"
    boost_name = "boostbelow" if "boostbelow" in text else "boost"
    _ADYN_EQ_MODE_ENUM = {"cut": cut_name, "boost": boost_name}
    log("INFO", f"adynamicequalizer mode enum: {_ADYN_EQ_MODE_ENUM}")
    return _ADYN_EQ_MODE_ENUM


# ── 모드별 밴드 프리셋 ─────────────────────────────────────────────────────
# 각 밴드:
#   freq      — 중심 주파수 Hz
#   q         — Q 값
#   threshold — dBFS (이 레벨 이상에서 동작)
#   reduction — 임계 초과 시 감쇠량 (dB) 또는 임계 미달 시 부스트량
#   mode      — "cut" | "boost"
DYNAMIC_EQ_PRESETS: dict[str, list[dict[str, Any]]] = {
    "natural": [
        {"name": "sibilance",     "freq": 7500, "q": 1.6, "threshold": -22, "reduction": 1.5, "mode": "cut"},
    ],
    "balanced": [
        {"name": "sibilance",     "freq": 7500, "q": 1.6, "threshold": -22, "reduction": 2.0, "mode": "cut"},
        {"name": "harsh_highmid", "freq": 3500, "q": 1.4, "threshold": -20, "reduction": 1.5, "mode": "cut"},
        {"name": "muddy_lowmid",  "freq":  300, "q": 1.0, "threshold": -18, "reduction": 1.5, "mode": "cut"},
    ],
    "bright": [
        {"name": "sibilance",     "freq": 7500, "q": 1.8, "threshold": -20, "reduction": 2.5, "mode": "cut"},
        {"name": "air_dynamic",   "freq":12000, "q": 1.0, "threshold": -28, "reduction": 1.0, "mode": "boost"},
    ],
    "loud": [
        {"name": "boomy_low",     "freq":   90, "q": 1.2, "threshold": -16, "reduction": 2.5, "mode": "cut"},
        {"name": "muddy_lowmid",  "freq":  280, "q": 1.0, "threshold": -16, "reduction": 2.0, "mode": "cut"},
        {"name": "sibilance",     "freq": 7000, "q": 1.6, "threshold": -20, "reduction": 2.0, "mode": "cut"},
    ],
    # v3.4.6 — kpop_loud 텔레폰 사운드 방지: 저역 동적 cut 폭 대폭 축소.
    # v3.5 Phase 1 — Dynamic EQ 가 "tonal shaping" 이 아닌 "resonance
    # suppression only" 가 되도록 threshold 를 -16 → -10 으로 올림.
    # 이제 평균 신호 (-12 ~ -18 dB) 에서는 거의 발동 안 하고, 이상 피크
    # (-10 dB 이상) 에서만 작동.  reduction 도 모두 ≤ 1.5 dB 로 제한.
    "kpop_loud": [
        {"name": "boomy_low",     "freq":  100, "q": 1.2, "threshold": -10, "reduction": 1.0, "mode": "cut"},   # was thr=-14, red=1.2
        {"name": "muddy_lowmid",  "freq":  300, "q": 1.0, "threshold": -10, "reduction": 1.2, "mode": "cut"},   # was thr=-15, red=1.5
        {"name": "harsh_highmid", "freq": 3800, "q": 1.4, "threshold": -10, "reduction": 1.2, "mode": "cut"},   # was thr=-18, red=1.5
        {"name": "sibilance",     "freq": 7500, "q": 1.8, "threshold": -14, "reduction": 1.5, "mode": "cut"},   # sibilance 는 좀 더 쉽게 발동
        {"name": "vocal_presence","freq": 2500, "q": 1.0, "threshold": -22, "reduction": 0.8, "mode": "boost"}, # was red=1.0
    ],
    "warm": [
        {"name": "sibilance",     "freq": 7500, "q": 1.4, "threshold": -22, "reduction": 1.5, "mode": "cut"},
        {"name": "muddy_lowmid",  "freq":  280, "q": 1.0, "threshold": -18, "reduction": 1.5, "mode": "cut"},
    ],
    "punch": [
        {"name": "boomy_low",     "freq":  100, "q": 1.2, "threshold": -16, "reduction": 2.0, "mode": "cut"},
        {"name": "harsh_highmid", "freq": 3500, "q": 1.4, "threshold": -18, "reduction": 1.5, "mode": "cut"},
    ],
}

BAND_LABELS = {
    "sibilance":      "치찰음 제어 (7~8 kHz)",
    "harsh_highmid":  "고역 자극 제어 (3~5 kHz)",
    "muddy_lowmid":   "탁한 저중역 제어 (250~350 Hz)",
    "boomy_low":      "저역 부풀음 제어 (80~110 Hz)",
    "vocal_presence": "보컬 존재감 부스트 (2~3 kHz)",
    "air_dynamic":    "공기감 부스트 (12 kHz)",
}


# ── 빌더 ──────────────────────────────────────────────────────────────────────

def _adynamic_band(band: dict[str, Any], reduction: float) -> str | None:
    """ffmpeg adynamicequalizer 한 밴드.

    v3.5 Phase 1 — UNIT FIX:
      · `range` 파라미터는 ffmpeg 에서 LINEAR FACTOR 단위 (1.0 = no change,
        2.0 = 6 dB cut, 50 = 34 dB cut).  기존 코드는 이를 dB 로 잘못 알고
        `range = reduction * 1.5` 으로 설정해서 reduction=1.0 → range=2.0
        → 실제 -6 dB cut 발생 (의도는 -1 dB).
      · 수정: `range_linear = 10 ** (reduction_db / 20)` 로 정확히 dB → linear
        변환.  reduction=1.0 dB → range≈1.12 → max ±1 dB cut.
      · `threshold` 도 검증 결과 0 일 때만 bypass, > 0 이면 즉시 active 가
        되어 의도한 "peaks above threshold" 동작 안 함.  여기서는 그대로
        두되 사용자에게 "resonance suppression only" 가 되도록 reduction
        값을 낮게 유지함 (preset 에서 ≤ 1.5 dB).
    """
    threshold_db = float(band["threshold"])
    pct = (10.0 ** (threshold_db / 20.0)) * 100.0
    threshold_pct = max(0.1, min(99.9, pct))

    mode_str = _resolve_adyn_eq_mode_enum()["cut" if band["mode"] == "cut" else "boost"]
    ratio = max(1.0, min(8.0, 1.0 + reduction / 2.0))
    # CORRECT dB → linear conversion.  Floor at 1.05 (= ±0.42 dB) for
    # gentle resonance suppression; ceiling at 1.5 (= ±3.5 dB) hard safety.
    rng_linear = max(1.05, min(1.5, 10.0 ** (max(0.05, reduction) / 20.0)))
    return (
        f"adynamicequalizer=dfrequency={band['freq']}:dqfactor={band['q']}"
        f":tfrequency={band['freq']}:tqfactor={band['q']}"
        f":threshold={threshold_pct:.2f}:ratio={ratio:.2f}:range={rng_linear:.3f}"
        f":attack=20:release=200:mode={mode_str}"
    )


# v3.5 Phase 1 — fallback 강도 60% → 25%.  adynamicequalizer 미가용 시
# static EQ 가 *항상 작동* 하므로 강도가 낮아야 함.  60% 였을 때 LOW band
# 가 -1.8 dB 항상 cut 되어 텔레폰 사운드 fallback 경로의 단일 origin
# 이었음 (MASTERING_ARCHITECTURE_ANALYSIS.md 문제 #9 참조).
_FALLBACK_STRENGTH = 0.25

# v3.5 Phase 1 — 단일 band 절대 한도.  intensity / boomy_scale 곱셈 후
# 어떤 경우에도 ±1.5 dB 를 초과하지 않도록 hard clamp.
_MAX_SINGLE_BAND_REDUCTION_DB = 1.5


def _fallback_band(band: dict[str, Any], reduction: float) -> str | None:
    """정적 equalizer (동적의 25% 강도) 로 보수적 fallback."""
    if reduction < 0.05:
        return None
    static_gain = -reduction * _FALLBACK_STRENGTH if band["mode"] == "cut" \
                  else +reduction * _FALLBACK_STRENGTH
    return f"equalizer=f={band['freq']}:t=q:g={static_gain:.2f}:w={band['q']}"


def _adaptive_boomy_scale(low_to_mid_db: float | None) -> float:
    """v3.4.7 — return a multiplier for kpop_loud's boomy_low/muddy_lowmid
    reduction values based on input low/mid balance.

    Bass-light input → reduce the cut (don't kill what little bass there is).
    Bass-heavy input → keep or slightly increase the cut.
    None / unknown   → multiplier 1.0 (use preset value as-is).
    """
    if low_to_mid_db is None:
        return 1.0
    if low_to_mid_db < -10.0:
        return 0.3   # bass-light — very gentle
    if low_to_mid_db < -3.0:
        return 0.6   # neutral-light
    if low_to_mid_db < 3.0:
        return 1.0   # neutral — preset value
    if low_to_mid_db < 8.0:
        return 1.2   # neutral-heavy
    return 1.5       # bass-heavy — slightly more aggressive cut


def build_dynamic_eq_chain(
    mode: str,
    intensity: float = 1.0,
    use_adynamic_eq: bool | None = None,
    *,
    protection_log: list[dict] | None = None,
    low_to_mid_db: float | None = None,
    high_to_mid_db: float | None = None,
) -> dict[str, Any]:
    """
    모드 프리셋 기반 Dynamic EQ ffmpeg 필터 체인 생성.

    Args:
        mode: 마스터링 모드
        intensity: 0.0 ~ 2.0 — 모든 밴드 reduction/boost 양에 곱해지는 스케일
        use_adynamic_eq: True/False 강제 지정. None 이면 자동 가용성 검사.

    Returns:
        {
          "chain":  ffmpeg 필터 문자열 ("" 가능),
          "preset": 적용된 프리셋 이름 (또는 'disabled'),
          "engine": "adynamicequalizer" | "fallback" | "none",
          "bands":  적용된 밴드 메타 리스트,
        }
    """
    bands = DYNAMIC_EQ_PRESETS.get(mode, [])
    if not bands:
        return {"chain": "", "preset": "disabled", "engine": "none", "bands": []}

    intensity = max(0.0, min(2.0, float(intensity)))
    if intensity <= 0.001:
        return {"chain": "", "preset": "disabled", "engine": "none", "bands": []}

    if use_adynamic_eq is None:
        use_adynamic_eq = has_adynamic_equalizer()

    parts: list[str] = []
    band_meta: list[dict[str, Any]] = []
    engine = "adynamicequalizer" if use_adynamic_eq else "fallback"

    # v3.4.7 — adaptive scaling for kpop_loud's low-band cuts (boomy_low,
    # muddy_lowmid).  When the input is already bass-light, soften the cut;
    # when bass-heavy, keep or slightly increase it.  Other modes / bands
    # use the preset value unchanged (multiplier 1.0).
    boomy_scale = (_adaptive_boomy_scale(low_to_mid_db)
                    if mode == "kpop_loud" else 1.0)

    for band in bands:
        per_band_scale = (boomy_scale
                          if band.get("name") in ("boomy_low", "muddy_lowmid")
                          else 1.0)
        scaled = round(band["reduction"] * intensity * per_band_scale, 2)
        # v3.5 Phase 1 — single-band hard cap.  After all multipliers, no
        # single band reduction may exceed ±1.5 dB.  Combined with the
        # vocal-protection clamp at 2.5 dB this caps the WORST case
        # dynamic-EQ effect on any band.
        if scaled > _MAX_SINGLE_BAND_REDUCTION_DB:
            if protection_log is not None:
                protection_log.append({
                    "where":    f"dynamic_eq.{band['name']}.single_band_cap",
                    "original": scaled,
                    "clamped":  _MAX_SINGLE_BAND_REDUCTION_DB,
                    "reason":   "v3.5: dynamic EQ single-band reduction "
                                "capped at 1.5 dB (resonance suppression only).",
                })
            scaled = _MAX_SINGLE_BAND_REDUCTION_DB
        if scaled < 0.05:
            continue
        # Vocal-protection clamp: 1.5–5 kHz cut amount ≤ 2.5 dB
        clamped = clamp_vocal_band_cut(float(band["freq"]), scaled, str(band["mode"]))
        if clamped < scaled - 0.005:
            if protection_log is not None:
                protection_log.append({
                    "where":    f"dynamic_eq.{band['name']}@{band['freq']}Hz",
                    "original": scaled,
                    "clamped":  round(clamped, 2),
                    "reason":   "vocal protection: 1.5-5 kHz cut limited to 2.5 dB",
                })
            scaled = round(clamped, 2)
            if scaled < 0.05:
                continue
        f = _adynamic_band(band, scaled) if use_adynamic_eq else _fallback_band(band, scaled)
        if not f:
            continue
        parts.append(f)
        band_meta.append({
            "name":      band["name"],
            "label":     BAND_LABELS.get(band["name"], band["name"]),
            "freq":      band["freq"],
            "q":         band["q"],
            "threshold": band["threshold"],
            "reduction": scaled,
            "mode":      band["mode"],
            "engine":    engine,
        })

    return {
        "chain":  ",".join(parts),
        "preset": mode,
        "engine": engine if parts else "none",
        "bands":  band_meta,
    }
