"""Which of the engine's modules can a request actually reach?

Measured: 46 of 113 modules under `app/` — 13,552 lines, 40% of the engine's
own code — are not reachable from `app.main` by any import, static or lazy.
The engine ships them and no RPC call can run them:

    ai_cleanup_v2 + ai_cleanup_poc   10 modules   4,201 lines   finished, unwired
    mastering.calibration            19 modules   5,898 lines   offline tooling
    profiling                         6 modules   1,565 lines
    engine (EnginePreset schema)       5 modules     856 lines   tests import it
    fixtures                          5 modules   1,011 lines   tests only

Some of that is correct — `fixtures` is test material and `calibration` is a
set of offline tools that are run by hand.  The point of pinning it is not to
condemn it; it is that the list was nobody's: it grew without anyone deciding,
and `app/analyzers/canonical_features.py` carried a line saying it was
"test-only" while `master` reached it through two importers.

So the set is asserted exactly.  New unreachable code fails this, and wiring
one of these in fails it too, which is the half that keeps the list true.
"""
from __future__ import annotations

import ast
import os
from collections import deque

APP_ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "app")

# Reachable from no RPC method.  Each entry is a decision someone can revisit;
# none of them is a tolerance.
UNREACHABLE_FROM_MAIN = {
    # Test material — correct that the engine cannot reach it.
    "app.fixtures", "app.fixtures.generator", "app.fixtures.loader",
    "app.fixtures.schema", "app.fixtures.validate",
    # The EnginePreset schema/loader/validate/adapter.  Only tests import it;
    # the TS side carries the mirror that the product actually runs.
    "app.engine", "app.engine.adapter", "app.engine.loader",
    "app.engine.schema", "app.engine.validate",
    # AI cleanup — complete and not wired to any handler.
    "app.mastering.ai_cleanup_poc",
    "app.mastering.ai_cleanup_v2", "app.mastering.ai_cleanup_v2.blend",
    "app.mastering.ai_cleanup_v2.peak_control", "app.mastering.ai_cleanup_v2.processor",
    "app.mastering.ai_cleanup_v2.protection", "app.mastering.ai_cleanup_v2.reconstruction",
    "app.mastering.ai_cleanup_v2.safety_gate", "app.mastering.ai_cleanup_v2.smoothing",
    "app.mastering.ai_cleanup_v2.spectral_context", "app.mastering.ai_cleanup_v2.spectral_mask",
    # Calibration / evidence — offline tooling, run by hand.
    "app.mastering.calibration", "app.mastering.calibration.candidate_runner",
    "app.mastering.calibration.confidence", "app.mastering.calibration.constants",
    "app.mastering.calibration.curve_builder", "app.mastering.calibration.dataset_builder",
    "app.mastering.calibration.engine", "app.mastering.calibration.evidence",
    "app.mastering.calibration.evidence_validator", "app.mastering.calibration.mapping_calibrator",
    "app.mastering.calibration.no_action_auditor", "app.mastering.calibration.output_validator",
    "app.mastering.calibration.regression", "app.mastering.calibration.reproducibility",
    "app.mastering.calibration.response_analyzer", "app.mastering.calibration.runtime_validator",
    "app.mastering.calibration.schema", "app.mastering.calibration.sweep_registry",
    # Profiling — the reference-profile tooling.
    "app.profiling", "app.profiling.compare", "app.profiling.extract",
    "app.profiling.recommend", "app.profiling.schema", "app.profiling.validate",
    # The package root itself has no code.
    "app",
}


def _module_files() -> dict[str, str]:
    mods: dict[str, str] = {}
    base = os.path.dirname(APP_ROOT)
    for dirpath, _dirs, files in os.walk(APP_ROOT):
        for name in files:
            if not name.endswith(".py"):
                continue
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, base)[:-3].replace(os.sep, ".")
            if rel.endswith(".__init__"):
                rel = rel[: -len(".__init__")]
            mods[rel] = full
    return mods


def _imports(path: str, package: str) -> list[str]:
    """Every `app.*` name this file imports, absolute or relative.

    Lazy imports inside functions count — `rc_engine.apply_precorrection`
    imports `canonical_features` from inside a try block, which is exactly how
    the production path reaches a module that called itself test-only.
    """
    with open(path, encoding="utf-8") as handle:
        tree = ast.parse(handle.read())
    out: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            out += [alias.name for alias in node.names]
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                parts = package.split(".")
                base = parts[: len(parts) - (node.level - 1)] if node.level > 1 else parts
                prefix = base + ([node.module] if node.module else [])
                out.append(".".join(prefix))
                out += [".".join(prefix + [alias.name]) for alias in node.names]
            elif node.module:
                out.append(node.module)
                out += [f"{node.module}.{alias.name}" for alias in node.names]
    return out


def _reachable(mods: dict[str, str]) -> set[str]:
    seen: set[str] = set()
    queue: deque[str] = deque(["app.main"])
    while queue:
        name = queue.popleft()
        if name in seen or name not in mods:
            continue
        seen.add(name)
        package = name if mods[name].endswith("__init__.py") else name.rsplit(".", 1)[0]
        for imported in _imports(mods[name], package):
            if not imported.startswith("app"):
                continue
            for candidate in (imported, imported.rsplit(".", 1)[0]):
                if candidate in mods and candidate not in seen:
                    queue.append(candidate)
    return seen


def test_the_walk_found_the_engine():
    """A broken walk would make every assertion below pass by measuring nothing."""
    mods = _module_files()
    assert len(mods) > 100, f"only {len(mods)} modules found under {APP_ROOT}"
    reached = _reachable(mods)
    assert "app.main" in reached
    # The handlers and the things they call must be reachable, or the walk is wrong.
    for must in ("app.mastering.mastering", "app.analyzers.analyzer", "app.utils.audio_io",
                 "app.analyzers.canonical_features", "app.mastering.rc_engine"):
        assert must in reached, f"{must} is not reachable but the dispatch table reaches it"


def test_unreachable_modules_are_exactly_the_pinned_set():
    mods = _module_files()
    unreachable = set(mods) - _reachable(mods)
    new = sorted(unreachable - UNREACHABLE_FROM_MAIN)
    wired = sorted(UNREACHABLE_FROM_MAIN - unreachable)
    assert not new, (
        f"{len(new)} module(s) the engine ships and no request can reach:\n   "
        + "\n   ".join(new)
        + "\n  Wire it to a handler, move it out of app/, or add it to "
          "UNREACHABLE_FROM_MAIN with the reason."
    )
    assert not wired, (
        f"{len(wired)} module(s) are reachable now and still listed as unreachable:\n   "
        + "\n   ".join(wired) + "\n  Remove them from UNREACHABLE_FROM_MAIN."
    )


def test_canonical_features_is_reachable_from_master():
    """The claim that started this: `master` → rc_engine → canonical_features.

    The module's own docstring said it was "a test-only module that does NOT
    connect to the production mastering pipeline" while two importers in the
    production path reached it, one of them at module level.
    """
    mods = _module_files()
    assert "app.analyzers.canonical_features" in _reachable(mods)
