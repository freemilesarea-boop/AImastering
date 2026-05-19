"""
Python representation of the ReferenceProfile v1 schema.

Mirrors packages/shared-types/src/profile/profile.ts.  Any change here MUST
be paired on the TS side and the JSON Schema file in the same package.

Reference docs:
  docs/redesign/loui-mastering-v2/m1.75/06-REFERENCE-SAFE-LEGAL-GUIDELINE.md
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional

REFERENCE_PROFILE_SCHEMA_ID = "https://schemas.loui.studio/reference-profile/v1"
EXTRACTOR_VERSION = "1.0.0"   # bump when feature definitions change


# 1/3-octave centre frequencies (ANSI S1.11) — capped at ≤ 64 keys by schema.
# We use 30 centres (25 Hz … 20 kHz) — well under the cap.
THIRD_OCT_CENTRES = [
    25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630,
    800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000,
    12500, 16000, 20000,
]

# Frequency-band definitions for aggregate descriptors.
SUB_BAND      = (20, 100)         # subEnergyRatio numerator
LOW_MID_BAND  = (100, 500)        # lowMidBalanceDb numerator
VOCAL_BAND    = (1000, 4000)      # vocalRegionEnergyDb numerator
AIR_BAND      = (10000, 22000)    # airBandEnergyDb numerator
HARSH_BAND    = (2000, 5000)      # harshness region centre
HARSH_NEIGHBOUR_L = (700, 1500)   # neighbour low (compare for excess)
HARSH_NEIGHBOUR_H = (6000, 10000) # neighbour high


@dataclass
class Percentiles:
    p10: float
    p50: float
    p90: float

    def to_dict(self) -> dict[str, float]:
        return {"p10": self.p10, "p50": self.p50, "p90": self.p90}


@dataclass
class ReferenceProfileProvenance:
    sourceType: str   # 'user-supplied' | 'fixture' | 'builtin' | 'streaming-snapshot'
    createdAt: str
    durationSec: float
    sampleRate: int
    channels: int
    extractorVersion: str = EXTRACTOR_VERSION
    sourceFileSha256: Optional[str] = None
    userLabel: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "sourceType": self.sourceType,
            "createdAt": self.createdAt,
            "durationSec": self.durationSec,
            "sampleRate": self.sampleRate,
            "channels": self.channels,
            "extractorVersion": self.extractorVersion,
        }
        # Optional fields included only when set.
        if self.sourceFileSha256 is not None:
            out["sourceFileSha256"] = self.sourceFileSha256
        if self.userLabel is not None:
            out["userLabel"] = self.userLabel
        return out


@dataclass
class ReferenceProfileLoudness:
    integratedLufs: float
    truePeakDbtp: float
    loudnessRange: float
    shortTermPercentiles: Percentiles
    momentaryPercentiles: Percentiles

    def to_dict(self) -> dict[str, Any]:
        return {
            "integratedLufs": self.integratedLufs,
            "truePeakDbtp": self.truePeakDbtp,
            "loudnessRange": self.loudnessRange,
            "shortTermPercentiles": self.shortTermPercentiles.to_dict(),
            "momentaryPercentiles": self.momentaryPercentiles.to_dict(),
        }


@dataclass
class ReferenceProfileDynamics:
    crestDb: float
    transientDensityPerMin: float
    compressionScore: float    # [0, 1]

    def to_dict(self) -> dict[str, Any]:
        return {
            "crestDb": self.crestDb,
            "transientDensityPerMin": self.transientDensityPerMin,
            "compressionScore": self.compressionScore,
        }


@dataclass
class ReferenceProfileTonal:
    thirdOctSpectrumDb: dict[str, float]    # bin -> dB
    spectralTiltDbPerOct: float
    subEnergyRatio: float
    lowMidBalanceDb: float
    vocalRegionEnergyDb: float
    airBandEnergyDb: float
    harshnessIndex: float

    def to_dict(self) -> dict[str, Any]:
        return {
            "thirdOctSpectrumDb": dict(self.thirdOctSpectrumDb),
            "spectralTiltDbPerOct": self.spectralTiltDbPerOct,
            "subEnergyRatio": self.subEnergyRatio,
            "lowMidBalanceDb": self.lowMidBalanceDb,
            "vocalRegionEnergyDb": self.vocalRegionEnergyDb,
            "airBandEnergyDb": self.airBandEnergyDb,
            "harshnessIndex": self.harshnessIndex,
        }


@dataclass
class ReferenceProfileStereo:
    correlationMean: float
    msRatioDb: float
    stereoWidthIndex: float

    def to_dict(self) -> dict[str, Any]:
        return {
            "correlationMean": self.correlationMean,
            "msRatioDb": self.msRatioDb,
            "stereoWidthIndex": self.stereoWidthIndex,
        }


@dataclass
class ReferenceProfileFeatures:
    loudness: ReferenceProfileLoudness
    dynamics: ReferenceProfileDynamics
    tonal: ReferenceProfileTonal
    stereo: ReferenceProfileStereo

    def to_dict(self) -> dict[str, Any]:
        return {
            "loudness": self.loudness.to_dict(),
            "dynamics": self.dynamics.to_dict(),
            "tonal": self.tonal.to_dict(),
            "stereo": self.stereo.to_dict(),
        }


@dataclass
class ReferenceProfile:
    id: str
    version: str
    provenance: ReferenceProfileProvenance
    features: ReferenceProfileFeatures
    featureFingerprint: str = ""   # filled by extract_profile()

    def to_dict(self) -> dict[str, Any]:
        return {
            "$schema": REFERENCE_PROFILE_SCHEMA_ID,
            "id": self.id,
            "version": self.version,
            "provenance": self.provenance.to_dict(),
            "features": self.features.to_dict(),
            "featureFingerprint": self.featureFingerprint,
        }
