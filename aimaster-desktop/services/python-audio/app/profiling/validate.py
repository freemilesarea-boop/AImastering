"""
Runtime validator for ReferenceProfile v1 dicts.

Mirrors packages/shared-types/src/profile/validate.ts.  Enforces the
"no identifying metadata, no reconstruction-enabling data" invariants
at deserialisation time.
"""
from __future__ import annotations

import re
from typing import Any

from .schema import REFERENCE_PROFILE_SCHEMA_ID

_SLUG_RE = re.compile(r"^[A-Za-z0-9_-]{2,128}$")
_SEMVER_RE = re.compile(r"^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$")
_HEX64_RE = re.compile(r"^[a-f0-9]{64}$")

_FORBIDDEN_PROVENANCE_KEYS = {"artist", "title", "album", "lyrics", "isrc", "mbid"}


class ProfileValidationError(ValueError):
    def __init__(self, errors: list[dict[str, str]]) -> None:
        self.errors = errors
        joined = "; ".join(f"{e['path']}: {e['message']}" for e in errors)
        super().__init__(f"ReferenceProfile validation failed — {joined}")


def _err(errs: list[dict[str, str]], path: str, msg: str) -> None:
    errs.append({"path": path, "message": msg})


def _num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _percentiles(errs: list[dict[str, str]], v: Any, path: str) -> None:
    if not isinstance(v, dict):
        _err(errs, path, "must be object with p10/p50/p90")
        return
    for k in ("p10", "p50", "p90"):
        if not _num(v.get(k)):
            _err(errs, f"{path}/{k}", "must be number")


def validate_reference_profile(data: Any) -> list[dict[str, str]]:
    """Return list of error dicts.  Empty ⇒ valid."""
    errs: list[dict[str, str]] = []
    if not isinstance(data, dict):
        return [{"path": "", "message": "profile must be a JSON object"}]

    if data.get("$schema") != REFERENCE_PROFILE_SCHEMA_ID:
        _err(errs, "/$schema", f"must equal {REFERENCE_PROFILE_SCHEMA_ID}")

    if not isinstance(data.get("id"), str) or not _SLUG_RE.match(data["id"]):
        _err(errs, "/id", "must be slug")

    if not isinstance(data.get("version"), str) or not _SEMVER_RE.match(data["version"]):
        _err(errs, "/version", "must be semver")

    # Provenance — enforce the no-identifying-metadata rule.
    prov = data.get("provenance")
    if not isinstance(prov, dict):
        _err(errs, "/provenance", "object required")
    else:
        for forb in _FORBIDDEN_PROVENANCE_KEYS:
            if forb in prov:
                _err(
                    errs,
                    f"/provenance/{forb}",
                    "forbidden identifying field (schema requires no rights-holder metadata)",
                )
        if prov.get("sourceType") not in (
            "user-supplied", "fixture", "builtin", "streaming-snapshot",
        ):
            _err(errs, "/provenance/sourceType", f"unknown sourceType: {prov.get('sourceType')!r}")
        if not isinstance(prov.get("createdAt"), str):
            _err(errs, "/provenance/createdAt", "must be ISO string")
        if not _num(prov.get("durationSec")) or prov["durationSec"] <= 0:
            _err(errs, "/provenance/durationSec", "must be positive number")
        if not _num(prov.get("sampleRate")) or prov["sampleRate"] <= 0:
            _err(errs, "/provenance/sampleRate", "must be positive number")
        if not _num(prov.get("channels")) or not (1 <= prov["channels"] <= 8):
            _err(errs, "/provenance/channels", "must be int 1..8")
        if not isinstance(prov.get("extractorVersion"), str):
            _err(errs, "/provenance/extractorVersion", "must be string")
        sha = prov.get("sourceFileSha256")
        if sha is not None and not (isinstance(sha, str) and _HEX64_RE.match(sha)):
            _err(errs, "/provenance/sourceFileSha256", "must be null or 64-char hex sha256")

    # Features — enforce the no-fingerprint, no-time-series rule.
    f = data.get("features")
    if not isinstance(f, dict):
        _err(errs, "/features", "object required")
        return errs

    # Loudness
    ld = f.get("loudness")
    if not isinstance(ld, dict):
        _err(errs, "/features/loudness", "object required")
    else:
        for k in ("integratedLufs", "truePeakDbtp", "loudnessRange"):
            if not _num(ld.get(k)):
                _err(errs, f"/features/loudness/{k}", "must be number")
        _percentiles(errs, ld.get("shortTermPercentiles"), "/features/loudness/shortTermPercentiles")
        _percentiles(errs, ld.get("momentaryPercentiles"), "/features/loudness/momentaryPercentiles")

    # Dynamics
    dy = f.get("dynamics")
    if not isinstance(dy, dict):
        _err(errs, "/features/dynamics", "object required")
    else:
        for k in ("crestDb", "transientDensityPerMin"):
            if not _num(dy.get(k)):
                _err(errs, f"/features/dynamics/{k}", "must be number")
        cs = dy.get("compressionScore")
        if not _num(cs) or cs < 0 or cs > 1:
            _err(errs, "/features/dynamics/compressionScore", "must be number in [0, 1]")

    # Tonal — bin count cap
    tn = f.get("tonal")
    if not isinstance(tn, dict):
        _err(errs, "/features/tonal", "object required")
    else:
        spec = tn.get("thirdOctSpectrumDb")
        if not isinstance(spec, dict):
            _err(errs, "/features/tonal/thirdOctSpectrumDb", "object required")
        else:
            if len(spec) > 64:
                _err(
                    errs,
                    "/features/tonal/thirdOctSpectrumDb",
                    f"bin count {len(spec)} > 64 — 1/3-oct resolution maximum (no fingerprinting)",
                )
            for k, v in spec.items():
                if not _num(v):
                    _err(errs, f"/features/tonal/thirdOctSpectrumDb/{k}", "must be number")
        for k in ("spectralTiltDbPerOct", "lowMidBalanceDb", "vocalRegionEnergyDb",
                  "airBandEnergyDb", "harshnessIndex"):
            if not _num(tn.get(k)):
                _err(errs, f"/features/tonal/{k}", "must be number")
        sub = tn.get("subEnergyRatio")
        if not _num(sub) or sub < 0 or sub > 1:
            _err(errs, "/features/tonal/subEnergyRatio", "must be in [0, 1]")

    # Stereo
    st = f.get("stereo")
    if not isinstance(st, dict):
        _err(errs, "/features/stereo", "object required")
    else:
        for k in ("msRatioDb", "stereoWidthIndex"):
            if not _num(st.get(k)):
                _err(errs, f"/features/stereo/{k}", "must be number")
        c = st.get("correlationMean")
        if not _num(c) or c < -1.001 or c > 1.001:
            _err(errs, "/features/stereo/correlationMean", "must be in [-1, +1]")

    # featureFingerprint
    fp = data.get("featureFingerprint")
    if not isinstance(fp, str) or not _HEX64_RE.match(fp):
        _err(errs, "/featureFingerprint", "must be 64-char hex sha256")

    # Guard: arrays in features (forbidden — could be time-series or fingerprint).
    for k, v in (f or {}).items():
        if isinstance(v, list) and len(v) > 200:
            _err(
                errs,
                f"/features/{k}",
                f"array length {len(v)} > 200 — forbidden (no time-series / no fingerprint arrays)",
            )

    return errs
