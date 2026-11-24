"""Do the 24 conflict rules read features that exist?

The rule table and the feature extractor are two files that have to agree, and
nothing checked that they did.  Measured against a real
`extract_canonical_features` dict, three rules name features the analyzer never
produces, so they read `f.get(name, default)`'s default instead:

    DYN_001   BLOCK        compression_density
    DYN_002   WARN         envelope_smoothness
    SPEC_004  CONDITIONAL  hf_ratio_variance

Every default in the table sits on the non-firing side of its own comparison —
`test_no_rule_fires_on_an_empty_feature_set` is that claim, for all 24 — so
those three have never fired and never could.  Two of them are the only
coverage the DYNAMIC_RANGE profile's conflict set has.

This file pins the three, so a fourth cannot appear quietly and fixing one
cannot pass unnoticed either.
"""
from __future__ import annotations

import os
import re
import subprocess

import pytest

from app.analyzers.canonical_features import extract_canonical_features
from app.mastering.audio_profiles.conflict_engine import ConflictEngine
from app.mastering.audio_profiles.feature_input import FeatureSet


# Features named by a rule that the analyzer does not produce.  Not a tolerance
# — a list of known holes, asserted exactly.
NEVER_PRODUCED = {"compression_density", "envelope_smoothness", "hf_ratio_variance"}
UNEVALUABLE_RULES = {"DYN_001", "DYN_002", "SPEC_004"}


@pytest.fixture(scope="module")
def engine():
    return ConflictEngine()


@pytest.fixture(scope="module")
def track_features(ffmpeg_available, tmp_path_factory):
    """Pink noise plus a low tone — spectrum and dynamics in every band."""
    if not ffmpeg_available:
        pytest.skip("ffmpeg not available")
    out = str(tmp_path_factory.mktemp("rules") / "track.wav")
    subprocess.run(
        [os.environ.get("AIMASTER_FFMPEG", "ffmpeg"), "-y",
         "-f", "lavfi", "-i", "anoisesrc=color=pink:duration=8:sample_rate=44100:amplitude=0.3",
         "-f", "lavfi", "-i", "sine=frequency=110:duration=8:sample_rate=44100",
         "-filter_complex",
         "[0:a][1:a]amix=inputs=2:weights=1 0.6[a];[a]aformat=channel_layouts=stereo[out]",
         "-map", "[out]", out],
        capture_output=True, check=True,
    )
    return extract_canonical_features(out).to_dict()


# ── the rule table against the extractor ────────────────────────────────────

def test_every_rule_names_features_the_analyzer_produces(engine, track_features):
    holes = {}
    for rule_id, names in engine.all_rule_feature_names().items():
        for name in names:
            if FeatureSet(file_name="t", features=track_features).get(name) is None:
                holes.setdefault(rule_id, []).append(name)
    assert {n for names in holes.values() for n in names} == NEVER_PRODUCED, holes
    assert set(holes) == UNEVALUABLE_RULES, holes


def test_the_condition_string_and_the_lambda_name_the_same_features(engine):
    """Two writings of one rule.  The string is what a report shows a human."""
    vocabulary = {n for names in engine.all_rule_feature_names().values() for n in names}
    for rule in engine._rules:
        named = set(engine.rule_feature_names(rule["id"]))
        condition = rule["condition"]
        for name in named:
            assert name in condition, (
                f"{rule['id']}: the lambda reads {name!r}, the condition says {condition!r}"
            )
        # And the condition does not advertise a feature the lambda ignores.
        # `in` is substring matching, so drop names contained in a longer one
        # that the lambda does read (band_ratio_1-2kHz vs band_ratio_1-2kHz).
        for name in vocabulary - named:
            if any(name in longer for longer in named):
                continue
            assert name not in condition, (
                f"{rule['id']}: the condition says {name!r}, the lambda never reads it"
            )


def test_no_rule_fires_on_an_empty_feature_set(engine):
    """Why a rule that cannot be evaluated is reported as not triggered.

    Every default in the table is on the non-firing side of its own
    comparison, so an absent feature has always meant "no conflict".  If a
    default ever moves to the firing side, a missing feature would start
    blocking DSP actions on tracks nobody measured — and this fails.
    """
    report = engine.evaluate_all(FeatureSet(file_name="nothing", features={}))
    fired = [r.rule_id for r in report.results if r.triggered]
    assert fired == [], fired
    assert report.block_count == 0 and report.blocked_actions == []
    # And with nothing to read, every rule says so rather than reporting a
    # verdict it did not measure.
    assert set(report.unevaluable_rules) == {r["id"] for r in engine._rules}, (
        report.unevaluable_rules
    )


# ── what the probe records about a real track ───────────────────────────────

def test_the_report_separates_measured_from_never_looked(engine, track_features):
    report = engine.evaluate_all(FeatureSet(file_name="track.wav", features=track_features))
    # DYN_001 short-circuits before reaching compression_density on this track,
    # so the per-track list is the two whose first feature is the missing one.
    assert set(report.unevaluable_rules) == {"DYN_002", "SPEC_004"}, report.unevaluable_rules
    for result in report.results:
        if result.rule_id in {"DYN_002", "SPEC_004"}:
            assert not result.evaluable and result.missing_features and not result.triggered
        if result.rule_id == "TRANS_003":
            # Measured, not defaulted — the value is in the report.
            assert result.evaluable and "envelope_range_normalized" in result.feature_values


def test_feature_values_holds_what_the_rule_read_not_a_guess(engine, track_features):
    report = engine.evaluate_all(FeatureSet(file_name="track.wav", features=track_features))
    text001 = next(r for r in report.results if r.rule_id == "TEXT_001")
    assert list(text001.feature_values) == ["spectral_flatness"]
    assert text001.feature_values["spectral_flatness"] == pytest.approx(
        track_features["spectral_flatness"]
    )


# ── and the one feature that was on the wrong scale ─────────────────────────

def test_spectral_flux_is_on_the_scale_its_threshold_assumes(track_features):
    """`flux` summed over all ~1025 rfft bins and divided by the mean of ONE
    bin carried a factor of n_bins: 448.33 measured on this very fixture,
    against TRANS_001's `> 0.4` and its 0.25 default.  The flux half of that
    rule was true for every input.
    """
    value = track_features["spectral_flux_normalized_mean"]
    assert value is not None
    assert 0.0 <= value < 2.0, f"spectral_flux_normalized_mean={value} is not a normalized ratio"


def test_trans_001_flux_term_is_not_always_true(engine, track_features):
    report = engine.evaluate_all(FeatureSet(file_name="track.wav", features=track_features))
    trans001 = next(r for r in report.results if r.rule_id == "TRANS_001")
    assert trans001.evaluable
    assert trans001.feature_values["spectral_flux_normalized_mean"] < 0.4, (
        "the flux threshold is meant to separate tracks, not pass all of them"
    )
