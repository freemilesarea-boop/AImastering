"""
Profile comparison metric (M1.75).

Given two ReferenceProfiles A and B, produces a structured diff:
  - Per-axis numeric delta (target − source)
  - Per-axis similarity score (0..1)
  - Aggregate similarity (0..1)
  - Categorical labels (compressed/dynamic, dark/bright, narrow/wide, etc.)

Used by:
  - The user-facing reference-comparison UI (M3+)
  - The adaptive-mastering preset recommender (this module's sibling)

Reference doc: docs/redesign/loui-mastering-v2/m1.75/03-COMPARISON-METRICS.md
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Optional

from .schema import (
    ReferenceProfile,
    ReferenceProfileFeatures,
    THIRD_OCT_CENTRES,
)


@dataclass
class AxisDelta:
    """Comparison along a single feature axis."""
    name: str
    source: float                  # value in profile A (user/pre-master)
    target: float                  # value in profile B (reference)
    delta: float                   # target − source
    unit: str                      # 'LU' | 'dB' | 'ratio' | 'index' | 'events/min'
    similarity01: float = 0.0      # 0 (max divergence) .. 1 (identical)

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "source": self.source,
            "target": self.target,
            "delta": self.delta,
            "unit": self.unit,
            "similarity01": self.similarity01,
        }


@dataclass
class ProfileComparison:
    """Result of compare_profiles(A, B)."""
    sourceId: str
    targetId: str
    axes: dict[str, AxisDelta]     # name -> AxisDelta
    spectrumDeltaDb: dict[str, float]   # bin -> (target − source) in dB
    overallSimilarity01: float
    labels: dict[str, str]          # categorical: e.g. {dynamics: 'compressed', tone: 'brighter'}

    def to_dict(self) -> dict:
        return {
            "sourceId": self.sourceId,
            "targetId": self.targetId,
            "axes": {k: v.to_dict() for k, v in self.axes.items()},
            "spectrumDeltaDb": dict(self.spectrumDeltaDb),
            "overallSimilarity01": self.overallSimilarity01,
            "labels": dict(self.labels),
        }


# ── Similarity helpers ─────────────────────────────────────────────────────


def _similarity01_from_delta(delta: float, scale: float) -> float:
    """Map |delta|/scale → similarity in [0, 1] via 1/(1+x²)."""
    if not math.isfinite(delta) or scale <= 0:
        return 0.0
    x = abs(delta) / scale
    return float(1.0 / (1.0 + x * x))


# Per-axis scales — distance at which similarity falls to 0.5.
_AXIS_SCALES = {
    "lufsI": 4.0,                  # 4 LU
    "tpDb":  3.0,                  # 3 dB
    "lra":   3.0,                  # 3 LU
    "crestDb": 3.0,                # 3 dB
    "transientDensity": 60.0,      # 60 ev/min
    "compressionScore": 0.25,      # 0.25 score
    "spectralTilt": 1.5,           # 1.5 dB/oct
    "subEnergy": 0.10,             # ratio
    "lowMidBalance": 3.0,          # dB
    "vocalRegionEnergy": 3.0,      # dB
    "airBandEnergy": 3.0,          # dB
    "harshnessIndex": 1.5,         # index
    "correlationMean": 0.30,
    "msRatioDb": 4.0,              # dB
    "stereoWidthIndex": 0.40,
}


def _axis(
    name: str, source: float, target: float, unit: str, scale_key: str | None = None,
) -> AxisDelta:
    delta = target - source
    scale = _AXIS_SCALES.get(scale_key or name, 1.0)
    sim = _similarity01_from_delta(delta, scale)
    return AxisDelta(name=name, source=source, target=target, delta=delta, unit=unit, similarity01=sim)


# ── Categorical labels ─────────────────────────────────────────────────────


def _label_dynamics(src: ReferenceProfileFeatures, tgt: ReferenceProfileFeatures) -> str:
    d = tgt.dynamics.compressionScore - src.dynamics.compressionScore
    if d > 0.15:
        return "more-compressed"
    if d < -0.15:
        return "more-dynamic"
    return "matched"


def _label_tone(src: ReferenceProfileFeatures, tgt: ReferenceProfileFeatures) -> str:
    d = tgt.tonal.spectralTiltDbPerOct - src.tonal.spectralTiltDbPerOct
    if d > 0.7:
        return "brighter"
    if d < -0.7:
        return "darker"
    return "matched"


def _label_stereo(src: ReferenceProfileFeatures, tgt: ReferenceProfileFeatures) -> str:
    d = tgt.stereo.stereoWidthIndex - src.stereo.stereoWidthIndex
    if d > 0.3:
        return "wider"
    if d < -0.3:
        return "narrower"
    return "matched"


def _label_loudness(src: ReferenceProfileFeatures, tgt: ReferenceProfileFeatures) -> str:
    d = tgt.loudness.integratedLufs - src.loudness.integratedLufs
    if d > 1.5:
        return "louder"
    if d < -1.5:
        return "quieter"
    return "matched"


# ── Public entry ───────────────────────────────────────────────────────────


def compare_profiles(source: ReferenceProfile, target: ReferenceProfile) -> ProfileComparison:
    """
    Compare `source` (e.g. user's pre-master) against `target` (reference).

    Returns axis-by-axis deltas, spectrum delta, and an aggregate similarity.
    """
    s, t = source.features, target.features

    axes: dict[str, AxisDelta] = {}
    axes["lufsI"] = _axis(
        "lufsI", s.loudness.integratedLufs, t.loudness.integratedLufs, "LUFS",
    )
    axes["tpDb"] = _axis(
        "tpDb", s.loudness.truePeakDbtp, t.loudness.truePeakDbtp, "dB",
    )
    axes["lra"] = _axis(
        "lra", s.loudness.loudnessRange, t.loudness.loudnessRange, "LU",
    )
    axes["crestDb"] = _axis(
        "crestDb", s.dynamics.crestDb, t.dynamics.crestDb, "dB",
    )
    axes["transientDensity"] = _axis(
        "transientDensity", s.dynamics.transientDensityPerMin, t.dynamics.transientDensityPerMin,
        "events/min",
    )
    axes["compressionScore"] = _axis(
        "compressionScore", s.dynamics.compressionScore, t.dynamics.compressionScore, "score",
    )
    axes["spectralTilt"] = _axis(
        "spectralTilt", s.tonal.spectralTiltDbPerOct, t.tonal.spectralTiltDbPerOct, "dB/oct",
    )
    axes["subEnergy"] = _axis(
        "subEnergy", s.tonal.subEnergyRatio, t.tonal.subEnergyRatio, "ratio",
    )
    axes["lowMidBalance"] = _axis(
        "lowMidBalance", s.tonal.lowMidBalanceDb, t.tonal.lowMidBalanceDb, "dB",
    )
    axes["vocalRegionEnergy"] = _axis(
        "vocalRegionEnergy", s.tonal.vocalRegionEnergyDb, t.tonal.vocalRegionEnergyDb, "dB",
    )
    axes["airBandEnergy"] = _axis(
        "airBandEnergy", s.tonal.airBandEnergyDb, t.tonal.airBandEnergyDb, "dB",
    )
    axes["harshnessIndex"] = _axis(
        "harshnessIndex", s.tonal.harshnessIndex, t.tonal.harshnessIndex, "index",
    )
    axes["correlationMean"] = _axis(
        "correlationMean", s.stereo.correlationMean, t.stereo.correlationMean, "corr",
    )
    axes["msRatioDb"] = _axis(
        "msRatioDb", s.stereo.msRatioDb, t.stereo.msRatioDb, "dB",
    )
    axes["stereoWidthIndex"] = _axis(
        "stereoWidthIndex", s.stereo.stereoWidthIndex, t.stereo.stereoWidthIndex, "index",
    )

    # Spectrum delta (bin-by-bin dB) — same bins guaranteed by schema.
    spectrum_delta: dict[str, float] = {}
    for cf in THIRD_OCT_CENTRES:
        k = str(cf)
        a = s.tonal.thirdOctSpectrumDb.get(k, float("-inf"))
        b = t.tonal.thirdOctSpectrumDb.get(k, float("-inf"))
        if math.isfinite(a) and math.isfinite(b):
            spectrum_delta[k] = float(b - a)
        else:
            spectrum_delta[k] = float("nan")

    # Aggregate similarity — weighted mean.
    weights = {
        "lufsI": 1.5, "tpDb": 0.5, "lra": 1.0,
        "crestDb": 1.0, "compressionScore": 1.0, "transientDensity": 0.3,
        "spectralTilt": 1.2, "subEnergy": 0.8, "lowMidBalance": 0.8,
        "vocalRegionEnergy": 0.8, "airBandEnergy": 0.8, "harshnessIndex": 0.8,
        "correlationMean": 0.5, "msRatioDb": 0.5, "stereoWidthIndex": 0.7,
    }
    num = 0.0
    den = 0.0
    for name, ax in axes.items():
        w = weights.get(name, 0.5)
        num += w * ax.similarity01
        den += w
    overall = num / den if den > 0 else 0.0

    labels = {
        "loudness": _label_loudness(s, t),
        "dynamics": _label_dynamics(s, t),
        "tone": _label_tone(s, t),
        "stereo": _label_stereo(s, t),
    }

    return ProfileComparison(
        sourceId=source.id,
        targetId=target.id,
        axes=axes,
        spectrumDeltaDb=spectrum_delta,
        overallSimilarity01=float(overall),
        labels=labels,
    )
