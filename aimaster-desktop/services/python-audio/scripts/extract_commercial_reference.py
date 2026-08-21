#!/usr/bin/env python3
"""
Commercial Reference canonical extraction.

Turns a commercial reference corpus into canonical evidence: source audio in,
one immutable evidence record per track out. It computes no targets and touches
no registry — target derivation is a separate step that reads what this writes.

Why this exists rather than an extension of scripts/canonical_feature_poc.py:
that script samples 5 tracks, writes to a fixed Desktop path, and predates the
Evidence Contract entirely. The previous reference statistics were lost because
they lived outside version control with no manifest, no hashes and no record of
what produced them, and a 5-track POC cannot be grown into something that
prevents that recurring.

Guarantees:

  - Fails closed on provenance. Without an explicitly resolved ffmpeg binary
    there is no extraction, because a measurement whose decoder is unknown
    cannot be compared against anything later.
  - Every source gets a record, success or failure. A run where one track failed
    is INCOMPLETE, never a 99-track success. ``success + failure == expected``
    is checked, not assumed.
  - Runs are immutable. An existing run directory is never reused or
    overwritten; a collision is an error.
  - Corpus identity is a hash, not a path. The manifest hash is independent of
    filesystem enumeration order, so the same corpus always identifies the same
    way.

A note on ``output.render_sha256``: source extraction renders no audio file. The
field carries the sha256 of the canonical decoded PCM stream — literally the
bytes ffmpeg produced and the features were computed from — so the decode stays
independently verifiable. ``summary.json`` states this explicitly so nobody goes
looking for a render file that was never meant to exist.

Usage:
    python scripts/extract_commercial_reference.py \
        --corpus <corpus-root> --output-root <evidence-root> [--dry-run]

Phase: AI-MASTERING-COMMERCIAL-REFERENCE-EXTRACTION-TOOL-1
"""
from __future__ import annotations

import argparse
import hashlib
import os
import platform
import subprocess
import sys
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.analyzers.canonical_features import (  # noqa: E402
    CANONICAL_ANALYSIS_SR,
    CANONICAL_SILENCE_POLICY,
    CANONICAL_TRIM_POLICY,
    PREPROCESSING_POLICY_VERSION,
    CanonicalFeatureExtractor,
)
from app.mastering.calibration.evidence import (  # noqa: E402
    CalibrationRecord,
    EvidenceStatus,
    EvidenceStore,
    Identity,
    InputEvidence,
    OutputEvidence,
    RunManifest,
    SafetyEvidence,
    SourceInfo,
    canonical_sha256,
    find_sensitive_strings,
    relative_track_path,
    sha256_file,
)
from app.mastering.calibration.evidence_validator import (  # noqa: E402
    summarise,
    validate_store,
)
from app.utils.ffmpeg_wrapper import (  # noqa: E402
    CANONICAL_ARESAMPLE_PARAMS,
    CANONICAL_DITHER_POLICY,
    CanonicalProvenanceError,
    canonical_aresample_filter,
    ffmpeg_binary_sha256,
    ffmpeg_version,
    ffprobe_info,
    resolve_canonical_ffmpeg,
)

AUDIO_EXTENSIONS = (".flac", ".wav", ".aiff", ".aif")

RUN_STATUS_COMPLETE = "COMPLETE"
RUN_STATUS_INCOMPLETE = "INCOMPLETE"

DECODER_IMPLEMENTATION = "ffmpeg"
RESAMPLER_IMPLEMENTATION = "ffmpeg-aresample-swr"


# Failure stages. Finer-grained than EvidenceStatus on purpose: the status says
# how far the candidate got in contract terms, the stage says which operation
# actually broke, and losing the second makes a failure record nearly useless.
class Stage:
    INVENTORY = "INVENTORY"
    PROBE = "PROBE"
    HASH = "HASH"
    FFMPEG_PROVENANCE = "FFMPEG_PROVENANCE"
    CANONICAL_DECODE = "CANONICAL_DECODE"
    FEATURE_EXTRACTION = "FEATURE_EXTRACTION"
    LOUDNESS = "LOUDNESS"
    EVIDENCE_WRITE = "EVIDENCE_WRITE"
    VALIDATION = "VALIDATION"


# Stages that happen before anything was decoded map to RENDER_FAILED; stages
# after a successful decode map to ANALYSIS_FAILED. The existing enum already
# draws that line, so no new status value is introduced.
_STAGE_STATUS = {
    Stage.INVENTORY: EvidenceStatus.RENDER_FAILED.value,
    Stage.PROBE: EvidenceStatus.RENDER_FAILED.value,
    Stage.HASH: EvidenceStatus.RENDER_FAILED.value,
    Stage.FFMPEG_PROVENANCE: EvidenceStatus.RENDER_FAILED.value,
    Stage.CANONICAL_DECODE: EvidenceStatus.RENDER_FAILED.value,
    Stage.FEATURE_EXTRACTION: EvidenceStatus.ANALYSIS_FAILED.value,
    Stage.LOUDNESS: EvidenceStatus.ANALYSIS_FAILED.value,
    Stage.EVIDENCE_WRITE: EvidenceStatus.ANALYSIS_FAILED.value,
    Stage.VALIDATION: EvidenceStatus.ANALYSIS_FAILED.value,
}


class ExtractionError(RuntimeError):
    """A gate failed before any track could be processed."""


# ── helpers ──────────────────────────────────────────────────────────────────

def _utc_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def _git_commit_sha(repo_hint: str) -> str:
    """HEAD of the repository this code is running from.

    Required rather than best-effort: evidence that cannot name the code that
    produced it is the exact failure this contract exists to prevent.
    """
    try:
        proc = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=repo_hint, capture_output=True, text=True, timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise ExtractionError(f"could not determine git commit: {exc}")
    if proc.returncode != 0:
        raise ExtractionError(
            "could not determine git commit (not a git repository?): "
            f"{proc.stderr.strip()[:200]}"
        )
    sha = proc.stdout.strip()
    if not sha:
        raise ExtractionError("git returned an empty commit sha")
    return sha


def _analyzer_source_sha256() -> str:
    """Hash of the module that defines what the features mean.

    Narrower than the commit sha on purpose: the commit moves whenever any file
    in the repository changes, which cannot distinguish a feature-definition
    change from an unrelated one.
    """
    import app.analyzers.canonical_features as mod

    return sha256_file(os.path.abspath(mod.__file__))


def default_expected_count() -> int:
    """Read the authoritative commercial reference size from the target registry.

    The number is not restated here. It lives on the data-derived targets as
    ``commercial_n``, and duplicating it in this tool would create a second
    source of truth that could silently disagree with the first.

    Read-only: nothing in the registry is written or modified.
    """
    from app.mastering.decision_engine.target_registry import get_target_registry

    registry = get_target_registry()
    counts = {
        target.commercial_n
        for profile in registry.get_all_profiles_with_targets()
        for target in registry.get_profile_targets(profile).values()
        if target.data_based and target.commercial_n > 0
    }
    if len(counts) != 1:
        raise ExtractionError(
            "commercial reference size is ambiguous in the target registry "
            f"(found {sorted(counts)}); pass --expected-count explicitly"
        )
    return counts.pop()


def _sanitise(message: str, corpus_root: str, track_abs: Optional[str],
              track_rel: Optional[str]) -> str:
    """Strip machine-specific paths out of an error before it is stored.

    The store refuses to write a record containing an absolute path, so an
    unsanitised message would turn a track failure into an unwritable record —
    losing the very thing the failure record exists to preserve.
    """
    text = " ".join(str(message).split())
    if track_abs and track_rel:
        text = text.replace(track_abs, track_rel)
    text = text.replace(os.path.abspath(corpus_root), "<corpus>")
    text = text.replace(corpus_root, "<corpus>")
    if find_sensitive_strings(text):
        return "(message withheld: contained a machine-specific path)"
    return text[:400]


# ── inventory ────────────────────────────────────────────────────────────────

def discover_audio(corpus_root: str) -> List[str]:
    """Audio files directly under the corpus root, in a stable order.

    Sorted by relative path so two runs over the same corpus enumerate it
    identically regardless of what order the filesystem hands the names back.
    """
    if not os.path.isdir(corpus_root):
        raise ExtractionError(f"corpus root is not a directory: {corpus_root}")
    names = [
        n for n in os.listdir(corpus_root)
        if not n.startswith(".")
        and os.path.isfile(os.path.join(corpus_root, n))
        and n.lower().endswith(AUDIO_EXTENSIONS)
    ]
    return [os.path.join(corpus_root, n) for n in sorted(names)]


def build_source_manifest(corpus_root: str, paths: List[str]) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """Probe and hash every source. Returns (entries, unreadable)."""
    entries: List[Dict[str, Any]] = []
    unreadable: List[Dict[str, Any]] = []

    for path in paths:
        rel = relative_track_path(path, corpus_root)
        track_id = os.path.splitext(os.path.basename(path))[0]
        try:
            info = ffprobe_info(path)
            streams = [s for s in (info.get("streams") or []) if s.get("codec_type") == "audio"]
            if not streams:
                raise ExtractionError("no audio stream")
            stream = streams[0]
            duration = stream.get("duration") or (info.get("format") or {}).get("duration")
            entry = {
                "track_id": track_id,
                "relative_path": rel,
                "source_sha256": sha256_file(path),
                "format": stream.get("codec_name"),
                "sample_rate": int(stream.get("sample_rate") or 0),
                "channels": int(stream.get("channels") or 0),
                "duration_s": float(duration) if duration else None,
                "sample_fmt": stream.get("sample_fmt"),
                "bit_depth": (
                    int(stream["bits_per_raw_sample"])
                    if str(stream.get("bits_per_raw_sample") or "").isdigit() else None
                ),
            }
            if entry["sample_rate"] <= 0 or entry["channels"] <= 0:
                raise ExtractionError("unreadable stream metadata")
            entries.append(entry)
        except Exception as exc:  # noqa: BLE001 - recorded, never swallowed
            unreadable.append({
                "track_id": track_id,
                "relative_path": rel,
                "stage": Stage.PROBE,
                "error_type": type(exc).__name__,
                "error": _sanitise(str(exc), corpus_root, path, rel),
            })

    return entries, unreadable


def corpus_manifest_sha256(entries: List[Dict[str, Any]]) -> str:
    """Identity of the corpus, independent of enumeration order.

    Sorted by track_id before hashing, and the canonical JSON form sorts object
    keys, so the same set of files always hashes the same way.
    """
    ordered = sorted(entries, key=lambda e: (e["track_id"], e["source_sha256"]))
    return canonical_sha256(ordered)


def gate_corpus(entries: List[Dict[str, Any]], unreadable: List[Dict[str, Any]],
                expected_count: int) -> List[str]:
    """Reasons this corpus must not produce reference evidence. Empty means pass."""
    problems: List[str] = []

    discovered = len(entries) + len(unreadable)
    if discovered != expected_count:
        problems.append(
            f"discovered {discovered} tracks but expected {expected_count}"
        )
    if unreadable:
        problems.append(f"{len(unreadable)} track(s) could not be probed")

    paths: Dict[str, int] = {}
    hashes: Dict[str, List[str]] = {}
    for e in entries:
        paths[e["relative_path"]] = paths.get(e["relative_path"], 0) + 1
        hashes.setdefault(e["source_sha256"], []).append(e["track_id"])

    dupe_paths = sorted(p for p, n in paths.items() if n > 1)
    if dupe_paths:
        problems.append(f"duplicate relative path(s): {dupe_paths}")

    dupe_hashes = {h: ids for h, ids in hashes.items() if len(ids) > 1}
    if dupe_hashes:
        problems.append(
            "duplicate source content: "
            + "; ".join(f"{h[:12]}… -> {sorted(ids)}" for h, ids in sorted(dupe_hashes.items()))
        )

    return problems


# ── per-track extraction ─────────────────────────────────────────────────────

def extract_track(entry: Dict[str, Any], corpus_root: str, *, commit_sha: str,
                  created_at: str, extractor: CanonicalFeatureExtractor
                  ) -> Tuple[CalibrationRecord, Optional[str]]:
    """One track to one record. Returns (record, failure_stage_or_None)."""
    abs_path = os.path.join(corpus_root, entry["relative_path"])
    identity = Identity(
        candidate_id=entry["track_id"],
        engine_commit_sha=commit_sha,
        created_at_utc=created_at,
    )
    source = SourceInfo(
        track_path_relative=entry["relative_path"],
        track_sha256=entry["source_sha256"],
        track_duration_s=entry["duration_s"],
        sample_rate=entry["sample_rate"],
        channels=entry["channels"],
        bit_depth=entry["bit_depth"],
    )

    stage = Stage.CANONICAL_DECODE
    try:
        # Hash the canonical decoded stream so the decode itself stays
        # verifiable. Decoded separately from the feature pass: both decodes are
        # byte-deterministic, so the hash describes exactly the samples the
        # features were computed from.
        from app.analyzers.canonical_features import _load_canonical_signal

        data, analysis_sr, source_sr, resampled = _load_canonical_signal(abs_path)
        pcm = data.tobytes()
        source.analysis_resampled = resampled

        stage = Stage.FEATURE_EXTRACTION
        features = extractor.extract(abs_path).to_dict()
        if not features:
            raise ExtractionError("canonical feature extraction produced nothing")

        stage = Stage.LOUDNESS
        # Authoritative loudness comes from the extractor's ffmpeg pass against
        # the original file; this tool implements no loudness of its own.
        loudness_i = features.get("input_i")
        loudness_tp = features.get("input_tp")
        loudness_lra = features.get("input_lra")
        if loudness_i is None or loudness_tp is None or loudness_lra is None:
            raise ExtractionError(
                "authoritative loudness measurement incomplete "
                f"(I={loudness_i} TP={loudness_tp} LRA={loudness_lra})"
            )

        record = CalibrationRecord(
            identity=identity,
            status=EvidenceStatus.PASSED.value,
            source=source,
            input=InputEvidence(
                input_features=features,
                input_feature_sha256=canonical_sha256(features),
            ),
            output=OutputEvidence(
                render_sha256=hashlib.sha256(pcm).hexdigest(),
                render_bytes=len(pcm),
            ),
            safety=SafetyEvidence(
                clipping_sample_count=features.get("clipping_sample_count"),
                sample_peak_dbfs=features.get("sample_peak_dbfs"),
                true_peak_dbtp=loudness_tp,
                loudness_lufs_i=loudness_i,
                loudness_lra=loudness_lra,
                mono_compatibility=features.get("mono_compatibility_score"),
            ),
        )
        if analysis_sr != CANONICAL_ANALYSIS_SR:  # pragma: no cover - guarded upstream
            raise ExtractionError(f"analysis rate {analysis_sr} is not canonical")
        return record, None

    except Exception as exc:  # noqa: BLE001 - always becomes a failure record
        reason = _sanitise(str(exc), corpus_root, abs_path, entry["relative_path"])
        record = CalibrationRecord(
            identity=identity,
            status=_STAGE_STATUS[stage],
            failure_reason=f"{stage}: {type(exc).__name__}: {reason}",
            source=source,
        )
        return record, stage


# ── run ──────────────────────────────────────────────────────────────────────

def build_run_manifest(*, run_id: str, commit_sha: str, created_at: str,
                       manifest_hash: str, expected_count: int,
                       discovered_count: int, decoder_path: str,
                       decoder_ver: str, decoder_sha: str) -> RunManifest:
    config_hash = canonical_sha256({
        "canonical_analysis_sr": CANONICAL_ANALYSIS_SR,
        "preprocessing_policy_version": PREPROCESSING_POLICY_VERSION,
        "resampler_parameters": canonical_aresample_filter(CANONICAL_ANALYSIS_SR),
        "dither_policy": CANONICAL_DITHER_POLICY,
        "trim_policy": CANONICAL_TRIM_POLICY,
        "silence_policy": CANONICAL_SILENCE_POLICY,
        "aresample_params": [list(p) for p in CANONICAL_ARESAMPLE_PARAMS],
    })
    import numpy

    return RunManifest(
        run_id=run_id,
        engine_commit_sha=commit_sha,
        # Corpus identity travels as a hash, so the run cannot be confused with
        # one taken over a different set of files.
        source_dataset_id=f"commercial-reference:{manifest_hash}",
        source_track_count=discovered_count,
        expected_candidate_count=expected_count,
        created_at_utc=created_at,
        ffmpeg_version=decoder_ver,
        python_version=platform.python_version(),
        platform=f"{platform.system().lower()}-{platform.machine()}",
        deterministic_config_hash=config_hash,
        preprocessing_policy_version=PREPROCESSING_POLICY_VERSION,
        canonical_analysis_sr=CANONICAL_ANALYSIS_SR,
        numpy_version=numpy.__version__,
        decoder_implementation=DECODER_IMPLEMENTATION,
        decoder_version=decoder_ver,
        decoder_binary_sha256=decoder_sha,
        resampler_implementation=RESAMPLER_IMPLEMENTATION,
        resampler_version=decoder_ver,
        resampler_binary_sha256=decoder_sha,
        resampler_parameters=canonical_aresample_filter(CANONICAL_ANALYSIS_SR),
        dither_policy=CANONICAL_DITHER_POLICY,
        analyzer_source_sha256=_analyzer_source_sha256(),
    )


def run_extraction(corpus_root: str, output_root: str, *,
                   expected_count: Optional[int] = None,
                   dry_run: bool = False) -> Dict[str, Any]:
    """Extract a corpus into one immutable evidence run.

    Returns a result dict. ``run_status`` is COMPLETE only when every expected
    track produced a successful record and the validator found nothing.
    """
    corpus_root = os.path.abspath(corpus_root)
    repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

    # Provenance first. Nothing is decoded until the binary is known.
    try:
        decoder_path = resolve_canonical_ffmpeg()
        decoder_ver = ffmpeg_version(decoder_path)
        decoder_sha = ffmpeg_binary_sha256(decoder_path)
    except CanonicalProvenanceError as exc:
        raise ExtractionError(f"{Stage.FFMPEG_PROVENANCE}: {exc}")

    if expected_count is None:
        expected_count = default_expected_count()

    commit_sha = _git_commit_sha(repo_root)
    created_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    paths = discover_audio(corpus_root)
    entries, unreadable = build_source_manifest(corpus_root, paths)
    manifest_hash = corpus_manifest_sha256(entries)
    gate_problems = gate_corpus(entries, unreadable, expected_count)

    run_id = (
        f"commercial-reference-{_utc_stamp()}-{commit_sha[:7]}-{manifest_hash[:12]}"
    )

    plan = {
        "run_id": run_id,
        "corpus_root": corpus_root,
        "expected_count": expected_count,
        "discovered_count": len(entries) + len(unreadable),
        "probed_count": len(entries),
        "unreadable_count": len(unreadable),
        "corpus_manifest_sha256": manifest_hash,
        "decoder_path": decoder_path,
        "decoder_version": decoder_ver,
        "decoder_binary_sha256": decoder_sha,
        "planned_run_dir": os.path.join(os.path.abspath(output_root), "runs", run_id),
        "gate_problems": gate_problems,
    }

    if dry_run:
        plan["run_status"] = "DRY_RUN"
        return plan

    if gate_problems:
        # A partial or ambiguous corpus must not become reference evidence.
        raise ExtractionError(
            "corpus gate failed: " + " | ".join(gate_problems)
        )

    store = EvidenceStore(run_id, root=output_root)
    if os.path.exists(store.run_dir):
        raise ExtractionError(f"run directory already exists: {store.run_dir}")
    store.ensure_dirs()

    extractor = CanonicalFeatureExtractor()
    successes: List[CalibrationRecord] = []
    failures: List[CalibrationRecord] = []
    stages: Dict[str, int] = {}

    for entry in entries:
        record, stage = extract_track(
            entry, corpus_root,
            commit_sha=commit_sha, created_at=created_at, extractor=extractor,
        )
        store.write_record(record)
        if record.is_failure:
            failures.append(record)
            stages[stage or "UNKNOWN"] = stages.get(stage or "UNKNOWN", 0) + 1
        else:
            successes.append(record)

    manifest = build_run_manifest(
        run_id=run_id, commit_sha=commit_sha, created_at=created_at,
        manifest_hash=manifest_hash, expected_count=expected_count,
        discovered_count=len(entries) + len(unreadable),
        decoder_path=decoder_path, decoder_ver=decoder_ver, decoder_sha=decoder_sha,
    )
    manifest.completed_record_count = len(successes)
    manifest.failed_record_count = len(failures)
    manifest.missing_record_count = max(
        expected_count - (len(successes) + len(failures)), 0
    )
    store.write_manifest(manifest)

    records = successes + failures
    validation_errors = validate_store(store)
    accounted = len(successes) + len(failures)

    complete = (
        accounted == expected_count
        and len(failures) == 0
        and not validation_errors
    )

    summary = summarise(manifest, records)
    summary.update({
        "run_status": RUN_STATUS_COMPLETE if complete else RUN_STATUS_INCOMPLETE,
        "corpus_manifest_sha256": manifest_hash,
        "expected_count": expected_count,
        "attempted_count": len(entries),
        "success_count": len(successes),
        "failure_count": len(failures),
        "accounted_count": accounted,
        "failure_stages": dict(sorted(stages.items())),
        "validation_error_count": len(validation_errors),
        "decoder_binary_sha256": decoder_sha,
        # Stated so nobody looks for a rendered audio file: source extraction
        # renders nothing, and render_sha256 describes the decoded PCM stream.
        "render_sha256_semantics": (
            "sha256 of the canonical decoded PCM stream; no rendered audio file exists"
        ),
    })
    store.write_summary(summary)

    plan.update({
        "run_status": summary["run_status"],
        "success_count": len(successes),
        "failure_count": len(failures),
        "accounted_count": accounted,
        "validation_errors": validation_errors,
        "run_dir": store.run_dir,
        "summary": summary,
    })
    return plan


# ── CLI ──────────────────────────────────────────────────────────────────────

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Extract canonical evidence from a commercial reference corpus. "
            "Computes no targets and modifies no registry."
        )
    )
    parser.add_argument(
        "--corpus", required=True,
        help="Corpus root directory (no default: a hardcoded path is how the "
             "previous evidence ended up outside version control)",
    )
    parser.add_argument(
        "--output-root", required=True,
        help="Evidence root; the run is written to <output-root>/runs/<run_id>",
    )
    parser.add_argument(
        "--expected-count", type=int, default=None,
        help="Expected track count (default: the authoritative commercial_n "
             "read from the target registry)",
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Inventory, corpus hash, provenance and planned run directory only "
             "— no decoding and no evidence written",
    )
    return parser


def main(argv: Optional[List[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        result = run_extraction(
            args.corpus, args.output_root,
            expected_count=args.expected_count, dry_run=args.dry_run,
        )
    except ExtractionError as exc:
        print(f"EXTRACTION FAILED: {exc}", file=sys.stderr)
        return 2

    print(f"run_id                : {result['run_id']}")
    print(f"corpus_manifest_sha256: {result['corpus_manifest_sha256']}")
    print(f"decoder               : ffmpeg {result['decoder_version']} "
          f"({result['decoder_binary_sha256'][:16]}…)")
    print(f"expected / discovered : {result['expected_count']} / {result['discovered_count']}")
    if result.get("run_status") == "DRY_RUN":
        print(f"planned_run_dir       : {result['planned_run_dir']}")
        print(f"gate_problems         : {result['gate_problems'] or 'none'}")
        return 0

    print(f"success / failure     : {result['success_count']} / {result['failure_count']}")
    print(f"validation errors     : {len(result['validation_errors'])}")
    print(f"run_status            : {result['run_status']}")
    print(f"run_dir               : {result['run_dir']}")
    return 0 if result["run_status"] == RUN_STATUS_COMPLETE else 1


if __name__ == "__main__":
    raise SystemExit(main())
