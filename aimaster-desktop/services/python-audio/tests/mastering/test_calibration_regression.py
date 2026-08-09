"""Calibration regression tracking — R1 / R2 / R3.

These exist because ``MappingCalibrator`` reported ``regression_rate = 0.0`` as a
hardcoded literal with a ``# TODO`` beside it, while ``REGRESSION_RATE_MAX`` was
defined and never consulted. Promotion had no regression axis: a mapping could be
promoted no matter what it did to features it was not aiming at.

Fixtures are synthetic and in-memory. No audio is rendered and no calibration
artifact is read - the real P1 output does not currently exist on disk, and the
regression maths is pure, so it can be driven directly.
"""
from __future__ import annotations

import pytest

from app.mastering.calibration.constants import (
    COLLATERAL_FEATURES,
    MappingSourceCandidate,
    REGRESSION_RATE_MAX,
)
from app.mastering.calibration.mapping_calibrator import MappingCalibrator
from app.mastering.calibration.regression import (
    ISP_OVERSHOOT_TOLERANCE_DB,
    R2_CLIPPING,
    R2_ISP,
    R2_MONO,
    R2_TRUE_PEAK,
    CandidateRegression,
    aggregate_rule_regression,
    detect_collateral_regression,
    detect_overcorrection,
    detect_safety_regression,
    evaluate_candidate_regression,
    feature_in_normal_range,
    find_target,
    rule_regression_for_candidates,
    sweep_profile_for_parameter,
)
from app.mastering.calibration.schema import (
    CandidateResult,
    FeatureResponse,
    ResponseCurve,
    ResponseCurvePoint,
    SweepCandidate,
)
from app.mastering.calibration.constants import CalibrationStatus


# ── fixtures ─────────────────────────────────────────────────────────────────

# BRIGHTNESS collateral features are input_tp and stereo_correlation.
# Targets: input_tp p25=-1.5 p75=-0.5 ; stereo_correlation p25=0.71 p75=0.90
SAFE_FEATURES = {
    "input_tp": -1.2,
    "sample_peak_dbfs": -1.5,
    "clipping_sample_count": 0,
    "mono_compatibility_score": 0.9,
    "stereo_correlation": 0.80,
    "spectral_centroid": 3100.0,
}


def features(**overrides):
    merged = dict(SAFE_FEATURES)
    merged.update(overrides)
    return merged


def make_candidate(
    parameter="high_shelf_gain_db",
    processor="EQ",
    before=None,
    after=None,
    primary_responses=(),
    candidate_id="C1",
):
    return CandidateResult(
        candidate=SweepCandidate(
            candidate_id=candidate_id,
            track_name="t.wav",
            track_path="/tmp/t.wav",
            processor=processor,
            parameter=parameter,
            value=1.0,
            unit="dB",
        ),
        status=CalibrationStatus.PASSED,
        render_success=True,
        safety_passed=True,
        before_features=before if before is not None else features(),
        after_features=after if after is not None else features(),
        primary_responses=list(primary_responses),
    )


def response(feature="spectral_centroid", before=2000.0, after=3147.0, median=3147.0):
    return FeatureResponse(
        feature=feature,
        before_value=before,
        after_value=after,
        delta=after - before,
        response_per_unit=0.0,
        target_median=median,
    )


# ── sanity: the fixture really is inside the normal ranges ───────────────────

def test_fixture_baseline_is_clean():
    """If the baseline were already regressed, every test below would be vacuous."""
    assert feature_in_normal_range("input_tp", SAFE_FEATURES["input_tp"]) is True
    assert feature_in_normal_range("stereo_correlation", SAFE_FEATURES["stereo_correlation"]) is True
    result = evaluate_candidate_regression(make_candidate())
    assert result.r1_regressed == 0
    assert result.r2_violations == ()
    assert result.r3_overcorrected is False


def test_collateral_features_for_brightness_are_what_we_think():
    assert COLLATERAL_FEATURES["BRIGHTNESS"] == ["input_tp", "stereo_correlation"]


def test_sweep_parameter_resolves_to_its_profile():
    assert sweep_profile_for_parameter("high_shelf_gain_db") == "BRIGHTNESS"
    assert sweep_profile_for_parameter("bell_gain_db_warmth") == "WARMTH"
    assert sweep_profile_for_parameter("bell_gain_db_presence") == "PRESENCE"
    assert sweep_profile_for_parameter("nope") is None


# ══ DEFECT INJECTION A — collateral normal -> abnormal detected by R1 ════════

def test_injection_a_collateral_regression_detected():
    """stereo_correlation 0.80 (in P25-P75) -> 0.40 (below P25)."""
    result = evaluate_candidate_regression(make_candidate(
        after=features(stereo_correlation=0.40),
    ))
    assert result.r1_monitored == 2
    assert result.r1_regressed == 1
    assert result.r1_rate == pytest.approx(0.5)
    regressed = [d for d in result.r1_details if d.regressed]
    assert [d.feature for d in regressed] == ["stereo_correlation"]


def test_r1_ignores_a_feature_that_was_already_abnormal():
    """We did not put it out of range, so it is not our regression."""
    result = evaluate_candidate_regression(make_candidate(
        before=features(stereo_correlation=0.40),
        after=features(stereo_correlation=0.35),
    ))
    assert result.r1_regressed == 0


def test_r1_does_not_count_a_feature_moving_back_into_range():
    result = evaluate_candidate_regression(make_candidate(
        before=features(stereo_correlation=0.40),
        after=features(stereo_correlation=0.80),
    ))
    assert result.r1_regressed == 0


def test_r1_skips_features_without_a_target():
    """mono_compatibility_score has no commercial target: unjudgeable, not clean."""
    assert find_target("mono_compatibility_score") is None
    assert feature_in_normal_range("mono_compatibility_score", 0.9) is None


def test_r1_rate_is_zero_when_nothing_is_monitored():
    result = evaluate_candidate_regression(make_candidate(before={}, after={}))
    assert result.r1_monitored == 0
    assert result.r1_rate == 0.0


def test_detect_collateral_regression_is_directly_callable():
    monitored = detect_collateral_regression(
        "BRIGHTNESS", features(), features(input_tp=0.5)
    )
    assert [m.feature for m in monitored] == ["input_tp", "stereo_correlation"]
    assert monitored[0].regressed is True


# ══ DEFECT INJECTION B — true peak safety violation detected by R2 ═══════════

def test_injection_b_true_peak_violation_detected():
    """-1.2 dBTP (under the -1.0 ceiling) -> -0.3 dBTP (over it)."""
    violations = detect_safety_regression(
        features(), features(input_tp=-0.3, sample_peak_dbfs=-0.6)
    )
    assert R2_TRUE_PEAK in violations


def test_injection_b_is_a_hard_failure_not_a_rate():
    result = evaluate_candidate_regression(make_candidate(
        after=features(input_tp=-0.3, sample_peak_dbfs=-0.6),
    ))
    assert result.r2_violated is True
    assert isinstance(result.r2_violations, tuple)


def test_r2_clipping_introduced():
    violations = detect_safety_regression(features(), features(clipping_sample_count=12))
    assert R2_CLIPPING in violations


def test_r2_ignores_clipping_that_was_already_there():
    violations = detect_safety_regression(
        features(clipping_sample_count=5), features(clipping_sample_count=9)
    )
    assert R2_CLIPPING not in violations


def test_r2_ignores_true_peak_already_over_the_ceiling():
    violations = detect_safety_regression(
        features(input_tp=-0.5), features(input_tp=-0.4, sample_peak_dbfs=-0.7)
    )
    assert R2_TRUE_PEAK not in violations


def test_r2_mono_compatibility_lost():
    violations = detect_safety_regression(features(), features(mono_compatibility_score=0.2))
    assert R2_MONO in violations


def test_r2_isp_overshoot_worsened():
    """Inter-sample peak rises above the sample peak by more than the tolerance."""
    before = features(input_tp=-1.2, sample_peak_dbfs=-1.5)          # overshoot 0.3
    after = features(input_tp=-1.05, sample_peak_dbfs=-1.9)           # overshoot 0.85
    assert R2_ISP in detect_safety_regression(before, after)


def test_r2_isp_not_triggered_by_plain_gain_change():
    """A uniform level change moves both peaks equally - not an ISP regression."""
    before = features(input_tp=-3.0, sample_peak_dbfs=-3.3)
    after = features(input_tp=-2.0, sample_peak_dbfs=-2.3)
    assert R2_ISP not in detect_safety_regression(before, after)


def test_r2_isp_drift_within_tolerance_is_not_a_violation():
    """Overshoot grows by half the tolerance - measurement noise, not a defect."""
    before = features(input_tp=-2.0, sample_peak_dbfs=-2.3)
    after = features(
        input_tp=-2.0,
        sample_peak_dbfs=-2.3 - (ISP_OVERSHOOT_TOLERANCE_DB / 2),
    )
    assert R2_ISP not in detect_safety_regression(before, after)


def test_r2_isp_drift_beyond_tolerance_is_a_violation():
    before = features(input_tp=-2.0, sample_peak_dbfs=-2.3)
    after = features(
        input_tp=-2.0,
        sample_peak_dbfs=-2.3 - (ISP_OVERSHOOT_TOLERANCE_DB * 3),
    )
    assert R2_ISP in detect_safety_regression(before, after)


def test_r2_reports_every_violation_not_just_the_first():
    violations = detect_safety_regression(features(), features(
        input_tp=-0.2, sample_peak_dbfs=-0.6,
        clipping_sample_count=40,
        mono_compatibility_score=0.1,
    ))
    assert R2_CLIPPING in violations
    assert R2_TRUE_PEAK in violations
    assert R2_MONO in violations


# ══ DEFECT INJECTION C — overcorrection detected by R3 ═══════════════════════

def test_injection_c_overcorrection_detected():
    """2000 Hz (1147 below median) -> 4500 Hz (1353 above): crossed and worse."""
    check = detect_overcorrection("spectral_centroid", 2000.0, 4500.0, 3147.0)
    assert check.crossed_target is True
    assert check.further_away is True
    assert check.overcorrected is True


def test_injection_c_via_candidate():
    result = evaluate_candidate_regression(make_candidate(
        primary_responses=[response(before=2000.0, after=4500.0)],
    ))
    assert result.r3_overcorrected is True


def test_r3_crossing_the_target_but_landing_closer_is_not_a_regression():
    """Overshooting slightly while still improving is success, not regression."""
    check = detect_overcorrection("spectral_centroid", 2000.0, 3300.0, 3147.0)
    assert check.crossed_target is True
    assert check.further_away is False
    assert check.overcorrected is False


def test_r3_undershoot_is_not_a_regression():
    check = detect_overcorrection("spectral_centroid", 2000.0, 2800.0, 3147.0)
    assert check.crossed_target is False
    assert check.overcorrected is False


def test_r3_moving_further_away_without_crossing_is_not_r3():
    """Getting worse on the same side is a direction-correctness failure,
    which is a separate axis that already exists."""
    check = detect_overcorrection("spectral_centroid", 3000.0, 2000.0, 3147.0)
    assert check.crossed_target is False
    assert check.overcorrected is False


def test_r3_is_unmeasurable_without_a_target_median():
    assert detect_overcorrection("f", 1.0, 2.0, None) is None
    assert detect_overcorrection("f", None, 2.0, 3.0) is None


def test_r3_unmeasurable_candidate_is_not_counted_as_clean():
    result = evaluate_candidate_regression(make_candidate(
        primary_responses=[response(median=None)],
    ))
    assert result.r3_details == ()
    assert result.r3_overcorrected is False


# ══ DEFECT INJECTION D — a clean improvement is not a regression ═════════════

def test_injection_d_clean_improvement_has_no_regression():
    result = evaluate_candidate_regression(make_candidate(
        before=features(spectral_centroid=2000.0),
        after=features(spectral_centroid=3100.0),
        primary_responses=[response(before=2000.0, after=3100.0)],
    ))
    assert result.r1_regressed == 0
    assert result.r1_rate == 0.0
    assert result.r2_violated is False
    assert result.r3_overcorrected is False

    rule = aggregate_rule_regression([result])
    assert rule.regression_rate == 0.0
    assert rule.r2_violation_count == 0


# ══ DEFECT INJECTION E — aggregation takes max(R1, R3) ═══════════════════════

def test_injection_e_regression_rate_is_the_max_of_r1_and_r3():
    r1_heavy = CandidateRegression(r1_monitored=2, r1_regressed=2)      # r1 = 1.0
    r3_only = CandidateRegression(r1_monitored=2, r3_overcorrected=True)  # r1 = 0.0
    rule = aggregate_rule_regression([r1_heavy, r3_only])

    assert rule.candidate_count == 2
    assert rule.r1_rate == pytest.approx(0.5)   # (1.0 + 0.0) / 2
    assert rule.r3_rate == pytest.approx(0.5)   # 1 of 2 overcorrected
    assert rule.regression_rate == pytest.approx(0.5)


def test_injection_e_max_picks_the_worse_axis():
    candidates = [
        CandidateRegression(r1_monitored=4, r1_regressed=1),               # r1 = 0.25
        CandidateRegression(r1_monitored=4, r1_regressed=1, r3_overcorrected=True),
        CandidateRegression(r1_monitored=4, r1_regressed=1, r3_overcorrected=True),
        CandidateRegression(r1_monitored=4, r1_regressed=1, r3_overcorrected=True),
    ]
    rule = aggregate_rule_regression(candidates)
    assert rule.r1_rate == pytest.approx(0.25)
    assert rule.r3_rate == pytest.approx(0.75)
    assert rule.regression_rate == pytest.approx(0.75)  # R3 dominates


def test_r2_violations_are_counted_never_averaged():
    candidates = [
        CandidateRegression(),
        CandidateRegression(),
        CandidateRegression(r2_violations=(R2_CLIPPING,)),
    ]
    rule = aggregate_rule_regression(candidates)
    assert rule.r2_violation_count == 1
    assert rule.regression_rate == 0.0  # unaffected by the safety axis


def test_empty_aggregation_reports_zero_candidates():
    rule = aggregate_rule_regression([])
    assert rule.candidate_count == 0
    assert rule.regression_rate == 0.0


def test_aggregation_is_deterministic():
    cands = [make_candidate(after=features(stereo_correlation=0.4)), make_candidate()]
    assert rule_regression_for_candidates(cands) == rule_regression_for_candidates(cands)


# ══ DEFECT INJECTION F — any R2 violation blocks promotion ═══════════════════

def _curve(processor="EQ", parameter="high_shelf_gain_db", profile="BRIGHTNESS"):
    """A curve strong enough to satisfy every pre-existing promotion condition."""
    return ResponseCurve(
        processor=processor,
        parameter=parameter,
        feature="spectral_centroid",
        profile=profile,
        unit="dB",
        points=[ResponseCurvePoint(
            value=1.0, sample_count=20, valid_count=20,
            direction_correct_rate=1.0, safety_pass_rate=1.0, overshoot_rate=0.0,
        )],
        total_samples=20,
        valid_samples=20,
        rejected_samples=0,
        overall_direction_correct_rate=1.0,
    )


def _calibrate(candidates):
    results = MappingCalibrator().calibrate_mappings([_curve()], candidates)
    return next(r for r in results if r.rule_id == "BRIGHT_001")


def test_promotion_possible_when_evidence_is_clean():
    """Guard against the gate being vacuously false: promotion must be reachable."""
    result = _calibrate([make_candidate(candidate_id=f"C{i}") for i in range(20)])
    assert result.source_candidate == MappingSourceCandidate.DATA_DERIVED_CANDIDATE
    assert result.regression_measured is True
    assert result.regression_rate == 0.0
    assert result.r2_violation_count == 0
    assert result.promotion_eligible is True


def test_injection_f_single_r2_violation_blocks_promotion():
    candidates = [make_candidate(candidate_id=f"C{i}") for i in range(19)]
    candidates.append(make_candidate(
        candidate_id="BAD",
        after=features(input_tp=-0.2, sample_peak_dbfs=-0.5),
    ))
    result = _calibrate(candidates)
    assert result.r2_violation_count == 1
    assert result.promotion_eligible is False


def test_regression_rate_above_max_blocks_promotion():
    """Every candidate regresses a collateral feature: R1 = 0.5 > 0.20 cap."""
    candidates = [
        make_candidate(candidate_id=f"C{i}", after=features(stereo_correlation=0.40))
        for i in range(20)
    ]
    result = _calibrate(candidates)
    assert result.regression_rate > REGRESSION_RATE_MAX
    assert result.promotion_eligible is False


def test_regression_rate_within_max_still_allows_promotion():
    clean = [make_candidate(candidate_id=f"C{i}") for i in range(18)]
    bad = [make_candidate(candidate_id=f"B{i}", after=features(stereo_correlation=0.40))
           for i in range(2)]
    result = _calibrate(clean + bad)
    assert result.regression_rate <= REGRESSION_RATE_MAX
    assert result.promotion_eligible is True


def test_unmeasured_regression_blocks_promotion():
    """The old default. No candidates means no regression evidence, so the rule
    must not be promotable even though every other condition passes."""
    result = _calibrate([])
    assert result.regression_measured is False
    assert result.regression_rate == 0.0
    assert result.promotion_eligible is False


def test_calibrate_mappings_without_candidates_is_backward_compatible():
    results = MappingCalibrator().calibrate_mappings([_curve()])
    assert results
    assert all(r.regression_measured is False for r in results)
    assert all(r.promotion_eligible is False for r in results)


def test_pre_existing_promotion_conditions_are_not_loosened():
    """Regression is added on top of the old conditions, never in place of them.

    Direction correctness of 0.5 fails DIRECTION_CORRECTNESS_MIN_DERIVED (0.80),
    so the rule must stay unpromotable even with spotless regression evidence.
    """
    weak = _curve()
    weak.overall_direction_correct_rate = 0.5
    weak.points[0].direction_correct_rate = 0.5
    results = MappingCalibrator().calibrate_mappings(
        [weak], [make_candidate(candidate_id=f"C{i}") for i in range(20)]
    )
    result = next(r for r in results if r.rule_id == "BRIGHT_001")
    assert result.source_candidate != MappingSourceCandidate.DATA_DERIVED_CANDIDATE
    assert result.promotion_eligible is False


def test_notes_distinguish_unmeasured_from_clean():
    unmeasured = _calibrate([])
    measured = _calibrate([make_candidate(candidate_id=f"C{i}") for i in range(20)])
    assert "regression=UNMEASURED" in unmeasured.notes
    assert "regression=0.0%" in measured.notes


def test_presence_candidates_are_not_credited_to_mid_clarity():
    """PRES_001/002 and MID_001 all declare parameter "bell_gain_db", while the
    sweep is named "bell_gain_db_presence". Matching candidates to rules on the
    parameter string would credit PRESENCE evidence to the MID_CLARITY rule, so
    the match goes through the sweep's declared profile instead."""
    curve = _curve(parameter="bell_gain_db", profile="PRESENCE")
    curve.feature = "spectral_contrast_band_4"
    candidates = [
        make_candidate(candidate_id=f"P{i}", parameter="bell_gain_db_presence")
        for i in range(20)
    ]
    results = MappingCalibrator().calibrate_mappings([curve], candidates)
    by_id = {r.rule_id: r for r in results}

    # Both rules match the curve (same processor:parameter key)...
    assert by_id["PRES_001"].valid_tracks == 20
    assert by_id["MID_001"].valid_tracks == 20
    # ...but only PRESENCE owns the regression evidence.
    assert by_id["PRES_001"].regression_measured is True
    assert by_id["MID_001"].regression_measured is False


def test_candidates_are_matched_by_profile_not_parameter_string():
    """The WARMTH sweep is "bell_gain_db_warmth" while WARM_001 calls its
    parameter "low_mid_gain_db" - two names for the same 350 Hz bell. Profile
    matching connects them; a string match never would."""
    curve = _curve(parameter="low_mid_gain_db", profile="WARMTH")
    curve.feature = "spectral_contrast_band_1"
    candidates = [
        make_candidate(candidate_id=f"W{i}", parameter="bell_gain_db_warmth")
        for i in range(20)
    ]
    results = MappingCalibrator().calibrate_mappings([curve], candidates)
    by_id = {r.rule_id: r for r in results}
    assert by_id["WARM_001"].regression_measured is True
