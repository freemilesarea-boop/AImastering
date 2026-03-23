"""
Stage 4: Dynamic control.

Principles (from spec):
  - Over-compression is forbidden — protect the source.
  - Conservative processing is always preferred over aggressive processing.
  - Peak control happens here (before loudnorm), not by pushing RMS up.
  - If input is clipped (peak ≥ 0 dBFS), reduce level first.
  - Compressor settings are style-aware but always "bus glue" level, not
    single-instrument limiting.

FFmpeg filter reference:
  acompressor=threshold=<dBFS>:ratio=<n>:attack=<ms>:release=<ms>
              :makeup=<dBFS>:knee=<dBFS>:level_in=<gain>
"""
from __future__ import annotations

from app.utils.logger import log

# ── Per-style compressor parameters ───────────────────────────────────────────

_STYLE_COMP: dict[str, dict] = {

    # Balanced: very light touch — only gentle glue, transient preserved
    "balanced": {
        "threshold": -20,
        "ratio":     2.0,
        "attack":    20,
        "release":   250,
        "makeup":    1.0,
        "knee":      8.0,
    },

    # Warm: slow attack preserves transients; forgiving release
    "warm": {
        "threshold": -18,
        "ratio":     2.0,
        "attack":    30,
        "release":   300,
        "makeup":    1.5,
        "knee":      8.0,
    },

    # Bright: slightly faster and more transparent; still gentle
    "bright": {
        "threshold": -20,
        "ratio":     2.5,
        "attack":    15,
        "release":   200,
        "makeup":    1.5,
        "knee":      5.0,
    },

    # Punch: bus-comp feel; faster attack for density; higher ratio for weight
    "punch": {
        "threshold": -16,
        "ratio":     3.5,
        "attack":     8,
        "release":   120,
        "makeup":    2.0,
        "knee":      4.0,
    },
}

# Absolute ceiling for pre-loudnorm makeup gain — prevent over-boosting RMS
_MAX_MAKEUP_DB = 3.0


def build_dynamics_filter(
    style: str,
    input_peak_db: float = 0.0,
) -> str:
    """
    Build a compressor (and optional pre-gain) FFmpeg filter string.

    input_peak_db : sample peak in dBFS of the input file.
                    If ≥ 0 dB, a pre-gain reduction is inserted to prevent
                    the compressor from slamming against a clipped signal.

    Returns a comma-separated filter string (may be empty if no processing
    is needed).
    """
    parts: list[str] = []

    # ── Pre-gain for clipped input ─────────────────────────────────────────
    # Reduce level so the peak lands at -3 dBFS before the compressor.
    if input_peak_db >= -0.5:
        target_peak = -3.0
        reduction_db = target_peak - input_peak_db
        if reduction_db < -0.1:   # only if we actually need to reduce
            parts.append(f"volume={reduction_db:.2f}dB")
            log("INFO", f"Pre-gain: {reduction_db:.2f} dB (input peak={input_peak_db:.2f} dBFS)")

    # ── Compressor ────────────────────────────────────────────────────────
    c = _STYLE_COMP.get(style, _STYLE_COMP["balanced"])

    # Cap makeup to prevent excessive RMS push
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
    """Human-readable description of what the compressor is doing."""
    c = _STYLE_COMP.get(style, _STYLE_COMP["balanced"])
    return (
        f"{style.capitalize()} 다이내믹 — "
        f"threshold {c['threshold']} dBFS, ratio {c['ratio']}:1, "
        f"attack {c['attack']} ms, release {c['release']} ms"
    )
