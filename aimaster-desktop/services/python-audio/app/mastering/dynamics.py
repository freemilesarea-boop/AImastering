"""
Stage 4: Bus compression — gentle glue, not limiting.

Spec requirements:
  - Ratio: 1.5:1 ~ 2:1  (never higher — protect dynamics)
  - Attack: slow 20-40 ms (preserve transients)
  - Release: medium 80-150 ms
  - Gain reduction: max 2-3 dB
  - Over-compression is FORBIDDEN — LRA must stay above 4 LU after processing

The compressor runs BEFORE loudnorm, so its job is to even out
dynamic peaks (glue), not to raise perceived loudness. Loudness
is handled by the loudnorm stage and the final limiter.

Makeup gain is intentionally conservative (≤ 1.5 dB) to avoid
pushing levels into the boosted EQ zones and causing harshness.
"""
from __future__ import annotations

from app.utils.logger import log

# ── Per-style compressor parameters ───────────────────────────────────────────

_STYLE_COMP: dict[str, dict] = {

    # Balanced: barely-there glue — preserve dynamics completely
    "balanced": {
        "threshold": -20,
        "ratio":     1.5,    # very gentle
        "attack":    35,     # slow — let transients through
        "release":   150,
        "makeup":    1.0,
        "knee":      10.0,   # soft knee — gentle onset
    },

    # Warm: slow attack for vintage feel; release matches low-end decay
    "warm": {
        "threshold": -18,
        "ratio":     1.8,
        "attack":    30,
        "release":   120,
        "makeup":    1.0,
        "knee":      8.0,
    },

    # Bright: slightly faster to tame transient harshness; same gentle ratio
    "bright": {
        "threshold": -20,
        "ratio":     2.0,
        "attack":    20,     # faster — controls harsh transients in bright mixes
        "release":   100,
        "makeup":    1.0,
        "knee":      6.0,
    },

    # Punch: moderate bus-comp feel; attack fast enough for kick snap
    "punch": {
        "threshold": -18,
        "ratio":     2.0,
        "attack":    15,     # shortest acceptable — preserves kick attack
        "release":   80,
        "makeup":    1.5,
        "knee":      5.0,
    },
}

# Hard ceiling on makeup gain — prevents compressor from doing loudnorm's job
_MAX_MAKEUP_DB = 2.0


def build_dynamics_filter(
    style: str,
    input_peak_db: float = 0.0,
) -> str:
    """
    Build a bus compressor (and optional pre-gain) FFmpeg filter string.

    input_peak_db: sample peak in dBFS.
                   If ≥ -0.5 dBFS, a pre-gain reduction is inserted
                   to prevent the compressor from slamming a clipped signal.

    Returns a comma-separated filter string (may be empty if nothing needed).
    """
    parts: list[str] = []

    # ── Pre-gain for clipped input ─────────────────────────────────────────
    if input_peak_db >= -0.5:
        target_peak = -3.0
        reduction_db = target_peak - input_peak_db
        if reduction_db < -0.1:
            parts.append(f"volume={reduction_db:.2f}dB")
            log("INFO", f"Pre-gain: {reduction_db:.2f} dB (input peak={input_peak_db:.2f} dBFS)")

    # ── Bus compressor ─────────────────────────────────────────────────────
    c = _STYLE_COMP.get(style, _STYLE_COMP["balanced"])
    makeup = min(c["makeup"], _MAX_MAKEUP_DB)

    comp = (
        f"acompressor="
        f"threshold={c['threshold']}dB"
        f":ratio={c['ratio']}"
        f":attack={c['attack']}"
        f":release={c['release']}"
        f":makeup={makeup}dB"
        f":knee={c['knee']}dB"
        f":level_in=1"
    )
    parts.append(comp)

    return ",".join(p for p in parts if p)


def describe_dynamics(style: str) -> str:
    """Human-readable description of the compressor for the result payload."""
    c = _STYLE_COMP.get(style, _STYLE_COMP["balanced"])
    return (
        f"{style.capitalize()} 버스 컴프 — "
        f"threshold {c['threshold']} dBFS, ratio {c['ratio']}:1, "
        f"attack {c['attack']} ms, release {c['release']} ms"
    )
