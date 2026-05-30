"""
M1.75 reference profiling tests.

Verifies:
  1. extract_profile() produces a schema-valid profile from each fixture.
  2. The profile contains all required aggregate features (no time-series,
     no fingerprint arrays, no identifying metadata).
  3. compare_profiles() produces a meaningful diff with sane scores.
  4. recommend_preset() returns a known preset id for known inputs.
  5. derive_adaptive_overrides() returns clamped values.
  6. The schema validator rejects forbidden fields (artist/title/album/lyrics).

Each profile is persisted to /tmp/aimaster-m1.75-metrics/<id>.profile.json
so the harness can be inspected.
"""
from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from app.fixtures import (
    list_builtin_fixtures,
    load_builtin_fixture,
    materialise_fixture,
)
from app.profiling import (
    ExtractionOptions,
    REFERENCE_PROFILE_SCHEMA_ID,
    compare_profiles,
    derive_adaptive_overrides,
    extract_profile,
    recommend_preset,
    validate_reference_profile,
)
from app.profiling.recommend import PRESET_ANCHORS


METRICS_DIR = Path("/tmp/aimaster-m1.75-metrics")
METRICS_DIR.mkdir(parents=True, exist_ok=True)


@pytest.fixture(scope="session")
def ffmpeg_present() -> bool:
    return shutil.which("ffmpeg") is not None


# ── Schema sanity ──────────────────────────────────────────────────────────


def test_validator_rejects_forbidden_provenance_keys():
    """Schema must refuse any rights-holder-identifying metadata."""
    fake = {
        "$schema": REFERENCE_PROFILE_SCHEMA_ID,
        "id": "fake",
        "version": "1.0.0",
        "provenance": {
            "sourceType": "user-supplied",
            "createdAt": "2026-01-01T00:00:00Z",
            "durationSec": 1.0,
            "sampleRate": 44100,
            "channels": 2,
            "extractorVersion": "1.0.0",
            "artist": "Forbidden Artist",        # MUST be rejected
            "title": "Forbidden Title",          # MUST be rejected
        },
        "features": {},
        "featureFingerprint": "00" * 32,
    }
    errs = validate_reference_profile(fake)
    paths = [e["path"] for e in errs]
    assert "/provenance/artist" in paths
    assert "/provenance/title" in paths


def test_validator_rejects_huge_feature_arrays():
    """Schema must refuse anything that looks like a time-series."""
    fake = {
        "$schema": REFERENCE_PROFILE_SCHEMA_ID,
        "id": "fake",
        "version": "1.0.0",
        "provenance": {
            "sourceType": "user-supplied",
            "createdAt": "2026-01-01T00:00:00Z",
            "durationSec": 1.0,
            "sampleRate": 44100,
            "channels": 2,
            "extractorVersion": "1.0.0",
        },
        "features": {
            "loudness": {},
            "dynamics": {},
            "tonal": {},
            "stereo": {},
            "rogueTimeSeries": list(range(500)),   # MUST be rejected
        },
        "featureFingerprint": "00" * 32,
    }
    errs = validate_reference_profile(fake)
    assert any("rogueTimeSeries" in e["path"] for e in errs)


def test_validator_rejects_too_many_spectrum_bins():
    """Schema caps spectrum at 64 bins (1/3-oct max — no fingerprinting)."""
    spec = {str(i * 100): float(i % 30) for i in range(1, 80)}  # 79 bins
    fake = {
        "$schema": REFERENCE_PROFILE_SCHEMA_ID,
        "id": "fake",
        "version": "1.0.0",
        "provenance": {
            "sourceType": "user-supplied",
            "createdAt": "2026-01-01T00:00:00Z",
            "durationSec": 1.0,
            "sampleRate": 44100,
            "channels": 2,
            "extractorVersion": "1.0.0",
        },
        "features": {
            "loudness": {},
            "dynamics": {},
            "tonal": {"thirdOctSpectrumDb": spec},
            "stereo": {},
        },
        "featureFingerprint": "00" * 32,
    }
    errs = validate_reference_profile(fake)
    assert any("thirdOctSpectrumDb" in e["path"] and "> 64" in e["message"] for e in errs)


# ── Extraction × all fixtures ──────────────────────────────────────────────


@pytest.mark.parametrize("fixture_name", list_builtin_fixtures())
def test_extract_profile_from_fixture(fixture_name: str, ffmpeg_present: bool) -> None:
    if not ffmpeg_present:
        pytest.skip("ffmpeg unavailable")

    meta = load_builtin_fixture(fixture_name)
    res = materialise_fixture(meta)

    profile = extract_profile(
        res.wavPath,
        profile_id=f"fixture-{fixture_name}",
        options=ExtractionOptions(
            source_type="fixture",
            user_label=meta.name,
            include_source_sha256=True,
        ),
    )

    # Schema validation.
    errs = validate_reference_profile(profile.to_dict())
    assert errs == [], f"profile validation failed: {errs}"

    # Required aggregate features are present and numeric.
    f = profile.features
    for k in (
        "integratedLufs", "truePeakDbtp", "loudnessRange",
    ):
        v = getattr(f.loudness, k)
        assert isinstance(v, (int, float))

    for k in ("crestDb", "transientDensityPerMin", "compressionScore"):
        v = getattr(f.dynamics, k)
        assert isinstance(v, (int, float))
    assert 0.0 <= f.dynamics.compressionScore <= 1.0

    # Spectrum: at most 64 bins (schema cap), 1/3-oct standard centres.
    assert len(f.tonal.thirdOctSpectrumDb) <= 64
    assert len(f.tonal.thirdOctSpectrumDb) >= 20  # most bins should populate

    # No forbidden fields in serialised dict.
    pd = profile.to_dict()
    assert "artist" not in pd["provenance"]
    assert "title" not in pd["provenance"]
    assert "lyrics" not in pd["provenance"]

    # Spectrum is dB scalars, never an array — defensive: check no key maps
    # to a list/array.
    for v in f.tonal.thirdOctSpectrumDb.values():
        assert isinstance(v, (int, float))

    out = METRICS_DIR / f"{fixture_name}.profile.json"
    out.write_text(json.dumps(profile.to_dict(), indent=2, ensure_ascii=False))


# ── Compare two profiles ───────────────────────────────────────────────────


def test_compare_profiles_self_similarity_is_one(ffmpeg_present: bool) -> None:
    """A profile compared against itself must have similarity ≈ 1."""
    if not ffmpeg_present:
        pytest.skip("ffmpeg unavailable")
    name = "ballad-piano-01"
    meta = load_builtin_fixture(name)
    res = materialise_fixture(meta)
    p = extract_profile(res.wavPath, profile_id=f"fx-{name}")
    cmp_self = compare_profiles(p, p)
    assert cmp_self.overallSimilarity01 > 0.99
    for ax_name, ax in cmp_self.axes.items():
        assert abs(ax.delta) < 1e-6, f"self-compare delta non-zero on {ax_name}: {ax.delta}"
        assert ax.similarity01 > 0.99


def test_compare_profiles_different_genres_diverge(ffmpeg_present: bool) -> None:
    """Two clearly different fixtures must produce a lower aggregate similarity."""
    if not ffmpeg_present:
        pytest.skip("ffmpeg unavailable")
    a = extract_profile(
        materialise_fixture(load_builtin_fixture("acoustic-fingerpick-01")).wavPath,
        profile_id="fx-acoustic",
    )
    b = extract_profile(
        materialise_fixture(load_builtin_fixture("ai-harsh-mix-01")).wavPath,
        profile_id="fx-aiharsh",
    )
    cmp = compare_profiles(a, b)
    assert cmp.overallSimilarity01 < 0.85   # acoustic vs ai-harsh: clearly different
    # Loudness label must reflect the huge LUFS gap.
    assert cmp.labels["loudness"] == "louder"
    out = METRICS_DIR / "compare_acoustic_vs_aiharsh.json"
    out.write_text(json.dumps(cmp.to_dict(), indent=2, ensure_ascii=False))


# ── Recommender ────────────────────────────────────────────────────────────


def test_recommender_returns_known_preset_for_fixture(ffmpeg_present: bool) -> None:
    if not ffmpeg_present:
        pytest.skip("ffmpeg unavailable")
    meta = load_builtin_fixture("kpop-modern-01")
    p = extract_profile(materialise_fixture(meta).wavPath, profile_id="fx-kpop")
    rec = recommend_preset(p)
    assert rec.presetId in PRESET_ANCHORS, f"unknown preset: {rec.presetId}"
    assert 0.0 <= rec.score <= 1.0
    # Rationale must list all weighted axes.
    expected_axes = {"lufsI", "lra", "crest", "compression", "spectralTilt",
                     "subRatio", "harshness", "width"}
    assert expected_axes.issubset(set(rec.rationale.keys()))


def test_adaptive_overrides_are_clamped(ffmpeg_present: bool) -> None:
    """derive_adaptive_overrides must never exceed its declared bounds."""
    if not ffmpeg_present:
        pytest.skip("ffmpeg unavailable")
    pre = extract_profile(
        materialise_fixture(load_builtin_fixture("acoustic-fingerpick-01")).wavPath,
        profile_id="pre",
    )
    ref = extract_profile(
        materialise_fixture(load_builtin_fixture("kpop-modern-01")).wavPath,
        profile_id="ref",
    )
    over = derive_adaptive_overrides(pre, ref, chosen_preset_id="builtin-balanced")
    # Each field clamped to ±2 (lufs/eq) or ±0.10 (saturation/width).
    assert abs(over.targetLufsAdjustDb) <= 2.0
    assert abs(over.saturationDelta) <= 0.10
    assert abs(over.stereoWidthDelta) <= 0.10
    assert abs(over.eqAirShelfDeltaDb) <= 2.0
    assert abs(over.eqLowShelfDeltaDb) <= 2.0
    # The overrides note must explicitly state the no-clone guarantee.
    assert any("nudge" in n.lower() or "characteristic" in n.lower() for n in over.notes)


def test_unknown_preset_overrides_skipped(ffmpeg_present: bool) -> None:
    if not ffmpeg_present:
        pytest.skip("ffmpeg unavailable")
    p = extract_profile(
        materialise_fixture(load_builtin_fixture("ballad-piano-01")).wavPath,
        profile_id="pre",
    )
    over = derive_adaptive_overrides(p, p, chosen_preset_id="builtin-unknown-preset")
    assert any("not in anchors" in n for n in over.notes)
    # Defaults are all zero.
    assert over.targetLufsAdjustDb == 0.0
    assert over.saturationDelta == 0.0
