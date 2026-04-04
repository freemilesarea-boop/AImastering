"""
Stage 3: Style-specific tone correction.

Each preset has a clearly defined purpose and allowed frequency range.
Filters are expressed in FFmpeg audio filter syntax and joined as a
comma-separated chain to be inserted before loudnorm pass-2.

Preset principles (from spec):
  Balanced — neutral; no aggressive EQ; minimal transient disturbance
  Warm     — 2.5–5 kHz over-stimulation reduction; 150–350 Hz preservation
  Bright   — 6–12 kHz presence; light mid-low cleanup; no excessive sibilance
  Punch    — 60–120 Hz low-end body; 1–3 kHz presence; bus-comp density feel
"""
from __future__ import annotations

# ── FFmpeg filter syntax quick reference ──────────────────────────────────────
#   parametric bell  : equalizer=f=<Hz>:t=o:w=<oct>:g=<dB>
#   low shelf        : lowshelf=f=<Hz>:g=<dB>:t=h  (t=h = Hz mode)
#   high shelf       : highshelf=f=<Hz>:g=<dB>:t=h

# ── Per-style EQ filter lists ─────────────────────────────────────────────────

_STYLE_EQ: dict[str, list[str]] = {

    # ── Balanced ──────────────────────────────────────────────────────────
    # Principle: most neutral; over-EQ forbidden; transient damage minimal.
    # A single gentle tilt is allowed if the file clearly needs it,
    # but by default the chain is empty — do not add "just in case" filters.
    "balanced": [
        # No filters by default — let loudnorm handle level-matching only.
        # If future analysis detects systematic issues, add conservative fixes here.
    ],

    # ── Warm ──────────────────────────────────────────────────────────────
    # Principle: soften 2.5–5 kHz over-stimulation; preserve 150–350 Hz warmth;
    #            gentle high rolloff to reduce "sharp" impression.
    "warm": [
        # Reduce harsh upper-mids (3–4 kHz) — moderate bell, conservative cut
        # w=1.5 → ~1.7 octave span; avoids phase artifacts from overly wide cuts
        "equalizer=f=3500:t=o:w=1.5:g=-1.5",
        # Preserve body warmth (200–300 Hz) — very gentle lift
        "equalizer=f=250:t=o:w=1.0:g=+0.5",
        # Tame air shelf above 8 kHz without killing it
        "highshelf=f=8000:g=-1.5",
    ],

    # ── Bright ────────────────────────────────────────────────────────────
    # Principle: enhance 6–12 kHz presence; light cleanup of mid-low mud;
    #            must NOT introduce sibilance or harshness.
    # CRITICAL: narrow boost width + strong de-ess to prevent ringing artifacts.
    "bright": [
        # Gently clean up mid-low mud (250–400 Hz)
        "equalizer=f=300:t=o:w=1.0:g=-1.0",
        # Lift air/presence (8–12 kHz) — NARROW bell, conservative gain
        # w=1.0 (was 2.0) keeps boost focused; g=+0.8 (was +1.5) prevents harshness
        "equalizer=f=9000:t=o:w=1.0:g=+0.8",
        # Very subtle top-end shelf — just a whisper of air
        "highshelf=f=12000:g=+0.5",
        # De-ess: stronger cut at 8 kHz to prevent sibilance ringing
        # g=-2.0 (was -0.5) properly counteracts the 9 kHz boost in the 7–9 kHz zone
        "equalizer=f=8000:t=o:w=0.8:g=-2.0",
    ],

    # ── Punch ─────────────────────────────────────────────────────────────
    # Principle: tighten 60–120 Hz sub-body; add 1–3 kHz attack presence;
    #            clean up boxiness; no distortion.
    "punch": [
        # Sub/kick body (60–120 Hz) — bell boost, moderate width
        "equalizer=f=80:t=o:w=1.0:g=+1.5",
        # Clean up boxy low-mid buildup (300–400 Hz)
        "equalizer=f=350:t=o:w=1.0:g=-1.0",
        # Presence/attack (1–3 kHz) — NARROWER width, lower gain to prevent resonance
        # w=1.0 (was 1.5) + g=+1.0 (was +1.5) reduces mid-frequency buildup / ringing
        "equalizer=f=2000:t=o:w=1.0:g=+1.0",
    ],
}

# ── AI artifact correction notches ────────────────────────────────────────────
# These are pre-pended to the style EQ chain when the corresponding
# flag is set in aiDetection and apply_ai_corrections=True.
# Kept conservative: 3–4 dB cuts, not notch-filter extremes.

_AI_CORRECTIONS: dict[str, str] = {
    # 3–5 kHz harsh high-mid → bell cut centred at 4 kHz
    "harshHighMid": "equalizer=f=4000:t=o:w=2.0:g=-3.0",
    # 60–200 Hz boomy low-end → cut at 120 Hz
    "boomyLowEnd":  "equalizer=f=120:t=o:w=1.0:g=-4.0",
}


# ── Public function ───────────────────────────────────────────────────────────

def build_eq_filter(
    style: str,
    ai_detections: dict[str, bool] | None = None,
    apply_ai_corrections: bool = True,
) -> str:
    """
    Build a comma-separated FFmpeg audio filter string for the given style.

    Order:
      1. AI artifact corrections (if enabled and detected)
      2. Style EQ

    Returns an empty string if no filters are needed (Balanced with no AI issues).
    """
    parts: list[str] = []

    # 1. AI corrections — applied first so style EQ acts on corrected audio
    if apply_ai_corrections and ai_detections:
        for key, filt in _AI_CORRECTIONS.items():
            if ai_detections.get(key):
                parts.append(filt)

    # 2. Style EQ
    parts.extend(_STYLE_EQ.get(style, _STYLE_EQ["balanced"]))

    return ",".join(p for p in parts if p)
