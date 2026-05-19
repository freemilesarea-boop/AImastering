"""
Real-music fixture system (M1.5).

Each fixture is a JSON metadata document under `recipes/`.  The WAV itself
is NEVER committed — it is either:
  • Synthesized on demand by `generator.synthesize_fixture()` (deterministic,
    seeded by the fixture id) and cached to /tmp/aimaster-fixtures/
  • Fetched from a CC0 URL (verified by sha256)
  • Loaded from a user-supplied path under $LOUI_FIXTURE_DIR

Reference docs:
  docs/redesign/loui-mastering-v2/m1.5/00-FIXTURE-SYSTEM.md
  docs/redesign/loui-mastering-v2/m1.5/01-DSP-POLICY-PHILOSOPHY.md
"""
from .schema import (
    FixtureMetadata,
    FixtureTargetMetrics,
    FixturePolicy,
    FIXTURE_SCHEMA_ID,
)
from .loader import (
    load_fixture_file,
    load_builtin_fixture,
    list_builtin_fixtures,
    RECIPES_DIR,
    CACHE_DIR,
)
from .validate import (
    validate_fixture,
    FixtureValidationError,
)
from .generator import (
    materialise_fixture,
    FixtureMaterialisationResult,
)

__all__ = [
    "FixtureMetadata",
    "FixtureTargetMetrics",
    "FixturePolicy",
    "FIXTURE_SCHEMA_ID",
    "load_fixture_file",
    "load_builtin_fixture",
    "list_builtin_fixtures",
    "RECIPES_DIR",
    "CACHE_DIR",
    "validate_fixture",
    "FixtureValidationError",
    "materialise_fixture",
    "FixtureMaterialisationResult",
]
