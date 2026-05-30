"""
Python representation of FixtureMetadata v1.

Mirrors packages/shared-types/src/fixtures/*.ts.  Changes here MUST be
paired with the TS side.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, Optional, Union

FIXTURE_SCHEMA_ID = "https://schemas.loui.studio/fixture/v1"

FixtureCategory = Literal[
    "kpop",
    "lofi",
    "edm",
    "hiphop",
    "ballad",
    "acoustic",
    "female-vocal",
    "male-vocal",
    "ai-harsh-mix",
    "reference-tone",
    "broadcast-speech",
]


@dataclass
class FixtureSourceSyntheticRecipe:
    type: Literal["synthetic-recipe"]
    recipe: str
    params: dict[str, Any]


@dataclass
class FixtureSourceExternalCC0:
    type: Literal["external-cc0"]
    url: str
    sha256: str
    license: str
    attribution: Optional[str] = None


@dataclass
class FixtureSourceUserSupplied:
    type: Literal["user-supplied"]
    relativePath: str


FixtureSource = Union[
    FixtureSourceSyntheticRecipe,
    FixtureSourceExternalCC0,
    FixtureSourceUserSupplied,
]


@dataclass
class FixtureCharacteristics:
    durationSec: float
    sampleRate: int
    bitDepth: int
    channels: int
    preMasterLufsI: Optional[float] = None
    tags: list[str] = field(default_factory=list)


@dataclass
class FixtureTargetMetrics:
    lufsI: float
    tpMaxDb: float
    lraMinLu: float
    lraMaxLu: float
    crestDb: Optional[float] = None
    thirdOctSpectrumDb: Optional[dict[str, float]] = None
    rationale: Optional[str] = None


@dataclass
class FixturePolicy:
    lufsToleranceLu: float
    spectrumRmsDeltaMaxDb: Optional[float] = None
    spectrumMaxDeltaMaxDb: Optional[float] = None
    tpHardCeiling: bool = True


@dataclass
class FixtureReferenceMaster:
    available: bool
    targetMetrics: FixtureTargetMetrics
    wavRelativePath: Optional[str] = None


@dataclass
class FixtureMetadata:
    id: str
    category: str
    name: str
    version: str
    source: FixtureSource
    characteristics: FixtureCharacteristics
    referenceMaster: FixtureReferenceMaster
    recommendedPresetId: str
    policy: FixturePolicy
    description: Optional[str] = None
    raw: dict[str, Any] = field(default_factory=dict)
