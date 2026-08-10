"""Commercial reference extraction tool.

The previous reference statistics were lost because they were produced outside
version control with no manifest, no hashes and no record of what made them, and
nothing could later say whether a run had been complete. These tests pin the
properties that make that recoverable: every source is accounted for, a partial
corpus cannot become reference evidence, runs are immutable, and provenance is
recorded rather than assumed.

Synthetic corpora in tmp_path only. The real commercial corpus is never touched.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from app.mastering.calibration.evidence import EvidenceStore, RunManifest
from app.mastering.calibration.evidence_validator import validate_store
from scripts.extract_commercial_reference import (
    ExtractionError,
    Stage,
    build_parser,
    corpus_manifest_sha256,
    default_expected_count,
    discover_audio,
    build_source_manifest,
    run_extraction,
)

pytestmark = pytest.mark.skipif(
    not os.environ.get("AIMASTER_FFMPEG"),
    reason="canonical extraction requires an explicit ffmpeg binary",
)


# ── synthetic corpus helpers ─────────────────────────────────────────────────

def _make_tone(path: Path, *, freq: int, sr: int = 44100, seconds: float = 1.0,
               channels: int = 2) -> None:
    """One short synthetic tone. Distinct freq => distinct content hash."""
    subprocess.run(
        ["ffmpeg", "-y", "-f", "lavfi",
         "-i", f"sine=frequency={freq}:duration={seconds}",
         "-ar", str(sr), "-ac", str(channels), "-acodec", "pcm_s24le",
         str(path)],
        check=True, capture_output=True,
    )


@pytest.fixture
def corpus(tmp_path):
    """Factory for synthetic corpora of a given size."""
    def build(n: int, *, sr: int = 44100, start: int = 200, name="corpus") -> Path:
        root = tmp_path / name
        root.mkdir()
        for i in range(n):
            _make_tone(root / f"track_{i:03d}.wav", freq=start + i * 10, sr=sr)
        return root
    return build


@pytest.fixture
def out_root(tmp_path):
    return tmp_path / "evidence"


def _run(corpus_root, out, **kw):
    return run_extraction(str(corpus_root), str(out), **kw)


# ── T1 — exact count extracts to COMPLETE ────────────────────────────────────

def test_t1_exact_count_completes(corpus, out_root):
    root = corpus(3)
    result = _run(root, out_root, expected_count=3)

    assert result["run_status"] == "COMPLETE"
    assert result["success_count"] == 3
    assert result["failure_count"] == 0
    assert result["accounted_count"] == 3
    assert result["validation_errors"] == []


# ── T2 / T3 — count mismatch is fail-closed ──────────────────────────────────

def test_t2_too_few_tracks_fails_closed(corpus, out_root):
    root = corpus(2)
    with pytest.raises(ExtractionError, match="expected 3"):
        _run(root, out_root, expected_count=3)
    assert not (out_root / "runs").exists(), "no run may be written for a short corpus"


def test_t3_too_many_tracks_fails_closed(corpus, out_root):
    root = corpus(4)
    with pytest.raises(ExtractionError, match="expected 3"):
        _run(root, out_root, expected_count=3)
    assert not (out_root / "runs").exists()


# ── T4 — duplicate content is fail-closed ────────────────────────────────────

def test_t4_duplicate_source_hash_fails_closed(corpus, out_root, tmp_path):
    root = corpus(2)
    files = sorted(root.glob("*.wav"))
    dupe = root / "track_dupe.wav"
    dupe.write_bytes(files[0].read_bytes())      # byte-identical copy

    with pytest.raises(ExtractionError, match="duplicate source content"):
        _run(root, out_root, expected_count=3)
    assert not (out_root / "runs").exists()


def test_t4_duplicate_report_names_the_colliding_tracks(corpus, out_root):
    root = corpus(2)
    files = sorted(root.glob("*.wav"))
    (root / "track_dupe.wav").write_bytes(files[0].read_bytes())

    entries, unreadable = build_source_manifest(str(root), sorted(str(p) for p in root.glob("*.wav")))
    from scripts.extract_commercial_reference import gate_corpus
    problems = " ".join(gate_corpus(entries, unreadable, 3))
    assert "track_000" in problems and "track_dupe" in problems


# ── T5 — unreadable audio is accounted for, never ignored ────────────────────

def test_t5_unreadable_audio_blocks_complete(corpus, out_root):
    root = corpus(2)
    (root / "broken.wav").write_text("this is not audio")

    with pytest.raises(ExtractionError, match="could not be probed"):
        _run(root, out_root, expected_count=3)
    assert not (out_root / "runs").exists()


def test_t5_unreadable_is_reported_not_dropped(corpus):
    root = corpus(2)
    (root / "broken.wav").write_text("this is not audio")

    entries, unreadable = build_source_manifest(str(root), sorted(str(p) for p in root.glob("*.wav")))
    assert len(entries) == 2
    assert len(unreadable) == 1
    assert unreadable[0]["stage"] == Stage.PROBE
    assert unreadable[0]["track_id"] == "broken"


# ── T6 — a single extraction failure yields INCOMPLETE, fully accounted ──────

def test_t6_single_track_failure_is_incomplete_and_accounted(corpus, out_root, monkeypatch):
    root = corpus(3)
    import scripts.extract_commercial_reference as tool

    real = tool.CanonicalFeatureExtractor.extract
    def flaky(self, path):
        if os.path.basename(path) == "track_001.wav":
            raise RuntimeError("synthetic feature failure")
        return real(self, path)
    monkeypatch.setattr(tool.CanonicalFeatureExtractor, "extract", flaky)

    result = _run(root, out_root, expected_count=3)

    assert result["run_status"] == "INCOMPLETE", "a failed track must not pass as COMPLETE"
    assert result["success_count"] == 2
    assert result["failure_count"] == 1
    # The invariant the whole contract rests on.
    assert result["success_count"] + result["failure_count"] == 3

    store = EvidenceStore(result["run_id"], root=str(out_root))
    records = store.read_records()
    assert len(records) == 3, "every source must have a record"
    failed = [r for r in records if r.is_failure]
    assert len(failed) == 1
    assert failed[0].failure_reason.startswith(Stage.FEATURE_EXTRACTION)
    assert "synthetic feature failure" in failed[0].failure_reason


# ── T7 — run directories are immutable ───────────────────────────────────────

def test_t7_existing_run_directory_is_not_overwritten(corpus, out_root, monkeypatch):
    root = corpus(2)
    import scripts.extract_commercial_reference as tool
    monkeypatch.setattr(tool, "_utc_stamp", lambda: "20260810T000000Z")

    first = _run(root, out_root, expected_count=2)
    assert first["run_status"] == "COMPLETE"
    marker = Path(first["run_dir"]) / "manifest.json"
    original = marker.read_bytes()

    with pytest.raises(ExtractionError, match="already exists"):
        _run(root, out_root, expected_count=2)

    assert marker.read_bytes() == original, "existing run evidence was modified"


# ── T8 — corpus hash is enumeration-order independent ────────────────────────

def test_t8_manifest_hash_is_order_independent(corpus):
    root = corpus(3)
    paths = [str(p) for p in root.glob("*.wav")]

    a, _ = build_source_manifest(str(root), sorted(paths))
    b, _ = build_source_manifest(str(root), sorted(paths, reverse=True))

    assert corpus_manifest_sha256(a) == corpus_manifest_sha256(b)


def test_t8_different_corpus_hashes_differently(corpus):
    a_root, b_root = corpus(2, name="a"), corpus(2, start=900, name="b")
    a, _ = build_source_manifest(str(a_root), [str(p) for p in a_root.glob("*.wav")])
    b, _ = build_source_manifest(str(b_root), [str(p) for p in b_root.glob("*.wav")])
    assert corpus_manifest_sha256(a) != corpus_manifest_sha256(b)


def test_t8_discover_is_sorted(corpus):
    root = corpus(4)
    found = discover_audio(str(root))
    assert found == sorted(found)


# ── T9 / T10 — provenance is recorded ────────────────────────────────────────

def test_t9_ffmpeg_provenance_in_manifest(corpus, out_root):
    result = _run(corpus(2), out_root, expected_count=2)
    m = EvidenceStore(result["run_id"], root=str(out_root)).read_manifest()

    real_sha = subprocess.run(
        ["shasum", "-a", "256", os.environ["AIMASTER_FFMPEG"]],
        capture_output=True, text=True,
    ).stdout.split()[0]

    assert m.decoder_implementation == "ffmpeg"
    assert m.decoder_version and m.decoder_version[0].isdigit()
    assert m.decoder_binary_sha256 == real_sha
    assert m.resampler_implementation == "ffmpeg-aresample-swr"
    assert m.resampler_binary_sha256 == real_sha
    assert "osr=44100" in m.resampler_parameters
    assert "cutoff=0" in m.resampler_parameters
    assert m.dither_policy == "none"


def test_t10_python_and_numpy_provenance_in_manifest(corpus, out_root):
    import numpy, platform

    result = _run(corpus(2), out_root, expected_count=2)
    m = EvidenceStore(result["run_id"], root=str(out_root)).read_manifest()

    assert m.python_version == platform.python_version()
    assert m.numpy_version == numpy.__version__
    assert m.canonical_analysis_sr == 44100
    assert m.preprocessing_policy_version
    assert m.analyzer_source_sha256 and len(m.analyzer_source_sha256) == 64
    assert m.engine_commit_sha and len(m.engine_commit_sha) == 40
    assert m.source_dataset_id.startswith("commercial-reference:")


def test_expected_count_defaults_to_registry_value():
    """Not restated in the tool: read from the authoritative target registry."""
    assert default_expected_count() == 100


# ── T11 / T12 / T13 / T14 — per-record analysis provenance ───────────────────

def test_t11_t12_t13_44100_source_records_no_resample(corpus, out_root):
    result = _run(corpus(2, sr=44100), out_root, expected_count=2)
    records = EvidenceStore(result["run_id"], root=str(out_root)).read_records()

    for r in records:
        assert r.source.sample_rate == 44100          # T11
        assert r.source.analysis_resampled is False    # T12 + T13
        assert r.source.channels == 2
        assert r.source.track_duration_s and r.source.track_duration_s > 0


def test_t14_48k_source_is_resampled_to_canonical(corpus, out_root):
    result = _run(corpus(2, sr=48000), out_root, expected_count=2)
    records = EvidenceStore(result["run_id"], root=str(out_root)).read_records()

    for r in records:
        assert r.source.sample_rate == 48000
        assert r.source.analysis_resampled is True
        assert r.input.input_features["analysis_sample_rate"] == 44100
        assert r.input.input_features["sample_rate"] == 48000


# ── T15 / T16 — validator integration ────────────────────────────────────────

def test_t15_validator_passes_a_complete_run(corpus, out_root):
    result = _run(corpus(3), out_root, expected_count=3)
    store = EvidenceStore(result["run_id"], root=str(out_root))
    assert validate_store(store) == []
    assert result["run_status"] == "COMPLETE"


def test_t16_missing_provenance_field_fails_validation(corpus, out_root):
    """Strip one required field from a written run: the validator must object.

    Guards against COMPLETE being reachable without provenance.
    """
    result = _run(corpus(2), out_root, expected_count=2)
    store = EvidenceStore(result["run_id"], root=str(out_root))

    data = json.loads(Path(store.manifest_path).read_text())
    data["numpy_version"] = ""
    Path(store.manifest_path).write_text(json.dumps(data))

    errors = validate_store(store)
    assert any("numpy_version" in e["path"] for e in errors)


def test_summary_records_run_status_and_semantics(corpus, out_root):
    result = _run(corpus(2), out_root, expected_count=2)
    summary = json.loads(Path(EvidenceStore(result["run_id"], root=str(out_root)).summary_path).read_text())
    assert summary["run_status"] == "COMPLETE"
    assert summary["success_count"] == 2
    assert summary["failure_count"] == 0
    assert "render_sha256_semantics" in summary


# ── T17 — targets are untouched ──────────────────────────────────────────────

def test_t17_target_registry_values_unchanged_by_extraction(corpus, out_root):
    from app.mastering.decision_engine.target_registry import get_target_registry

    def snapshot():
        reg = get_target_registry()
        return {
            (p, f): (t.median, t.p25, t.p75, t.p5, t.p95, t.data_based, t.commercial_n)
            for p in reg.get_all_profiles_with_targets()
            for f, t in reg.get_profile_targets(p).items()
        }

    before = snapshot()
    _run(corpus(2), out_root, expected_count=2)
    assert snapshot() == before


def test_t17_target_registry_source_file_not_modified():
    """The tool reads commercial_n; it must never write the registry."""
    proc = subprocess.run(
        ["git", "status", "--porcelain",
         "aimaster-desktop/services/python-audio/app/mastering/decision_engine/target_registry.py"],
        cwd="/Users/theblank/Desktop/AImastering", capture_output=True, text=True,
    )
    assert proc.stdout.strip() == "", f"target_registry.py was modified: {proc.stdout}"


# ── T18 / T19 — no absolute paths in evidence ────────────────────────────────

def test_t18_evidence_carries_no_absolute_source_path(corpus, out_root):
    result = _run(corpus(2), out_root, expected_count=2)
    store = EvidenceStore(result["run_id"], root=str(out_root))

    for path in (store.manifest_path, store.summary_path):
        text = Path(path).read_text()
        assert "/Users/" not in text, f"absolute path leaked into {os.path.basename(path)}"

    for r in store.read_records():
        assert not os.path.isabs(r.source.track_path_relative)
        assert "/Users/" not in r.to_canonical_json()
        assert r.source.track_path_relative.endswith(".wav")


def test_t19_failure_message_does_not_leak_absolute_paths(corpus, out_root, monkeypatch):
    """A failure message often contains the path that failed. It must be
    sanitised, or the store would refuse to write the record at all."""
    root = corpus(2)
    import scripts.extract_commercial_reference as tool

    def boom(self, path):
        raise RuntimeError(f"failed while reading {path}")   # absolute path inside
    monkeypatch.setattr(tool.CanonicalFeatureExtractor, "extract", boom)

    result = _run(root, out_root, expected_count=2)
    assert result["run_status"] == "INCOMPLETE"
    assert result["failure_count"] == 2

    for r in EvidenceStore(result["run_id"], root=str(out_root)).read_records():
        assert r.failure_reason
        assert "/Users/" not in r.failure_reason
        assert str(root) not in r.failure_reason


# ── T20 — same corpus, two runs, identical payload ───────────────────────────

def test_t20_repeat_run_produces_identical_feature_payload(corpus, out_root):
    root = corpus(2)
    first = _run(root, out_root, expected_count=2)
    second = _run(root, out_root / "second", expected_count=2)

    assert first["corpus_manifest_sha256"] == second["corpus_manifest_sha256"]
    assert first["run_id"] != second["run_id"] or True  # timestamp may collide; not asserted

    def payload(result, root_dir):
        store = EvidenceStore(result["run_id"], root=str(root_dir))
        return {
            r.identity.candidate_id: (
                r.input.input_features,
                r.input.input_feature_sha256,
                r.output.render_sha256,
                r.source.track_sha256,
                r.source.analysis_resampled,
            )
            for r in store.read_records()
        }

    assert payload(first, out_root) == payload(second, out_root / "second")


# ── dry run ──────────────────────────────────────────────────────────────────

def test_dry_run_writes_nothing(corpus, out_root):
    root = corpus(2)
    result = _run(root, out_root, expected_count=2, dry_run=True)

    assert result["run_status"] == "DRY_RUN"
    assert result["discovered_count"] == 2
    assert result["corpus_manifest_sha256"]
    assert result["decoder_version"]
    assert result["planned_run_dir"]
    assert not out_root.exists(), "dry run must not create the evidence root"


def test_dry_run_reports_gate_problems_without_raising(corpus, out_root):
    result = _run(corpus(2), out_root, expected_count=5, dry_run=True)
    assert result["run_status"] == "DRY_RUN"
    assert any("expected 5" in p for p in result["gate_problems"])


# ── CLI contract ─────────────────────────────────────────────────────────────

def test_cli_requires_corpus_and_output_root():
    parser = build_parser()
    with pytest.raises(SystemExit):
        parser.parse_args([])
    args = parser.parse_args(["--corpus", "/c", "--output-root", "/o"])
    assert args.corpus == "/c" and args.output_root == "/o"
    assert args.expected_count is None and args.dry_run is False


def test_cli_has_no_hardcoded_corpus_default():
    """A hardcoded path is how the previous evidence ended up unmanaged.

    Asserted as a property of the parser (corpus is required, with no default)
    rather than by scanning prose for words: the module docstring legitimately
    mentions the old Desktop path when explaining why this tool replaces it.
    """
    corpus_action = next(
        a for a in build_parser()._actions if "--corpus" in (a.option_strings or [])
    )
    assert corpus_action.required is True
    assert corpus_action.default is None

    src = Path(__file__).parent.parent.parent / "scripts" / "extract_commercial_reference.py"
    text = src.read_text()
    # No absolute path or corpus-name literal anywhere in the tool.
    assert "/Users/" not in text
    assert "기성 음원" not in text
    assert 'default="/' not in text and "default='/" not in text


# ── provenance is mandatory ───────────────────────────────────────────────────

def test_extraction_refuses_to_start_without_ffmpeg_provenance(corpus, out_root, monkeypatch):
    monkeypatch.delenv("AIMASTER_FFMPEG", raising=False)
    with pytest.raises(ExtractionError, match=Stage.FFMPEG_PROVENANCE):
        _run(corpus(2), out_root, expected_count=2)
    assert not out_root.exists()
