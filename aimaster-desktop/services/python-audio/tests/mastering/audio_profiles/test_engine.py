"""
Unit tests for Audio Profile Engine P0.

Tests cover:
- Profile evaluation with DATA_DERIVED thresholds
- UNCALIBRATED state for non-data-derived thresholds
- INSUFFICIENT_DATA state for missing features
- Confidence calculation with ceilings
- Conflict detection
- Eligibility resolution
- TEXTURE profile MONITOR_ONLY
- Reproducibility
- Schema validation
"""

import pytest
import sys
from pathlib import Path

# Add parent to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent))

from app.mastering.audio_profiles import (
    AudioProfileEngine,
    ProfileState,
    Severity,
    DSPEligibility,
    ThresholdSource,
    ConfidenceGrade,
)
from app.mastering.audio_profiles.threshold_registry import get_registry


class TestThresholdRegistry:
    """Tests for threshold registry."""

    def test_registry_has_data_derived_thresholds(self):
        """Registry should have DATA_DERIVED thresholds."""
        registry = get_registry()
        # DYNAMIC_RANGE should have data-derived thresholds
        assert registry.has_data_derived_thresholds("DYNAMIC_RANGE")
        assert registry.has_data_derived_thresholds("BRIGHTNESS")
        assert registry.has_data_derived_thresholds("STEREO_IMAGE")

    def test_registry_crest_factor_values(self):
        """Crest factor thresholds from commercial data."""
        registry = get_registry()
        median = registry.get_value("DYNAMIC_RANGE", "crest_factor_commercial_median")
        assert median == pytest.approx(10.87, rel=0.01)

    def test_registry_is_data_derived(self):
        """Test data_based flag is correctly set."""
        registry = get_registry()
        entry = registry.get("BRIGHTNESS", "centroid_commercial_median")
        assert entry is not None
        assert entry.data_based is True
        assert entry.source == ThresholdSource.DATA_DERIVED

    def test_registry_loudness_is_not_data_derived(self):
        """LOUDNESS thresholds are not data-derived."""
        registry = get_registry()
        assert not registry.has_data_derived_thresholds("LOUDNESS")


class TestProfileEvaluator:
    """Tests for profile evaluation."""

    def setup_method(self):
        self.engine = AudioProfileEngine(validate_schema=True)

    def test_brightness_dark_state(self):
        """Low spectral centroid -> DARK state."""
        features = {
            "spectral_centroid": 2500.0,  # Below P25 (2683)
            "hf_ratio": 0.05,
        }
        result = self.engine.evaluate_track(features, "test.wav")
        brightness_result = result.profile_results.get("BRIGHTNESS")
        assert brightness_result is not None
        assert brightness_result.state == ProfileState.DARK

    def test_brightness_bright_state(self):
        """High spectral centroid -> BRIGHT state."""
        features = {
            "spectral_centroid": 3800.0,  # Above P75 (3482)
            "hf_ratio": 0.15,
        }
        result = self.engine.evaluate_track(features, "test.wav")
        brightness_result = result.profile_results.get("BRIGHTNESS")
        assert brightness_result is not None
        assert brightness_result.state == ProfileState.BRIGHT

    def test_brightness_balanced_state(self):
        """Mid spectral centroid -> BALANCED state."""
        features = {
            "spectral_centroid": 3100.0,  # Between P25 and P75
            "hf_ratio": 0.10,
        }
        result = self.engine.evaluate_track(features, "test.wav")
        brightness_result = result.profile_results.get("BRIGHTNESS")
        assert brightness_result is not None
        assert brightness_result.state == ProfileState.BALANCED

    def test_insufficient_data_when_primary_missing(self):
        """Missing primary features -> INSUFFICIENT_DATA."""
        features = {
            "hf_ratio": 0.10,  # Supporting only, no spectral_centroid
        }
        result = self.engine.evaluate_track(features, "test.wav")
        brightness_result = result.profile_results.get("BRIGHTNESS")
        assert brightness_result is not None
        assert brightness_result.state == ProfileState.INSUFFICIENT_DATA

    def test_uncalibrated_for_profiles_without_data(self):
        """Profiles without DATA_DERIVED thresholds -> UNCALIBRATED."""
        features = {
            "input_i": -14.0,
            "rms_db": -18.0,
            "peak_db": -3.0,
        }
        result = self.engine.evaluate_track(features, "test.wav")
        loudness_result = result.profile_results.get("LOUDNESS")
        assert loudness_result is not None
        # LOUDNESS has no DATA_DERIVED thresholds, should be UNCALIBRATED
        assert loudness_result.state == ProfileState.UNCALIBRATED


class TestTexture:
    """Tests for TEXTURE profile special handling."""

    def setup_method(self):
        self.engine = AudioProfileEngine(validate_schema=True)

    def test_texture_always_monitor_only(self):
        """TEXTURE profile should always be MONITOR_ONLY."""
        features = {
            "spectral_centroid": 3000.0,
            "spectral_flatness_temporal_std": 0.12,
        }
        result = self.engine.evaluate_track(features, "test.wav")
        texture_eligibility = result.eligibility_results.get("TEXTURE")
        assert texture_eligibility is not None
        assert texture_eligibility.eligibility == DSPEligibility.MONITOR_ONLY

    def test_texture_no_allowed_actions(self):
        """TEXTURE should have no allowed DSP actions."""
        features = {"spectral_centroid": 3000.0}
        result = self.engine.evaluate_track(features, "test.wav")
        texture_eligibility = result.eligibility_results.get("TEXTURE")
        assert texture_eligibility.allowed_actions == []


class TestConfidence:
    """Tests for confidence calculation."""

    def setup_method(self):
        self.engine = AudioProfileEngine(validate_schema=True)

    def test_data_derived_high_confidence(self):
        """DATA_DERIVED thresholds should allow high confidence."""
        features = {
            "spectral_centroid": 3100.0,
            "hf_ratio": 0.10,
        }
        result = self.engine.evaluate_track(features, "test.wav")
        brightness_confidence = result.confidence_results.get("BRIGHTNESS")
        assert brightness_confidence is not None
        # Should have high ceiling (0.95) for DATA_DERIVED
        assert brightness_confidence.confidence >= 0.8
        assert brightness_confidence.grade == ConfidenceGrade.HIGH

    def test_uncalibrated_low_confidence(self):
        """UNCALIBRATED profiles should have low confidence ceiling."""
        features = {
            "input_i": -14.0,
            "rms_db": -18.0,
        }
        result = self.engine.evaluate_track(features, "test.wav")
        loudness_confidence = result.confidence_results.get("LOUDNESS")
        assert loudness_confidence is not None
        # UNCALIBRATED ceiling is 0.39
        assert loudness_confidence.confidence <= 0.39


class TestConflictEngine:
    """Tests for conflict detection."""

    def setup_method(self):
        self.engine = AudioProfileEngine(validate_schema=True)

    def test_24_conflict_rules(self):
        """Should have 24 conflict rules."""
        assert len(self.engine.conflict_engine._rules) == 24

    def test_conflict_severity_distribution(self):
        """Check conflict severity distribution."""
        rules = self.engine.conflict_engine._rules
        block_count = sum(1 for r in rules if r["severity"].value == "BLOCK")
        conditional_count = sum(1 for r in rules if r["severity"].value == "CONDITIONAL")
        warn_count = sum(1 for r in rules if r["severity"].value == "WARN")

        assert block_count == 5
        assert conditional_count == 7
        assert warn_count == 12


class TestGlobalReadiness:
    """Tests for global readiness assessment."""

    def setup_method(self):
        self.engine = AudioProfileEngine(validate_schema=True)

    def test_ready_state(self):
        """Track with good features should be READY."""
        features = {
            "spectral_centroid": 3100.0,
            "hf_ratio": 0.10,
            "stereo_correlation": 0.85,
        }
        result = self.engine.evaluate_track(features, "test.wav")
        assert result.global_readiness.readiness == "READY"


class TestSchemaValidation:
    """Tests for output schema validation."""

    def setup_method(self):
        self.engine = AudioProfileEngine(validate_schema=True)

    def test_output_has_required_fields(self):
        """Output should have all required fields."""
        features = {"spectral_centroid": 3100.0}
        result = self.engine.evaluate_track(features, "test.wav")

        assert "metadata" in result.output
        assert "features" in result.output
        assert "profiles" in result.output
        assert "dsp_plan" in result.output
        assert "global_readiness" in result.output

    def test_schema_valid(self):
        """Output should pass schema validation."""
        features = {"spectral_centroid": 3100.0}
        result = self.engine.evaluate_track(features, "test.wav")
        assert result.schema_valid is True
        assert result.schema_errors == []

    def test_profiles_have_required_fields(self):
        """Each profile in output should have required fields."""
        features = {"spectral_centroid": 3100.0}
        result = self.engine.evaluate_track(features, "test.wav")

        for profile in result.output["profiles"]:
            assert "id" in profile
            assert "eligibility" in profile
            assert "confidence" in profile
            assert "state" in profile


class TestReproducibility:
    """Tests for reproducibility."""

    def setup_method(self):
        self.engine = AudioProfileEngine(validate_schema=True)

    def test_deterministic_output(self):
        """Same input should produce same output (excluding timestamp)."""
        features = {
            "spectral_centroid": 3100.0,
            "hf_ratio": 0.10,
        }

        result1 = self.engine.evaluate_track(features, "test.wav")
        result2 = self.engine.evaluate_track(features, "test.wav")

        # Compare profiles (excluding timestamp)
        assert len(result1.output["profiles"]) == len(result2.output["profiles"])

        for p1, p2 in zip(result1.output["profiles"], result2.output["profiles"]):
            assert p1["id"] == p2["id"]
            assert p1["state"] == p2["state"]
            assert p1["eligibility"] == p2["eligibility"]
            assert p1["confidence"] == p2["confidence"]


class TestEligibility:
    """Tests for eligibility resolution."""

    def setup_method(self):
        self.engine = AudioProfileEngine(validate_schema=True)

    def test_eligible_when_high_confidence(self):
        """High confidence + no conflicts -> ELIGIBLE."""
        features = {
            "spectral_centroid": 3100.0,
            "hf_ratio": 0.10,
        }
        result = self.engine.evaluate_track(features, "test.wav")
        brightness_eligibility = result.eligibility_results.get("BRIGHTNESS")
        assert brightness_eligibility.eligibility == DSPEligibility.ELIGIBLE

    def test_blocked_when_insufficient_data(self):
        """INSUFFICIENT_DATA -> BLOCKED."""
        features = {"hf_ratio": 0.10}  # Missing primary feature
        result = self.engine.evaluate_track(features, "test.wav")
        brightness_eligibility = result.eligibility_results.get("BRIGHTNESS")
        assert brightness_eligibility.eligibility == DSPEligibility.BLOCKED

    def test_monitor_only_when_uncalibrated(self):
        """UNCALIBRATED -> MONITOR_ONLY."""
        features = {
            "input_i": -14.0,
            "rms_db": -18.0,
        }
        result = self.engine.evaluate_track(features, "test.wav")
        loudness_eligibility = result.eligibility_results.get("LOUDNESS")
        assert loudness_eligibility.eligibility == DSPEligibility.MONITOR_ONLY


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
