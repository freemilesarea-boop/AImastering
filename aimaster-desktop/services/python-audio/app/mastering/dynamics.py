"""
Stage 4: Bus compression — cohesion and density, not over-processing.

Revised parameters provide 2-4 dB of peak gain reduction on typical programme
material, which is enough to add perceived density and cohesion without
squashing transients or reducing LRA below commercial norms (floor 4 LU).

The compressor runs BEFORE loudnorm, so its job is tonal shaping and
transient control, not loudness.  Loudnorm handles the final LUFS target.

Per-style intent:
  Balanced — moderate glue, preserve dynamics fully
  Warm     — slower, vintage "breathe" feel; adds body
  Bright   — faster attack to tame the presence boosts
  Punch    — most gain reduction; tightens the dynamic envelope for impact
"""
from __future__ import annotations

from app.utils.logger import log
from app.utils.vocal_protection import clamp_compressor_params

# ── Per-style compressor parameters ───────────────────────────────────────────

# v3.3 — 컴프레서는 "글루 / 음색" 역할로만 사용한다.  메이크업 게인 / ratio 를
# 낮춰 메인 멜로디 transient 가 살아남도록 함.  loudness push 는 final loudness
# matching 단계에서만 처리한다.  과거 makeup 1.5~2.0 dB 가 entry gain 과
# 합쳐져 보컬 뭉개짐의 주 원인이었다.
_STYLE_COMP: dict[str, dict] = {

    # Natural — 거의 무처리에 가까운 가벼운 글루
    "natural": {
        "threshold": -22,
        "ratio":     1.3,    # was 1.4
        "attack":    50,
        "release":   200,
        "makeup":    0.5,    # was 1.0
        "knee":      10.0,
    },

    "balanced": {
        "threshold": -20,
        "ratio":     1.6,    # was 1.8 — 보컬 transient 통과
        "attack":    40,     # was 35 — 살짝 느리게
        "release":   180,    # was 150 — 자연스럽게 풀어줌
        "makeup":    0.5,    # was 1.5 — push 거의 없음
        "knee":      10.0,   # was 8.0 — 더 부드러운 진입
    },

    "warm": {
        "threshold": -18,
        "ratio":     1.8,    # was 2.0
        "attack":    45,     # was 40 — transient breathe
        "release":   200,    # was 180
        "makeup":    0.7,    # was 1.5
        "knee":      12.0,   # was 10.0
    },

    # Bright — 고역 transient 를 누르지 말 것
    "bright": {
        "threshold": -18,
        "ratio":     1.5,    # was 1.6
        "attack":    35,     # was 30
        "release":   160,    # was 140
        "makeup":    0.5,    # was 1.0
        "knee":      10.0,   # was 8.0
    },

    "punch": {
        "threshold": -18,
        "ratio":     2.0,    # was 2.5 — punch 도 transient 보존 우선
        "attack":    20,     # was 15
        "release":   100,    # was 80
        "makeup":    0.8,    # was 2.0
        "knee":      6.0,    # was 4.0
    },

    # Loud — 글루는 유지하되 makeup 은 거의 없음.
    # final loudness match 단계에서 push 하므로 컴프 단계에서 미리 키울 필요 없다.
    "loud": {
        "threshold": -16,
        "ratio":     2.0,    # was 2.5
        "attack":    18,     # was 12 — transient 보존
        "release":   110,    # was 90
        "makeup":    0.5,    # was 2.0 — 보컬 뭉개짐 직격 원인
        "knee":      6.0,    # was 4.0
    },

    # KPOP Loud — 가장 강한 글루 + 빠른 attack 이었으나, 메인 멜로디 보존을
    # 우선하도록 ratio / attack 완화.  Loudness 는 final 단계에서.
    "kpop_loud": {
        "threshold": -14,
        "ratio":     2.2,    # was 2.8 — main melody transient 보존
        "attack":    15,     # was 10 — vocal pick 통과
        "release":   100,    # was 80
        "makeup":    0.7,    # was 2.0
        "knee":      5.0,    # was 3.0 — soft knee
    },
}

# v3.3 — 자동 makeup 의 절대 한도.  2.0 dB 초과 push 는 metadata 에만 기록되고
# 실제 적용은 1.0 dB 까지만 (loudness push 는 final stage 의 책임).
_MAX_MAKEUP_DB = 1.0  # was 3.0


def build_dynamics_filter(
    style: str,
    input_peak_db: float = 0.0,
    *,
    protection_log: list[dict] | None = None,
) -> str:
    """
    Return comma-separated FFmpeg filter string (Stage 4).

    Vocal-protection clamps (ratio ≤ 2.0, attack ≥ 25 ms, makeup ≤ 0.7 dB)
    are applied unconditionally.  When `protection_log` is provided, every
    clamp the engine had to make is appended so the pipeline can surface
    "보컬 보호 모드 적용됨" to the user.
    """
    parts: list[str] = []

    # Pre-gain reduction only for actually clipped input (>= 0 dBFS).
    if input_peak_db >= 0.0:
        target_peak = -3.0
        reduction_db = target_peak - input_peak_db
        if reduction_db < -0.1:
            parts.append(f"volume={reduction_db:.2f}dB")
            log("INFO", f"Pre-gain: {reduction_db:.2f} dB (input peak={input_peak_db:.2f} dBFS)")

    c = _STYLE_COMP.get(style, _STYLE_COMP["balanced"])
    # Vocal-protection clamp: ratio ≤ 2.0, attack ≥ 25 ms, makeup ≤ 0.7 dB
    c_protected, applied_clamps = clamp_compressor_params(c)
    if protection_log is not None:
        protection_log.extend(applied_clamps)
    makeup = min(float(c_protected["makeup"]), _MAX_MAKEUP_DB)

    parts.append(
        f"acompressor="
        f"threshold={c_protected['threshold']}dB"
        f":ratio={c_protected['ratio']}"
        f":attack={c_protected['attack']}"
        f":release={c_protected['release']}"
        f":makeup={makeup}dB"
        f":knee={c_protected['knee']}dB"
        f":level_in=1"
    )

    return ",".join(p for p in parts if p)


def get_comp_params(style: str) -> dict:
    """Return compressor parameters for analysis report (vocal-protected)."""
    raw = dict(_STYLE_COMP.get(style, _STYLE_COMP["balanced"]))
    protected, _ = clamp_compressor_params(raw)
    return protected


def estimate_comp_gr(style: str, input_peak_db: float) -> float:
    """
    Rough estimate of compressor gain reduction (dB) based on input peak.
    Uses average-level approximation: avg ≈ peak − 8 dB for typical programme.
    Returns 0.0 when the signal is below threshold.
    """
    c = _STYLE_COMP.get(style, _STYLE_COMP["balanced"])
    threshold = float(c["threshold"])
    ratio     = float(c["ratio"])
    avg_level = input_peak_db - 8.0   # typical peak-to-average for music
    if avg_level <= threshold:
        return 0.0
    above = avg_level - threshold
    gr    = above * (1.0 - 1.0 / ratio)
    return round(gr, 1)


def describe_dynamics(style: str) -> str:
    """Human-readable compressor summary for the appliedCorrections list."""
    c = _STYLE_COMP.get(style, _STYLE_COMP["balanced"])
    return (
        f"{style.capitalize()} 버스 컴프 — "
        f"threshold {c['threshold']} dBFS, ratio {c['ratio']}:1, "
        f"attack {c['attack']} ms, release {c['release']} ms, "
        f"makeup {c['makeup']} dB"
    )
