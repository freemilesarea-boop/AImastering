"""
Calibration Evidence Validator.

Answers the questions the previous audit could not: is this run complete, is
every record well formed, and does anything in it leak a path or an identity.

Follows the validator convention already used by app/engine/validate.py,
app/profiling/validate.py and app/mastering/calibration/output_validator.py -
every check appends ``{"path": ..., "message": ...}`` dicts, and an empty error
list means valid.

Reads only. Never writes, renders or repairs: a validator that fixes what it
finds cannot be trusted to report what was there.

Phase: AI-MASTERING-CALIBRATION-EVIDENCE-CONTRACT-IMPLEMENTATION-1
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Sequence

from .evidence import (
    ALL_STATUSES,
    EVIDENCE_SCHEMA_VERSION,
    FAILURE_STATUSES,
    SUCCESS_STATUSES,
    CalibrationRecord,
    RunManifest,
    canonical_json,
    find_sensitive_strings,
)

Error = Dict[str, str]


def _err(errors: List[Error], path: str, message: str) -> None:
    errors.append({"path": path, "message": message})


# ── per-record checks ────────────────────────────────────────────────────────

def validate_record(
    record: CalibrationRecord,
    expected_schema_version: str = EVIDENCE_SCHEMA_VERSION,
) -> List[Error]:
    """Validate one record in isolation."""
    errors: List[Error] = []
    cid = record.identity.candidate_id or "<no-candidate-id>"
    base = f"record[{cid}]"

    # identity
    if not record.identity.candidate_id:
        _err(errors, base, "candidate_id is missing")
    if not record.identity.engine_commit_sha:
        _err(errors, f"{base}.identity", "engine_commit_sha is missing")
    if not record.identity.created_at_utc:
        _err(errors, f"{base}.identity", "created_at_utc is missing")
    if record.identity.schema_version != expected_schema_version:
        _err(
            errors,
            f"{base}.identity",
            f"schema_version {record.identity.schema_version!r} does not match "
            f"expected {expected_schema_version!r}",
        )

    # status
    if record.status not in ALL_STATUSES:
        _err(errors, f"{base}.status", f"unknown status {record.status!r}")

    # A failed record without a reason is the failure equivalent of a missing
    # record: it says something went wrong and nothing about what.
    if record.status in FAILURE_STATUSES and not record.failure_reason:
        _err(
            errors,
            f"{base}.failure_reason",
            f"status is {record.status} but failure_reason is missing",
        )
    if record.status in SUCCESS_STATUSES and record.failure_reason:
        _err(
            errors,
            f"{base}.failure_reason",
            "failure_reason is set on a successful record",
        )

    # source hashing - required for every record, failures included: without it
    # a failure cannot be attributed to a specific version of a specific input.
    if not record.source.track_sha256:
        _err(errors, f"{base}.source.track_sha256", "source hash is missing")
    if not record.source.track_path_relative:
        _err(errors, f"{base}.source.track_path_relative", "track path is missing")

    # output hashing - only meaningful where a render exists.
    if record.status in SUCCESS_STATUSES:
        if not record.output.render_sha256:
            _err(
                errors,
                f"{base}.output.render_sha256",
                "render hash is missing on a successful record",
            )
        if not record.input.input_feature_sha256:
            _err(
                errors,
                f"{base}.input.input_feature_sha256",
                "input feature hash is missing on a successful record",
            )

    errors.extend(_path_and_privacy_errors(record, base))
    errors.extend(_canonicalisation_errors(record, base))
    return errors


def _path_and_privacy_errors(record: CalibrationRecord, base: str) -> List[Error]:
    errors: List[Error] = []

    rel = record.source.track_path_relative or ""
    if rel.startswith("/") or rel.startswith("\\"):
        _err(errors, f"{base}.source.track_path_relative",
             f"absolute path stored: {rel!r}")
    elif len(rel) > 1 and rel[1] == ":":
        _err(errors, f"{base}.source.track_path_relative",
             f"absolute Windows path stored: {rel!r}")
    elif rel.startswith("../") or rel == "..":
        _err(errors, f"{base}.source.track_path_relative",
             f"path escapes the dataset root: {rel!r}")

    try:
        serialised = canonical_json(record.to_dict())
    except Exception:  # canonicalisation errors are reported separately
        return errors

    for marker in sorted(set(find_sensitive_strings(serialised))):
        _err(errors, base, f"sensitive value present in record: {marker!r}")

    return errors


def _canonicalisation_errors(record: CalibrationRecord, base: str) -> List[Error]:
    errors: List[Error] = []
    try:
        canonical_json(record.to_dict())
    except Exception as exc:  # noqa: BLE001 - reported, not raised
        _err(errors, base, f"record is not canonically serialisable: {exc}")
    return errors


# ── run-level checks ─────────────────────────────────────────────────────────

def validate_run(
    manifest: RunManifest,
    records: Sequence[CalibrationRecord],
    expected_candidate_ids: Optional[Sequence[str]] = None,
) -> List[Error]:
    """Validate a whole run: completeness, uniqueness, and every record.

    ``expected_candidate_ids`` makes the missing-record check exact. Without it
    only the count can be checked, which catches a short run but not a run that
    is the right size with the wrong members.
    """
    errors: List[Error] = []

    if manifest.schema_version != EVIDENCE_SCHEMA_VERSION:
        _err(
            errors,
            "manifest.schema_version",
            f"schema_version {manifest.schema_version!r} does not match "
            f"expected {EVIDENCE_SCHEMA_VERSION!r}",
        )

    # duplicates
    seen: Dict[str, int] = {}
    for record in records:
        cid = record.identity.candidate_id
        seen[cid] = seen.get(cid, 0) + 1
    for cid, count in sorted(seen.items()):
        if count > 1:
            _err(errors, "run.candidates",
                 f"duplicate candidate_id {cid!r} appears {count} times")

    successes = [r for r in records if r.status in SUCCESS_STATUSES]
    failures = [r for r in records if r.status in FAILURE_STATUSES]

    # The counting identity this whole contract exists to make checkable:
    # a failed candidate is accounted for, not missing.
    total = len(successes) + len(failures)
    if manifest.completed_record_count != len(successes):
        _err(errors, "manifest.completed_record_count",
             f"manifest says {manifest.completed_record_count}, found {len(successes)}")
    if manifest.failed_record_count != len(failures):
        _err(errors, "manifest.failed_record_count",
             f"manifest says {manifest.failed_record_count}, found {len(failures)}")

    expected = manifest.expected_candidate_count
    missing = expected - total
    if missing < 0:
        _err(errors, "run.completeness",
             f"found {total} records but only {expected} were expected")
    elif missing > 0:
        _err(errors, "run.completeness",
             f"{missing} record(s) missing: expected {expected}, "
             f"found {total} ({len(successes)} passed + {len(failures)} failed)")

    if manifest.missing_record_count != max(missing, 0):
        _err(errors, "manifest.missing_record_count",
             f"manifest says {manifest.missing_record_count}, "
             f"computed {max(missing, 0)}")

    if expected_candidate_ids is not None:
        expected_set = set(expected_candidate_ids)
        found_set = set(seen)
        for cid in sorted(expected_set - found_set):
            _err(errors, "run.completeness", f"no record for expected candidate {cid!r}")
        for cid in sorted(found_set - expected_set):
            _err(errors, "run.completeness", f"unexpected candidate {cid!r} in run")

    if not manifest.run_id:
        _err(errors, "manifest.run_id", "run_id is missing")
    if not manifest.engine_commit_sha:
        _err(errors, "manifest.engine_commit_sha", "engine_commit_sha is missing")
    if not manifest.deterministic_config_hash:
        _err(errors, "manifest.deterministic_config_hash", "config hash is missing")

    for record in records:
        errors.extend(validate_record(record))

    return errors


def validate_store(store, expected_candidate_ids=None) -> List[Error]:
    """Validate a run on disk through an ``EvidenceStore``."""
    errors: List[Error] = []
    try:
        manifest = store.read_manifest()
    except FileNotFoundError:
        _err(errors, "manifest", f"manifest not found at {store.manifest_path}")
        return errors
    except Exception as exc:  # noqa: BLE001
        _err(errors, "manifest", f"manifest could not be read: {exc}")
        return errors

    try:
        records = store.read_records()
    except Exception as exc:  # noqa: BLE001
        _err(errors, "records", f"records could not be read: {exc}")
        return errors

    errors.extend(validate_run(manifest, records, expected_candidate_ids))
    return errors


def summarise(
    manifest: RunManifest,
    records: Sequence[CalibrationRecord],
) -> Dict[str, Any]:
    """Run summary derived entirely from the records, never asserted."""
    successes = [r for r in records if r.status in SUCCESS_STATUSES]
    failures = [r for r in records if r.status in FAILURE_STATUSES]

    by_status: Dict[str, int] = {}
    for record in records:
        by_status[record.status] = by_status.get(record.status, 0) + 1

    errors = validate_run(manifest, records)
    return {
        "run_id": manifest.run_id,
        "schema_version": manifest.schema_version,
        "expected_candidate_count": manifest.expected_candidate_count,
        "record_count": len(records),
        "passed_count": len(successes),
        "failed_count": len(failures),
        "missing_count": max(manifest.expected_candidate_count - len(records), 0),
        "by_status": dict(sorted(by_status.items())),
        "complete": manifest.expected_candidate_count == len(records),
        "valid": len(errors) == 0,
        "error_count": len(errors),
    }
