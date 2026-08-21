"""Calibration evidence contract — schema, hashing, storage, completeness.

The P1 run's evidence was deleted and with it every answer about missing,
duplicate and corrupt records. These tests pin the properties that make that
recoverable: failures are recorded, counts add up, hashes are deterministic, and
nothing machine-specific is ever written.

No audio is rendered and no calibration artifact is read. Records are built from
synthetic fixtures and written to tmp_path.
"""
from __future__ import annotations

import json
import os

import pytest

from app.mastering.calibration.evidence import (
    EVIDENCE_SCHEMA_VERSION,
    CalibrationRecord,
    CanonicalisationError,
    EvidenceStatus,
    EvidenceStore,
    Identity,
    InputEvidence,
    OutputEvidence,
    PathSafetyError,
    RunManifest,
    SafetyEvidence,
    SensitiveDataError,
    SourceInfo,
    canonical_json,
    canonical_sha256,
    config_hash,
    default_evidence_root,
    find_sensitive_strings,
    relative_track_path,
    scan_for_sensitive_strings,
    sha256_file,
)
from app.mastering.calibration.evidence_validator import (
    summarise,
    validate_record,
    validate_run,
    validate_store,
)

COMMIT = "1be4bce75c7411b17eb09e70535520c2851508fc"
WHEN = "2026-08-09T12:00:00Z"


def make_record(candidate_id="C0001", status=EvidenceStatus.PASSED.value, **over):
    """A complete, valid record. Tests break exactly one thing at a time."""
    record = CalibrationRecord(
        identity=Identity(
            candidate_id=candidate_id,
            engine_commit_sha=COMMIT,
            created_at_utc=WHEN,
        ),
        status=status,
        source=SourceInfo(
            track_path_relative="ai/Coastline.wav",
            track_sha256="a" * 64,
            track_duration_s=180.5,
            sample_rate=44100,
            channels=2,
            bit_depth=24,
        ),
        input=InputEvidence(
            input_features={"spectral_centroid": 3100.0, "input_tp": -1.2},
            input_feature_sha256="b" * 64,
        ),
        output=OutputEvidence(
            output_features={"spectral_centroid": 3000.0, "input_tp": -1.3},
            output_feature_sha256="c" * 64,
            render_sha256="d" * 64,
            render_bytes=1234567,
        ),
        safety=SafetyEvidence(
            clipping_sample_count=0,
            sample_peak_dbfs=-1.5,
            true_peak_dbtp=-1.3,
            isp_overshoot_dbtp=0.2,
            loudness_lufs_i=-9.8,
            loudness_lra=7.4,
            dc_offset=0.0,
            mono_compatibility=0.92,
            safety_pass=True,
        ),
    )
    if status in ("RENDER_FAILED", "ANALYSIS_FAILED", "SAFETY_FAILED", "REJECTED"):
        record.failure_reason = "ffmpeg exited 1"
    for key, value in over.items():
        setattr(record, key, value)
    return record


def make_manifest(expected=2, completed=1, failed=1, missing=0, run_id="run-0001"):
    return RunManifest(
        run_id=run_id,
        engine_commit_sha=COMMIT,
        source_dataset_id="ai-25",
        source_track_count=25,
        expected_candidate_count=expected,
        created_at_utc=WHEN,
        ffmpeg_version="6.0",
        python_version="3.11.9",
        platform="darwin-arm64",
        completed_record_count=completed,
        failed_record_count=failed,
        missing_record_count=missing,
        deterministic_config_hash=config_hash({"sweeps": 56}),
        # Canonical analysis provenance. Required: a target set whose analysis
        # conditions are unknown cannot be compared against anything later.
        preprocessing_policy_version="1.0.0",
        canonical_analysis_sr=44100,
        numpy_version="1.26.4",
        decoder_implementation="ffmpeg",
        decoder_version="6.0",
        decoder_binary_sha256="e" * 64,
        resampler_implementation="ffmpeg-aresample-swr",
        resampler_version="6.0",
        resampler_binary_sha256="e" * 64,
        resampler_parameters=(
            "aresample=osr=44100:resampler=swr:filter_size=32:phase_shift=10:"
            "linear_interp=1:exact_rational=1:filter_type=kaiser:kaiser_beta=9:"
            "cutoff=0:dither_method=0:async=0"
        ),
        dither_policy="none",
        analyzer_source_sha256="f" * 64,
    )


# ══ A — round-trip is lossless ═══════════════════════════════════════════════

def test_a_record_round_trip_is_lossless():
    original = make_record()
    restored = CalibrationRecord.from_dict(json.loads(json.dumps(original.to_dict())))
    assert restored == original
    assert restored.to_canonical_json() == original.to_canonical_json()


def test_a_failure_record_round_trip_is_lossless():
    original = make_record("C0002", EvidenceStatus.RENDER_FAILED.value)
    restored = CalibrationRecord.from_dict(original.to_dict())
    assert restored == original
    assert restored.failure_reason == "ffmpeg exited 1"


def test_a_manifest_round_trip_is_lossless():
    original = make_manifest()
    assert RunManifest.from_dict(original.to_dict()) == original


def test_round_trip_rejects_unknown_fields():
    """Silently dropping an unknown field would turn a schema mismatch into
    quiet data loss, which is the failure mode this contract exists to stop."""
    data = make_record().to_dict()
    data["surprise"] = 1
    with pytest.raises(ValueError, match="unknown field"):
        CalibrationRecord.from_dict(data)

    data = make_record().to_dict()
    data["safety"]["surprise"] = 1
    with pytest.raises(ValueError, match="unknown field"):
        CalibrationRecord.from_dict(data)


# ══ B — canonical hashing is deterministic ═══════════════════════════════════

def test_b_canonical_json_is_key_order_independent():
    assert canonical_json({"b": 1, "a": 2}) == canonical_json({"a": 2, "b": 1})
    assert canonical_json({"b": 1, "a": 2}) == '{"a":2,"b":1}'


def test_b_hash_is_stable_across_calls():
    record = make_record()
    assert record.content_sha256() == record.content_sha256()


def test_b_same_logical_record_hashes_identically():
    assert make_record().content_sha256() == make_record().content_sha256()


def test_b_different_record_hashes_differently():
    assert make_record("C0001").content_sha256() != make_record("C0002").content_sha256()


def test_b_negative_zero_normalises():
    """-0.0 == 0.0 but serialises differently: one value must not have two hashes."""
    assert canonical_json({"v": -0.0}) == canonical_json({"v": 0.0})


def test_b_non_finite_floats_are_rejected():
    """Python's json writes bare NaN/Infinity, which no conforming reader
    accepts - permitting them writes evidence that cannot be read back."""
    for bad in (float("nan"), float("inf"), float("-inf")):
        with pytest.raises(CanonicalisationError):
            canonical_json({"v": bad})


def test_b_unrepresentable_types_are_rejected():
    with pytest.raises(CanonicalisationError):
        canonical_json({"v": object()})


def test_b_non_string_keys_are_rejected():
    with pytest.raises(CanonicalisationError):
        canonical_json({1: "x"})


def test_b_unicode_is_preserved_not_escaped():
    assert canonical_json({"t": "한글"}) == '{"t":"한글"}'


def test_b_tuples_and_sets_serialise_deterministically():
    assert canonical_json({"v": (1, 2)}) == canonical_json({"v": [1, 2]})
    assert canonical_json({"v": {"b", "a"}}) == canonical_json({"v": ["a", "b"]})


def test_b_config_hash_is_order_independent():
    assert config_hash({"a": 1, "b": 2}) == config_hash({"b": 2, "a": 1})


def test_b_file_hash_matches_known_value(tmp_path):
    path = tmp_path / "x.bin"
    path.write_bytes(b"abc")
    # sha256("abc")
    assert sha256_file(str(path)) == (
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    )


def test_b_canonical_sha256_matches_manual_digest():
    import hashlib
    payload = {"a": 1}
    expected = hashlib.sha256(canonical_json(payload).encode("utf-8")).hexdigest()
    assert canonical_sha256(payload) == expected


# ══ K — repeated serialisation is byte-identical ═════════════════════════════

def test_k_repeated_serialisation_is_byte_identical():
    record = make_record()
    first = record.to_canonical_json().encode("utf-8")
    for _ in range(5):
        assert record.to_canonical_json().encode("utf-8") == first


def test_k_written_files_are_byte_identical_across_runs(tmp_path):
    record = make_record()
    a = EvidenceStore("r1", root=str(tmp_path / "a"))
    b = EvidenceStore("r1", root=str(tmp_path / "b"))
    a.ensure_dirs(); b.ensure_dirs()
    pa, pb = a.write_record(record), b.write_record(record)
    assert open(pa, "rb").read() == open(pb, "rb").read()


# ══ C / D — completeness of success and failure records ══════════════════════

def test_c_valid_success_record_passes():
    assert validate_record(make_record()) == []


def test_d_valid_failure_record_passes():
    for status in ("RENDER_FAILED", "ANALYSIS_FAILED", "SAFETY_FAILED", "REJECTED"):
        assert validate_record(make_record("C1", status)) == [], status


def test_failure_record_needs_no_render_hash():
    """A render that never happened has no hash; demanding one would make every
    failure record permanently invalid."""
    record = make_record("C1", EvidenceStatus.RENDER_FAILED.value)
    record.output = OutputEvidence()
    assert validate_record(record) == []


def test_success_record_without_render_hash_is_rejected():
    record = make_record()
    record.output.render_sha256 = ""
    errors = validate_record(record)
    assert any("render hash is missing" in e["message"] for e in errors)


# ══ E — a failed candidate is not counted as missing ═════════════════════════

def test_e_failed_candidate_is_accounted_for_not_missing():
    """The counting identity the whole contract rests on."""
    records = [
        make_record("C0001", EvidenceStatus.PASSED.value),
        make_record("C0002", EvidenceStatus.RENDER_FAILED.value),
    ]
    manifest = make_manifest(expected=2, completed=1, failed=1, missing=0)
    assert validate_run(manifest, records) == []

    summary = summarise(manifest, records)
    assert summary["passed_count"] == 1
    assert summary["failed_count"] == 1
    assert summary["missing_count"] == 0
    assert summary["complete"] is True
    assert summary["valid"] is True


def test_e_genuinely_absent_candidate_is_reported_missing():
    records = [make_record("C0001")]
    manifest = make_manifest(expected=2, completed=1, failed=0, missing=1)
    errors = validate_run(manifest, records)
    assert any("1 record(s) missing" in e["message"] for e in errors)


def test_e_expected_ids_catch_a_right_sized_run_with_wrong_members():
    """Counts alone cannot see a substitution."""
    records = [make_record("C0001"), make_record("C0999")]
    manifest = make_manifest(expected=2, completed=2, failed=0)
    errors = validate_run(manifest, records, expected_candidate_ids=["C0001", "C0002"])
    assert any("no record for expected candidate 'C0002'" in e["message"] for e in errors)
    assert any("unexpected candidate 'C0999'" in e["message"] for e in errors)


# ══ F — duplicate candidate_id ═══════════════════════════════════════════════

def test_f_duplicate_candidate_id_detected():
    records = [make_record("C0001"), make_record("C0001")]
    manifest = make_manifest(expected=2, completed=2, failed=0)
    errors = validate_run(manifest, records)
    assert any("duplicate candidate_id 'C0001'" in e["message"] for e in errors)


def test_f_store_refuses_to_overwrite_a_record(tmp_path):
    """Append-only: evidence that can be quietly overwritten is not evidence."""
    store = EvidenceStore("r1", root=str(tmp_path))
    store.ensure_dirs()
    store.write_record(make_record("C0001"))
    with pytest.raises(FileExistsError):
        store.write_record(make_record("C0001"))


# ══ G — absolute paths rejected ══════════════════════════════════════════════

@pytest.mark.parametrize("bad", [
    "/Users/theblank/Desktop/AI 음원/Coastline.wav",
    "/home/dev/audio/x.wav",
    "C:\\Users\\dev\\x.wav",
    "../outside/x.wav",
])
def test_g_absolute_or_escaping_path_is_rejected(bad):
    record = make_record()
    record.source.track_path_relative = bad
    errors = validate_record(record)
    assert errors, f"{bad} was accepted"


def test_g_store_refuses_to_write_a_sensitive_record(tmp_path):
    """The write path fails closed, so a leak cannot reach disk at all."""
    record = make_record()
    record.source.track_path_relative = "/Users/theblank/x.wav"
    store = EvidenceStore("r1", root=str(tmp_path))
    store.ensure_dirs()
    with pytest.raises(SensitiveDataError):
        store.write_record(record)
    assert not os.path.exists(store.record_path("C0001", False))


def test_g_relative_track_path_helper():
    rel = relative_track_path("/data/ai/Coastline.wav", "/data")
    assert rel == "ai/Coastline.wav"


def test_g_relative_track_path_refuses_to_fall_back_to_absolute():
    """A silent fallback is exactly how an absolute path reaches permanent
    evidence."""
    with pytest.raises(PathSafetyError):
        relative_track_path("/elsewhere/x.wav", "/data")


# ══ H — missing hashes ═══════════════════════════════════════════════════════

def test_h_missing_source_hash_detected():
    record = make_record()
    record.source.track_sha256 = ""
    assert any("source hash is missing" in e["message"] for e in validate_record(record))


def test_h_missing_input_feature_hash_detected():
    record = make_record()
    record.input.input_feature_sha256 = ""
    errors = validate_record(record)
    assert any("input feature hash is missing" in e["message"] for e in errors)


def test_h_missing_config_hash_detected():
    manifest = make_manifest(expected=1, completed=1, failed=0)
    manifest.deterministic_config_hash = ""
    errors = validate_run(manifest, [make_record()])
    assert any("config hash is missing" in e["message"] for e in errors)


# ══ I — schema version mismatch ══════════════════════════════════════════════

def test_i_record_schema_version_mismatch_detected():
    record = make_record()
    record.identity.schema_version = "0.9.0"
    errors = validate_record(record)
    assert any("schema_version" in e["message"] for e in errors)


def test_i_manifest_schema_version_mismatch_detected():
    manifest = make_manifest(expected=1, completed=1, failed=0)
    manifest.schema_version = "0.9.0"
    errors = validate_run(manifest, [make_record()])
    assert any("schema_version" in e["message"] for e in errors)


def test_i_current_schema_version_is_pinned():
    assert EVIDENCE_SCHEMA_VERSION == "1.0.0"


# ══ J — expected count mismatch ══════════════════════════════════════════════

def test_j_manifest_counts_disagreeing_with_records_detected():
    records = [make_record("C0001"), make_record("C0002")]
    manifest = make_manifest(expected=2, completed=1, failed=1)
    errors = validate_run(manifest, records)
    assert any("completed_record_count" in e["path"] for e in errors)
    assert any("failed_record_count" in e["path"] for e in errors)


def test_j_more_records_than_expected_detected():
    records = [make_record(f"C{i:04d}") for i in range(3)]
    manifest = make_manifest(expected=2, completed=3, failed=0)
    errors = validate_run(manifest, records)
    assert any("only 2 were expected" in e["message"] for e in errors)


def test_j_missing_count_must_match_computation():
    manifest = make_manifest(expected=5, completed=1, failed=0, missing=0)
    errors = validate_run(manifest, [make_record()])
    assert any("missing_record_count" in e["path"] for e in errors)


# ══ L — failed record without a reason ═══════════════════════════════════════

def test_l_failed_record_without_reason_is_rejected():
    record = make_record("C1", EvidenceStatus.SAFETY_FAILED.value)
    record.failure_reason = None
    errors = validate_record(record)
    assert any("failure_reason is missing" in e["message"] for e in errors)


def test_l_successful_record_with_a_failure_reason_is_rejected():
    record = make_record()
    record.failure_reason = "why is this here"
    errors = validate_record(record)
    assert any("failure_reason is set" in e["message"] for e in errors)


def test_unknown_status_is_rejected():
    record = make_record()
    record.status = "MAYBE"
    assert any("unknown status" in e["message"] for e in validate_record(record))


# ══ privacy scanning ═════════════════════════════════════════════════════════

@pytest.mark.parametrize("text", [
    '{"p":"/Users/theblank/x.wav"}',
    '{"p":"/home/dev/x.wav"}',
    '{"p":"C:\\\\Users\\\\dev\\\\x.wav"}',
    '{"p":"/private/var/folders/ab/T/tmp123"}',
    '{"p":"/var/folders/ab/T/tmp123"}',
    '{"p":"/tmp/aimaster-rc-1234"}',
    '{"e":"freemilesarea@gmail.com"}',
    '{"p":"$HOME/audio"}',
    '{"p":"%USERPROFILE%\\\\audio"}',
])
def test_sensitive_strings_are_detected(text):
    assert find_sensitive_strings(text), f"not detected: {text}"
    with pytest.raises(SensitiveDataError):
        scan_for_sensitive_strings(text)


@pytest.mark.parametrize("text", [
    '{"p":"ai/Coastline.wav"}',
    '{"p":"subdir/track 01.wav"}',
    '{"filter":"highshelf=f=10000:g=-1.50"}',
    '{"t":"한글 트랙.wav"}',
])
def test_clean_strings_are_not_flagged(text):
    assert find_sensitive_strings(text) == []
    scan_for_sensitive_strings(text)


def test_a_clean_record_contains_no_sensitive_value():
    assert find_sensitive_strings(make_record().to_canonical_json()) == []


# ══ storage ══════════════════════════════════════════════════════════════════

def test_store_routes_success_and_failure_to_separate_directories(tmp_path):
    store = EvidenceStore("r1", root=str(tmp_path))
    store.ensure_dirs()
    store.write_record(make_record("C0001", EvidenceStatus.PASSED.value))
    store.write_record(make_record("C0002", EvidenceStatus.RENDER_FAILED.value))

    assert os.listdir(store.candidates_dir) == ["C0001.json"]
    assert os.listdir(store.failures_dir) == ["C0002.json"]


def test_store_write_then_read_round_trip(tmp_path):
    store = EvidenceStore("r1", root=str(tmp_path))
    store.ensure_dirs()
    written = [
        make_record("C0001", EvidenceStatus.PASSED.value),
        make_record("C0002", EvidenceStatus.REJECTED.value),
    ]
    for record in written:
        store.write_record(record)
    manifest = make_manifest(expected=2, completed=1, failed=1)
    store.write_manifest(manifest)

    assert store.read_manifest() == manifest
    assert store.read_records() == written
    assert validate_store(store) == []


def test_store_read_order_is_deterministic(tmp_path):
    store = EvidenceStore("r1", root=str(tmp_path))
    store.ensure_dirs()
    for i in (3, 1, 2):
        store.write_record(make_record(f"C{i:04d}"))
    ids = [r.identity.candidate_id for r in store.read_records()]
    assert ids == sorted(ids)


def test_validate_store_reports_a_missing_manifest(tmp_path):
    store = EvidenceStore("nope", root=str(tmp_path))
    errors = validate_store(store)
    assert any("manifest not found" in e["message"] for e in errors)


def test_evidence_root_is_repository_managed_not_desktop():
    root = default_evidence_root()
    assert root.endswith(os.path.join("python-audio", "calibration-evidence"))
    assert "Desktop/Closed-Loop" not in root
    # Never inside app/: that package is what PyInstaller bundles.
    assert os.path.join("python-audio", "app") not in root


def test_evidence_root_is_overridable(monkeypatch, tmp_path):
    monkeypatch.setenv("AIMASTER_CALIBRATION_EVIDENCE_DIR", str(tmp_path))
    assert default_evidence_root() == str(tmp_path)


def test_summary_is_derived_not_asserted(tmp_path):
    """summary.json must reflect the records, so a wrong manifest cannot make an
    incomplete run look finished."""
    manifest = make_manifest(expected=5, completed=1, failed=0, missing=0)
    summary = summarise(manifest, [make_record()])
    assert summary["complete"] is False
    assert summary["missing_count"] == 4
    assert summary["valid"] is False
    assert summary["error_count"] > 0


# ══ canonical analysis provenance (RUN_LEVEL) ════════════════════════════════

def test_provenance_complete_manifest_is_valid():
    """Guard against the provenance checks being vacuously satisfiable."""
    assert validate_run(make_manifest(expected=1, completed=1, failed=0),
                        [make_record()]) == []


@pytest.mark.parametrize("field", [
    "preprocessing_policy_version",
    "numpy_version",
    "decoder_implementation",
    "decoder_version",
    "decoder_binary_sha256",
    "resampler_implementation",
    "resampler_version",
    "resampler_binary_sha256",
    "resampler_parameters",
    "dither_policy",
    "analyzer_source_sha256",
    "python_version",
])
def test_missing_provenance_field_is_detected(field):
    """Each field is independently required.

    The previous reference statistics were unusable because nobody could say
    what produced them; any one of these going missing recreates that.
    """
    manifest = make_manifest(expected=1, completed=1, failed=0)
    setattr(manifest, field, "")
    errors = validate_run(manifest, [make_record()])
    assert any(field in e["path"] for e in errors), f"{field} not required"


def test_missing_canonical_analysis_sr_is_detected():
    manifest = make_manifest(expected=1, completed=1, failed=0)
    manifest.canonical_analysis_sr = None
    errors = validate_run(manifest, [make_record()])
    assert any("canonical_analysis_sr" in e["path"] for e in errors)


def test_wrong_canonical_analysis_sr_is_detected():
    """A run analysed at 48 kHz must not pass as canonical."""
    manifest = make_manifest(expected=1, completed=1, failed=0)
    manifest.canonical_analysis_sr = 48000
    errors = validate_run(manifest, [make_record()])
    assert any("does not match" in e["message"] for e in errors)


def test_provenance_round_trip_is_lossless():
    original = make_manifest()
    restored = RunManifest.from_dict(json.loads(json.dumps(original.to_dict())))
    assert restored == original
    assert restored.canonical_analysis_sr == 44100
    assert restored.numpy_version == "1.26.4"
    assert restored.decoder_binary_sha256 == "e" * 64


def test_analysis_resampled_round_trips_per_record():
    record = make_record()
    record.source.analysis_resampled = True
    restored = CalibrationRecord.from_dict(record.to_dict())
    assert restored.source.analysis_resampled is True
    assert restored == record


def test_old_manifest_without_provenance_still_parses():
    """Schema growth must not make existing evidence unreadable.

    An older manifest is missing the new keys, not carrying wrong ones: it must
    still load (so it can be inspected) while failing validation (so it is not
    mistaken for provenanced evidence).
    """
    data = make_manifest().to_dict()
    for key in ("preprocessing_policy_version", "canonical_analysis_sr",
                "numpy_version", "decoder_implementation", "decoder_version",
                "decoder_binary_sha256", "resampler_implementation",
                "resampler_version", "resampler_binary_sha256",
                "resampler_parameters", "dither_policy",
                "analyzer_source_sha256"):
        del data[key]

    restored = RunManifest.from_dict(data)          # readable
    assert restored.run_id == "run-0001"
    assert restored.canonical_analysis_sr is None

    errors = validate_run(restored, [make_record()])  # but not valid
    assert errors


def test_old_record_without_analysis_resampled_still_parses():
    data = make_record().to_dict()
    del data["source"]["analysis_resampled"]
    restored = CalibrationRecord.from_dict(data)
    assert restored.source.analysis_resampled is None
    assert validate_record(restored) == []
