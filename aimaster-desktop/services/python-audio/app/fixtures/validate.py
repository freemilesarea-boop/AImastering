"""
Runtime validator for FixtureMetadata v1 dicts.

Mirrors packages/shared-types/src/fixtures/validate.ts.
"""
from __future__ import annotations

import re
from typing import Any

from .schema import FIXTURE_SCHEMA_ID

_SLUG = re.compile(r"^[A-Za-z0-9_-]{2,64}$")
_SEMVER = re.compile(r"^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$")

_CATEGORIES = {
    "kpop", "lofi", "edm", "hiphop", "ballad", "acoustic",
    "female-vocal", "male-vocal", "ai-harsh-mix",
    "reference-tone", "broadcast-speech",
}


class FixtureValidationError(ValueError):
    def __init__(self, errors: list[dict[str, str]]) -> None:
        self.errors = errors
        joined = "; ".join(f"{e['path']}: {e['message']}" for e in errors)
        super().__init__(f"Fixture validation failed — {joined}")


def _err(errs: list[dict[str, str]], path: str, message: str) -> None:
    errs.append({"path": path, "message": message})


def _num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def validate_fixture(data: Any) -> list[dict[str, str]]:
    """Return list of error dicts.  Empty ⇒ valid."""
    errs: list[dict[str, str]] = []
    if not isinstance(data, dict):
        return [{"path": "", "message": "fixture must be a JSON object"}]

    if data.get("$schema") != FIXTURE_SCHEMA_ID:
        _err(errs, "/$schema", f"must equal {FIXTURE_SCHEMA_ID}")

    if not isinstance(data.get("id"), str) or not _SLUG.match(data["id"]):
        _err(errs, "/id", "must be slug")
    if data.get("category") not in _CATEGORIES:
        _err(errs, "/category", f"unknown category: {data.get('category')!r}")
    if not isinstance(data.get("name"), str) or not data["name"]:
        _err(errs, "/name", "name required")
    if not isinstance(data.get("version"), str) or not _SEMVER.match(data["version"]):
        _err(errs, "/version", "must be semver")

    src = data.get("source")
    if not isinstance(src, dict):
        _err(errs, "/source", "object required")
    else:
        t = src.get("type")
        if t == "synthetic-recipe":
            if not isinstance(src.get("recipe"), str):
                _err(errs, "/source/recipe", "must be string")
            if not isinstance(src.get("params"), dict):
                _err(errs, "/source/params", "must be object")
        elif t == "external-cc0":
            if not isinstance(src.get("url"), str):
                _err(errs, "/source/url", "must be string")
            sha = src.get("sha256")
            if not isinstance(sha, str) or len(sha) != 64:
                _err(errs, "/source/sha256", "must be 64-char hex sha256")
            if src.get("license") not in ("CC0", "CC-BY", "CC-BY-SA", "public-domain"):
                _err(errs, "/source/license", "license must be CC0|CC-BY|CC-BY-SA|public-domain")
        elif t == "user-supplied":
            if not isinstance(src.get("relativePath"), str):
                _err(errs, "/source/relativePath", "must be string")
        else:
            _err(errs, "/source/type", f"unknown source type: {t}")

    ch = data.get("characteristics")
    if not isinstance(ch, dict):
        _err(errs, "/characteristics", "object required")
    else:
        if not _num(ch.get("durationSec")) or ch["durationSec"] <= 0:
            _err(errs, "/characteristics/durationSec", "must be positive number")
        if ch.get("sampleRate") not in (44100, 48000, 88200, 96000):
            _err(errs, "/characteristics/sampleRate", "must be 44100|48000|88200|96000")
        if ch.get("bitDepth") not in (16, 24, 32):
            _err(errs, "/characteristics/bitDepth", "must be 16|24|32")
        if ch.get("channels") not in (1, 2):
            _err(errs, "/characteristics/channels", "must be 1 or 2")

    ref = data.get("referenceMaster")
    if not isinstance(ref, dict):
        _err(errs, "/referenceMaster", "object required")
    else:
        if not isinstance(ref.get("available"), bool):
            _err(errs, "/referenceMaster/available", "must be boolean")
        if ref.get("available") and not isinstance(ref.get("wavRelativePath"), str):
            _err(errs, "/referenceMaster/wavRelativePath", "required when available=true")
        tm = ref.get("targetMetrics")
        if not isinstance(tm, dict):
            _err(errs, "/referenceMaster/targetMetrics", "object required")
        else:
            for k in ("lufsI", "tpMaxDb", "lraMinLu", "lraMaxLu"):
                if not _num(tm.get(k)):
                    _err(errs, f"/referenceMaster/targetMetrics/{k}", "must be number")
            if _num(tm.get("lraMinLu")) and _num(tm.get("lraMaxLu")):
                if tm["lraMinLu"] > tm["lraMaxLu"]:
                    _err(errs, "/referenceMaster/targetMetrics/lraMaxLu", "must be ≥ lraMinLu")

    if not isinstance(data.get("recommendedPresetId"), str) or not _SLUG.match(data["recommendedPresetId"]):
        _err(errs, "/recommendedPresetId", "must be slug")

    pol = data.get("policy")
    if not isinstance(pol, dict):
        _err(errs, "/policy", "object required")
    else:
        v = pol.get("lufsToleranceLu")
        if not _num(v) or v < 0:
            _err(errs, "/policy/lufsToleranceLu", "must be non-negative number")

    return errs
