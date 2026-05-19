"""
Runtime validation for EnginePreset v1 dicts.

Mirrors the rules in packages/shared-types/src/engine/validate.ts so the
adapters agree on what counts as a valid preset.
"""
from __future__ import annotations

import re
from typing import Any

from .schema import ENGINE_PRESET_SCHEMA_ID

_SEMVER_RE = re.compile(r"^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$")
_SLUG_RE = re.compile(r"^[A-Za-z0-9_-]{2,64}$")

_VALID_MODULE_TYPES = {
    "source",
    "gain-staging",
    "adaptive-eq",
    "dynamic-eq",
    "multiband-eq",
    "bus-comp",
    "transient-protection",
    "vocal-enhancer",
    "saturator",
    "stereo-imager",
    "deesser",
    "loudness-norm",
    "soft-clip",
    "limiter",
    "isp-safety",
    "dither",
    "sink",
}

_VALID_SR = {44100, 48000, 88200, 96000}
_VALID_BIT = {16, 24, 32}
_VALID_FMT = {"wav", "flac", "mp3", "aac"}


class ValidationError(ValueError):
    """Raised when a preset dict fails schema validation."""

    def __init__(self, errors: list[dict[str, str]]) -> None:
        self.errors = errors
        joined = "; ".join(f"{e['path']}: {e['message']}" for e in errors)
        super().__init__(f"EnginePreset validation failed — {joined}")


def _err(errors: list[dict[str, str]], path: str, message: str) -> None:
    errors.append({"path": path, "message": message})


def _num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _range(
    errors: list[dict[str, str]],
    v: Any,
    path: str,
    min_v: float | None = None,
    max_v: float | None = None,
) -> bool:
    if not _num(v):
        _err(errors, path, f"expected number, got {type(v).__name__}")
        return False
    if min_v is not None and v < min_v:
        _err(errors, path, f"value {v} below min {min_v}")
        return False
    if max_v is not None and v > max_v:
        _err(errors, path, f"value {v} above max {max_v}")
        return False
    return True


def _validate_module(errors: list[dict[str, str]], node: Any, path: str) -> None:
    if not isinstance(node, dict):
        _err(errors, path, "module must be a JSON object")
        return
    t = node.get("type")
    if t not in _VALID_MODULE_TYPES:
        _err(errors, f"{path}/type", f"unknown module type: {t!r}")
        return
    mid = node.get("id")
    if not isinstance(mid, str) or not _SLUG_RE.match(mid):
        _err(errors, f"{path}/id", "id must be a slug (2-64 chars, [A-Za-z0-9_-])")

    if t in ("source", "sink"):
        return

    if t == "adaptive-eq":
        bands = node.get("bands")
        if not isinstance(bands, list) or not bands:
            _err(errors, f"{path}/bands", "adaptive-eq must have at least one band")
            return
        for i, b in enumerate(bands):
            bp = f"{path}/bands/{i}"
            if not isinstance(b, dict):
                _err(errors, bp, "band must be object")
                continue
            if b.get("filterType") not in ("low_shelf", "high_shelf", "peak", "high_pass", "low_pass"):
                _err(errors, f"{bp}/filterType", f"unknown filterType: {b.get('filterType')!r}")
            _range(errors, b.get("freqHz"), f"{bp}/freqHz", 1, 96000)
            _range(errors, b.get("gainDb"), f"{bp}/gainDb", -48, 24)
        return

    if t == "dynamic-eq":
        _range(errors, node.get("intensity"), f"{path}/intensity", 0, 2)
        bands = node.get("bands", [])
        if not isinstance(bands, list):
            _err(errors, f"{path}/bands", "bands must be array")
            return
        for i, b in enumerate(bands):
            bp = f"{path}/bands/{i}"
            if not isinstance(b, dict):
                continue
            _range(errors, b.get("freqHz"), f"{bp}/freqHz", 20, 20000)
            _range(errors, b.get("q"), f"{bp}/q", 0.1, 10)
            _range(errors, b.get("thresholdDb"), f"{bp}/thresholdDb", -60, 0)
            _range(errors, b.get("reductionDb"), f"{bp}/reductionDb", 0, 12)
            if b.get("mode") not in ("cut", "boost"):
                _err(errors, f"{bp}/mode", "mode must be 'cut' or 'boost'")
        return

    if t == "multiband-eq":
        bands = node.get("bands", [])
        if not isinstance(bands, list):
            _err(errors, f"{path}/bands", "bands must be array")
            return
        for i, b in enumerate(bands):
            bp = f"{path}/bands/{i}"
            if not isinstance(b, dict):
                continue
            if b.get("id") not in ("low", "mid", "vocal", "high"):
                _err(errors, f"{bp}/id", "must be low|mid|vocal|high")
            _range(errors, b.get("centreHz"), f"{bp}/centreHz", 20, 20000)
            _range(errors, b.get("gainDb"), f"{bp}/gainDb", -12, 12)
        return

    if t == "bus-comp":
        _range(errors, node.get("thresholdDb"), f"{path}/thresholdDb", -60, 0)
        _range(errors, node.get("ratio"), f"{path}/ratio", 1, 20)
        _range(errors, node.get("attackMs"), f"{path}/attackMs", 0.1, 1000)
        _range(errors, node.get("releaseMs"), f"{path}/releaseMs", 1, 5000)
        _range(errors, node.get("makeupDb"), f"{path}/makeupDb", 0, 24)
        _range(errors, node.get("kneeDb"), f"{path}/kneeDb", 0, 24)
        return

    if t == "saturator":
        _range(errors, node.get("amount"), f"{path}/amount", 0, 1)
        return

    if t == "stereo-imager":
        _range(errors, node.get("width"), f"{path}/width", 0, 4)
        return

    if t == "deesser":
        _range(errors, node.get("freqHz"), f"{path}/freqHz", 1000, 20000)
        _range(errors, node.get("q"), f"{path}/q", 0.1, 10)
        _range(errors, node.get("reductionDb"), f"{path}/reductionDb", 0, 12)
        return

    if t == "loudness-norm":
        _range(errors, node.get("targetLufs"), f"{path}/targetLufs", -36, -3)
        _range(errors, node.get("targetTpDb"), f"{path}/targetTpDb", -9, 0)
        if "targetLra" in node:
            _range(errors, node.get("targetLra"), f"{path}/targetLra", 1, 30)
        return

    if t == "limiter":
        _range(errors, node.get("ceilingDb"), f"{path}/ceilingDb", -6, 0)
        return

    if t == "isp-safety":
        _range(errors, node.get("ceilingDbtp"), f"{path}/ceilingDbtp", -6, 0)
        return

    if t == "dither":
        if node.get("bitDepth") not in (16, 24, 32):
            _err(errors, f"{path}/bitDepth", "bitDepth must be 16|24|32")
        return

    # gain-staging / transient-protection / vocal-enhancer / soft-clip:
    # all fields optional with adapter defaults — nothing to validate here.


def validate_preset(data: Any) -> list[dict[str, str]]:
    """Return list of error dicts.  Empty list ⇒ valid."""
    errors: list[dict[str, str]] = []
    if not isinstance(data, dict):
        _err(errors, "", "preset must be a JSON object")
        return errors

    if data.get("$schema") != ENGINE_PRESET_SCHEMA_ID:
        _err(errors, "/$schema", f"$schema must equal {ENGINE_PRESET_SCHEMA_ID}")

    if not isinstance(data.get("id"), str) or not _SLUG_RE.match(data["id"]):
        _err(errors, "/id", "id must be a slug")
    if not isinstance(data.get("name"), str) or not data["name"]:
        _err(errors, "/name", "name must be non-empty string")
    if not isinstance(data.get("version"), str) or not _SEMVER_RE.match(data["version"]):
        _err(errors, "/version", "version must be semver")

    compat = data.get("compatibility")
    if not isinstance(compat, dict) or not _SEMVER_RE.match(compat.get("engineApiMin", "")):
        _err(errors, "/compatibility/engineApiMin", "must be semver")

    if "meta" in data and not isinstance(data["meta"], dict):
        _err(errors, "/meta", "meta must be object")

    pol = data.get("policies")
    if not isinstance(pol, dict):
        _err(errors, "/policies", "policies object required")
    else:
        if pol.get("vocalProtection") not in (None, "off", "safe", "strict"):
            _err(errors, "/policies/vocalProtection", "must be off|safe|strict")
        if pol.get("safeMode") not in (None, "none", "safe", "vocal_safe", "low_limit"):
            _err(errors, "/policies/safeMode", "must be none|safe|vocal_safe|low_limit")
        if "aiCorrections" in pol and not isinstance(pol["aiCorrections"], bool):
            _err(errors, "/policies/aiCorrections", "must be boolean")
        if pol.get("limiterStrength") not in (None, "low", "medium", "high"):
            _err(errors, "/policies/limiterStrength", "must be low|medium|high")

    out = data.get("output")
    if not isinstance(out, dict):
        _err(errors, "/output", "output object required")
    else:
        if out.get("sampleRate") not in _VALID_SR:
            _err(errors, "/output/sampleRate", "must be 44100|48000|88200|96000")
        if out.get("bitDepth") not in _VALID_BIT:
            _err(errors, "/output/bitDepth", "must be 16|24|32")
        if out.get("format") not in _VALID_FMT:
            _err(errors, "/output/format", "must be wav|flac|mp3|aac")

    chain = data.get("chain")
    if not isinstance(chain, dict) or not isinstance(chain.get("nodes"), list):
        _err(errors, "/chain/nodes", "chain.nodes must be array")
    else:
        nodes = chain["nodes"]
        if len(nodes) < 2:
            _err(errors, "/chain/nodes", "chain must have at least source and sink")
        for i, n in enumerate(nodes):
            _validate_module(errors, n, f"/chain/nodes/{i}")
        if nodes and isinstance(nodes[0], dict) and nodes[0].get("type") != "source":
            _err(errors, "/chain/nodes/0/type", "first node must be source")
        if nodes and isinstance(nodes[-1], dict) and nodes[-1].get("type") != "sink":
            _err(errors, f"/chain/nodes/{len(nodes)-1}/type", "last node must be sink")
        # Unique IDs
        seen: set[str] = set()
        for i, n in enumerate(nodes):
            if isinstance(n, dict) and isinstance(n.get("id"), str):
                if n["id"] in seen:
                    _err(errors, f"/chain/nodes/{i}/id", f"duplicate id: {n['id']}")
                seen.add(n["id"])

    return errors
