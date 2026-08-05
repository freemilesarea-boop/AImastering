"""
Unit tests for Canonical Feature Extractor.

Tests cover:
- Loudness feature extraction
- Peak/RMS feature extraction
- Spectral feature extraction
- Band ratio calculation
- Stereo feature extraction
- Transient feature extraction
- Error handling
- Reproducibility
"""

import pytest
import sys
import math
import tempfile
from pathlib import Path

# Add parent to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

try:
    import numpy as np
    import soundfile as sf
    HAS_SF = True
except ImportError:
    HAS_SF = False

from app.analyzers.canonical_features import (
    CanonicalFeatureExtractor,
    CanonicalFeatures,
    FeatureStatus,
    BAND_DEFINITIONS,
    CONTRAST_BANDS,
)


@pytest.fixture
def extractor():
    """Create feature extractor instance."""
    return CanonicalFeatureExtractor()


@pytest.fixture
def test_audio_stereo(tmp_path):
    """Create a stereo test audio file."""
    if not HAS_SF:
        pytest.skip("soundfile not available")

    sr = 48000
    duration = 2.0  # seconds
    n_samples = int(sr * duration)

    # Generate stereo signal with some correlation
    t = np.linspace(0, duration, n_samples)
    left = 0.5 * np.sin(2 * np.pi * 440 * t) + 0.1 * np.random.randn(n_samples)
    right = 0.5 * np.sin(2 * np.pi * 440 * t) + 0.1 * np.random.randn(n_samples)

    data = np.stack([left, right], axis=1).astype(np.float32)
    file_path = tmp_path / "test_stereo.wav"
    sf.write(str(file_path), data, sr)
    return str(file_path)


@pytest.fixture
def test_audio_mono(tmp_path):
    """Create a mono test audio file."""
    if not HAS_SF:
        pytest.skip("soundfile not available")

    sr = 48000
    duration = 2.0
    n_samples = int(sr * duration)

    t = np.linspace(0, duration, n_samples)
    mono = 0.5 * np.sin(2 * np.pi * 440 * t)

    file_path = tmp_path / "test_mono.wav"
    sf.write(str(file_path), mono.astype(np.float32), sr)
    return str(file_path)


@pytest.fixture
def test_audio_silent(tmp_path):
    """Create a silent audio file."""
    if not HAS_SF:
        pytest.skip("soundfile not available")

    sr = 48000
    duration = 1.0
    n_samples = int(sr * duration)

    data = np.zeros((n_samples, 2), dtype=np.float32)
    file_path = tmp_path / "test_silent.wav"
    sf.write(str(file_path), data, sr)
    return str(file_path)


class TestFeatureExtraction:
    """Tests for feature extraction."""

    @pytest.mark.skipif(not HAS_SF, reason="soundfile not available")
    def test_extract_returns_features(self, extractor, test_audio_stereo):
        """Extract should return CanonicalFeatures object."""
        features = extractor.extract(test_audio_stereo)
        assert isinstance(features, CanonicalFeatures)
        assert features.file_name == "test_stereo.wav"
        assert features.sample_rate == 48000
        assert features.channels == 2

    @pytest.mark.skipif(not HAS_SF, reason="soundfile not available")
    def test_peak_rms_extracted(self, extractor, test_audio_stereo):
        """Peak and RMS should be extracted."""
        features = extractor.extract(test_audio_stereo)
        assert features.sample_peak_dbfs is not None
        assert features.rms_dbfs is not None
        assert features.crest_factor_db is not None
        assert features.sample_peak_dbfs < 0  # Should be negative dBFS
        assert features.rms_dbfs < 0

    @pytest.mark.skipif(not HAS_SF, reason="soundfile not available")
    def test_spectral_features_extracted(self, extractor, test_audio_stereo):
        """Spectral features should be extracted."""
        features = extractor.extract(test_audio_stereo)
        assert features.spectral_centroid is not None
        assert features.spectral_rolloff is not None
        assert features.spectral_flatness is not None
        assert features.spectral_centroid > 0  # Hz

    @pytest.mark.skipif(not HAS_SF, reason="soundfile not available")
    def test_band_ratios_extracted(self, extractor, test_audio_stereo):
        """Band ratios should be extracted for all defined bands."""
        features = extractor.extract(test_audio_stereo)
        assert len(features.band_ratios) > 0

        # Check at least some bands are present
        for band_name in ["250-500Hz", "500-1000Hz", "1-2kHz", "2-4kHz"]:
            assert band_name in features.band_ratios
            ratio = features.band_ratios[band_name]
            if ratio is not None:
                assert 0 <= ratio <= 1

    @pytest.mark.skipif(not HAS_SF, reason="soundfile not available")
    def test_stereo_features_extracted(self, extractor, test_audio_stereo):
        """Stereo features should be extracted."""
        features = extractor.extract(test_audio_stereo)
        assert features.stereo_correlation is not None
        assert features.stereo_width is not None
        assert features.ms_ratio_db is not None
        assert -1 <= features.stereo_correlation <= 1

    @pytest.mark.skipif(not HAS_SF, reason="soundfile not available")
    def test_transient_features_extracted(self, extractor, test_audio_stereo):
        """Transient features should be extracted."""
        features = extractor.extract(test_audio_stereo)
        assert features.spectral_flux_normalized_mean is not None
        assert features.onset_density is not None
        assert features.onset_density >= 0


class TestMonoHandling:
    """Tests for mono file handling."""

    @pytest.mark.skipif(not HAS_SF, reason="soundfile not available")
    def test_mono_file_extraction(self, extractor, test_audio_mono):
        """Mono files should be handled correctly."""
        features = extractor.extract(test_audio_mono)
        assert features.channels == 1

        # Stereo features should be handled gracefully
        assert features.stereo_width == 0.0
        assert features.mono_compatibility_score == 1.0

    @pytest.mark.skipif(not HAS_SF, reason="soundfile not available")
    def test_mono_peak_rms(self, extractor, test_audio_mono):
        """Peak/RMS should work for mono files."""
        features = extractor.extract(test_audio_mono)
        assert features.sample_peak_dbfs is not None
        assert features.rms_dbfs is not None


class TestErrorHandling:
    """Tests for error handling."""

    def test_nonexistent_file(self, extractor):
        """Should raise FileNotFoundError for missing files."""
        with pytest.raises(FileNotFoundError):
            extractor.extract("/nonexistent/path/audio.wav")

    @pytest.mark.skipif(not HAS_SF, reason="soundfile not available")
    def test_no_nan_or_inf(self, extractor, test_audio_stereo):
        """No feature should be NaN or Infinity."""
        features = extractor.extract(test_audio_stereo)
        feature_dict = features.to_dict()

        for key, value in feature_dict.items():
            if isinstance(value, float):
                assert not math.isnan(value), f"{key} is NaN"
                assert not math.isinf(value), f"{key} is Infinity"
            elif isinstance(value, dict):
                for k, v in value.items():
                    if isinstance(v, float):
                        assert not math.isnan(v), f"{key}.{k} is NaN"
                        assert not math.isinf(v), f"{key}.{k} is Infinity"


class TestReproducibility:
    """Tests for reproducibility."""

    @pytest.mark.skipif(not HAS_SF, reason="soundfile not available")
    def test_same_file_same_results(self, extractor, test_audio_stereo):
        """Same file should produce same results."""
        features1 = extractor.extract(test_audio_stereo)
        features2 = extractor.extract(test_audio_stereo)

        # Compare key values
        assert features1.sample_peak_dbfs == features2.sample_peak_dbfs
        assert features1.rms_dbfs == features2.rms_dbfs
        assert features1.spectral_centroid == features2.spectral_centroid
        assert features1.stereo_correlation == features2.stereo_correlation


class TestToDict:
    """Tests for dictionary conversion."""

    @pytest.mark.skipif(not HAS_SF, reason="soundfile not available")
    def test_to_dict_contains_required_keys(self, extractor, test_audio_stereo):
        """to_dict should contain all required keys for profile engine."""
        features = extractor.extract(test_audio_stereo)
        feature_dict = features.to_dict()

        # Check required keys for profile engine
        required_keys = [
            "input_i", "input_tp", "input_lra",  # Loudness
            "peak_db", "rms_db", "crest_factor_db",  # Peak/RMS
            "spectral_centroid", "spectral_flatness",  # Spectral
            "stereo_correlation", "stereo_width",  # Stereo
            "band_ratios", "spectral_contrast",  # Bands
        ]

        for key in required_keys:
            assert key in feature_dict, f"Missing key: {key}"

    @pytest.mark.skipif(not HAS_SF, reason="soundfile not available")
    def test_band_ratio_keys_flattened(self, extractor, test_audio_stereo):
        """Band ratios should be flattened with band_ratio_ prefix."""
        features = extractor.extract(test_audio_stereo)
        feature_dict = features.to_dict()

        # Check for flattened band ratio keys
        assert "band_ratio_250-500Hz" in feature_dict
        assert "band_ratio_1-2kHz" in feature_dict


class TestClipping:
    """Tests for clipping detection."""

    @pytest.mark.skipif(not HAS_SF, reason="soundfile not available")
    def test_no_clipping_detected(self, extractor, test_audio_stereo):
        """Normal audio should not be clipping."""
        features = extractor.extract(test_audio_stereo)
        # Test signal is normalized, shouldn't clip
        assert features.clipping_sample_count == 0
        assert features.clipping_ratio == 0.0

    @pytest.mark.skipif(not HAS_SF, reason="soundfile not available")
    def test_clipping_with_loud_signal(self, extractor, tmp_path):
        """Clipping signal should be detected."""
        sr = 48000
        n_samples = sr * 1
        # Create clipping signal
        signal = np.ones((n_samples, 2), dtype=np.float32)
        file_path = tmp_path / "clipping.wav"
        sf.write(str(file_path), signal, sr)

        features = extractor.extract(str(file_path))
        assert features.clipping_sample_count > 0


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
