"""
Tonal budget system (v3.5 Phase 2).

Defines per-stage tonal change budgets so the pipeline can target a
spectral shape rather than just stacking arbitrary EQ moves.

Three constants drive the new architecture:

  · TARGETS    — desired final-output band balance (post all stages)
  · BUDGETS    — max change a single stage may apply to each band
  · EFFECTIVENESS — empirical "how much actual band Δ a 1 dB EQ move
                    produces" for each filter type at each band centre.
                    Used by the corrective-EQ solver to convert "want
                    band Δ X dB" into "set EQ gain Y dB".

These constants are tuned for KPOP Loud specifically.  Other styles
continue to use the older base+overlay approach unchanged.
"""
from __future__ import annotations

from dataclasses import dataclass


# ── Final-output targets (KPOP Loud) ────────────────────────────────────────
# All measured *relative to MID band* on the loudness-normalized scale
# (post-master mid-band rise is the "0 dB" reference).

@dataclass(frozen=True)
class TonalTargets:
    """Desired final balance after the full chain."""
    # Relative to mid band, in dB
    low_relative_db_ideal:  tuple[float, float] = (-0.7, +0.6)   # ratio 0.85–1.15
    low_relative_db_accept: tuple[float, float] = (-1.25, +1.14) # ratio 0.75–1.30
    high_low_tilt_ideal:    tuple[float, float] = (-2.0, +2.0)
    high_low_tilt_accept:   tuple[float, float] = (-4.0, +4.0)
    target_lufs:            float = -9.0    # KPOP Loud
    target_tp:              float = -1.0


KPOP_LOUD_TARGETS = TonalTargets()


# ── Per-stage band-change budgets ────────────────────────────────────────────
# Each stage may move each band by at most this amount.  Exceeding it raises
# a "TONAL_BUDGET_EXCEEDED" warning in the pipeline.
#
# Values in dB (signed: range = (min_change, max_change)).
#
# Why these limits:
#   T1 (corrective EQ): the only stage allowed to do aggressive shaping.
#     Up to ±3 dB on any band.
#   T2 (dynamic EQ):    resonance suppression only — ±1.5 dB hard cap
#     (already enforced in dynamic_eq.py via MAX_SINGLE_BAND_REDUCTION).
#   T3 (compressor):    glue only — broadband effect, ±1 dB on bands.
#   T4 (pre-correction shelf): single-axis tilt fix, ±2.5 dB.
#   T7 (limiter):       broadband peak safety, may pull ALL bands by ~+1.5 dB
#     uniformly.  Per-band budget thus allowed up to that.
#   Tg (final guard):   post-master polish, ±2.5 dB max.

@dataclass(frozen=True)
class StageBudget:
    name:    str
    low_db:  tuple[float, float]
    mid_db:  tuple[float, float]
    high_db: tuple[float, float]
    air_db:  tuple[float, float]


KPOP_LOUD_BUDGETS: dict[str, StageBudget] = {
    "T1_CORRECTIVE_EQ": StageBudget("T1_CORRECTIVE_EQ",
        low_db=(-3.0, +3.0), mid_db=(-2.0, +2.0),
        high_db=(-1.5, +2.0), air_db=(-1.0, +3.0)),
    "T2_DYNAMIC_EQ":    StageBudget("T2_DYNAMIC_EQ",
        low_db=(-1.5, +1.5), mid_db=(-1.5, +1.5),
        high_db=(-1.5, +1.5), air_db=(-1.5, +1.5)),
    "T3_COMPRESSOR":    StageBudget("T3_COMPRESSOR",
        low_db=(-1.0, +1.0), mid_db=(-1.0, +1.0),
        high_db=(-1.0, +1.0), air_db=(-1.0, +1.0)),
    "T4_PRECORRECTION": StageBudget("T4_PRECORRECTION",
        low_db=(-1.0, +1.0), mid_db=(-0.5, +0.5),
        high_db=(-2.5, +2.0), air_db=(-2.5, +2.0)),
    "TG_FINAL_GUARD":   StageBudget("TG_FINAL_GUARD",
        low_db=(-2.5, +2.5), mid_db=(-1.0, +1.0),
        high_db=(-2.5, +2.0), air_db=(-2.5, +2.0)),
}


def check_budget(stage: str, band: str, delta_db: float) -> str | None:
    """
    Return None if delta_db is within the stage's budget for the band,
    or a human-readable budget-violation message.
    """
    sb = KPOP_LOUD_BUDGETS.get(stage)
    if sb is None:
        return None
    rng_map = {"low": sb.low_db, "mid": sb.mid_db,
               "high": sb.high_db, "air": sb.air_db}
    rng = rng_map.get(band)
    if rng is None:
        return None
    lo, hi = rng
    if delta_db < lo or delta_db > hi:
        return (f"{stage} 가 {band} 대역을 {delta_db:+.2f} dB 이동 — "
                f"허용 budget [{lo:+.1f}, {hi:+.1f}] 초과.")
    return None


# ── Filter "effectiveness" lookup (FFT-band Δ per 1 dB EQ move) ────────────
# Empirically measured on the synthetic kpop bass-heavy reference.  These
# coefficients let the corrective-EQ solver convert "want N dB band change"
# into a precise EQ gain: `gain = need_db / effectiveness`.
#
# Filter types:
#   bell @ low (90 Hz Q=0.7):   ~0.75 (wide bell partly bleeds into low-mid)
#   bell @ low-mid (120 Hz):    ~0.55
#   peak @ 250 Hz Q=1.2:        ~0.45 (mid-band measurement only partial)
#   peak @ 2.5 kHz Q=1.1:       ~0.25 (mid-band capture is wide)
#   peak @ 5.5 kHz Q=1.0:       ~0.40 (high-band)
#   peak @ 10 kHz Q=1.2:        ~0.30 (high-air boundary)
#   high-shelf @ 12 kHz:        ~0.85 (whole air band lifts together)
#   high-shelf @ 8 kHz:         ~0.65 (covers high + air)
#   peak @ 90 Hz Q=0.7 (warmth): ~0.75 (low band)
#   peak @ 100 Hz Q=0.9 (low trim): ~0.70

EFFECTIVENESS = {
    "low_warmth_bell_90":     0.75,
    "low_trim_bell_100":      0.70,
    "low_density_80":         0.80,
    "low_supp_120":           0.55,
    "mud_cut_250":            0.45,
    "mud_cut_320":            0.30,
    "presence_2500":          0.25,
    "clarity_5500":           0.40,
    "sheen_10000":            0.30,
    "high_shelf_8000":        0.65,
    "high_shelf_10000":       0.50,
    "high_shelf_12000":       0.85,
}


def gain_for_band_change(filter_key: str, desired_band_db: float,
                          *, max_gain_db: float = 4.0) -> float:
    """Return EQ gain (dB) needed to produce `desired_band_db` band change."""
    eff = EFFECTIVENESS.get(filter_key, 0.5)
    if eff <= 0:
        return 0.0
    raw = desired_band_db / eff
    return round(max(-max_gain_db, min(max_gain_db, raw)), 2)
