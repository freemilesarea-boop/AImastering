"""
Stage 3: Streaming-optimized tone correction.

Architecture (applied in this order):
  1. AI artifact corrections   (pre-pended when detected)
  2. Base streaming EQ         (adaptive: low density + mud cut + air shelf)
  3. Style-specific overlay    (character on top of base)

Base streaming EQ rationale:
  Every commercial streaming track needs three things:
    - Low-end density at 60-120 Hz  → perceived loudness without pushing LUFS
    - Mud cut at 200-300 Hz         → clarity and punch
    - Air shelf at 8-12 kHz         → brightness and presence

  The amount of boost/cut adapts to the spectral balance measured from
  the input file so bass-heavy tracks get less boost and dark tracks
  get more air.

Style overlays modify the character on top of the base:
  Balanced — base EQ only; flat, transparent
  Warm     — rolls off some high-end; adds low-mid body
  Bright   — more air; stronger presence
  Punch    — emphasizes 2-3 kHz attack; tighter low end
"""
from __future__ import annotations

# ── Spectral balance → adaptive EQ parameter tables ──────────────────────────
#
# low_to_mid_db thresholds (low_energy_db − mid_energy_db):
#   < -20  → very bass-light  → maximum low boost
#   -20..-13 → moderate bass  → standard low boost
#   -13..-6  → bass-adequate  → gentle low boost
#   > -6   → bass-heavy       → minimum low boost
#
# high_to_mid_db thresholds (high_energy_db − mid_energy_db):
#   < -28  → very dark        → maximum air boost
#   -28..-20 → moderate dark  → standard air boost
#   > -20  → already bright   → minimal air boost

def _adaptive_low_boost(low_to_mid_db: float) -> float:
    """Return boost gain (dB) for the 80 Hz low-end density bell."""
    if low_to_mid_db < -20.0:
        return 2.5
    if low_to_mid_db < -13.0:
        return 2.0
    if low_to_mid_db < -6.0:
        return 1.5
    return 1.0   # bass-heavy track — minimum density boost


def _adaptive_air_boost(high_to_mid_db: float) -> float:
    """Return gain (dB) for the 10 kHz high-shelf air boost."""
    if high_to_mid_db < -28.0:
        return 2.0
    if high_to_mid_db < -20.0:
        return 1.5
    return 1.0   # already bright — minimal shelf


# ── Base streaming EQ builder ─────────────────────────────────────────────────

def _build_base_eq(low_to_mid_db: float, high_to_mid_db: float) -> list[str]:
    """
    Three-band streaming-optimized EQ applied to every style.

      1. Low-end density bell  80 Hz  +1.0 ~ +2.5 dB  (adaptive, wide Q)
      2. Mud cut               250 Hz  -1.5 dB          (fixed, medium Q)
      3. Air shelf             10 kHz +1.0 ~ +2.0 dB  (adaptive)
    """
    low_gain = _adaptive_low_boost(low_to_mid_db)
    air_gain = _adaptive_air_boost(high_to_mid_db)

    return [
        # Low-end density: wide bell at 80 Hz (w=2.0 octaves ≈ 40–160 Hz)
        f"equalizer=f=80:t=o:w=2.0:g=+{low_gain:.1f}",
        # Mud cut: narrows boxiness around 250 Hz
        "equalizer=f=250:t=o:w=1.0:g=-1.5",
        # Air shelf: adds openness above 10 kHz
        f"highshelf=f=10000:g=+{air_gain:.1f}",
    ]


# ── Style-specific overlay ────────────────────────────────────────────────────
# Applied ON TOP of base streaming EQ. Keep these conservative —
# the base EQ already handles the heavy lifting.

_STYLE_OVERLAY: dict[str, list[str]] = {

    # Balanced: base EQ only — transparent, streaming-neutral
    "balanced": [],

    # Warm: pull back upper mids and air; add low-mid body
    # Goal: reduce harshness, cozy analog character
    "warm": [
        # Tame upper-mid edge (3.5 kHz)
        "equalizer=f=3500:t=o:w=1.5:g=-1.5",
        # Add low-mid body (200 Hz)
        "equalizer=f=200:t=o:w=1.0:g=+0.5",
        # Roll off top-end slightly (counter the air shelf)
        "highshelf=f=8000:g=-1.5",
    ],

    # Bright: more presence and air on top of base
    # Goal: modern, detailed, forward sound
    "bright": [
        # Presence lift around 5 kHz (adds definition)
        "equalizer=f=5000:t=o:w=1.0:g=+0.8",
        # Extra air: narrow addition at 12 kHz
        "equalizer=f=12000:t=o:w=1.0:g=+0.8",
        # De-ess safety at 8 kHz (prevent sibilance from combined boosts)
        "equalizer=f=8000:t=o:w=0.8:g=-1.5",
    ],

    # Punch: tighter low end, more attack presence
    # Goal: kick/bass density, transient definition
    "punch": [
        # Sub-kick tightening: narrow bell at 60 Hz
        "equalizer=f=60:t=o:w=0.8:g=+1.0",
        # Extra mud cut (complement the base 250 Hz cut)
        "equalizer=f=350:t=o:w=0.8:g=-1.0",
        # Attack presence at 2.5 kHz (narrow, controlled)
        "equalizer=f=2500:t=o:w=0.8:g=+1.0",
    ],
}

# ── AI artifact correction notches ────────────────────────────────────────────

_AI_CORRECTIONS: dict[str, str] = {
    "harshHighMid": "equalizer=f=4000:t=o:w=2.0:g=-3.0",
    "boomyLowEnd":  "equalizer=f=120:t=o:w=1.0:g=-4.0",
}


# ── Public API ────────────────────────────────────────────────────────────────

def build_eq_filter(
    style: str,
    *,
    low_to_mid_db: float = -15.0,
    high_to_mid_db: float = -22.0,
    ai_detections: dict[str, bool] | None = None,
    apply_ai_corrections: bool = True,
) -> str:
    """
    Build a comma-separated FFmpeg audio filter string.

    Filter order:
      1. AI artifact corrections (if enabled and detected)
      2. Base streaming EQ       (adaptive low density + mud cut + air)
      3. Style overlay           (character filters)

    Args:
        style:            "balanced" | "warm" | "bright" | "punch"
        low_to_mid_db:    spectral ratio from WaveformStats (low - mid, dB)
        high_to_mid_db:   spectral ratio from WaveformStats (high - mid, dB)
        ai_detections:    flags from analyzer (harshHighMid, boomyLowEnd, ...)
        apply_ai_corrections: whether to prepend AI correction notches

    Returns empty string when no filters are needed (balanced + no AI issues).
    """
    parts: list[str] = []

    # 1. AI corrections
    if apply_ai_corrections and ai_detections:
        for key, filt in _AI_CORRECTIONS.items():
            if ai_detections.get(key):
                parts.append(filt)

    # 2. Base streaming EQ
    parts.extend(_build_base_eq(low_to_mid_db, high_to_mid_db))

    # 3. Style overlay
    overlay = _STYLE_OVERLAY.get(style, _STYLE_OVERLAY["balanced"])
    parts.extend(overlay)

    return ",".join(p for p in parts if p)
