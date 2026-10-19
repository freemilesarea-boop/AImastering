"""The envelope and onset features the Decision Engine reads.

`canonical_features.py` said it was "a test-only module that does NOT connect
to the production mastering pipeline".  It is not: `master` reaches it through
`apply_precorrection` in `rc_engine.py`, which the mastering page's
"Stable / RC" toggle turns on, and `closed_loop/engine.py` imports it at
module level.  Nothing here had a test, so two defects sat in one function:

  · the envelope was a zero-padded `np.convolve(..., mode='same')`, so the
    first and last half-window averaged real samples against nothing.  For any
    file that does not begin and end quiet the minimum came from the padding —
    a steady tone measured 0.5021 instead of 0.0014 — and
    `envelope_range_normalized` described the window length, not the music.
    `conflict_engine.TRANS_003` ("Already limited envelope range", severity
    BLOCK) tests that value against 0.2, which is the range a limited master
    sits in, so the rule could not fire and transient enhancement went through
    on exactly the material it was written to protect.

  · the onset peak picker compared `[i - 1]` twice, so it counted every rising
    sample above the threshold rather than the local maxima.
"""
from __future__ import annotations

import subprocess

import numpy as np
import pytest

from app.analyzers.canonical_features import (
    _moving_average,
    count_onset_peaks,
    extract_canonical_features,
)
from app.mastering.audio_profiles.conflict_engine import ConflictEngine


# ── the filter itself ────────────────────────────────────────────────────────

def _definition(values: np.ndarray, size: int) -> np.ndarray:
    """The thing being computed, written out slowly, as an oracle."""
    pad_left = size // 2
    pad_right = size - 1 - pad_left
    padded = np.pad(values, (pad_left, pad_right), mode="reflect")
    return np.array([padded[i:i + size].mean() for i in range(len(values))])


@pytest.mark.parametrize("length,size", [(40, 7), (41, 8), (100, 25), (257, 64)])
def test_moving_average_is_the_filter_it_claims_to_be(length, size):
    rng = np.random.default_rng(3)
    values = rng.standard_normal(length)
    got = _moving_average(values, size)
    assert got.shape == values.shape
    assert np.max(np.abs(got - _definition(values, size))) < 1e-12


def test_a_constant_signal_has_a_constant_envelope():
    """The regression, in one line.

    Zero padding made the ends of a constant array read about half, which is
    where `envelope_range_normalized` got its 0.5 from.
    """
    values = np.full(4096, 0.19)
    envelope = _moving_average(values, 1103)      # 25 ms at 44.1 kHz
    assert np.max(envelope) - np.min(envelope) < 1e-9, (
        f"range {np.max(envelope) - np.min(envelope)} — the edges are not flat"
    )


def test_a_real_dip_is_still_a_dip():
    """And the fix must not flatten a signal that genuinely varies."""
    values = np.concatenate([np.full(8192, 0.4), np.full(8192, 0.02), np.full(8192, 0.4)])
    envelope = _moving_average(values, 1103)
    assert np.min(envelope) < 0.05
    assert np.max(envelope) > 0.35


# ── the onset counter ────────────────────────────────────────────────────────

def test_only_local_maxima_count_as_onsets():
    # 1.0 and 2.0 are above the threshold and rising, but neither is a peak.
    flux = np.array([0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 2.0, 3.0, 0.0, 0.0, 0.0, 0.0])
    assert float(np.mean(flux) + np.std(flux)) < 2.0, "the fixture must put 2.0 above threshold"
    assert count_onset_peaks(flux) == 1


def test_a_flux_curve_too_short_to_have_an_interior_has_no_onsets():
    assert count_onset_peaks(np.array([1.0, 2.0])) == 0
    assert count_onset_peaks(np.array([])) == 0


# ── and what the Decision Engine then does with it ──────────────────────────

@pytest.fixture(scope="module")
def steady_level_wav(ffmpeg_available, tmp_path_factory):
    """A file whose envelope really is flat — the case the padding broke."""
    if not ffmpeg_available:
        pytest.skip("ffmpeg not available")
    import os
    out = str(tmp_path_factory.mktemp("steady") / "steady.wav")
    subprocess.run(
        [os.environ.get("AIMASTER_FFMPEG", "ffmpeg"), "-y", "-f", "lavfi",
         "-i", "sine=frequency=440:duration=5:sample_rate=44100", "-ac", "2", out],
        capture_output=True, check=True,
    )
    return out


def test_a_steady_file_measures_inside_the_rule_that_protects_it(steady_level_wav):
    features = extract_canonical_features(steady_level_wav).to_dict()
    value = features["envelope_range_normalized"]
    assert value is not None, features.get("feature_status")
    # TRANS_003's threshold.  Measured through the real path: 0.0014 with the
    # reflected edges, 0.50 with the zero-padded ones.
    assert value < 0.2, f"envelope_range_normalized={value} — TRANS_003 cannot fire"


def test_trans_003_blocks_transient_enhancement_on_a_limited_envelope(steady_level_wav):
    features = extract_canonical_features(steady_level_wav).to_dict()
    report = ConflictEngine().evaluate_all(features)
    trans003 = next(r for r in report.results if r.rule_id == "TRANS_003")
    assert trans003.triggered, (
        f"the BLOCK rule did not fire for envelope_range_normalized="
        f"{features['envelope_range_normalized']} (rule: {trans003.condition})"
    )
    # And the block it exists to apply actually reaches the caller.
    assert "transient_enhancement" in report.blocked_actions, report.blocked_actions
    assert "attack_boost" in report.blocked_actions, report.blocked_actions
