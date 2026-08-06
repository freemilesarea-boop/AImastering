"""
Closed Loop Calibration P1 - Runtime Safety Validator

Computes ``runtime_safe`` and ``production_affected`` from evidence instead of
declaring them.  Two independent sources are used:

1. **git diff** — which files this PoC changed relative to the branch point.
   A file that is *added* is treated differently from one that is *modified* or
   *deleted*: adding a new module cannot change existing runtime behaviour
   unless something already running imports it, which is what (2) checks.
2. **static import graph** — walks imports from the production entrypoint with
   ``ast`` (never executing project code) and reports whether any PoC module is
   transitively reachable.

Reads the repository; mutates nothing.  stdlib only.

Phase: AI-MASTERING-CLOSED-LOOP-CALIBRATION-P1-1
"""
from __future__ import annotations

import ast
import hashlib
import os
import subprocess
from typing import Any

# Service root = .../services/python-audio (this file is app/mastering/calibration/)
SERVICE_ROOT = os.path.abspath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..")
)

# Refs tried in order when resolving the comparison baseline.
DEFAULT_BASE_REFS = ("origin/HEAD", "main", "master")
BASE_REF_ENV = "CALIBRATION_BASE_REF"

# ── Production surface, relative to SERVICE_ROOT ───────────────────────────
DECISION_ENGINE_PATHS = ("app/mastering/decision_engine/",)

DSP_PROCESSOR_PATHS = (
    "app/mastering/eq.py",
    "app/mastering/dynamic_eq.py",
    "app/mastering/dynamics.py",
    "app/mastering/multiband.py",
    "app/mastering/effects.py",
    "app/mastering/mastering.py",
    "app/mastering/pipeline.py",
    "app/mastering/iterative.py",
    "app/mastering/safe_modes.py",
    "app/mastering/tonal_budget.py",
    "app/mastering/reference_matching.py",
    "app/mastering/reference_presets.py",
    "app/engine/",
)

MAPPING_REGISTRY_PATHS = (
    "app/mastering/decision_engine/mapping_registry.py",
    "app/mastering/decision_engine/target_registry.py",
)

PRODUCTION_PATHS = DSP_PROCESSOR_PATHS + DECISION_ENGINE_PATHS + (
    "app/main.py",
    "app/analysis/",
    "app/analyzers/",
    "app/qc/",
    "app/profiling/",
    "app/fixtures/",
    "app/utils/",
)

# UI lives at the repository root, not under the service.
UI_REPO_PATHS = ("src/",)

# Calibration algorithm modules.  engine.py (orchestration + reporting) and the
# validators are deliberately excluded — they are the reporting layer and are
# tracked separately via ORCHESTRATION_MODULES so the exclusion stays visible.
CALIBRATION_ALGORITHM_MODULES = (
    "app/mastering/calibration/dataset_builder.py",
    "app/mastering/calibration/sweep_registry.py",
    "app/mastering/calibration/candidate_runner.py",
    "app/mastering/calibration/response_analyzer.py",
    "app/mastering/calibration/curve_builder.py",
    "app/mastering/calibration/mapping_calibrator.py",
    "app/mastering/calibration/no_action_auditor.py",
    "app/mastering/calibration/confidence.py",
    "app/mastering/calibration/constants.py",
    "app/mastering/calibration/schema.py",
)

ORCHESTRATION_MODULES = (
    "app/mastering/calibration/engine.py",
    "app/mastering/calibration/output_validator.py",
    "app/mastering/calibration/runtime_validator.py",
)

# Modules introduced by the PoC phases.  None of these may be reachable from
# the production entrypoint.
POC_MODULE_PREFIXES = (
    "app.mastering.calibration",
    "app.mastering.closed_loop",
    "app.mastering.audio_profiles",
    "app.mastering.ai_cleanup_v2",
    "app.mastering.ai_cleanup_poc",
    "app.mastering.decision_engine",
    "app.analyzers.canonical_features",
)

PRODUCTION_ENTRYPOINTS = ("app/main.py",)

# git status letters that mean an already-existing file was altered.
_ALTERING_STATUS = ("M", "D", "R", "T")


class RuntimeSafetyError(RuntimeError):
    """Raised when runtime safety cannot be established."""


# ── git helpers ────────────────────────────────────────────────────────────

def _git(repo_root: str, *args: str) -> tuple[int, str]:
    try:
        proc = subprocess.run(
            ("git",) + args,
            cwd=repo_root,
            capture_output=True,
            text=True,
            timeout=60,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return 1, str(exc)
    return proc.returncode, proc.stdout.strip()


def _repo_root() -> str | None:
    code, out = _git(SERVICE_ROOT, "rev-parse", "--show-toplevel")
    return out if code == 0 and out else None


def _resolve_baseline(repo_root: str, base_ref: str | None = None) -> tuple[str | None, str | None]:
    """Return (merge_base_sha, ref_used).  (None, None) if unresolvable."""
    candidates: list[str] = []
    if base_ref:
        candidates.append(base_ref)
    env_ref = os.environ.get(BASE_REF_ENV)
    if env_ref:
        candidates.append(env_ref)
    candidates.extend(DEFAULT_BASE_REFS)

    for ref in candidates:
        code, _ = _git(repo_root, "rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}")
        if code != 0:
            continue
        code, merge_base = _git(repo_root, "merge-base", "HEAD", ref)
        if code == 0 and merge_base:
            return merge_base, ref
    return None, None


def _changed_files(repo_root: str, base: str) -> dict[str, str]:
    """Map repo-relative path -> status letter, covering committed, staged,
    unstaged and untracked changes since ``base``."""
    changes: dict[str, str] = {}

    def absorb(raw: str) -> None:
        for line in raw.splitlines():
            parts = line.split("\t")
            if len(parts) < 2:
                continue
            status, path = parts[0][:1], parts[-1]
            prev = changes.get(path)
            # An altering status always wins over a plain addition.
            if prev in _ALTERING_STATUS:
                continue
            changes[path] = status

    for args in (
        ("diff", "--name-status", base, "HEAD"),
        ("diff", "--name-status", "HEAD"),
        ("diff", "--name-status", "--cached", "HEAD"),
    ):
        code, out = _git(repo_root, *args)
        if code == 0 and out:
            absorb(out)

    code, out = _git(repo_root, "ls-files", "--others", "--exclude-standard")
    if code == 0 and out:
        for path in out.splitlines():
            changes.setdefault(path.strip(), "A")

    return changes


def _matches(repo_rel_path: str, service_prefix: str, patterns: tuple[str, ...]) -> bool:
    for pattern in patterns:
        full = f"{service_prefix}{pattern}" if service_prefix else pattern
        if full.endswith("/"):
            if repo_rel_path.startswith(full):
                return True
        elif repo_rel_path == full:
            return True
    return False


def _select(
    changes: dict[str, str],
    service_prefix: str,
    patterns: tuple[str, ...],
    statuses: tuple[str, ...] | None = None,
) -> dict[str, str]:
    return {
        path: status
        for path, status in sorted(changes.items())
        if _matches(path, service_prefix, patterns)
        and (statuses is None or status in statuses)
    }


# ── static import graph ────────────────────────────────────────────────────

def _module_to_file(module: str) -> str | None:
    rel = module.replace(".", os.sep)
    for cand in (f"{rel}.py", os.path.join(rel, "__init__.py")):
        full = os.path.join(SERVICE_ROOT, cand)
        if os.path.isfile(full):
            return full
    return None


def _file_to_module(path: str) -> str:
    rel = os.path.relpath(path, SERVICE_ROOT)
    rel = rel[: -len(".py")] if rel.endswith(".py") else rel
    parts = rel.split(os.sep)
    if parts and parts[-1] == "__init__":
        parts = parts[:-1]
    return ".".join(parts)


def _imports_of(path: str) -> set[str]:
    """Absolute 'app.*' module names imported by a source file (ast only)."""
    try:
        with open(path, encoding="utf-8") as f:
            tree = ast.parse(f.read(), filename=path)
    except (OSError, SyntaxError, ValueError):
        return set()

    package = _file_to_module(path)
    package_parts = package.split(".")
    if not os.path.basename(path) == "__init__.py":
        package_parts = package_parts[:-1]

    found: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name.startswith("app."):
                    found.add(alias.name)
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                base = package_parts[: len(package_parts) - node.level + 1]
                target = ".".join(base + ([node.module] if node.module else []))
            else:
                target = node.module or ""
            if not target.startswith("app"):
                continue
            found.add(target)
            for alias in node.names:
                found.add(f"{target}.{alias.name}")
    return found


def _reachable_modules(entrypoints: tuple[str, ...]) -> tuple[set[str], dict[str, list[str]]]:
    """Transitively reachable 'app.*' modules from the entrypoints, plus the
    path by which each was first reached."""
    seen: set[str] = set()
    origin: dict[str, list[str]] = {}
    stack: list[tuple[str, list[str]]] = []

    for entry in entrypoints:
        full = os.path.join(SERVICE_ROOT, entry)
        if os.path.isfile(full):
            mod = _file_to_module(full)
            seen.add(mod)
            origin[mod] = [mod]
            stack.append((mod, [mod]))

    while stack:
        module, chain = stack.pop()
        path = _module_to_file(module)
        if not path:
            continue
        for imported in _imports_of(path):
            if imported in seen:
                continue
            if _module_to_file(imported) is None:
                continue
            seen.add(imported)
            origin[imported] = chain + [imported]
            stack.append((imported, chain + [imported]))

    return seen, origin


def _sha256(path: str) -> str | None:
    try:
        with open(path, "rb") as f:
            return hashlib.sha256(f.read()).hexdigest()
    except OSError:
        return None


# ── report ─────────────────────────────────────────────────────────────────

def build_runtime_safety_report(base_ref: str | None = None) -> dict[str, Any]:
    """Compute the 17_runtime_safety.json payload from git + import graph."""
    checks: list[dict[str, Any]] = []
    evidence: dict[str, Any] = {}

    def add(name: str, status: str, detail: Any) -> None:
        checks.append({"check": name, "status": status, "detail": detail})

    repo_root = _repo_root()
    if repo_root is None:
        add("baseline_resolution", "INDETERMINATE", "not a git repository")
        return _finalize(checks, evidence, resolvable=False)

    base, ref_used = _resolve_baseline(repo_root, base_ref)
    if base is None:
        add("baseline_resolution", "INDETERMINATE", f"no baseline ref among {DEFAULT_BASE_REFS}")
        return _finalize(checks, evidence, resolvable=False)

    _, head = _git(repo_root, "rev-parse", "HEAD")
    add("baseline_resolution", "PASS", {"ref": ref_used, "merge_base": base, "head": head})
    evidence["baseline"] = {"ref": ref_used, "merge_base": base, "head": head, "repo_root": repo_root}

    changes = _changed_files(repo_root, base)
    prefix = os.path.relpath(SERVICE_ROOT, repo_root).replace(os.sep, "/")
    prefix = "" if prefix == "." else f"{prefix}/"

    evidence["changed_file_count"] = len(changes)
    evidence["status_breakdown"] = {
        s: sum(1 for v in changes.values() if v == s) for s in sorted(set(changes.values()))
    }

    # ── 1. Production modules: only alterations to existing files matter ──
    prod_altered = _select(changes, prefix, PRODUCTION_PATHS, _ALTERING_STATUS)
    prod_added = _select(changes, prefix, PRODUCTION_PATHS, ("A",))
    add(
        "production_modules_unaltered",
        "PASS" if not prod_altered else "FAIL",
        {"altered": prod_altered, "added_new_files": sorted(prod_added)},
    )

    # ── 2. Decision engine ──
    de_altered = _select(changes, prefix, DECISION_ENGINE_PATHS, _ALTERING_STATUS)
    add("decision_engine_unaltered", "PASS" if not de_altered else "FAIL", {"altered": de_altered})

    # ── 3. DSP processors ──
    dsp_altered = _select(changes, prefix, DSP_PROCESSOR_PATHS, _ALTERING_STATUS)
    add("dsp_processor_unaltered", "PASS" if not dsp_altered else "FAIL", {"altered": dsp_altered})

    # ── 4. Mapping registry ──
    reg_altered = _select(changes, prefix, MAPPING_REGISTRY_PATHS, _ALTERING_STATUS)
    add("mapping_registry_unaltered", "PASS" if not reg_altered else "FAIL", {"altered": reg_altered})

    # ── 5. Calibration algorithm ──
    algo_altered = _select(changes, prefix, CALIBRATION_ALGORITHM_MODULES, _ALTERING_STATUS)
    fingerprints = {
        m: _sha256(os.path.join(SERVICE_ROOT, m)) for m in CALIBRATION_ALGORITHM_MODULES
    }
    add(
        "calibration_algorithm_unaltered",
        "PASS" if not algo_altered else "FAIL",
        {"altered": algo_altered, "excluded_reporting_layer": list(ORCHESTRATION_MODULES)},
    )
    evidence["calibration_algorithm_sha256"] = fingerprints

    # ── 6. UI ──
    ui_altered = _select(changes, "", UI_REPO_PATHS, _ALTERING_STATUS)
    add("ui_unaltered", "PASS" if not ui_altered else "FAIL", {"altered": ui_altered})

    # ── 7. Import graph isolation ──
    reachable, origin = _reachable_modules(PRODUCTION_ENTRYPOINTS)
    contaminated = sorted(
        m for m in reachable if any(m == p or m.startswith(p + ".") for p in POC_MODULE_PREFIXES)
    )
    add(
        "production_import_isolation",
        "PASS" if not contaminated else "FAIL",
        {
            "entrypoints": list(PRODUCTION_ENTRYPOINTS),
            "reachable_module_count": len(reachable),
            "poc_modules_reachable": contaminated,
            "import_chains": {m: origin.get(m, []) for m in contaminated},
        },
    )
    evidence["production_reachable_modules"] = sorted(reachable)

    evidence["altered"] = {
        "production": prod_altered,
        "decision_engine": de_altered,
        "dsp_processor": dsp_altered,
        "mapping_registry": reg_altered,
        "calibration_algorithm": algo_altered,
        "ui": ui_altered,
    }

    return _finalize(checks, evidence, resolvable=True)


def _finalize(
    checks: list[dict[str, Any]], evidence: dict[str, Any], resolvable: bool
) -> dict[str, Any]:
    by_name = {c["check"]: c for c in checks}

    def failed(name: str) -> bool:
        return by_name.get(name, {}).get("status") == "FAIL"

    altered = evidence.get("altered", {})
    contaminated = by_name.get("production_import_isolation", {}).get("detail", {})
    poc_reachable = bool(contaminated.get("poc_modules_reachable")) if contaminated else False

    production_affected = bool(altered.get("production")) or poc_reachable

    all_pass = all(c["status"] == "PASS" for c in checks)
    runtime_safe = resolvable and all_pass and not production_affected

    return {
        # Original keys, now computed rather than declared.
        "production_affected": production_affected,
        "existing_registry_modified": bool(altered.get("mapping_registry")),
        "mastering_path_modified": bool(altered.get("dsp_processor")),
        "ui_modified": bool(altered.get("ui")),
        "user_output_affected": production_affected,
        # Verdict + evidence.
        "runtime_safe": runtime_safe,
        "determinable": resolvable,
        "checks": checks,
        "evidence": evidence,
        "summary": {
            "total_checks": len(checks),
            "passed_checks": sum(1 for c in checks if c["status"] == "PASS"),
            "failed_checks": sum(1 for c in checks if c["status"] == "FAIL"),
            "indeterminate_checks": sum(1 for c in checks if c["status"] == "INDETERMINATE"),
        },
        "method": {
            "git_baseline": "merge-base(HEAD, base_ref)",
            "added_vs_altered": "added files do not affect runtime unless imported; "
                                "only M/D/R/T on existing files count as alteration",
            "import_graph": "static ast walk from production entrypoints, no code executed",
        },
    }


def validate_runtime_safety(base_ref: str | None = None) -> bool:
    """True when runtime safety is established by evidence."""
    return build_runtime_safety_report(base_ref)["runtime_safe"]


if __name__ == "__main__":  # pragma: no cover - manual re-validation entrypoint
    import json
    import sys

    report = build_runtime_safety_report(sys.argv[1] if len(sys.argv) > 1 else None)
    print(json.dumps(report, indent=2))
    sys.exit(0 if report["runtime_safe"] else 1)
