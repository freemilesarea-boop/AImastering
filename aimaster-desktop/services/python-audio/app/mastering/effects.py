"""
Stage 4.5 — Glue effects: harmonic saturation, stereo widening, soft clipper.

These run AFTER bus compression and BEFORE loudnorm/limiter.  They add the
"commercial polish" that mass-market mastering plugins (Ozone, Pro-L 2, etc.)
provide without precisely replicating any of them — implemented entirely via
ffmpeg's built-in `compand`, `extrastereo` and `equalizer` filters.

Public functions return ffmpeg filter strings (or empty string when disabled)
so they can be joined into the pre_filter chain.
"""
from __future__ import annotations


# ─────────────────────────────────────────────────────────────────────────────
# Per-mode default saturation / stereo width / de-esser
# ─────────────────────────────────────────────────────────────────────────────

_MODE_DEFAULTS: dict[str, dict] = {
    # Phase-C (audit 2026-05): `stereo_width` (legacy, mono-unsafe
    # extrastereo) is now neutralized to 1.0 across all modes.  All
    # stereo widening flows through `stereo_enhance_amount` which uses
    # the new M/S decode + low-end mono protection (always-on when > 1.0).
    "natural":   {"saturation": 0.0,  "stereo_width": 1.0, "deesser": False, "stereo_enhance_amount": 1.0},
    "balanced":  {"saturation": 0.20, "stereo_width": 1.0, "deesser": False, "stereo_enhance_amount": 1.05},
    # Bright: saturation 과 deesser 를 모두 비활성 → 고역 보존
    "bright":    {"saturation": 0.0,  "stereo_width": 1.0, "deesser": False, "stereo_enhance_amount": 1.10},
    "warm":      {"saturation": 0.15, "stereo_width": 1.0, "deesser": True,  "stereo_enhance_amount": 1.0},
    "punch":     {"saturation": 0.30, "stereo_width": 1.0, "deesser": False, "stereo_enhance_amount": 1.05},
    # v3.5 Phase 1 — saturation 단계가 측정상 no-op 이었으므로 (compand
    # transfer curve 가 RMS 에 거의 영향 없음) loud / kpop_loud 의
    # saturation 을 0 으로 두고 그 효과 (warm even-harmonics) 를 compressor
    # knee 확장으로 대체.  chain 한 단계 단축 + 고역 가속 위험 제거.
    "loud":      {"saturation": 0.0, "stereo_width": 1.0, "deesser": False, "stereo_enhance_amount": 1.10},
    "kpop_loud": {"saturation": 0.0, "stereo_width": 1.0, "deesser": False, "stereo_enhance_amount": 1.15},
}


def get_mode_defaults(mode: str) -> dict:
    return dict(_MODE_DEFAULTS.get(mode, _MODE_DEFAULTS["balanced"]))


# ─────────────────────────────────────────────────────────────────────────────
# Saturation — gentle waveshaping via compand transfer curve
# ─────────────────────────────────────────────────────────────────────────────

def saturation_filter(amount: float) -> str:
    """
    `amount` 0.0 (off) ~ 1.0 (강함).
    낮은 레벨은 그대로 통과, 중상위 레벨에 부드러운 곡선을 적용해 짝수 차 고조파를
    만들어낸다.  `compand` 의 attacks=0/decays=0 모드를 사용해 waveshaper 처럼 동작.
    """
    a = max(0.0, min(1.0, amount))
    if a <= 0.001:
        return ""
    p_minus3 = round(-3.0 - 0.4 * a, 2)
    p_minus1 = round(-1.0 - 0.7 * a, 2)
    p_zero   = round(0.0  - 1.0 * a, 2)
    points = (
        f"-90/-90"
        f"|-30/-30"
        f"|-12/-12"
        f"|-6/-6"
        f"|-3/{p_minus3}"
        f"|-1/{p_minus1}"
        f"|0/{p_zero}"
    )
    return f"compand=attacks=0:decays=0:points={points}"


# ─────────────────────────────────────────────────────────────────────────────
# Stereo widening — extrastereo m=...
# ─────────────────────────────────────────────────────────────────────────────

def stereo_width_filter(width: float) -> str:
    """1.0 = passthrough, >1.0 = wider, <1.0 = narrower."""
    if abs(width - 1.0) < 0.01:
        return ""
    w = max(0.0, min(2.5, width))
    return f"extrastereo=m={w:.2f}:c=0"


# ─────────────────────────────────────────────────────────────────────────────
# Soft clipper — gentle ceiling shaping via compand transfer curve
# ─────────────────────────────────────────────────────────────────────────────

def soft_clipper_filter(ceiling_dbtp: float) -> str:
    """
    True peak limiter 직전 단계.  ceiling_dbtp 근처에서 부드럽게 휘어지는 곡선.
    """
    c = max(-3.0, min(-0.1, ceiling_dbtp))
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


# ─────────────────────────────────────────────────────────────────────────────
# Lightweight de-esser — static dip in 5~7 kHz region
# ─────────────────────────────────────────────────────────────────────────────

def deesser_filter() -> str:
    """6.5 kHz 부근 -1.5 dB peaking dip — sibilance 완화 (정적, 가벼운 효과)."""
    return "equalizer=f=6500:t=o:w=1.5:g=-1.5"
