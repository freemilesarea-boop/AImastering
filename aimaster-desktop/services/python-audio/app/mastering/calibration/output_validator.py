"""
Closed Loop Calibration P1 - Output Validator

Validates the artifacts written to a calibration output directory.  Reads the
output directory only — it never re-renders, re-analyses or mutates any
calibration result.

Mirrors the validator style used in app/engine/validate.py,
app/profiling/validate.py and app/fixtures/validate.py: every check appends
``{"path": ..., "message": ...}`` dicts and an empty error list means valid.

The validator excludes its own output file (15_schema_validation.json) from
every scan so the result is identical whether or not a previous validation
report is already present on disk.

Phase: AI-MASTERING-CLOSED-LOOP-CALIBRATION-P1-1
"""
from __future__ import annotations

import json
import math
import os
import re
from typing import Any

from .constants import CalibrationStatus

SELF_ARTIFACT = "15_schema_validation.json"

# Artifacts the calibration engine is expected to emit, excluding SELF_ARTIFACT.
# 16 is intentionally absent — the numbering skips it by design.
REQUIRED_ARTIFACTS = (
    "01_calibration_dataset.json",
    "02_processor_sweep_registry.json",
    "03_candidate_render_results.json",
    "04_feature_response_results.json",
    "05_response_curves.json",
    "06_safety_results.json",
    "07_overshoot_results.json",
    "08_collateral_regression_results.json",
    "09_no_action_sensitivity_audit.json",
    "10_mapping_registry_original.json",
    "11_mapping_registry_calibrated_candidate.json",
    "12_mapping_registry_diff.json",
    "13_calibration_confidence.json",
    "14_reproducibility.json",
    "17_runtime_safety.json",
)

RENDERS_DIRNAME = "renders"

_CANDIDATE_ID_RE = re.compile(r"^C\d{4}$")

_VALID_STATUS = {s.value for s in CalibrationStatus}

_REQUIRED_RESULT_FIELDS = (
    "candidate_id",
    "track_name",
    "processor",
    "parameter",
    "value",
    "unit",
    "frequency_hz",
    "status",
    "render_success",
    "safety_passed",
    "safety_failures",
    "primary_responses",
    "collateral_responses",
    "overshoot",
    "regression_detected",
    "notes",
)

# Fields that must carry a real number (bool is rejected).
_NUMERIC_RESULT_FIELDS = ("value",)

# Fields that must carry a bool.
_BOOL_RESULT_FIELDS = (
    "render_success",
    "safety_passed",
    "overshoot",
    "regression_detected",
)

# Fields allowed to be null, mapped to the condition under which null is legal.
# frequency_hz is Optional[int] in schema.py — null only for non-EQ processors.
_NULLABLE_RESULT_FIELDS = ("frequency_hz",)

_NUMERIC_RESPONSE_FIELDS = ("before", "after", "delta")


class CalibrationOutputValidationError(ValueError):
    """Raised when a calibration output directory fails schema validation."""

    def __init__(self, errors: list[dict[str, str]]) -> None:
        self.errors = errors
        joined = "; ".join(f"{e['path']}: {e['message']}" for e in errors)
        super().__init__(f"Calibration output validation failed — {joined}")


def _err(errors: list[dict[str, str]], path: str, message: str) -> None:
    errors.append({"path": path, "message": message})


def _num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _finite(v: Any) -> bool:
    return _num(v) and not (math.isnan(v) or math.isinf(v))


def _artifact_files(output_dir: str) -> list[str]:
    """Every .json artifact in the output dir except the validator's own output."""
    if not os.path.isdir(output_dir):
        return []
    return sorted(
        f
        for f in os.listdir(output_dir)
        if f.endswith(".json") and f != SELF_ARTIFACT
    )


def _scan_non_finite(node: Any, path: str, errors: list[dict[str, str]]) -> None:
    """Recursively flag NaN / Infinity floats, which are not valid JSON."""
    if isinstance(node, float):
        if math.isnan(node):
            _err(errors, path, "NaN is not valid JSON")
        elif math.isinf(node):
            _err(errors, path, "Infinity is not valid JSON")
    elif isinstance(node, dict):
        for k, v in node.items():
            _scan_non_finite(v, f"{path}/{k}", errors)
    elif isinstance(node, list):
        for i, v in enumerate(node):
            _scan_non_finite(v, f"{path}[{i}]", errors)


# ═══════════════════════════════════════════════════════════════════════════
# Individual checks — each returns its own error list
# ═══════════════════════════════════════════════════════════════════════════

def check_json_decode(output_dir: str) -> tuple[list[dict[str, str]], dict[str, Any], int]:
    """Every artifact parses as JSON. Returns (errors, parsed, checked_count)."""
    errors: list[dict[str, str]] = []
    parsed: dict[str, Any] = {}
    files = _artifact_files(output_dir)

    if not os.path.isdir(output_dir):
        _err(errors, "/", f"output directory not found: {output_dir}")
        return errors, parsed, 0

    for name in files:
        full = os.path.join(output_dir, name)
        try:
            with open(full) as f:
                parsed[name] = json.load(f)
        except (ValueError, OSError) as exc:
            _err(errors, f"/{name}", f"JSON decode failed: {exc}")

    return errors, parsed, len(files)


def check_required_artifacts(parsed: dict[str, Any]) -> tuple[list[dict[str, str]], int]:
    """All expected artifacts are present and decodable."""
    errors: list[dict[str, str]] = []
    for name in REQUIRED_ARTIFACTS:
        if name not in parsed:
            _err(errors, f"/{name}", "required artifact missing or unreadable")
    return errors, len(REQUIRED_ARTIFACTS)


def check_non_finite(parsed: dict[str, Any]) -> tuple[list[dict[str, str]], int]:
    """No NaN / Infinity anywhere in any artifact."""
    errors: list[dict[str, str]] = []
    for name, data in parsed.items():
        _scan_non_finite(data, f"/{name}", errors)
    return errors, len(parsed)


def _results(parsed: dict[str, Any]) -> list[Any]:
    doc = parsed.get("03_candidate_render_results.json")
    if not isinstance(doc, dict):
        return []
    results = doc.get("results")
    return results if isinstance(results, list) else []


def check_required_fields(parsed: dict[str, Any]) -> tuple[list[dict[str, str]], int]:
    """Every candidate result carries all required fields."""
    errors: list[dict[str, str]] = []
    results = _results(parsed)
    for i, rec in enumerate(results):
        base = f"/03_candidate_render_results.json/results[{i}]"
        if not isinstance(rec, dict):
            _err(errors, base, "result must be a JSON object")
            continue
        for field in _REQUIRED_RESULT_FIELDS:
            if field not in rec:
                _err(errors, f"{base}/{field}", "required field missing")
    return errors, len(results)


def check_enum_values(parsed: dict[str, Any]) -> tuple[list[dict[str, str]], int]:
    """status is a member of CalibrationStatus."""
    errors: list[dict[str, str]] = []
    results = _results(parsed)
    for i, rec in enumerate(results):
        if not isinstance(rec, dict):
            continue
        status = rec.get("status")
        if status not in _VALID_STATUS:
            _err(
                errors,
                f"/03_candidate_render_results.json/results[{i}]/status",
                f"status {status!r} not in {sorted(_VALID_STATUS)}",
            )
    return errors, len(results)


def check_numeric_types(parsed: dict[str, Any]) -> tuple[list[dict[str, str]], int]:
    """Numeric fields are finite numbers; boolean fields are booleans."""
    errors: list[dict[str, str]] = []
    results = _results(parsed)
    checked = 0
    for i, rec in enumerate(results):
        if not isinstance(rec, dict):
            continue
        base = f"/03_candidate_render_results.json/results[{i}]"

        for field in _NUMERIC_RESULT_FIELDS:
            checked += 1
            if not _finite(rec.get(field)):
                _err(errors, f"{base}/{field}", f"expected finite number, got {rec.get(field)!r}")

        for field in _BOOL_RESULT_FIELDS:
            checked += 1
            if not isinstance(rec.get(field), bool):
                _err(errors, f"{base}/{field}", f"expected bool, got {type(rec.get(field)).__name__}")

        for key in ("primary_responses", "collateral_responses"):
            seq = rec.get(key)
            if not isinstance(seq, list):
                _err(errors, f"{base}/{key}", "expected list")
                continue
            for j, resp in enumerate(seq):
                if not isinstance(resp, dict):
                    _err(errors, f"{base}/{key}[{j}]", "response must be a JSON object")
                    continue
                for field in _NUMERIC_RESPONSE_FIELDS:
                    if field in resp:
                        checked += 1
                        if not _finite(resp[field]):
                            _err(
                                errors,
                                f"{base}/{key}[{j}]/{field}",
                                f"expected finite number, got {resp[field]!r}",
                            )
    return errors, checked


def check_null_rules(parsed: dict[str, Any]) -> tuple[list[dict[str, str]], int]:
    """Non-nullable fields are never null; frequency_hz is null only for non-EQ."""
    errors: list[dict[str, str]] = []
    results = _results(parsed)
    for i, rec in enumerate(results):
        if not isinstance(rec, dict):
            continue
        base = f"/03_candidate_render_results.json/results[{i}]"

        for field in _REQUIRED_RESULT_FIELDS:
            if field in _NULLABLE_RESULT_FIELDS or field == "notes":
                continue
            if rec.get(field) is None:
                _err(errors, f"{base}/{field}", "field is not nullable")

        freq = rec.get("frequency_hz")
        if freq is None:
            if rec.get("processor") == "EQ":
                _err(errors, f"{base}/frequency_hz", "EQ candidate requires a frequency")
        elif not isinstance(freq, int) or isinstance(freq, bool):
            _err(errors, f"{base}/frequency_hz", f"expected int or null, got {freq!r}")
    return errors, len(results)


def check_candidate_id_uniqueness(parsed: dict[str, Any]) -> tuple[list[dict[str, str]], int]:
    """candidate_id matches C#### and is unique across all results."""
    errors: list[dict[str, str]] = []
    results = _results(parsed)
    seen: set[str] = set()
    for i, rec in enumerate(results):
        if not isinstance(rec, dict):
            continue
        path = f"/03_candidate_render_results.json/results[{i}]/candidate_id"
        cid = rec.get("candidate_id")
        if not isinstance(cid, str) or not _CANDIDATE_ID_RE.match(cid):
            _err(errors, path, f"candidate_id {cid!r} must match C####")
            continue
        if cid in seen:
            _err(errors, path, f"duplicate candidate_id {cid}")
        seen.add(cid)
    return errors, len(results)


def check_referential_integrity(parsed: dict[str, Any]) -> tuple[list[dict[str, str]], int]:
    """Planned sweep × dataset tracks reconciles with results, and every
    candidate id referenced by a downstream artifact exists in results."""
    errors: list[dict[str, str]] = []
    checks = 0
    results = _results(parsed)
    result_ids = {
        r["candidate_id"]
        for r in results
        if isinstance(r, dict) and isinstance(r.get("candidate_id"), str)
    }

    dataset = parsed.get("01_calibration_dataset.json")
    sweep = parsed.get("02_processor_sweep_registry.json")

    # planned = sweep points × valid tracks
    if isinstance(dataset, dict) and isinstance(sweep, dict):
        checks += 1
        valid_tracks = dataset.get("valid_tracks")
        sweep_points = sweep.get("total_sweep_points")
        if _num(valid_tracks) and _num(sweep_points):
            planned = int(valid_tracks) * int(sweep_points)
            if planned != len(results):
                _err(
                    errors,
                    "/03_candidate_render_results.json/results",
                    f"planned {planned} candidates "
                    f"({valid_tracks} tracks x {sweep_points} sweep points) "
                    f"but found {len(results)} results",
                )

    # every result track must exist in the dataset
    if isinstance(dataset, dict) and isinstance(dataset.get("tracks"), list):
        checks += 1
        stems = {
            os.path.splitext(t["file_name"])[0]
            for t in dataset["tracks"]
            if isinstance(t, dict) and isinstance(t.get("file_name"), str)
        }
        unknown = sorted(
            {
                r["track_name"]
                for r in results
                if isinstance(r, dict)
                and isinstance(r.get("track_name"), str)
                and r["track_name"] not in stems
            }
        )
        for name in unknown:
            _err(
                errors,
                "/03_candidate_render_results.json/results/track_name",
                f"track {name!r} not present in 01_calibration_dataset.json",
            )

    # downstream artifacts must only reference known candidate ids
    for artifact in (
        "07_overshoot_results.json",
        "08_collateral_regression_results.json",
    ):
        doc = parsed.get(artifact)
        if not isinstance(doc, dict) or not isinstance(doc.get("candidates"), list):
            continue
        checks += 1
        for cid in doc["candidates"]:
            if cid not in result_ids:
                _err(
                    errors,
                    f"/{artifact}/candidates",
                    f"references unknown candidate_id {cid!r}",
                )

    return errors, checks


def check_render_files(output_dir: str, parsed: dict[str, Any]) -> tuple[list[dict[str, str]], int]:
    """A render exists on disk for every successfully rendered candidate, and
    no render is orphaned.

    03 does not persist the render path, so the engine's naming convention
    ``{candidate_id}_{track_name}.wav`` is the join key.
    """
    errors: list[dict[str, str]] = []
    results = _results(parsed)
    renders_dir = os.path.join(output_dir, RENDERS_DIRNAME)

    if not os.path.isdir(renders_dir):
        _err(errors, f"/{RENDERS_DIRNAME}", "renders directory not found")
        return errors, 0

    on_disk = {f for f in os.listdir(renders_dir) if f.endswith(".wav")}
    expected: set[str] = set()

    for i, rec in enumerate(results):
        if not isinstance(rec, dict) or not rec.get("render_success"):
            continue
        cid, track = rec.get("candidate_id"), rec.get("track_name")
        if not isinstance(cid, str) or not isinstance(track, str):
            continue
        name = f"{cid}_{track}.wav"
        expected.add(name)
        full = os.path.join(renders_dir, name)
        if name not in on_disk:
            _err(
                errors,
                f"/03_candidate_render_results.json/results[{i}]",
                f"render_success is true but {RENDERS_DIRNAME}/{name} does not exist",
            )
        elif os.path.getsize(full) == 0:
            _err(errors, f"/{RENDERS_DIRNAME}/{name}", "render file is empty")

    for orphan in sorted(on_disk - expected):
        _err(errors, f"/{RENDERS_DIRNAME}/{orphan}", "render has no corresponding result record")

    return errors, len(expected)


def check_cross_file_counts(parsed: dict[str, Any]) -> tuple[list[dict[str, str]], int]:
    """Header counters agree with the arrays they summarise."""
    errors: list[dict[str, str]] = []
    checks = 0
    results = _results(parsed)

    doc = parsed.get("03_candidate_render_results.json")
    if isinstance(doc, dict):
        checks += 1
        if doc.get("total_candidates") != len(results):
            _err(
                errors,
                "/03_candidate_render_results.json/total_candidates",
                f"declares {doc.get('total_candidates')} but results has {len(results)}",
            )

        checks += 1
        tallied = {
            "passed": sum(1 for r in results if isinstance(r, dict) and r.get("status") == "PASSED"),
            "rejected": sum(1 for r in results if isinstance(r, dict) and r.get("status") == "REJECTED"),
            "safety_failed": sum(
                1 for r in results if isinstance(r, dict) and r.get("status") == "SAFETY_FAILED"
            ),
        }
        for key, actual in tallied.items():
            if doc.get(key) != actual:
                _err(
                    errors,
                    f"/03_candidate_render_results.json/{key}",
                    f"declares {doc.get(key)} but results contain {actual}",
                )

    for artifact, total_key, list_key in (
        ("07_overshoot_results.json", "total_overshoot", "candidates"),
        ("08_collateral_regression_results.json", "total_regression", "candidates"),
        ("09_no_action_sensitivity_audit.json", "total_audits", "audits"),
        ("05_response_curves.json", "total_curves", "curves"),
    ):
        d = parsed.get(artifact)
        if not isinstance(d, dict) or not isinstance(d.get(list_key), list):
            continue
        checks += 1
        if d.get(total_key) != len(d[list_key]):
            _err(
                errors,
                f"/{artifact}/{total_key}",
                f"declares {d.get(total_key)} but {list_key} has {len(d[list_key])}",
            )

    safety = parsed.get("06_safety_results.json")
    if isinstance(safety, dict):
        checks += 1
        actual = sum(1 for r in results if isinstance(r, dict) and r.get("safety_passed") is True)
        if safety.get("safety_passed") != actual:
            _err(
                errors,
                "/06_safety_results.json/safety_passed",
                f"declares {safety.get('safety_passed')} but results contain {actual}",
            )

    return errors, checks


# ═══════════════════════════════════════════════════════════════════════════
# Public API
# ═══════════════════════════════════════════════════════════════════════════

def build_validation_report(output_dir: str) -> dict[str, Any]:
    """Validate a calibration output directory and return the report dict
    written to 15_schema_validation.json.

    Only checks that are actually implemented are reported.  Reads the output
    directory; mutates nothing.
    """
    decode_errors, parsed, decoded_count = check_json_decode(output_dir)

    checks: list[dict[str, Any]] = [
        {"check": "json_decode", "checked": decoded_count, "errors": decode_errors},
    ]

    if parsed or not decode_errors:
        artifact_errors, artifact_count = check_required_artifacts(parsed)
        nonfinite_errors, nonfinite_count = check_non_finite(parsed)
        field_errors, field_count = check_required_fields(parsed)
        enum_errors, enum_count = check_enum_values(parsed)
        numeric_errors, numeric_count = check_numeric_types(parsed)
        null_errors, null_count = check_null_rules(parsed)
        id_errors, id_count = check_candidate_id_uniqueness(parsed)
        ref_errors, ref_count = check_referential_integrity(parsed)
        render_errors, render_count = check_render_files(output_dir, parsed)
        count_errors, count_count = check_cross_file_counts(parsed)

        checks += [
            {"check": "required_artifacts", "checked": artifact_count, "errors": artifact_errors},
            {"check": "required_fields", "checked": field_count, "errors": field_errors},
            {"check": "enum_values", "checked": enum_count, "errors": enum_errors},
            {"check": "numeric_types", "checked": numeric_count, "errors": numeric_errors},
            {"check": "nan_infinity", "checked": nonfinite_count, "errors": nonfinite_errors},
            {"check": "null_rules", "checked": null_count, "errors": null_errors},
            {"check": "candidate_id_uniqueness", "checked": id_count, "errors": id_errors},
            {"check": "referential_integrity", "checked": ref_count, "errors": ref_errors},
            {"check": "render_file_existence", "checked": render_count, "errors": render_errors},
            {"check": "cross_file_counts", "checked": count_count, "errors": count_errors},
        ]

    all_errors: list[dict[str, str]] = []
    check_rows: list[dict[str, Any]] = []
    for entry in checks:
        errs = entry["errors"]
        all_errors.extend(errs)
        check_rows.append(
            {
                "check": entry["check"],
                "status": "PASS" if not errs else "FAIL",
                "checked": entry["checked"],
                "error_count": len(errs),
            }
        )

    return {
        "valid": not all_errors,
        "errors": all_errors,
        "validated_dir": output_dir,
        "self_excluded": SELF_ARTIFACT,
        "checks": check_rows,
        "summary": {
            "total_checks": len(check_rows),
            "passed_checks": sum(1 for c in check_rows if c["status"] == "PASS"),
            "failed_checks": sum(1 for c in check_rows if c["status"] == "FAIL"),
            "total_errors": len(all_errors),
        },
    }


def validate_calibration_output(output_dir: str) -> list[dict[str, str]]:
    """Return list of error dicts.  Empty list ⇒ valid."""
    return build_validation_report(output_dir)["errors"]


if __name__ == "__main__":  # pragma: no cover - manual re-validation entrypoint
    import sys

    target = sys.argv[1] if len(sys.argv) > 1 else "."
    report = build_validation_report(target)
    print(json.dumps(report, indent=2))
    sys.exit(0 if report["valid"] else 1)
