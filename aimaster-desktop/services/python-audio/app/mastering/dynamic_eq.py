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
    # boomy_low / muddy_lowmid 가 EQ overlay 의 (구) -1.5 dB 80Hz cut 과
    # 누적되어 저역을 5 dB 이상 깎던 패턴을 제거.
    "kpop_loud": [
        {"name": "boomy_low",     "freq":  100, "q": 1.2, "threshold": -14, "reduction": 1.2, "mode": "cut"},   # was thr=-16, red=2.5
        {"name": "muddy_lowmid",  "freq":  300, "q": 1.0, "threshold": -15, "reduction": 1.5, "mode": "cut"},   # was thr=-16, red=2.0
        {"name": "harsh_highmid", "freq": 3800, "q": 1.4, "threshold": -18, "reduction": 1.5, "mode": "cut"},   # was red=2.0
        {"name": "sibilance",     "freq": 7500, "q": 1.8, "threshold": -20, "reduction": 2.0, "mode": "cut"},   # was red=2.5
        {"name": "vocal_presence","freq": 2500, "q": 1.0, "threshold": -26, "reduction": 1.0, "mode": "boost"},
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
    """ffmpeg adynamicequalizer 한 밴드.  threshold 는 amplitude-percent."""
    threshold_db = float(band["threshold"])
    pct = (10.0 ** (threshold_db / 20.0)) * 100.0
    threshold_pct = max(0.1, min(99.9, pct))

    mode_str = _resolve_adyn_eq_mode_enum()["cut" if band["mode"] == "cut" else "boost"]
    ratio = max(1.0, min(8.0, 1.0 + reduction / 2.0))
    rng   = max(2.0, min(24.0, reduction * 1.5))
    return (
        f"adynamicequalizer=dfrequency={band['freq']}:dqfactor={band['q']}"
        f":tfrequency={band['freq']}:tqfactor={band['q']}"
        f":threshold={threshold_pct:.2f}:ratio={ratio:.2f}:range={rng:.2f}"
        f":attack=20:release=200:mode={mode_str}"
    )


def _fallback_band(band: dict[str, Any], reduction: float) -> str | None:
    """정적 equalizer (동적의 60% 강도) 로 보수적 fallback."""
    if reduction < 0.05:
        return None
    static_gain = -reduction * 0.6 if band["mode"] == "cut" else +reduction * 0.6
    return f"equalizer=f={band['freq']}:t=q:g={static_gain:.2f}:w={band['q']}"


def build_dynamic_eq_chain(
    mode: str,
    intensity: float = 1.0,
    use_adynamic_eq: bool | None = None,
    *,
    protection_log: list[dict] | None = None,
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

    for band in bands:
        scaled = round(band["reduction"] * intensity, 2)
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
