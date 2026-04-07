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

# ── Per-style compressor parameters ───────────────────────────────────────────

_STYLE_COMP: dict[str, dict] = {

    "balanced": {
        "threshold": -20,
        "ratio":     1.8,
        "attack":    35,
        "release":   150,
        "makeup":    1.5,
        "knee":      8.0,
    },

    "warm": {
        "threshold": -18,
        "ratio":     2.0,
        "attack":    40,    # slow attack — transients breathe through
        "release":   180,
        "makeup":    1.5,
        "knee":      10.0,
    },

    "bright": {
        "threshold": -20,
        "ratio":     2.0,
        "attack":    20,    # faster — controls harshness from presence boosts
        "release":   100,
        "makeup":    1.5,
        "knee":      6.0,
    },

    "punch": {
        "threshold": -18,
        "ratio":     2.5,
        "attack":    15,
        "release":   80,
        "makeup":    2.0,
        "knee":      4.0,
    },
}

_MAX_MAKEUP_DB = 3.0


def build_dynamics_filter(
    style: str,
    input_peak_db: float = 0.0,
) -> str:
    """Return comma-separated FFmpeg filter string (Stage 4)."""
    parts: list[str] = []

    # Pre-gain reduction only for actually clipped input (>= 0 dBFS).
    # Previously this triggered at -0.5 dBFS, which hit almost every
    # commercial track and silently reduced gain before the compressor,
    # causing perceived volume loss even after loudnorm compensation.
    if input_peak_db >= 0.0:
        target_peak = -3.0
        reduction_db = target_peak - input_peak_db
        if reduction_db < -0.1:
            parts.append(f"volume={reduction_db:.2f}dB")
            log("INFO", f"Pre-gain: {reduction_db:.2f} dB (input peak={input_peak_db:.2f} dBFS)")

    c = _STYLE_COMP.get(style, _STYLE_COMP["balanced"])
    makeup = min(c["makeup"], _MAX_MAKEUP_DB)

    parts.append(
        f"acompressor="
        f"threshold={c['threshold']}dB"
        f":ratio={c['ratio']}"
        f":attack={c['attack']}"
        f":release={c['release']}"
        f":makeup={makeup}dB"
        f":knee={c['knee']}dB"
        f":level_in=1"
    )

    return ",".join(p for p in parts if p)


def get_comp_params(style: str) -> dict:
    """Return compressor parameters for analysis report."""
    return dict(_STYLE_COMP.get(style, _STYLE_COMP["balanced"]))


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
