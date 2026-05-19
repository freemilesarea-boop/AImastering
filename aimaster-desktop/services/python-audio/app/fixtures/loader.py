"""
FixtureMetadata loader.

Loads + validates JSON files under recipes/ into FixtureMetadata dataclasses.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from .schema import (
    FixtureCharacteristics,
    FixtureMetadata,
    FixturePolicy,
    FixtureReferenceMaster,
    FixtureSourceExternalCC0,
    FixtureSourceSyntheticRecipe,
    FixtureSourceUserSupplied,
    FixtureTargetMetrics,
)
from .validate import FixtureValidationError, validate_fixture

RECIPES_DIR = Path(__file__).parent / "recipes"
CACHE_DIR = Path(os.environ.get("LOUI_FIXTURE_CACHE", "/tmp/aimaster-fixtures"))


def _coerce_source(src: dict[str, Any]) -> Any:
    t = src["type"]
    if t == "synthetic-recipe":
        return FixtureSourceSyntheticRecipe(
            type="synthetic-recipe",
            recipe=src["recipe"],
            params=dict(src.get("params") or {}),
        )
    if t == "external-cc0":
        return FixtureSourceExternalCC0(
            type="external-cc0",
            url=src["url"],
            sha256=src["sha256"],
            license=src["license"],
            attribution=src.get("attribution"),
        )
    if t == "user-supplied":
        return FixtureSourceUserSupplied(
            type="user-supplied",
            relativePath=src["relativePath"],
        )
    raise FixtureValidationError([{"path": "/source/type", "message": f"unknown type: {t}"}])


def _coerce(data: dict[str, Any]) -> FixtureMetadata:
    ch = data["characteristics"]
    ref = data["referenceMaster"]
    tm = ref["targetMetrics"]
    pol = data["policy"]
    return FixtureMetadata(
        id=data["id"],
        category=data["category"],
        name=data["name"],
        version=data["version"],
        source=_coerce_source(data["source"]),
        characteristics=FixtureCharacteristics(
            durationSec=float(ch["durationSec"]),
            sampleRate=int(ch["sampleRate"]),
            bitDepth=int(ch["bitDepth"]),
            channels=int(ch["channels"]),
            preMasterLufsI=(float(ch["preMasterLufsI"]) if ch.get("preMasterLufsI") is not None else None),
            tags=list(ch.get("tags") or []),
        ),
        referenceMaster=FixtureReferenceMaster(
            available=bool(ref["available"]),
            targetMetrics=FixtureTargetMetrics(
                lufsI=float(tm["lufsI"]),
                tpMaxDb=float(tm["tpMaxDb"]),
                lraMinLu=float(tm["lraMinLu"]),
                lraMaxLu=float(tm["lraMaxLu"]),
                crestDb=(float(tm["crestDb"]) if tm.get("crestDb") is not None else None),
                thirdOctSpectrumDb=(dict(tm["thirdOctSpectrumDb"]) if tm.get("thirdOctSpectrumDb") else None),
                rationale=tm.get("rationale"),
            ),
            wavRelativePath=ref.get("wavRelativePath"),
        ),
        recommendedPresetId=data["recommendedPresetId"],
        policy=FixturePolicy(
            lufsToleranceLu=float(pol["lufsToleranceLu"]),
            spectrumRmsDeltaMaxDb=(
                float(pol["spectrumRmsDeltaMaxDb"]) if pol.get("spectrumRmsDeltaMaxDb") is not None else None
            ),
            spectrumMaxDeltaMaxDb=(
                float(pol["spectrumMaxDeltaMaxDb"]) if pol.get("spectrumMaxDeltaMaxDb") is not None else None
            ),
            tpHardCeiling=bool(pol.get("tpHardCeiling", True)),
        ),
        description=data.get("description"),
        raw=data,
    )


def load_fixture_dict(data: dict[str, Any]) -> FixtureMetadata:
    errs = validate_fixture(data)
    if errs:
        raise FixtureValidationError(errs)
    return _coerce(data)


def load_fixture_file(path: str | Path) -> FixtureMetadata:
    p = Path(path)
    with p.open("r", encoding="utf-8") as f:
        return load_fixture_dict(json.load(f))


def list_builtin_fixtures() -> list[str]:
    """Return base names (without .fixture.json) of bundled recipes."""
    if not RECIPES_DIR.exists():
        return []
    out: list[str] = []
    for p in sorted(RECIPES_DIR.glob("*.fixture.json")):
        out.append(p.name.removesuffix(".fixture.json"))
    return out


def load_builtin_fixture(name: str) -> FixtureMetadata:
    fname = name if name.endswith(".fixture.json") else f"{name}.fixture.json"
    return load_fixture_file(RECIPES_DIR / fname)
