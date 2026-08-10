"""
Calibration Evidence Contract.

The P1 calibration run produced 1,400 renders and eighteen artifacts, validated
them, and then the whole output directory vanished from disk. A later audit
could not answer how many renders were missing, how many were duplicates, how
many were corrupt, or whether any mapping had ever been promotable - not because
the questions were hard, but because nothing that could answer them had been
kept anywhere managed.

This module defines what a calibration run must preserve so that never happens
again, and so that the preserved data can answer questions that were not asked
at the time it was written:

  - Every candidate gets an immutable record, INCLUDING the ones that failed.
    A run is complete when ``successes + failures == expected``; without failure
    records, "absent" and "failed" are indistinguishable and completeness cannot
    be checked at all.
  - Records store MEASUREMENTS, not just verdicts. ``safety_pass: true`` alone
    is unfalsifiable later; the true peak, sample peak, clipping count, ISP
    overshoot, loudness and mono compatibility behind it let a changed threshold
    be re-applied without re-rendering a single file.
  - Everything hashes deterministically, so a record can be checked against the
    bytes it claims to describe.
  - Paths are stored relative to the dataset root. No absolute path, machine
    temp directory, username or email may appear anywhere in a record.

Pure and deterministic: no rendering, no analysis, no clock and no global state.
Timestamps and commit SHAs are supplied by the caller so a record is reproducible
byte-for-byte.

Phase: AI-MASTERING-CALIBRATION-EVIDENCE-CONTRACT-IMPLEMENTATION-1
"""
from __future__ import annotations

import hashlib
import json
import math
import os
from dataclasses import asdict, dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional

# Bump when a field is added, removed or reinterpreted. The validator refuses
# records whose version it does not recognise rather than guessing.
EVIDENCE_SCHEMA_VERSION = "1.0.0"

# Directory name under the service root. Deliberately a sibling of app/ rather
# than a child: app/ is the package PyInstaller bundles, and calibration
# evidence must never ship inside the shipped engine.
EVIDENCE_DIRNAME = "calibration-evidence"
EVIDENCE_DIR_ENV = "AIMASTER_CALIBRATION_EVIDENCE_DIR"

# app/mastering/calibration/evidence.py -> services/python-audio
SERVICE_ROOT = os.path.abspath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..")
)

MANIFEST_FILENAME = "manifest.json"
SUMMARY_FILENAME = "summary.json"
CANDIDATES_DIRNAME = "candidates"
FAILURES_DIRNAME = "failures"
RUNS_DIRNAME = "runs"


class EvidenceStatus(str, Enum):
    """Terminal status of a candidate.

    Separate from ``CalibrationStatus`` so the evidence contract can version
    independently of the calibration algorithm, and because the contract needs
    ANALYSIS_FAILED - a render that succeeded but whose features could not be
    extracted is a different failure from a render that never happened, and
    collapsing them loses the distinction permanently.
    """
    PASSED = "PASSED"
    RENDER_FAILED = "RENDER_FAILED"
    ANALYSIS_FAILED = "ANALYSIS_FAILED"
    SAFETY_FAILED = "SAFETY_FAILED"
    REJECTED = "REJECTED"


SUCCESS_STATUSES = frozenset({EvidenceStatus.PASSED.value})
FAILURE_STATUSES = frozenset({
    EvidenceStatus.RENDER_FAILED.value,
    EvidenceStatus.ANALYSIS_FAILED.value,
    EvidenceStatus.SAFETY_FAILED.value,
    EvidenceStatus.REJECTED.value,
})
ALL_STATUSES = SUCCESS_STATUSES | FAILURE_STATUSES


# ── canonical serialisation ──────────────────────────────────────────────────
#
# Canonical form rules, fixed so the same logical record always produces the
# same bytes on every machine and every Python build:
#
#   1. Object keys sorted lexicographically (``sort_keys=True``).
#   2. No insignificant whitespace (``separators=(",", ":")``).
#   3. UTF-8 text, not escaped to ASCII, so a non-Latin track title hashes as
#      itself rather than as its escape sequence.
#   4. Floats use Python's shortest round-trip repr, which is stable for a given
#      double. Values are never rounded: rounding would silently discard
#      measurement precision that a later re-judgement may need.
#   5. ``-0.0`` normalises to ``0.0``. They compare equal but serialise
#      differently, which would otherwise produce two hashes for one value.
#   6. NaN and Infinity are rejected outright. Python's json writes them as bare
#      ``NaN``/``Infinity`` tokens, which no conforming JSON reader accepts, so
#      permitting them would write evidence that cannot be read back.
#   7. Tuples and sets become lists; sets are sorted first so ordering cannot
#      vary between runs.

class CanonicalisationError(ValueError):
    """A value cannot be represented in canonical evidence form."""


def _canonicalise(value: Any, path: str = "$") -> Any:
    if value is None or isinstance(value, (str, bool)):
        return value

    if isinstance(value, int):
        return value

    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value):
            raise CanonicalisationError(
                f"{path}: non-finite float ({value!r}) cannot be stored as evidence"
            )
        return 0.0 if value == 0.0 else value

    if isinstance(value, Enum):
        return _canonicalise(value.value, path)

    if isinstance(value, dict):
        out: Dict[str, Any] = {}
        for key, item in value.items():
            if not isinstance(key, str):
                raise CanonicalisationError(
                    f"{path}: object key {key!r} is not a string"
                )
            out[key] = _canonicalise(item, f"{path}.{key}")
        return out

    if isinstance(value, (list, tuple)):
        return [_canonicalise(v, f"{path}[{i}]") for i, v in enumerate(value)]

    if isinstance(value, (set, frozenset)):
        return [_canonicalise(v, f"{path}[]") for v in sorted(value, key=repr)]

    raise CanonicalisationError(
        f"{path}: {type(value).__name__} is not representable in evidence"
    )


def canonical_json(value: Any) -> str:
    """Serialise to the canonical evidence form described above."""
    return json.dumps(
        _canonicalise(value),
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    )


def canonical_sha256(value: Any) -> str:
    """Deterministic sha256 over the canonical form of a Python value."""
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def sha256_file(path: str, chunk_size: int = 1024 * 1024) -> str:
    """sha256 over a file's bytes, streamed so a large render is not loaded."""
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(chunk_size), b""):
            digest.update(chunk)
    return digest.hexdigest()


# ── record sections ──────────────────────────────────────────────────────────

@dataclass
class Identity:
    candidate_id: str
    schema_version: str = EVIDENCE_SCHEMA_VERSION
    engine_commit_sha: str = ""
    created_at_utc: str = ""


@dataclass
class SourceInfo:
    """The input track. Path is relative to the dataset root, never absolute."""
    track_path_relative: str = ""
    track_sha256: str = ""
    track_duration_s: Optional[float] = None
    # Rate of the file as delivered. The rate the analysis ran at is a run-level
    # constant (RunManifest.canonical_analysis_sr); this is per-track because it
    # is what determines whether the resampler was involved at all.
    sample_rate: Optional[int] = None
    channels: Optional[int] = None
    bit_depth: Optional[int] = None
    # Whether reaching the canonical analysis rate required the resampler.
    # Recorded per record so a natively-canonical reference track and a resampled
    # runtime input stay distinguishable after the fact.
    analysis_resampled: Optional[bool] = None


@dataclass
class InputEvidence:
    input_features: Dict[str, Any] = field(default_factory=dict)
    input_feature_sha256: str = ""


@dataclass
class CandidateSpec:
    profile: str = ""
    processor: str = ""
    parameter: str = ""
    parameter_value: Optional[float] = None
    extra_params: Dict[str, Any] = field(default_factory=dict)
    filter_chain: str = ""
    ffmpeg_version: str = ""


@dataclass
class OutputEvidence:
    output_features: Dict[str, Any] = field(default_factory=dict)
    output_feature_sha256: str = ""
    render_sha256: str = ""
    render_bytes: Optional[int] = None


@dataclass
class DeltaEvidence:
    feature_deltas: Dict[str, Any] = field(default_factory=dict)
    primary_feature_delta: Optional[float] = None
    direction_intended: str = ""
    direction_achieved: str = ""
    direction_correct: Optional[bool] = None


@dataclass
class SafetyEvidence:
    """Measurements first, verdict last.

    ``safety_pass`` is a judgement made under the thresholds in force at write
    time; every measurement it was derived from is stored beside it so the same
    candidate can be re-judged under different thresholds without re-rendering.
    """
    clipping_sample_count: Optional[int] = None
    sample_peak_dbfs: Optional[float] = None
    true_peak_dbtp: Optional[float] = None
    isp_overshoot_dbtp: Optional[float] = None
    loudness_lufs_i: Optional[float] = None
    loudness_lra: Optional[float] = None
    dc_offset: Optional[float] = None
    mono_compatibility: Optional[float] = None
    safety_pass: Optional[bool] = None
    safety_fail_reasons: List[str] = field(default_factory=list)


@dataclass
class ObjectiveEvidence:
    improvement_metric: Optional[float] = None
    # The formula as text, so a stored number stays interpretable after the code
    # that produced it has changed.
    improvement_definition: str = ""
    overshoot: Optional[bool] = None


@dataclass
class RegressionEvidence:
    """Mirrors the R1/R2/R3 axes implemented in ``regression.py``.

    Stored per candidate rather than only per rule so rule-level aggregation can
    be recomputed later under different definitions.
    """
    r1_monitored: int = 0
    r1_regressed: int = 0
    r1_rate: float = 0.0
    r1_details: List[Dict[str, Any]] = field(default_factory=list)
    r2_violations: List[str] = field(default_factory=list)
    r3_overcorrected: bool = False
    r3_details: List[Dict[str, Any]] = field(default_factory=list)
    regression_rate: float = 0.0
    regression_measured: bool = False


@dataclass
class ReproducibilityEvidence:
    repro_runs: int = 0
    repro_render_sha256: List[str] = field(default_factory=list)
    repro_feature_sha256: List[str] = field(default_factory=list)
    repro_byte_identical: Optional[bool] = None
    repro_feature_identical: Optional[bool] = None


@dataclass
class CalibrationRecord:
    """One calibration candidate, success or failure, as immutable evidence."""
    identity: Identity
    status: str = EvidenceStatus.PASSED.value
    failure_reason: Optional[str] = None

    source: SourceInfo = field(default_factory=SourceInfo)
    input: InputEvidence = field(default_factory=InputEvidence)
    candidate: CandidateSpec = field(default_factory=CandidateSpec)
    output: OutputEvidence = field(default_factory=OutputEvidence)
    delta: DeltaEvidence = field(default_factory=DeltaEvidence)
    safety: SafetyEvidence = field(default_factory=SafetyEvidence)
    objective: ObjectiveEvidence = field(default_factory=ObjectiveEvidence)
    regression: RegressionEvidence = field(default_factory=RegressionEvidence)
    reproducibility: ReproducibilityEvidence = field(
        default_factory=ReproducibilityEvidence
    )

    # ── serialisation ────────────────────────────────────────────────────────

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "CalibrationRecord":
        """Rebuild a record. Unknown keys are an error, not something to ignore:
        silently dropping a field would turn a schema mismatch into data loss."""
        def section(section_cls, key):
            raw = data.get(key) or {}
            known = {f for f in section_cls.__dataclass_fields__}
            unknown = set(raw) - known
            if unknown:
                raise ValueError(
                    f"{key}: unknown field(s) {sorted(unknown)} for "
                    f"{section_cls.__name__}"
                )
            return section_cls(**raw)

        top_known = {f for f in cls.__dataclass_fields__}
        unknown_top = set(data) - top_known
        if unknown_top:
            raise ValueError(f"record: unknown field(s) {sorted(unknown_top)}")

        return cls(
            identity=section(Identity, "identity"),
            status=data.get("status", EvidenceStatus.PASSED.value),
            failure_reason=data.get("failure_reason"),
            source=section(SourceInfo, "source"),
            input=section(InputEvidence, "input"),
            candidate=section(CandidateSpec, "candidate"),
            output=section(OutputEvidence, "output"),
            delta=section(DeltaEvidence, "delta"),
            safety=section(SafetyEvidence, "safety"),
            objective=section(ObjectiveEvidence, "objective"),
            regression=section(RegressionEvidence, "regression"),
            reproducibility=section(ReproducibilityEvidence, "reproducibility"),
        )

    def to_canonical_json(self) -> str:
        return canonical_json(self.to_dict())

    def content_sha256(self) -> str:
        return canonical_sha256(self.to_dict())

    @property
    def is_failure(self) -> bool:
        return self.status in FAILURE_STATUSES


@dataclass
class RunManifest:
    """Everything needed to judge whether a run is complete and trustworthy."""
    run_id: str
    schema_version: str = EVIDENCE_SCHEMA_VERSION
    engine_commit_sha: str = ""
    source_dataset_id: str = ""
    source_track_count: int = 0
    expected_candidate_count: int = 0
    created_at_utc: str = ""
    ffmpeg_version: str = ""
    python_version: str = ""
    platform: str = ""
    completed_record_count: int = 0
    failed_record_count: int = 0
    missing_record_count: int = 0
    # Hash of the sweep/threshold configuration the run used, so a run cannot be
    # silently compared against another produced under different settings.
    deterministic_config_hash: str = ""

    # ── Canonical analysis provenance ────────────────────────────────────────
    #
    # The previous target set could not be trusted because nobody could say what
    # had produced it: the statistics file was gone, and the analyzer that could
    # have made it did not exist yet when its numbers were committed. These
    # fields exist so that question is answerable from the evidence alone.
    #
    # Run-level rather than per-record: they are constant for a run, and copying
    # them onto every candidate would add bulk without adding information.
    preprocessing_policy_version: str = ""
    canonical_analysis_sr: Optional[int] = None
    numpy_version: str = ""
    decoder_implementation: str = ""
    decoder_version: str = ""
    decoder_binary_sha256: str = ""
    resampler_implementation: str = ""
    resampler_version: str = ""
    resampler_binary_sha256: str = ""
    # Full parameter string as passed, not a summary: an unrecorded parameter is
    # indistinguishable from one that never mattered.
    resampler_parameters: str = ""
    dither_policy: str = ""
    # Hash of the analyzer source itself. engine_commit_sha moves whenever any
    # file in the repository changes; this isolates the code that defines what
    # the features mean.
    analyzer_source_sha256: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "RunManifest":
        unknown = set(data) - set(cls.__dataclass_fields__)
        if unknown:
            raise ValueError(f"manifest: unknown field(s) {sorted(unknown)}")
        return cls(**data)

    def to_canonical_json(self) -> str:
        return canonical_json(self.to_dict())


def config_hash(config: Dict[str, Any]) -> str:
    """Deterministic hash of a run's configuration."""
    return canonical_sha256(config)


# ── path safety ──────────────────────────────────────────────────────────────

class PathSafetyError(ValueError):
    """A path or string would leak an absolute or machine-specific location."""


def relative_track_path(track_path: str, dataset_root: str) -> str:
    """Path of a track relative to its dataset root, with forward slashes.

    Raises rather than falling back to the absolute path: a silent fallback is
    exactly how an absolute path ends up in permanent evidence.
    """
    rel = os.path.relpath(os.path.abspath(track_path), os.path.abspath(dataset_root))
    normalised = rel.replace(os.sep, "/")
    if normalised.startswith("../") or normalised == "..":
        raise PathSafetyError(
            f"track is outside the dataset root and has no relative form: {normalised}"
        )
    if os.path.isabs(normalised):
        raise PathSafetyError(f"path did not relativise: {normalised}")
    return normalised


# ── storage ──────────────────────────────────────────────────────────────────

def default_evidence_root() -> str:
    """Canonical evidence location.

    A repository-managed directory beside the service, never a developer's
    Desktop - losing the last run to a folder deletion is the failure this
    contract exists to prevent. Overridable by env var for tests and CI.
    """
    override = os.environ.get(EVIDENCE_DIR_ENV)
    if override:
        return os.path.abspath(override)
    return os.path.join(SERVICE_ROOT, EVIDENCE_DIRNAME)


class EvidenceStore:
    """Writes and reads calibration evidence for one run.

    Records are append-only: writing a candidate_id that already exists raises,
    because evidence that can be quietly overwritten is not evidence.
    """

    def __init__(self, run_id: str, root: Optional[str] = None):
        self.run_id = run_id
        self.root = os.path.abspath(root) if root else default_evidence_root()

    # paths -------------------------------------------------------------------

    @property
    def run_dir(self) -> str:
        return os.path.join(self.root, RUNS_DIRNAME, self.run_id)

    @property
    def candidates_dir(self) -> str:
        return os.path.join(self.run_dir, CANDIDATES_DIRNAME)

    @property
    def failures_dir(self) -> str:
        return os.path.join(self.run_dir, FAILURES_DIRNAME)

    @property
    def manifest_path(self) -> str:
        return os.path.join(self.run_dir, MANIFEST_FILENAME)

    @property
    def summary_path(self) -> str:
        return os.path.join(self.run_dir, SUMMARY_FILENAME)

    def record_path(self, candidate_id: str, is_failure: bool) -> str:
        directory = self.failures_dir if is_failure else self.candidates_dir
        return os.path.join(directory, f"{candidate_id}.json")

    # writing -----------------------------------------------------------------

    def ensure_dirs(self) -> None:
        os.makedirs(self.candidates_dir, exist_ok=True)
        os.makedirs(self.failures_dir, exist_ok=True)

    def _write_canonical(self, path: str, payload: Any) -> None:
        text = canonical_json(payload)
        scan_for_sensitive_strings(text, where=os.path.basename(path))
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(text)

    def write_record(self, record: CalibrationRecord) -> str:
        """Persist one record. Failures land in failures/, successes in
        candidates/, so a completeness count never has to parse every file."""
        path = self.record_path(record.identity.candidate_id, record.is_failure)
        if os.path.exists(path):
            raise FileExistsError(
                f"evidence for {record.identity.candidate_id} already exists: "
                "records are append-only"
            )
        self._write_canonical(path, record.to_dict())
        return path

    def write_manifest(self, manifest: RunManifest) -> str:
        self._write_canonical(self.manifest_path, manifest.to_dict())
        return self.manifest_path

    def write_summary(self, summary: Dict[str, Any]) -> str:
        self._write_canonical(self.summary_path, summary)
        return self.summary_path

    # reading -----------------------------------------------------------------

    def read_manifest(self) -> RunManifest:
        with open(self.manifest_path, "r", encoding="utf-8") as handle:
            return RunManifest.from_dict(json.load(handle))

    def _read_dir(self, directory: str) -> List[CalibrationRecord]:
        if not os.path.isdir(directory):
            return []
        records: List[CalibrationRecord] = []
        for name in sorted(os.listdir(directory)):
            if not name.endswith(".json"):
                continue
            with open(os.path.join(directory, name), "r", encoding="utf-8") as handle:
                records.append(CalibrationRecord.from_dict(json.load(handle)))
        return records

    def read_records(self) -> List[CalibrationRecord]:
        """All records, successes and failures, in deterministic order."""
        return self._read_dir(self.candidates_dir) + self._read_dir(self.failures_dir)


# ── privacy ──────────────────────────────────────────────────────────────────

# Substrings that must never appear in stored evidence. Checked against the
# serialised record rather than field by field, so a leak through an unexpected
# field (a filter chain, a failure_reason, an exception message) is caught too.
_SENSITIVE_MARKERS = (
    "/Users/",
    "/home/",
    "/root/",
    "/private/var/",
    "/var/folders/",
    "/tmp/",
    "\\Users\\",
    "AppData\\Local\\Temp",
    "%USERPROFILE%",
    "$HOME",
)

_WINDOWS_DRIVE = ("A:\\", "B:\\", "C:\\", "D:\\", "E:\\", "F:\\", "G:\\", "H:\\")


class SensitiveDataError(ValueError):
    """Evidence contains an absolute path, machine path or personal identifier."""


def find_sensitive_strings(text: str) -> List[str]:
    """Sensitive markers present in ``text``. Empty list means clean."""
    found: List[str] = []
    for marker in _SENSITIVE_MARKERS:
        if marker in text:
            found.append(marker)
    for drive in _WINDOWS_DRIVE:
        if drive in text or drive.replace("\\", "/") in text:
            found.append(drive)
    if _looks_like_email(text):
        found.append("email-address")
    return found


def _looks_like_email(text: str) -> bool:
    """Detect an email without a regex engine dependency on the text size.

    Deliberately simple: any ``@`` with word characters either side and a dot in
    the domain. False positives are acceptable here - refusing to store an
    ambiguous string is cheaper than leaking a real address.
    """
    for index, char in enumerate(text):
        if char != "@" or index == 0 or index + 1 >= len(text):
            continue
        before = text[index - 1]
        after_part = text[index + 1:index + 64].split('"')[0].split(" ")[0]
        if before.isalnum() and "." in after_part and after_part[0].isalnum():
            return True
    return False


def scan_for_sensitive_strings(text: str, where: str = "record") -> None:
    """Raise if the serialised evidence would leak a path or identifier."""
    found = find_sensitive_strings(text)
    if found:
        raise SensitiveDataError(
            f"{where}: evidence contains sensitive value(s) {sorted(set(found))}"
        )
