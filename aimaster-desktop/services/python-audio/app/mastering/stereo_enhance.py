"""
Mono-safe stereo enhancement (Phase-B mastering quality, 2026-05).

The legacy `effects.stereo_width_filter()` uses ffmpeg's `extrastereo`,
which simply amplifies the side signal across the full spectrum.  At
amounts > 1.2 it cripples mono compatibility — phone speakers, BT
mono, AM-radio bounces, club PA stacks all collapse stereo to L+R sum
and the side energy added to LOW frequencies cancels there, gutting
the kick / sub bass / floor tom.

Mastering practice: apply stereo widening ABOVE a crossover (typically
120–200 Hz) and keep everything below the crossover in mono.  This is
a hard requirement for translation across:
  • cheap phone earbuds (3-inch driver, can't reproduce <150 Hz anyway)
  • car audio (dash speakers + sub — sub is mono-summed)
  • Bluetooth speakers in mono mode
  • restaurant / store PA systems (mono bounce off walls)
  • YouTube Music's mobile mix (mono on iPhone speaker)

Implementation: split the signal at `crossover_hz`, force the low band
to mono via M/S downmix (sum the two channels and route to both), apply
the user-configured side-level boost to the HIGH band only via
ffmpeg's `stereotools` filter, then sum.

Returns a (filter_string, applied_log) pair so the pipeline can record
exactly what it applied for the gain-staging report.
"""
from __future__ import annotations

from typing import Any


# ── Defaults ────────────────────────────────────────────────────────────────

# 120 Hz is conservative — preserves bass-guitar fundamentals (~80 Hz)
# AND the punch portion of kick drums (60–120 Hz).  Anything above 120
# is tonally "where stereo lives" anyway (vocals, snares, hats, etc.).
DEFAULT_CROSSOVER_HZ:    float = 120.0

# Width amount.  1.0 = no change.  1.2 = subtle.  1.5 = obvious.  >1.8
# starts to sound unnaturally wide and risks comb-filter on mono fold.
DEFAULT_WIDTH:           float = 1.0

# Hard upper limit on the side level boost — anything past 1.8 is a
# mastering bug, not a creative choice.
MAX_WIDTH:               float = 1.8

# Crossover Q — 0.7 (Butterworth) gives a smooth handoff with no hump.
# Higher Q makes the crossover snappier but can introduce a phase wiggle
# at the crossover frequency (audible as a comb-filter on mono fold).
CROSSOVER_Q:             float = 0.7071067811865476


def build_stereo_enhance_chain(
    width:         float = DEFAULT_WIDTH,
    crossover_hz:  float = DEFAULT_CROSSOVER_HZ,
    *,
    applied_log: list[dict[str, Any]] | None = None,
) -> str:
    """Return an ffmpeg filter_complex chain that widens the SIDE
    component above `crossover_hz` while keeping the low band in pure
    mono.  Designed to be used as the entire `-filter_complex` graph
    (the final amerge+pan output is auto-mapped by ffmpeg).

    `width` of 1.0 returns an empty string (no-op).

    `applied_log`, if provided, is appended with a structured record
    of what was applied — used by the gain-staging report.

    Algorithm — TRUE M/S decode (not LPF/HPF on stereo signal):

      1. mid  = (L + R) / 2                — full-band, untouched
      2. side = (L - R) / 2                — full-band, MONO signal
      3. side' = HPF(side, crossover_hz)   — kill all sub-crossover
                                              energy in the side stream
      4. side'' = side' × widthScale       — apply width as a side-level
                                              boost (linear gain)
      5. L_out = mid + side''
      6. R_out = mid - side''

    Below the crossover the side signal is silent → L_out == R_out ==
    mid → pure mono.  Above the crossover the original side energy
    plus the width-scaled gain reproduces the design intent without
    leaking into low frequencies.
    """
    # No-op fast path
    if abs(width - 1.0) < 0.02:
        if applied_log is not None:
            applied_log.append({"stage": "stereo_enhance", "applied": False,
                                "reason": "width=1.0 → bypass"})
        return ""

    # Clamp.
    w   = max(0.5, min(MAX_WIDTH, float(width)))
    fxo = max(40.0, min(400.0, float(crossover_hz)))

    if applied_log is not None:
        applied_log.append({
            "stage":         "stereo_enhance",
            "applied":       True,
            "width":         round(w, 3),
            "crossoverHz":   round(fxo, 1),
            "monoBelow":     True,
            "filterType":    "M/S decode + side-band HPF",
        })

    # Convert width to side-level dB.
    import math as _m
    side_gain_db = 20.0 * _m.log10(w)

    # Cascade two highpasses on the side band for steeper rolloff
    # (~24 dB/oct at the corner).  Single 12 dB/oct lets sub-crossover
    # energy leak through after the side-level boost.
    return (
        f"asplit=2[in_a][in_b];"
        # Mid: average of L/R, kept stereo-shaped so amerge later stays
        # 2-channel-coherent.  pan=stereo|... outputs a 2-channel signal
        # where both channels are the mono mid — this keeps the merge
        # math symmetric.
        f"[in_a]pan=mono|c0=0.5*c0+0.5*c1[mid];"
        # Side: difference of L/R, then steep HPF to silence sub-crossover.
        f"[in_b]pan=mono|c0=0.5*c0-0.5*c1,"
        f"highpass=f={fxo:.1f}:t=q:w={CROSSOVER_Q:.4f},"
        f"highpass=f={fxo:.1f}:t=q:w={CROSSOVER_Q:.4f},"
        f"volume={side_gain_db:+.3f}dB[side];"
        # Reconstruct stereo: L = mid + side, R = mid - side.
        # amerge gives c0=mid, c1=side; pan applies the M/S decode.
        f"[mid][side]amerge=inputs=2,"
        f"pan=stereo|c0=c0+c1|c1=c0-c1"
    )


def describe_stereo_enhance(width: float, crossover_hz: float = DEFAULT_CROSSOVER_HZ) -> str:
    """Human-readable summary for the appliedCorrections list."""
    if abs(width - 1.0) < 0.02:
        return "Stereo enhance: 적용 안 됨 (width=1.0)"
    direction = "확장" if width > 1.0 else "축소"
    return (f"Stereo {direction} (M/S, low {crossover_hz:.0f} Hz 이하 모노 보호, "
            f"side level {width:.2f}×)")
