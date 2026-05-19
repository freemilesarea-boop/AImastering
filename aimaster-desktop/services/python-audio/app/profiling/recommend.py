"""
Adaptive preset recommendation (M1.75).

Given a ReferenceProfile (the user's reference track) and a catalogue of
available presets (each carrying its own target metrics), this module:

  1. Scores each preset by similarity to the reference's loudness /
     dynamics / tone characteristics.
  2. Returns the highest-scoring preset + similarity score + the per-axis
     deltas that explain the recommendation.

Also derives `AdaptiveOverrides` — small numerical adjustments to the
chosen preset that nudge it toward the reference's characteristics.
The overrides are deliberately conservative (range-clamped) to avoid
"clone the reference" failure modes.

Reference docs:
  docs/redesign/loui-mastering-v2/m1.75/05-PRESET-RECOMMENDATION-FLOW.md
  docs/redesign/loui-mastering-v2/m1.75/04-ADAPTIVE-MASTERING-FLOW.md
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Optional

from .schema import ReferenceProfile, THIRD_OCT_CENTRES


# Loui's built-in preset characteristic anchors.
# Format: presetId -> reference metric anchors.  Kept in sync with the
# 01-DSP-POLICY-PHILOSOPHY.md table.  These are NOT preset DSP parameters
# — they are "what this preset is intended to produce" anchors used for
# matching.
PRESET_ANCHORS: dict[str, dict[str, float]] = {
    "builtin-natural": {
        "targetLufs": -14.0, "targetTp": -1.0,
        "lraTarget": 11.0,  "crestTarget": 12.0,
        "compressionTarget": 0.25,
        "spectralTiltTarget": -3.0, "subRatioTarget": 0.12,
        "harshnessTarget": 1.0, "widthTarget": 1.0,
    },
    "builtin-balanced": {
        "targetLufs": -12.0, "targetTp": -1.0,
        "lraTarget": 8.0,   "crestTarget": 10.0,
        "compressionTarget": 0.40,
        "spectralTiltTarget": -3.0, "subRatioTarget": 0.15,
        "harshnessTarget": 1.0, "widthTarget": 1.05,
    },
    "builtin-bright": {
        "targetLufs": -12.0, "targetTp": -1.0,
        "lraTarget": 8.0,   "crestTarget": 10.0,
        "compressionTarget": 0.40,
        "spectralTiltTarget": -2.0, "subRatioTarget": 0.13,
        "harshnessTarget": 0.9, "widthTarget": 1.10,
    },
    "builtin-warm": {
        "targetLufs": -14.0, "targetTp": -1.0,
        "lraTarget": 11.0,  "crestTarget": 11.0,
        "compressionTarget": 0.30,
        "spectralTiltTarget": -4.0, "subRatioTarget": 0.16,
        "harshnessTarget": 0.7, "widthTarget": 1.0,
    },
    "builtin-loud": {
        "targetLufs": -10.0, "targetTp": -1.0,
        "lraTarget": 5.0,   "crestTarget": 8.0,
        "compressionTarget": 0.60,
        "spectralTiltTarget": -2.5, "subRatioTarget": 0.18,
        "harshnessTarget": 1.0, "widthTarget": 1.10,
    },
    "builtin-kpop-loud": {
        "targetLufs": -9.0,  "targetTp": -0.8,
        "lraTarget": 4.5,   "crestTarget": 7.5,
        "compressionTarget": 0.70,
        "spectralTiltTarget": -2.5, "subRatioTarget": 0.20,
        "harshnessTarget": 1.0, "widthTarget": 1.10,
    },
    "builtin-punch": {
        "targetLufs": -11.0, "targetTp": -1.0,
        "lraTarget": 6.0,   "crestTarget": 9.0,
        "compressionTarget": 0.55,
        "spectralTiltTarget": -3.0, "subRatioTarget": 0.22,
        "harshnessTarget": 1.0, "widthTarget": 1.05,
    },
}


# ── Scoring weights ────────────────────────────────────────────────────────


_SCORE_WEIGHTS = {
    # Axis -> (weight, distance-at-which-score=0.5).
    "lufsI":             (3.0, 3.0),    # LUFS — heaviest
    "lra":               (2.0, 3.0),
    "crest":             (1.5, 3.0),
    "compression":       (2.0, 0.25),
    "spectralTilt":      (1.5, 1.5),
    "subRatio":          (1.0, 0.10),
    "harshness":         (1.0, 1.5),
    "width":             (1.0, 0.40),
}


def _axis_score(delta: float, scale: float) -> float:
    if not math.isfinite(delta) or scale <= 0:
        return 0.0
    x = abs(delta) / scale
    return 1.0 / (1.0 + x * x)


# ── Public types ───────────────────────────────────────────────────────────


@dataclass
class PresetRecommendation:
    """Result of recommend_preset()."""
    presetId: str
    score: float                          # 0..1, higher = better match
    rationale: dict[str, float]           # per-axis score contributions
    runnerUp: Optional[str] = None        # second-best preset
    runnerUpScore: Optional[float] = None
    explanation: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "presetId": self.presetId,
            "score": self.score,
            "rationale": dict(self.rationale),
            "runnerUp": self.runnerUp,
            "runnerUpScore": self.runnerUpScore,
            "explanation": self.explanation,
        }


@dataclass
class AdaptiveOverrides:
    """
    Small DSP-parameter adjustments to nudge a preset toward the reference.

    All deltas are clamped to a safe range so the adapted output remains
    recognisable as the chosen preset and does not "clone" the reference.
    """
    targetLufsAdjustDb: float = 0.0       # ±2 dB max
    saturationDelta: float = 0.0          # ±0.10 max (0..1 scale)
    stereoWidthDelta: float = 0.0         # ±0.10 max
    eqAirShelfDeltaDb: float = 0.0        # ±2 dB max
    eqLowShelfDeltaDb: float = 0.0        # ±2 dB max
    notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "targetLufsAdjustDb": self.targetLufsAdjustDb,
            "saturationDelta": self.saturationDelta,
            "stereoWidthDelta": self.stereoWidthDelta,
            "eqAirShelfDeltaDb": self.eqAirShelfDeltaDb,
            "eqLowShelfDeltaDb": self.eqLowShelfDeltaDb,
            "notes": list(self.notes),
        }


# ── Recommender ────────────────────────────────────────────────────────────


def _score_preset(
    preset_id: str,
    anchors: dict[str, float],
    profile: ReferenceProfile,
) -> tuple[float, dict[str, float]]:
    """Score a preset against the reference profile."""
    f = profile.features
    contribs: dict[str, float] = {}

    pairs = [
        ("lufsI",         anchors["targetLufs"] - f.loudness.integratedLufs),
        ("lra",           anchors["lraTarget"]  - f.loudness.loudnessRange),
        ("crest",         anchors["crestTarget"] - f.dynamics.crestDb),
        ("compression",   anchors["compressionTarget"] - f.dynamics.compressionScore),
        ("spectralTilt",  anchors["spectralTiltTarget"] - f.tonal.spectralTiltDbPerOct),
        ("subRatio",      anchors["subRatioTarget"] - f.tonal.subEnergyRatio),
        ("harshness",     anchors["harshnessTarget"] - f.tonal.harshnessIndex),
        ("width",         anchors["widthTarget"] - f.stereo.stereoWidthIndex),
    ]

    weighted_num = 0.0
    weight_sum = 0.0
    for name, delta in pairs:
        w, scale = _SCORE_WEIGHTS[name]
        s = _axis_score(delta, scale)
        contribs[name] = s
        weighted_num += w * s
        weight_sum += w
    score = weighted_num / weight_sum if weight_sum > 0 else 0.0
    return score, contribs


def recommend_preset(
    profile: ReferenceProfile,
    *,
    preset_ids: Optional[list[str]] = None,
) -> PresetRecommendation:
    """
    Score every preset in `preset_ids` (default = all built-in) and return
    the best match.

    The score is an aggregate similarity in [0, 1].  Above 0.7 = strong
    match; 0.5–0.7 = plausible; below 0.5 = weak — the recommendation is
    still returned but the explanation says so.
    """
    candidates = preset_ids if preset_ids is not None else list(PRESET_ANCHORS.keys())
    if not candidates:
        raise ValueError("no preset candidates")

    scored: list[tuple[float, str, dict[str, float]]] = []
    for pid in candidates:
        if pid not in PRESET_ANCHORS:
            continue
        s, c = _score_preset(pid, PRESET_ANCHORS[pid], profile)
        scored.append((s, pid, c))

    if not scored:
        raise ValueError("no known presets in candidate list")

    scored.sort(key=lambda t: t[0], reverse=True)
    best_score, best_id, best_contribs = scored[0]
    runner_up_id: Optional[str] = scored[1][1] if len(scored) > 1 else None
    runner_up_score: Optional[float] = scored[1][0] if len(scored) > 1 else None

    if best_score >= 0.75:
        explanation = f"Strong match — reference profile aligns with preset's intended characteristics."
    elif best_score >= 0.55:
        explanation = f"Plausible match — preset is the closest of the available set."
    else:
        explanation = (
            f"Weak match (score {best_score:.2f}).  No preset is a close fit; "
            f"consider building a custom preset or using overrides aggressively."
        )

    return PresetRecommendation(
        presetId=best_id,
        score=float(best_score),
        rationale={k: float(v) for k, v in best_contribs.items()},
        runnerUp=runner_up_id,
        runnerUpScore=float(runner_up_score) if runner_up_score is not None else None,
        explanation=explanation,
    )


# ── Adaptive overrides ─────────────────────────────────────────────────────


def _clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def derive_adaptive_overrides(
    pre_master_profile: ReferenceProfile,
    reference_profile: ReferenceProfile,
    *,
    chosen_preset_id: str,
) -> AdaptiveOverrides:
    """
    Derive small parameter adjustments that nudge the chosen preset toward
    the reference's characteristics.

    Inputs:
      • pre_master_profile  — profile of the user's RAW (pre-master) audio.
      • reference_profile   — profile of the reference track.
      • chosen_preset_id    — which preset will be applied.

    Output is intentionally conservative — adjustments are clamped to small
    ranges so the chosen preset's identity is preserved and the system
    cannot "clone" the reference's exact tone.
    """
    over = AdaptiveOverrides()
    anchors = PRESET_ANCHORS.get(chosen_preset_id)
    if anchors is None:
        over.notes.append(f"preset {chosen_preset_id!r} not in anchors — overrides skipped")
        return over

    ref = reference_profile.features
    base_lufs = anchors["targetLufs"]
    target_lufs = ref.loudness.integratedLufs
    # Pull the preset's targetLUFS toward the reference, but cap movement at ±2 dB.
    over.targetLufsAdjustDb = _clamp(target_lufs - base_lufs, -2.0, 2.0)
    if abs(over.targetLufsAdjustDb) > 0.05:
        over.notes.append(
            f"loudness target nudged by {over.targetLufsAdjustDb:+.2f} dB (toward reference)"
        )

    # Tilt → air/low shelf nudges.  Reference brighter than preset anchor → +air, −low.
    tilt_delta = ref.tonal.spectralTiltDbPerOct - anchors["spectralTiltTarget"]
    over.eqAirShelfDeltaDb = _clamp(tilt_delta * 0.8, -2.0, 2.0)
    over.eqLowShelfDeltaDb = _clamp(-tilt_delta * 0.4, -2.0, 2.0)
    if abs(over.eqAirShelfDeltaDb) > 0.1:
        over.notes.append(
            f"air shelf nudge {over.eqAirShelfDeltaDb:+.2f} dB (reference is "
            f"{'brighter' if tilt_delta > 0 else 'darker'})"
        )

    # Sub ratio → saturator amount (more sub-heavy reference → reduce saturation).
    sub_delta = ref.tonal.subEnergyRatio - anchors["subRatioTarget"]
    over.saturationDelta = _clamp(-sub_delta * 0.5, -0.10, 0.10)

    # Width → width delta.
    width_delta = ref.stereo.stereoWidthIndex - anchors["widthTarget"]
    over.stereoWidthDelta = _clamp(width_delta * 0.2, -0.10, 0.10)
    if abs(over.stereoWidthDelta) > 0.01:
        over.notes.append(
            f"width delta {over.stereoWidthDelta:+.2f} (reference is "
            f"{'wider' if width_delta > 0 else 'narrower'})"
        )

    over.notes.append(
        "Overrides are conservative by design — they nudge, not clone.  "
        "Reference profile is used as a CHARACTERISTIC target, not a fingerprint."
    )
    # pre_master_profile is read so future versions can use it (delta from
    # pre-master).  Currently unused; kept in signature for forward compat.
    _ = pre_master_profile
    return over
