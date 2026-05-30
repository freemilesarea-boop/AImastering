"""
Python representation of the canonical EnginePreset v1 schema.

This mirrors `packages/shared-types/src/engine/*.ts`.  Any change here MUST
be paired with the TS side; the cross-language equivalence harness fails on
schema drift.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, Optional

# Authoritative version constants (mirrors ts/engine/index.ts).
ENGINE_PRESET_SCHEMA_ID = "https://schemas.loui.studio/engine-preset/v1"
ENGINE_API_VERSION = "1.0.0"

FilterType = Literal["low_shelf", "high_shelf", "peak", "high_pass", "low_pass"]
DynamicEqMode = Literal["cut", "boost"]
MultibandId = Literal["low", "mid", "vocal", "high"]
VocalProtectionPolicy = Literal["off", "safe", "strict"]
SafeMode = Literal["none", "safe", "vocal_safe", "low_limit"]
LimiterStrength = Literal["low", "medium", "high"]
LoudnessAlgorithm = Literal["linear", "static", "iterative", "auto"]
EnginePresetSampleRate = Literal[44100, 48000, 88200, 96000]
EnginePresetBitDepth = Literal[16, 24, 32]
EnginePresetFormat = Literal["wav", "flac", "mp3", "aac"]


# ── Module payloads (raw dicts — we keep them dynamic so the adapter can
# ── consume future v1.x additions without dataclass churn).  Type-safety
# ── happens in validate.py.
EngineModule = dict[str, Any]


@dataclass
class EnginePresetCompatibility:
    engineApiMin: str
    dspCoreMin: Optional[str] = None


@dataclass
class EnginePresetOutput:
    sampleRate: int
    bitDepth: int
    format: str
    bitrateKbps: Optional[int] = None


@dataclass
class EnginePresetPolicies:
    vocalProtection: Optional[str] = None
    safeMode: Optional[str] = None
    aiCorrections: Optional[bool] = None
    limiterStrength: Optional[str] = None


@dataclass
class EnginePresetMeta:
    author: Optional[str] = None
    createdAt: Optional[str] = None
    updatedAt: Optional[str] = None
    tags: list[str] = field(default_factory=list)
    genre: Optional[str] = None
    description: Optional[str] = None
    legacyStyleId: Optional[str] = None


@dataclass
class EnginePreset:
    """In-memory representation of an EnginePreset v1 document."""

    id: str
    name: str
    version: str
    compatibility: EnginePresetCompatibility
    meta: EnginePresetMeta
    policies: EnginePresetPolicies
    output: EnginePresetOutput
    nodes: list[EngineModule]
    raw: dict[str, Any] = field(default_factory=dict)  # original JSON, for debug

    # Convenience accessors -------------------------------------------------

    def module(self, module_type: str) -> Optional[EngineModule]:
        """Return first node of given type or None."""
        for n in self.nodes:
            if n.get("type") == module_type:
                return n
        return None

    def has_module(self, module_type: str) -> bool:
        return self.module(module_type) is not None


@dataclass
class AdapterLogEntry:
    moduleId: str
    moduleType: str
    status: Literal["applied", "noop", "clamped", "error"]
    note: Optional[str] = None
    clamps: list[dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "moduleId": self.moduleId,
            "moduleType": self.moduleType,
            "status": self.status,
        }
        if self.note:
            out["note"] = self.note
        if self.clamps:
            out["clamps"] = self.clamps
        return out


@dataclass
class AdapterRunReport:
    presetId: str
    presetVersion: str
    adapter: str  # 'python'
    actualSampleRate: int
    durationMs: float
    entries: list[AdapterLogEntry] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "presetId": self.presetId,
            "presetVersion": self.presetVersion,
            "adapter": self.adapter,
            "actualSampleRate": self.actualSampleRate,
            "durationMs": self.durationMs,
            "entries": [e.to_dict() for e in self.entries],
        }

    def add(
        self,
        module_id: str,
        module_type: str,
        status: str,
        note: Optional[str] = None,
        clamps: Optional[list[dict[str, Any]]] = None,
    ) -> None:
        self.entries.append(
            AdapterLogEntry(
                moduleId=module_id,
                moduleType=module_type,
                status=status,  # type: ignore[arg-type]
                note=note,
                clamps=clamps or [],
            )
        )
