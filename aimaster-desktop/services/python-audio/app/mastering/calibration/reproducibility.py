"""
Closed Loop Calibration P1 - Deterministic Reproducibility

Proves that rendering the same candidate from the same input with the same
settings produces the same bytes, by actually doing it.

Method: for each selected candidate, render it ``runs`` times into a temporary
directory and compare (a) the sha256 of the rendered bytes and (b) the sha256
of the extracted canonical feature set.  Byte equality is the strong claim;
feature equality is kept as a separate signal because a byte difference that
does not move any measured feature is a materially different failure from one
that does.

Each temporary render is also compared against the archived render for that
candidate, which proves the stored 1,400-candidate output set is reproducible
rather than merely self-consistent.

Safety:
  - Renders only ever go to a temporary directory.
  - The archived renders and every calibration artifact are opened read-only.
  - The filter chain comes from CandidateRunner._build_filter_chain, so this
    exercises the production render path rather than a reimplementation of it.

Phase: AI-MASTERING-CLOSED-LOOP-CALIBRATION-P1-1
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import tempfile
from typing import Any, Dict, List, Optional

from .constants import REPRODUCIBILITY_RUNS
from .schema import SweepCandidate
from app.utils.logger import log

# Candidates sampled for the check.  One per distinct processor keeps the
# proof from resting on a single filter shape.
DEFAULT_CANDIDATE_COUNT = 3

_HASH_CHUNK = 1 << 20


def _sha256_file(path: str) -> Optional[str]:
    try:
        digest = hashlib.sha256()
        with open(path, "rb") as f:
            while True:
                chunk = f.read(_HASH_CHUNK)
                if not chunk:
                    break
                digest.update(chunk)
        return digest.hexdigest()
    except OSError:
        return None


def _feature_hash(features: Dict[str, Any]) -> str:
    """Stable hash of a feature dict.

    Floats are rounded to 9 significant decimals before hashing, matching the
    rounding convention already used by the canonical feature PoC, so that a
    last-bit float representation difference is not reported as a feature
    change.  Byte-level comparison remains exact and is the primary signal.
    """
    def normalise(value: Any) -> Any:
        if isinstance(value, float):
            return round(value, 9)
        if isinstance(value, dict):
            return {k: normalise(v) for k, v in sorted(value.items())}
        if isinstance(value, (list, tuple)):
            return [normalise(v) for v in value]
        return value

    payload = json.dumps(normalise(features), sort_keys=True, default=str)
    return hashlib.sha256(payload.encode()).hexdigest()


def select_candidates(
    candidates: List[SweepCandidate],
    count: int = DEFAULT_CANDIDATE_COUNT,
) -> List[SweepCandidate]:
    """Pick a deterministic, processor-diverse sample.

    Selection is by sorted candidate_id so the same candidates are chosen on
    every run — a reproducibility check must not itself be random.
    """
    ordered = sorted(candidates, key=lambda c: c.candidate_id)
    chosen: List[SweepCandidate] = []
    seen_processors: set[str] = set()

    for candidate in ordered:
        if candidate.processor not in seen_processors:
            chosen.append(candidate)
            seen_processors.add(candidate.processor)
        if len(chosen) >= count:
            break

    # Top up with the lowest ids if there were fewer processors than slots.
    for candidate in ordered:
        if len(chosen) >= count:
            break
        if candidate not in chosen:
            chosen.append(candidate)

    return chosen[:count]


def check_reproducibility(
    candidates: List[SweepCandidate],
    runs: int = REPRODUCIBILITY_RUNS,
    candidate_count: int = DEFAULT_CANDIDATE_COUNT,
    temp_dir: Optional[str] = None,
    archived_renders_dir: Optional[str] = None,
    sample_rate: int = 44100,
    bit_depth: int = 24,
    cleanup: bool = True,
) -> Dict[str, Any]:
    """Render selected candidates ``runs`` times and compare the results."""
    # Imported here so the module can be loaded without pulling the render
    # stack into processes that only need the report shape.
    from .candidate_runner import CandidateRunner
    from app.analyzers.canonical_features import extract_canonical_features

    if not candidates:
        return {
            "passed": False,
            "determinable": False,
            "runs": runs,
            "note": "No candidates available for reproducibility test",
            "byte_level_reproducible": None,
            "feature_level_reproducible": None,
            "candidates": [],
            "differences": [],
        }

    selected = select_candidates(candidates, candidate_count)
    workspace = temp_dir or tempfile.mkdtemp(prefix="calibration-repro-")
    os.makedirs(workspace, exist_ok=True)

    reports: List[Dict[str, Any]] = []
    differences: List[Dict[str, Any]] = []

    try:
        for candidate in selected:
            entry: Dict[str, Any] = {
                "candidate_id": candidate.candidate_id,
                "track_name": candidate.track_name,
                "processor": candidate.processor,
                "parameter": candidate.parameter,
                "value": candidate.value,
                "unit": candidate.unit,
                "frequency_hz": candidate.frequency_hz,
                "byte_hashes": [],
                "feature_hashes": [],
                "output_sizes": [],
                "render_errors": [],
            }

            for run_index in range(1, runs + 1):
                run_dir = os.path.join(workspace, f"run_{run_index}")
                runner = CandidateRunner(
                    output_dir=run_dir,
                    sample_rate=sample_rate,
                    bit_depth=bit_depth,
                )
                # Render through the production chain builder.
                chain = runner._build_filter_chain(candidate)
                entry.setdefault("filter_chain", chain)
                output_name = f"{candidate.candidate_id}_{candidate.track_name}"
                render = runner.render_executor.render(
                    candidate.track_path, chain, output_name
                )

                if not render.success:
                    entry["render_errors"].append(
                        {"run": run_index, "error": render.error_message}
                    )
                    continue

                entry["byte_hashes"].append(_sha256_file(render.output_path))
                entry["output_sizes"].append(os.path.getsize(render.output_path))
                try:
                    features = extract_canonical_features(render.output_path)
                    entry["feature_hashes"].append(
                        _feature_hash(
                            features.to_dict() if hasattr(features, "to_dict") else features
                        )
                    )
                except Exception as exc:  # noqa: BLE001 - recorded, not swallowed
                    entry["render_errors"].append(
                        {"run": run_index, "error": f"feature extraction failed: {exc}"}
                    )

            byte_hashes = [h for h in entry["byte_hashes"] if h]
            feature_hashes = entry["feature_hashes"]

            entry["completed_runs"] = len(byte_hashes)
            entry["byte_identical"] = bool(byte_hashes) and len(set(byte_hashes)) == 1
            entry["feature_identical"] = bool(feature_hashes) and len(set(feature_hashes)) == 1

            if len(byte_hashes) < runs:
                differences.append(
                    {
                        "candidate_id": candidate.candidate_id,
                        "field": "completed_runs",
                        "expected": runs,
                        "actual": len(byte_hashes),
                    }
                )
            if byte_hashes and not entry["byte_identical"]:
                differences.append(
                    {
                        "candidate_id": candidate.candidate_id,
                        "field": "byte_hash",
                        "baseline": byte_hashes[0],
                        "observed": sorted(set(byte_hashes)),
                    }
                )
            if feature_hashes and not entry["feature_identical"]:
                differences.append(
                    {
                        "candidate_id": candidate.candidate_id,
                        "field": "feature_hash",
                        "baseline": feature_hashes[0],
                        "observed": sorted(set(feature_hashes)),
                    }
                )

            # Compare against the archived render (read-only).
            if archived_renders_dir:
                archived = os.path.join(
                    archived_renders_dir,
                    f"{candidate.candidate_id}_{candidate.track_name}.wav",
                )
                archived_hash = _sha256_file(archived) if os.path.isfile(archived) else None
                entry["archived_hash"] = archived_hash
                if archived_hash and byte_hashes:
                    entry["matches_archived_render"] = archived_hash == byte_hashes[0]
                    if not entry["matches_archived_render"]:
                        differences.append(
                            {
                                "candidate_id": candidate.candidate_id,
                                "field": "archived_render_hash",
                                "archived": archived_hash,
                                "rerendered": byte_hashes[0],
                            }
                        )
                elif byte_hashes:
                    # An archive was named but this candidate is not in it.
                    entry["matches_archived_render"] = False
                    differences.append(
                        {
                            "candidate_id": candidate.candidate_id,
                            "field": "archived_render_missing",
                            "expected_path": archived,
                        }
                    )
                else:
                    entry["matches_archived_render"] = None

            reports.append(entry)
            log(
                "INFO",
                f"[calibration] Reproducibility {candidate.candidate_id}: "
                f"byte_identical={entry['byte_identical']} "
                f"feature_identical={entry['feature_identical']}",
            )
    finally:
        if cleanup and temp_dir is None:
            shutil.rmtree(workspace, ignore_errors=True)

    byte_ok = bool(reports) and all(r["byte_identical"] for r in reports)
    feature_ok = bool(reports) and all(r["feature_identical"] for r in reports)
    archived_flags = [
        r.get("matches_archived_render")
        for r in reports
        if r.get("matches_archived_render") is not None
    ]
    archived_ok = all(archived_flags) if archived_flags else None

    if not reports:
        note = "No candidates rendered; reproducibility not established"
    elif byte_ok and feature_ok and archived_ok is not False:
        note = (
            f"{len(reports)} candidates re-rendered {runs}x: byte-identical and "
            f"feature-identical across runs"
            + (", and matching the archived renders" if archived_ok else "")
        )
    else:
        note = f"Reproducibility FAILED: {len(differences)} difference(s) recorded"

    return {
        "passed": byte_ok and feature_ok and (archived_ok is not False),
        "note": note,
        "determinable": bool(reports),
        "runs": runs,
        "candidate_count": len(reports),
        "byte_level_reproducible": byte_ok,
        "feature_level_reproducible": feature_ok,
        "matches_archived_renders": archived_ok,
        "candidates": reports,
        "differences": differences,
        "method": {
            "selection": "lowest candidate_id per distinct processor, sorted — deterministic",
            "byte_comparison": "sha256 over full rendered file",
            "feature_comparison": "sha256 over canonical features, floats rounded to 9dp",
            "render_path": "CandidateRunner._build_filter_chain + RenderExecutor.render",
            "isolation": "renders written to a temporary directory; archived renders read-only",
        },
    }
