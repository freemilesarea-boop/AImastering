"""
EnginePreset JSON loader.

Reads preset JSON files, validates against the schema, materialises into
an EnginePreset dataclass.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .schema import (
    EnginePreset,
    EnginePresetCompatibility,
    EnginePresetMeta,
    EnginePresetOutput,
    EnginePresetPolicies,
)
from .validate import ValidationError, validate_preset

BUILTIN_DIR = Path(__file__).parent / "builtin"


def _coerce(data: dict[str, Any]) -> EnginePreset:
    meta_d = data.get("meta") or {}
    pol_d = data.get("policies") or {}
    out_d = data["output"]
    return EnginePreset(
        id=data["id"],
        name=data["name"],
        version=data["version"],
        compatibility=EnginePresetCompatibility(
            engineApiMin=data["compatibility"]["engineApiMin"],
            dspCoreMin=data["compatibility"].get("dspCoreMin"),
        ),
        meta=EnginePresetMeta(
            author=meta_d.get("author"),
            createdAt=meta_d.get("createdAt"),
            updatedAt=meta_d.get("updatedAt"),
            tags=list(meta_d.get("tags") or []),
            genre=meta_d.get("genre"),
            description=meta_d.get("description"),
            legacyStyleId=meta_d.get("legacyStyleId"),
        ),
        policies=EnginePresetPolicies(
            vocalProtection=pol_d.get("vocalProtection"),
            safeMode=pol_d.get("safeMode"),
            aiCorrections=pol_d.get("aiCorrections"),
            limiterStrength=pol_d.get("limiterStrength"),
        ),
        output=EnginePresetOutput(
            sampleRate=out_d["sampleRate"],
            bitDepth=out_d["bitDepth"],
            format=out_d["format"],
            bitrateKbps=out_d.get("bitrateKbps"),
        ),
        nodes=list(data["chain"]["nodes"]),
        raw=data,
    )


def load_preset_dict(data: dict[str, Any]) -> EnginePreset:
    """Validate and materialise a preset dict.  Raises ValidationError."""
    errors = validate_preset(data)
    if errors:
        raise ValidationError(errors)
    return _coerce(data)


def load_preset_file(path: str | Path) -> EnginePreset:
    """Load + validate a preset JSON file."""
    p = Path(path)
    with p.open("r", encoding="utf-8") as f:
        data = json.load(f)
    return load_preset_dict(data)


def load_builtin_preset(name: str) -> EnginePreset:
    """Load by base name (e.g. 'balanced' → balanced.preset.json)."""
    # Allow callers to pass either 'balanced' or 'balanced.preset.json'.
    fname = name if name.endswith(".preset.json") else f"{name}.preset.json"
    return load_preset_file(BUILTIN_DIR / fname)


def list_builtin_presets() -> list[str]:
    """Return base names of built-in presets, sorted."""
    if not BUILTIN_DIR.exists():
        return []
    out: list[str] = []
    for p in sorted(BUILTIN_DIR.glob("*.preset.json")):
        out.append(p.name.removesuffix(".preset.json"))
    return out
