"""
Canonical engine schema adapter (M1).

Loads EnginePreset v1 JSON files and translates them into kwargs the existing
`app.mastering.pipeline.run_pipeline` accepts.  M1 deliberately keeps Python
as the reference implementation: every module in the canonical chain is
either applied by run_pipeline (mapped through `adapter.preset_to_kwargs`)
or recorded as a "noop" entry in the run report.

Reference: docs/redesign/loui-mastering-v2/m1/00-M1-SCOPE.md
"""
from .schema import (
    EnginePreset,
    AdapterLogEntry,
    AdapterRunReport,
    ENGINE_PRESET_SCHEMA_ID,
    ENGINE_API_VERSION,
)
from .loader import (
    load_preset_file,
    load_builtin_preset,
    list_builtin_presets,
    BUILTIN_DIR,
)
from .validate import (
    validate_preset,
    ValidationError,
)
from .adapter import (
    preset_to_kwargs,
    PresetKwargs,
)

__all__ = [
    "EnginePreset",
    "AdapterLogEntry",
    "AdapterRunReport",
    "ENGINE_PRESET_SCHEMA_ID",
    "ENGINE_API_VERSION",
    "load_preset_file",
    "load_builtin_preset",
    "list_builtin_presets",
    "BUILTIN_DIR",
    "validate_preset",
    "ValidationError",
    "preset_to_kwargs",
    "PresetKwargs",
]
