"""
Stage 3: Adaptive streaming EQ — audible tonal shaping, commercially tasteful.

Design principles:
  - Every band adapts to the measured spectral balance of the input, so
    bass-light tracks get more low boost and dark tracks get more air, while
    already-balanced tracks receive a lighter touch.
  - Minimum effective floors ensure the mastering output is always audibly
    different from the source — not just louder — even on well-balanced mixes.
  - Gains are deliberately larger than a "final mix bus" would use because the
    loudnorm stage that follows applies a gain correction that partially offsets
    absolute level changes.  The spectral shape (the ratio between bands) is
    preserved by EQ and survives loudnorm.  A +3.5 dB boost at 80 Hz produces
    roughly +2.5-3 dB of perceived bass increase in the output.
  - Nothing is boosted beyond 4.5 dB or cut beyond -3.5 dB in a single band
    to avoid unnatural tonal hyping.

Band layout (base, applied to every style):
  1  80 Hz  bell  +2.0 ~ +4.0 dB  primary bass density         (adaptive)
  2 120 Hz  bell  +0.8 ~ +1.6 dB  upper-bass punch supplement  (40% of #1)
  3 250 Hz  bell  -3.0 dB         main mud/boxiness removal     (fixed)
  4 320 Hz  bell  -1.0 dB         secondary nasal cut           (fixed)
  5  10kHz  shelf +2.0 ~ +3.5 dB  air and openness              (adaptive)
  6   8kHz  bell  +0.8 ~ +1.4 dB  presence and clarity          (40% of #5)

Spectral balance thresholds used for adaptation:
  low_to_mid_db (= low_band_rms − mid_band_rms):
    < -20  → very bass-light  → maximum low boost (4.0 dB)
    -20..-13 → moderate       → standard boost    (3.5 dB)
    -13..-6  → adequate       → gentle boost      (2.5 dB)
    > -6   → bass-heavy       → minimum floor     (2.0 dB)

  high_to_mid_db (= high_band_rms − mid_band_rms):
    < -28  → very dark        → maximum air (3.5 dB)
    -28..-20 → moderate dark  → standard    (2.8 dB)
    > -20  → already bright   → minimum     (2.0 dB)
"""
from __future__ import annotations

from dataclasses import dataclass, field


# ── Adaptive helpers ──────────────────────────────────────────────────────────

def _adaptive_low_boost(low_to_mid_db: float) -> float:
    """Return primary 80 Hz bell gain (dB).  Floor 2.0 dB survives loudnorm."""
    if low_to_mid_db < -20.0:
        return 4.0
    if low_to_mid_db < -13.0:
        return 3.5
    if low_to_mid_db < -6.0:
        return 2.5
    return 2.0


def _adaptive_air_boost(high_to_mid_db: float) -> float:
    """Return 10 kHz shelf gain (dB).  Floor 2.0 dB ensures audible openness."""
    if high_to_mid_db < -28.0:
        return 3.5
    if high_to_mid_db < -20.0:
        return 2.8
    return 2.0


# ── EQ move descriptor (used for analysis report) ─────────────────────────────

@dataclass
class EqMove:
    band:     str         # human-readable label
    freq_hz:  int
    gain_db:  float
    filter:   str         # "bell" | "highshelf" | "lowshelf"
    adaptive: bool = False

    def to_dict(self) -> dict:
        sign = f"+{self.gain_db:.1f}" if self.gain_db >= 0 else f"{self.gain_db:.1f}"
        return {
            "band":     self.band,
            "freqHz":   self.freq_hz,
            "gainDb":   round(self.gain_db, 1),
            "gainStr":  sign,
            "filter":   self.filter,
            "adaptive": self.adaptive,
        }


# ── Base EQ builder ───────────────────────────────────────────────────────────

def _build_base_eq(
    low_to_mid_db: float,
    high_to_mid_db: float,
) -> tuple[list[str], list[EqMove]]:
    """
    Returns (ffmpeg_filter_parts, eq_moves).
    """
    low_gain = _adaptive_low_boost(low_to_mid_db)
    air_gain = _adaptive_air_boost(high_to_mid_db)

    # Supplements — proportional but with a minimum floor
    lo_supp  = max(0.8, round(low_gain * 0.40, 1))
    presence = max(0.8, round(air_gain * 0.40, 1))

    filters = [
        f"equalizer=f=80:t=o:w=2.0:g=+{low_gain:.1f}",
        f"equalizer=f=120:t=o:w=1.2:g=+{lo_supp:.1f}",
        "equalizer=f=250:t=o:w=1.2:g=-3.0",
        "equalizer=f=320:t=o:w=0.8:g=-1.0",
        f"highshelf=f=10000:g=+{air_gain:.1f}",
        f"equalizer=f=8000:t=o:w=1.5:g=+{presence:.1f}",
    ]

    moves = [
        EqMove("Low-end density",       80,    +low_gain, "bell",      adaptive=True),
        EqMove("Upper-bass punch",      120,   +lo_supp,  "bell",      adaptive=True),
        EqMove("Mud removal (main)",    250,   -3.0,      "bell"),
        EqMove("Mud removal (secondary)",320,  -1.0,      "bell"),
        EqMove("Air shelf",             10000, +air_gain, "highshelf", adaptive=True),
        EqMove("Presence / clarity",    8000,  +presence, "bell",      adaptive=True),
    ]

    return filters, moves


# ── Style overlays ────────────────────────────────────────────────────────────
# Applied on top of base EQ.  Gains produce clearly different characters but
# avoid anything that sounds like a DJ EQ or over-processing.

@dataclass
class StyleOverlay:
    filters: list[str]
    moves: list[EqMove]


_STYLE_OVERLAYS: dict[str, StyleOverlay] = {

    # Balanced: base EQ only — transparent streaming master
    "balanced": StyleOverlay(filters=[], moves=[]),

    # Warm: vintage character — body in low-mids, smooth upper-mids, softer top
    "warm": StyleOverlay(
        filters=[
            "equalizer=f=200:t=o:w=1.2:g=+1.5",    # low-mid body
            "equalizer=f=3500:t=o:w=1.5:g=-2.0",   # smooth upper-mid edge
            "highshelf=f=8000:g=-2.0",              # partial air rolloff
        ],
        moves=[
            EqMove("Low-mid body (warm)",     200,   +1.5, "bell"),
            EqMove("Upper-mid smooth (warm)", 3500,  -2.0, "bell"),
            EqMove("Top-end rolloff (warm)",  8000,  -2.0, "highshelf"),
        ],
    ),

    # Bright: modern clarity — presence forward, extended air, safe de-ess
    "bright": StyleOverlay(
        filters=[
            "equalizer=f=4000:t=o:w=1.2:g=+2.0",   # presence / definition
            "equalizer=f=12000:t=o:w=1.5:g=+1.5",  # extended air
            "equalizer=f=7500:t=o:w=0.8:g=-1.0",   # de-ess safety notch
        ],
        moves=[
            EqMove("Presence (bright)",    4000,  +2.0, "bell"),
            EqMove("Extended air (bright)", 12000, +1.5, "bell"),
            EqMove("De-ess safety (bright)", 7500, -1.0, "bell"),
        ],
    ),

    # Punch: club/EDM — sub weight, tight mid, attack snap
    "punch": StyleOverlay(
        filters=[
            "equalizer=f=60:t=o:w=0.9:g=+2.5",     # sub-kick weight
            "equalizer=f=350:t=o:w=1.0:g=-2.5",    # tight mid mud cut
            "equalizer=f=2500:t=o:w=1.0:g=+2.0",   # attack presence / snare
            "equalizer=f=5000:t=o:w=0.8:g=+1.0",   # upper presence edge
        ],
        moves=[
            EqMove("Sub-kick weight (punch)",   60,   +2.5, "bell"),
            EqMove("Mid tightness (punch)",     350,  -2.5, "bell"),
            EqMove("Attack presence (punch)",   2500, +2.0, "bell"),
            EqMove("Upper edge (punch)",        5000, +1.0, "bell"),
        ],
    ),
}

# ── AI artifact corrections ───────────────────────────────────────────────────

_AI_CORRECTIONS: dict[str, tuple[str, EqMove]] = {
    "harshHighMid": (
        "equalizer=f=4000:t=o:w=2.0:g=-3.0",
        EqMove("Harsh high-mid fix (AI)", 4000, -3.0, "bell"),
    ),
    "boomyLowEnd": (
        "equalizer=f=120:t=o:w=1.0:g=-4.0",
        EqMove("Boomy low-end fix (AI)", 120, -4.0, "bell"),
    ),
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
    """Return comma-separated FFmpeg filter string (Stage 3)."""
    filter_str, _ = build_eq_filter_with_report(
        style,
        low_to_mid_db=low_to_mid_db,
        high_to_mid_db=high_to_mid_db,
        ai_detections=ai_detections,
        apply_ai_corrections=apply_ai_corrections,
    )
    return filter_str


def build_eq_filter_with_report(
    style: str,
    *,
    low_to_mid_db: float = -15.0,
    high_to_mid_db: float = -22.0,
    ai_detections: dict[str, bool] | None = None,
    apply_ai_corrections: bool = True,
) -> tuple[str, list[dict]]:
    """
    Returns (ffmpeg_filter_str, list_of_eq_move_dicts).

    The eq_move_dicts describe every band applied, including whether each
    was adaptive and what frequency/gain was used — for the analysis report.
    """
    filter_parts: list[str] = []
    all_moves:    list[EqMove] = []

    # 1. AI corrections
    if apply_ai_corrections and ai_detections:
        for key, (filt, move) in _AI_CORRECTIONS.items():
            if ai_detections.get(key):
                filter_parts.append(filt)
                all_moves.append(move)

    # 2. Base EQ
    base_filters, base_moves = _build_base_eq(low_to_mid_db, high_to_mid_db)
    filter_parts.extend(base_filters)
    all_moves.extend(base_moves)

    # 3. Style overlay
    overlay = _STYLE_OVERLAYS.get(style, _STYLE_OVERLAYS["balanced"])
    filter_parts.extend(overlay.filters)
    all_moves.extend(overlay.moves)

    return ",".join(p for p in filter_parts if p), [m.to_dict() for m in all_moves]
