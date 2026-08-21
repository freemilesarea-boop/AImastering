"""
Canonical Feature Extractor for Audio Profile Engine.

Extracts all features required by the Audio Profile Engine from audio files.
This is a test-only module that does NOT connect to the production mastering pipeline.

Features extracted:
- Loudness: integrated_lufs, true_peak_dbtp, loudness_range_lu
- Peak: sample_peak_dbfs, peak_headroom_db, clipping_sample_count
- Dynamic: crest_factor_db, rms_dbfs, dynamic_range_db
- Band ratios: 20-60Hz, 60-120Hz, 120-250Hz, 250-500Hz, 500-1000Hz, 1-2kHz, 2-4kHz, 4-6kHz, 6-8kHz, 8-10kHz, 10-12kHz, 12-16kHz
- Spectral: centroid, flatness, contrast (per band), rolloff
- Stereo: correlation, width, ms_ratio_db, lr_balance_db, mono_compatibility
- Transient: spectral_flux, onset_density, envelope features
- Texture: spectral_flatness, spectral_contrast_mean

Phase: AI-MASTERING-CANONICAL-FEATURE-COVERAGE-P0-1
"""

from __future__ import annotations

import math
import os
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional, Tuple

from app.utils.logger import log

try:
    import numpy as np
    import soundfile as sf
    HAS_SF = True
except ImportError:
    HAS_SF = False
    log("WARN", "soundfile/numpy not installed — feature extraction unavailable")

try:
    from scipy import signal
    from scipy.ndimage import uniform_filter1d
    HAS_SCIPY = True
except ImportError:
    HAS_SCIPY = False
    log("WARN", "scipy not installed — some features unavailable")


class FeatureStatus(Enum):
    """Feature extraction status."""
    AVAILABLE = "AVAILABLE"
    MISSING_SOURCE = "MISSING_SOURCE"
    UNSUPPORTED = "UNSUPPORTED"
    MEASUREMENT_FAILED = "MEASUREMENT_FAILED"
    INVALID_VALUE = "INVALID_VALUE"


@dataclass
class FeatureResult:
    """Result of a single feature extraction."""
    feature: str
    status: FeatureStatus
    value: Optional[float]
    unit: str
    method: str
    error: Optional[str] = None


@dataclass
class CanonicalFeatures:
    """Complete set of canonical features for a track."""
    file_path: str
    file_name: str
    # Rate of the source file. Describes the input, not the measurement.
    sample_rate: int
    channels: int
    duration_sec: float

    # Rate the analysis actually ran at, and whether reaching it required the
    # resampler. Kept separate from sample_rate so a consumer can tell a
    # natively-canonical file from a resampled one.
    analysis_sample_rate: Optional[int] = None
    analysis_resampled: Optional[bool] = None

    # Loudness (from FFmpeg ebur128)
    integrated_lufs: Optional[float] = None
    true_peak_dbtp: Optional[float] = None
    loudness_range_lu: Optional[float] = None
    momentary_loudness_max_lufs: Optional[float] = None
    short_term_loudness_max_lufs: Optional[float] = None

    # Peak/RMS
    sample_peak_dbfs: Optional[float] = None
    rms_dbfs: Optional[float] = None
    peak_headroom_db: Optional[float] = None
    clipping_sample_count: int = 0
    clipping_ratio: float = 0.0

    # Dynamic range
    crest_factor_db: Optional[float] = None
    dynamic_range_db: Optional[float] = None

    # Spectral features
    spectral_centroid: Optional[float] = None
    spectral_rolloff: Optional[float] = None
    spectral_flatness: Optional[float] = None
    spectral_flatness_temporal_std: Optional[float] = None
    hf_ratio: Optional[float] = None

    # Band ratios (energy relative to total)
    band_ratios: Dict[str, float] = field(default_factory=dict)

    # Spectral contrast per band
    spectral_contrast: Dict[str, float] = field(default_factory=dict)

    # Stereo features
    stereo_correlation: Optional[float] = None
    stereo_width: Optional[float] = None
    ms_ratio_db: Optional[float] = None
    lr_balance_db: Optional[float] = None
    side_energy_ratio: Optional[float] = None
    mono_compatibility_score: Optional[float] = None

    # Transient features
    spectral_flux_normalized_mean: Optional[float] = None
    spectral_flux_normalized_std: Optional[float] = None
    onset_density: Optional[float] = None
    envelope_range_normalized: Optional[float] = None
    envelope_std_normalized: Optional[float] = None

    # Feature extraction status
    feature_status: Dict[str, FeatureResult] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON output."""
        result = {
            "file": self.file_name,
            "sample_rate": self.sample_rate,
            "analysis_sample_rate": self.analysis_sample_rate,
            "analysis_resampled": self.analysis_resampled,
            "channels": self.channels,
            "duration_sec": round(self.duration_sec, 3),

            # Loudness
            "input_i": self.integrated_lufs,
            "input_tp": self.true_peak_dbtp,
            "input_lra": self.loudness_range_lu,
            "momentary_max_lufs": self.momentary_loudness_max_lufs,
            "short_term_max_lufs": self.short_term_loudness_max_lufs,

            # Peak/RMS
            "sample_peak_dbfs": self.sample_peak_dbfs,
            "peak_db": self.sample_peak_dbfs,  # Alias for profile engine
            "rms_dbfs": self.rms_dbfs,
            "rms_db": self.rms_dbfs,  # Alias for profile engine
            "peak_headroom_db": self.peak_headroom_db,
            "clipping_sample_count": self.clipping_sample_count,
            "clipping_ratio": self.clipping_ratio,

            # Dynamic range
            "crest_factor_db": self.crest_factor_db,
            "dynamic_range_db": self.dynamic_range_db,

            # Spectral
            "spectral_centroid": self.spectral_centroid,
            "spectral_rolloff": self.spectral_rolloff,
            "spectral_flatness": self.spectral_flatness,
            "spectral_flatness_temporal_std": self.spectral_flatness_temporal_std,
            "hf_ratio": self.hf_ratio,

            # Band ratios (flattened for profile engine)
            "band_ratios": self.band_ratios,
        }

        # Add individual band ratio keys for profile engine compatibility
        for band, ratio in self.band_ratios.items():
            result[f"band_ratio_{band}"] = ratio

        # Spectral contrast
        result["spectral_contrast"] = self.spectral_contrast
        for band, contrast in self.spectral_contrast.items():
            result[f"spectral_contrast_{band}"] = contrast

        # Stereo
        result["stereo_correlation"] = self.stereo_correlation
        result["stereo_width"] = self.stereo_width
        result["ms_ratio_db"] = self.ms_ratio_db
        result["lr_balance_db"] = self.lr_balance_db
        result["side_energy_ratio"] = self.side_energy_ratio
        result["mono_compatibility_score"] = self.mono_compatibility_score

        # Transient
        result["spectral_flux_normalized_mean"] = self.spectral_flux_normalized_mean
        result["spectral_flux_normalized_std"] = self.spectral_flux_normalized_std
        result["onset_density"] = self.onset_density
        result["envelope_range_normalized"] = self.envelope_range_normalized
        result["envelope_std_normalized"] = self.envelope_std_normalized

        return result


# Canonical parameters
CANONICAL_PARAMS = {
    "n_fft": 4096,
    "hop_length": 1024,
    "epsilon": 1e-12,
}

# ── Canonical analysis conditions ────────────────────────────────────────────
#
# Every spectral feature here is a statistic over FFT bins that run up to
# Nyquist, so its value depends on the sample rate it was measured at:
# spectral_flatness is a geometric mean over all bins, hf_ratio and the band
# ratios divide by total power to Nyquist, and n_fft is fixed in samples so the
# bin width itself moves with the rate. Measuring a 44.1 kHz reference and a
# 48 kHz input natively therefore produces numbers that cannot be compared, and
# scaling n_fft with the rate does not fix it — the bin sets still end at
# different frequencies.
#
# So analysis is pinned to one rate. This is an analysis-only decision: the DSP,
# render and output sample rates are untouched, and loudness/true-peak/LRA keep
# coming from ffmpeg against the original file path.
CANONICAL_ANALYSIS_SR = 44100

# Version of the whole preprocessing contract (rate, decoder, resampler,
# dither, trim). Recorded in evidence so a target set and a runtime measurement
# can be checked for having been produced under the same rules.
PREPROCESSING_POLICY_VERSION = "1.0.0"

# No trim and no silence removal. Stated as constants because "we do not do it"
# is a policy that has to be recorded, not an absence: introducing a trim later
# would move spectral_flux, onset_density, flatness_temporal_std and
# crest_factor, and its threshold would be a new unvalidated parameter.
CANONICAL_TRIM_POLICY = "none"
CANONICAL_SILENCE_POLICY = "none"

# Band definitions for frequency analysis
BAND_DEFINITIONS = {
    "20-60Hz": (20, 60),
    "60-120Hz": (60, 120),
    "120-250Hz": (120, 250),
    "250-500Hz": (250, 500),
    "500-1000Hz": (500, 1000),
    "1-2kHz": (1000, 2000),
    "2-4kHz": (2000, 4000),
    "4-6kHz": (4000, 6000),
    "6-8kHz": (6000, 8000),
    "8-10kHz": (8000, 10000),
    "10-12kHz": (10000, 12000),
    "12-16kHz": (12000, 16000),
}

# Spectral contrast bands
CONTRAST_BANDS = {
    "band_0": (0, 250),
    "band_1": (250, 500),
    "band_2": (500, 1000),
    "band_3": (1000, 2000),
    "band_4": (2000, 4000),
    "band_5": (4000, 8000),
    "band_6": (8000, 16000),
}


def _db(linear: float, epsilon: float = 1e-12) -> float:
    """Convert linear to dB."""
    return 20.0 * math.log10(max(abs(linear), epsilon))


def _safe_divide(a: float, b: float, default: float = 0.0) -> float:
    """Safe division with default."""
    if b == 0 or math.isnan(b) or math.isinf(b):
        return default
    result = a / b
    if math.isnan(result) or math.isinf(result):
        return default
    return result


def _validate_value(value: float) -> Optional[float]:
    """Validate that a value is finite."""
    if value is None or math.isnan(value) or math.isinf(value):
        return None
    return round(value, 6)


def _as_positive_float(value: Any) -> Optional[float]:
    """Coerce a probe field to a positive float, or None when unusable."""
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    if result != result or result <= 0.0:  # NaN or non-positive
        return None
    return result


def _load_canonical_signal(file_path: str) -> tuple["np.ndarray", int, int, bool]:
    """Decode ``file_path`` under the canonical analysis conditions.

    Returns ``(data, analysis_sr, source_sr, resampled)`` where ``data`` is
    ``(samples, channels)`` float32 with nominal full scale +/-1.0.

    One decoder for every input. Splitting it — libsndfile for the 44.1 kHz
    reference, ffmpeg for everything else — would leave the reference and the
    runtime measured through different code, which is the same class of
    asymmetry as measuring them at different rates.

    Raises rather than returning partial data: see the fail-closed note in
    ``extract``.
    """
    from app.utils.ffmpeg_wrapper import (
        CanonicalProvenanceError,
        decode_canonical_pcm_f32le,
        ffprobe_info,
        resolve_canonical_ffmpeg,
    )

    binary = resolve_canonical_ffmpeg()

    info = ffprobe_info(file_path)
    audio_streams = [
        s for s in (info.get("streams") or []) if s.get("codec_type") == "audio"
    ]
    if not audio_streams:
        raise CanonicalProvenanceError(f"no audio stream in {file_path}")
    stream = audio_streams[0]

    try:
        source_sr = int(stream.get("sample_rate") or 0)
        channels = int(stream.get("channels") or 0)
    except (TypeError, ValueError) as exc:
        raise CanonicalProvenanceError(f"unreadable stream metadata: {exc}")

    if source_sr <= 0:
        raise CanonicalProvenanceError(f"invalid source sample rate: {source_sr}")
    if channels <= 0:
        raise CanonicalProvenanceError(f"invalid channel count: {channels}")

    # Only attach the resampler when the rate actually differs. At 44.1 kHz the
    # filter is absent from the graph entirely rather than present as a no-op.
    resampled = source_sr != CANONICAL_ANALYSIS_SR
    raw = decode_canonical_pcm_f32le(
        file_path,
        channels=channels,
        binary=binary,
        target_sr=CANONICAL_ANALYSIS_SR if resampled else None,
    )

    data = np.frombuffer(raw, dtype="<f4").reshape(-1, channels)
    if data.shape[0] <= 0:
        raise CanonicalProvenanceError(f"canonical decode yielded no frames: {file_path}")
    if data.shape[1] != channels:
        raise CanonicalProvenanceError(
            f"channel count changed during decode: expected {channels}, "
            f"got {data.shape[1]}"
        )

    analysis_sr = CANONICAL_ANALYSIS_SR

    # The decode is raw f32le, which carries no header to state its rate, so the
    # rate is checked indirectly: the frame count has to agree with the duration
    # ffprobe reported for the source. A resampler that silently produced some
    # other rate would show up here as the wrong number of frames. The tolerance
    # is loose because container durations are approximate; it is sized to catch
    # a wrong rate (a 8.8% error between 44.1 and 48 kHz), not to police rounding.
    probed_duration = _as_positive_float((info.get("format") or {}).get("duration"))
    if probed_duration is None:
        probed_duration = _as_positive_float(stream.get("duration"))
    if probed_duration is not None:
        decoded_duration = data.shape[0] / analysis_sr
        if abs(decoded_duration - probed_duration) > max(0.5, probed_duration * 0.02):
            raise CanonicalProvenanceError(
                f"decoded length {decoded_duration:.3f}s at {analysis_sr} Hz does not "
                f"match the probed duration {probed_duration:.3f}s — the analysis rate "
                f"is not {CANONICAL_ANALYSIS_SR} Hz"
            )

    # np.frombuffer returns a read-only view of the pipe bytes; downstream
    # extractors only read, but copy so no consumer can be surprised by it.
    return np.array(data, dtype="float32"), analysis_sr, source_sr, resampled


class CanonicalFeatureExtractor:
    """
    Extracts canonical features from audio files.

    Uses:
    - FFmpeg ebur128 for loudness (via existing loudnorm_pass1)
    - the bundled FFmpeg for canonical decode/resample, then numpy for analysis
    - scipy for transient detection (optional)
    """

    def __init__(self):
        self.params = CANONICAL_PARAMS.copy()

    def extract(self, file_path: str) -> CanonicalFeatures:
        """
        Extract all canonical features from an audio file.

        Args:
            file_path: Path to audio file

        Returns:
            CanonicalFeatures with all extracted features
        """
        if not os.path.exists(file_path):
            raise FileNotFoundError(f"Audio file not found: {file_path}")

        features = CanonicalFeatures(
            file_path=file_path,
            file_name=os.path.basename(file_path),
            sample_rate=0,
            channels=0,
            duration_sec=0.0,
        )

        # Load audio data
        if not HAS_SF:
            features.feature_status["_load"] = FeatureResult(
                feature="_load",
                status=FeatureStatus.UNSUPPORTED,
                value=None,
                unit="",
                method="soundfile",
                error="soundfile not installed",
            )
            return features

        # Fail closed. A canonical load that cannot be completed under the
        # canonical conditions must not degrade into a measurement taken under
        # different ones — features measured at the source rate would compare
        # against the targets as if they were commensurate, which is the failure
        # this contract exists to prevent. Callers that must survive (RC) already
        # catch and fall back to the stable path.
        data, sr, source_sr, resampled = _load_canonical_signal(file_path)
        features.analysis_sample_rate = sr
        features.analysis_resampled = resampled
        features.feature_status["_load"] = FeatureResult(
            feature="_load",
            status=FeatureStatus.AVAILABLE,
            value=float(sr),
            unit="Hz",
            method="ffmpeg_f32le",
        )

        n_samples, n_channels = data.shape
        # sample_rate stays the SOURCE rate: it describes the file, and callers
        # and existing tests read it that way. The rate the analysis actually ran
        # at is analysis_sample_rate.
        features.sample_rate = source_sr
        features.channels = n_channels
        features.duration_sec = n_samples / sr

        # Extract features in groups
        self._extract_loudness(features, file_path)
        self._extract_peak_rms(features, data, sr)
        self._extract_spectral(features, data, sr)
        self._extract_band_ratios(features, data, sr)
        self._extract_spectral_contrast(features, data, sr)
        self._extract_stereo(features, data, sr)
        self._extract_transients(features, data, sr)

        return features

    def _extract_loudness(self, features: CanonicalFeatures, file_path: str) -> None:
        """Extract loudness features using FFmpeg ebur128."""
        try:
            from app.utils.ffmpeg_wrapper import loudnorm_pass1

            pass1 = loudnorm_pass1(file_path)
            features.integrated_lufs = _validate_value(float(pass1.get("input_i", -99.0)))
            features.true_peak_dbtp = _validate_value(float(pass1.get("input_tp", 0.0)))
            features.loudness_range_lu = _validate_value(float(pass1.get("input_lra", 0.0)))
            features.short_term_loudness_max_lufs = _validate_value(float(pass1.get("input_thresh", -33.0)))

            features.feature_status["loudness"] = FeatureResult(
                feature="loudness",
                status=FeatureStatus.AVAILABLE,
                value=features.integrated_lufs,
                unit="LUFS",
                method="ffmpeg_ebur128",
            )
        except Exception as e:
            log("WARN", f"Loudness extraction failed: {e}")
            features.feature_status["loudness"] = FeatureResult(
                feature="loudness",
                status=FeatureStatus.MEASUREMENT_FAILED,
                value=None,
                unit="LUFS",
                method="ffmpeg_ebur128",
                error=str(e),
            )

    def _extract_peak_rms(
        self, features: CanonicalFeatures, data: "np.ndarray", sr: int
    ) -> None:
        """Extract peak and RMS features."""
        try:
            mono = np.mean(data, axis=1) if data.ndim == 2 else data

            # Peak
            peak_linear = float(np.max(np.abs(data)))
            features.sample_peak_dbfs = _validate_value(_db(peak_linear))

            # Peak headroom (distance from 0 dBFS)
            if features.sample_peak_dbfs is not None:
                features.peak_headroom_db = _validate_value(-features.sample_peak_dbfs)

            # RMS
            rms_linear = float(np.sqrt(np.mean(mono ** 2)))
            features.rms_dbfs = _validate_value(_db(rms_linear))

            # Crest factor
            if peak_linear > 0 and rms_linear > 0:
                features.crest_factor_db = _validate_value(
                    20.0 * math.log10(peak_linear / rms_linear)
                )

            # Dynamic range (simplified: peak - RMS)
            if features.sample_peak_dbfs is not None and features.rms_dbfs is not None:
                features.dynamic_range_db = _validate_value(
                    features.sample_peak_dbfs - features.rms_dbfs
                )

            # Clipping detection (samples >= 0.9999)
            clip_threshold = 0.9999
            clip_count = int(np.sum(np.abs(data) >= clip_threshold))
            features.clipping_sample_count = clip_count
            features.clipping_ratio = _safe_divide(
                clip_count, data.size, 0.0
            )

            features.feature_status["peak_rms"] = FeatureResult(
                feature="peak_rms",
                status=FeatureStatus.AVAILABLE,
                value=features.sample_peak_dbfs,
                unit="dBFS",
                method="numpy",
            )
        except Exception as e:
            log("WARN", f"Peak/RMS extraction failed: {e}")
            features.feature_status["peak_rms"] = FeatureResult(
                feature="peak_rms",
                status=FeatureStatus.MEASUREMENT_FAILED,
                value=None,
                unit="dBFS",
                method="numpy",
                error=str(e),
            )

    def _extract_spectral(
        self, features: CanonicalFeatures, data: "np.ndarray", sr: int
    ) -> None:
        """Extract spectral features using FFT."""
        try:
            mono = np.mean(data, axis=1) if data.ndim == 2 else data
            n_fft = self.params["n_fft"]
            hop = self.params["hop_length"]
            eps = self.params["epsilon"]

            # Compute spectrogram
            n_frames = 1 + (len(mono) - n_fft) // hop
            if n_frames <= 0:
                return

            specs = []
            for i in range(n_frames):
                frame = mono[i * hop: i * hop + n_fft]
                if len(frame) < n_fft:
                    frame = np.pad(frame, (0, n_fft - len(frame)))
                windowed = frame * np.hanning(n_fft)
                spec = np.abs(np.fft.rfft(windowed))
                specs.append(spec)

            spectrogram = np.array(specs)  # (n_frames, n_bins)
            freqs = np.fft.rfftfreq(n_fft, 1.0 / sr)

            # Spectral centroid (mean across frames)
            power = spectrogram ** 2
            weighted_freqs = np.sum(power * freqs, axis=1)
            total_power = np.sum(power, axis=1) + eps
            centroids = weighted_freqs / total_power
            features.spectral_centroid = _validate_value(float(np.mean(centroids)))

            # Spectral rolloff (95% energy point)
            cumsum_power = np.cumsum(power, axis=1)
            total_power_per_frame = np.sum(power, axis=1, keepdims=True) + eps
            rolloff_threshold = 0.95 * total_power_per_frame
            rolloff_indices = np.argmax(cumsum_power >= rolloff_threshold, axis=1)
            rolloff_freqs = freqs[rolloff_indices]
            features.spectral_rolloff = _validate_value(float(np.mean(rolloff_freqs)))

            # Spectral flatness (geometric mean / arithmetic mean)
            log_spec = np.log(spectrogram + eps)
            geo_mean = np.exp(np.mean(log_spec, axis=1))
            arith_mean = np.mean(spectrogram, axis=1) + eps
            flatness_per_frame = geo_mean / arith_mean
            features.spectral_flatness = _validate_value(float(np.mean(flatness_per_frame)))
            features.spectral_flatness_temporal_std = _validate_value(float(np.std(flatness_per_frame)))

            # HF ratio (energy above 8kHz / total energy)
            hf_mask = freqs >= 8000
            hf_energy = np.sum(power[:, hf_mask])
            total_energy = np.sum(power) + eps
            features.hf_ratio = _validate_value(float(hf_energy / total_energy))

            features.feature_status["spectral"] = FeatureResult(
                feature="spectral",
                status=FeatureStatus.AVAILABLE,
                value=features.spectral_centroid,
                unit="Hz",
                method="numpy_fft",
            )
        except Exception as e:
            log("WARN", f"Spectral extraction failed: {e}")
            features.feature_status["spectral"] = FeatureResult(
                feature="spectral",
                status=FeatureStatus.MEASUREMENT_FAILED,
                value=None,
                unit="Hz",
                method="numpy_fft",
                error=str(e),
            )

    def _extract_band_ratios(
        self, features: CanonicalFeatures, data: "np.ndarray", sr: int
    ) -> None:
        """Extract energy ratios for frequency bands."""
        try:
            mono = np.mean(data, axis=1) if data.ndim == 2 else data
            n_fft = self.params["n_fft"]
            eps = self.params["epsilon"]

            # Compute full spectrum
            spec = np.abs(np.fft.rfft(mono * np.hanning(len(mono)), n=len(mono)))
            freqs = np.fft.rfftfreq(len(mono), 1.0 / sr)
            power = spec ** 2
            total_power = np.sum(power) + eps

            for band_name, (f_low, f_high) in BAND_DEFINITIONS.items():
                # Cap high frequency at Nyquist
                f_high = min(f_high, sr / 2 - 1)
                if f_low >= sr / 2:
                    features.band_ratios[band_name] = None
                    continue

                mask = (freqs >= f_low) & (freqs < f_high)
                band_power = np.sum(power[mask])
                ratio = float(band_power / total_power)
                features.band_ratios[band_name] = _validate_value(ratio)

            features.feature_status["band_ratios"] = FeatureResult(
                feature="band_ratios",
                status=FeatureStatus.AVAILABLE,
                value=len(features.band_ratios),
                unit="ratio",
                method="numpy_fft",
            )
        except Exception as e:
            log("WARN", f"Band ratio extraction failed: {e}")
            features.feature_status["band_ratios"] = FeatureResult(
                feature="band_ratios",
                status=FeatureStatus.MEASUREMENT_FAILED,
                value=None,
                unit="ratio",
                method="numpy_fft",
                error=str(e),
            )

    def _extract_spectral_contrast(
        self, features: CanonicalFeatures, data: "np.ndarray", sr: int
    ) -> None:
        """Extract spectral contrast per band."""
        try:
            mono = np.mean(data, axis=1) if data.ndim == 2 else data
            n_fft = self.params["n_fft"]
            hop = self.params["hop_length"]
            eps = self.params["epsilon"]

            # Compute spectrogram
            n_frames = 1 + (len(mono) - n_fft) // hop
            if n_frames <= 0:
                return

            specs = []
            for i in range(n_frames):
                frame = mono[i * hop: i * hop + n_fft]
                if len(frame) < n_fft:
                    frame = np.pad(frame, (0, n_fft - len(frame)))
                windowed = frame * np.hanning(n_fft)
                spec = np.abs(np.fft.rfft(windowed))
                specs.append(spec)

            spectrogram = np.array(specs)  # (n_frames, n_bins)
            freqs = np.fft.rfftfreq(n_fft, 1.0 / sr)

            # Compute contrast for each band
            contrasts = []
            for band_name, (f_low, f_high) in CONTRAST_BANDS.items():
                f_high = min(f_high, sr / 2 - 1)
                if f_low >= sr / 2:
                    features.spectral_contrast[band_name] = None
                    continue

                mask = (freqs >= f_low) & (freqs < f_high)
                band_specs = spectrogram[:, mask]

                if band_specs.size == 0:
                    features.spectral_contrast[band_name] = None
                    continue

                # Contrast: ratio of peak to valley energy (in dB)
                peaks = np.percentile(band_specs, 95, axis=1) + eps
                valleys = np.percentile(band_specs, 5, axis=1) + eps
                with np.errstate(divide='ignore', invalid='ignore'):
                    contrast_per_frame = 20 * np.log10(peaks / valleys)
                    contrast_per_frame = np.nan_to_num(contrast_per_frame, nan=0.0, posinf=60.0, neginf=-60.0)
                mean_contrast = float(np.mean(contrast_per_frame))
                features.spectral_contrast[band_name] = _validate_value(mean_contrast)
                contrasts.append(mean_contrast)

            # Overall mean contrast
            if contrasts:
                features.spectral_contrast["mean"] = _validate_value(float(np.mean(contrasts)))

            features.feature_status["spectral_contrast"] = FeatureResult(
                feature="spectral_contrast",
                status=FeatureStatus.AVAILABLE,
                value=features.spectral_contrast.get("mean"),
                unit="dB",
                method="numpy_fft",
            )
        except Exception as e:
            log("WARN", f"Spectral contrast extraction failed: {e}")
            features.feature_status["spectral_contrast"] = FeatureResult(
                feature="spectral_contrast",
                status=FeatureStatus.MEASUREMENT_FAILED,
                value=None,
                unit="dB",
                method="numpy_fft",
                error=str(e),
            )

    def _extract_stereo(
        self, features: CanonicalFeatures, data: "np.ndarray", sr: int
    ) -> None:
        """Extract stereo features."""
        try:
            if data.ndim < 2 or data.shape[1] < 2:
                # Mono file
                features.stereo_correlation = None
                features.stereo_width = 0.0
                features.ms_ratio_db = None
                features.lr_balance_db = 0.0
                features.side_energy_ratio = 0.0
                features.mono_compatibility_score = 1.0
                features.feature_status["stereo"] = FeatureResult(
                    feature="stereo",
                    status=FeatureStatus.AVAILABLE,
                    value=features.stereo_correlation,
                    unit="correlation",
                    method="numpy",
                )
                return

            left = data[:, 0]
            right = data[:, 1]
            eps = self.params["epsilon"]

            # Stereo correlation (Pearson)
            corr_matrix = np.corrcoef(left, right)
            features.stereo_correlation = _validate_value(float(corr_matrix[0, 1]))

            # M/S calculation
            mid = (left + right) / 2
            side = (left - right) / 2

            # MS ratio (dB)
            mid_rms = float(np.sqrt(np.mean(mid ** 2))) + eps
            side_rms = float(np.sqrt(np.mean(side ** 2))) + eps
            features.ms_ratio_db = _validate_value(20 * math.log10(mid_rms / side_rms))

            # Stereo width (0 = mono, 1 = full stereo)
            # Approximation: side_rms / mid_rms normalized
            features.stereo_width = _validate_value(min(1.0, side_rms / mid_rms))

            # Side energy ratio
            total_energy = float(np.sum(left ** 2) + np.sum(right ** 2)) + eps
            side_energy = float(np.sum(side ** 2))
            features.side_energy_ratio = _validate_value(side_energy / total_energy)

            # L/R balance
            left_rms = float(np.sqrt(np.mean(left ** 2))) + eps
            right_rms = float(np.sqrt(np.mean(right ** 2))) + eps
            features.lr_balance_db = _validate_value(20 * math.log10(left_rms / right_rms))

            # Mono compatibility score
            # 1.0 = perfect mono compatibility, 0 = severe phase issues
            # Based on correlation: (corr + 1) / 2
            if features.stereo_correlation is not None:
                features.mono_compatibility_score = _validate_value(
                    (features.stereo_correlation + 1) / 2
                )
            else:
                features.mono_compatibility_score = 1.0

            features.feature_status["stereo"] = FeatureResult(
                feature="stereo",
                status=FeatureStatus.AVAILABLE,
                value=features.stereo_correlation,
                unit="correlation",
                method="numpy",
            )
        except Exception as e:
            log("WARN", f"Stereo extraction failed: {e}")
            features.feature_status["stereo"] = FeatureResult(
                feature="stereo",
                status=FeatureStatus.MEASUREMENT_FAILED,
                value=None,
                unit="correlation",
                method="numpy",
                error=str(e),
            )

    def _extract_transients(
        self, features: CanonicalFeatures, data: "np.ndarray", sr: int
    ) -> None:
        """Extract transient features using spectral flux and envelope analysis."""
        try:
            mono = np.mean(data, axis=1) if data.ndim == 2 else data
            n_fft = self.params["n_fft"]
            hop = self.params["hop_length"]
            eps = self.params["epsilon"]

            # Compute spectrogram
            n_frames = 1 + (len(mono) - n_fft) // hop
            if n_frames <= 1:
                return

            specs = []
            for i in range(n_frames):
                frame = mono[i * hop: i * hop + n_fft]
                if len(frame) < n_fft:
                    frame = np.pad(frame, (0, n_fft - len(frame)))
                windowed = frame * np.hanning(n_fft)
                spec = np.abs(np.fft.rfft(windowed))
                specs.append(spec)

            spectrogram = np.array(specs)  # (n_frames, n_bins)

            # Spectral flux (frame-to-frame difference)
            spec_diff = np.diff(spectrogram, axis=0)
            # Half-wave rectified (positive changes only = onset detection)
            spec_diff_hw = np.maximum(0, spec_diff)
            flux = np.sum(spec_diff_hw, axis=1)

            # Normalize by mean magnitude
            mean_mag = np.mean(spectrogram) + eps
            flux_normalized = flux / mean_mag

            features.spectral_flux_normalized_mean = _validate_value(float(np.mean(flux_normalized)))
            features.spectral_flux_normalized_std = _validate_value(float(np.std(flux_normalized)))

            # Onset density (peaks in flux per second)
            # Simple peak picking: local maxima above mean + std
            flux_threshold = np.mean(flux_normalized) + np.std(flux_normalized)
            peaks = []
            for i in range(1, len(flux_normalized) - 1):
                if (flux_normalized[i] > flux_threshold and
                    flux_normalized[i] > flux_normalized[i - 1] and
                    flux_normalized[i] > flux_normalized[i - 1]):
                    peaks.append(i)

            duration_sec = features.duration_sec or 1.0
            features.onset_density = _validate_value(len(peaks) / duration_sec)

            # Envelope analysis
            # Compute RMS envelope with 50ms window
            window_samples = int(0.05 * sr)
            if window_samples > 0 and len(mono) > window_samples:
                if HAS_SCIPY:
                    envelope = uniform_filter1d(np.abs(mono), window_samples)
                else:
                    # Fallback: simple moving average
                    envelope = np.convolve(np.abs(mono), np.ones(window_samples) / window_samples, mode='same')

                env_max = float(np.max(envelope))
                env_min = float(np.min(envelope))
                env_mean = float(np.mean(envelope)) + eps
                env_std = float(np.std(envelope))

                features.envelope_range_normalized = _validate_value((env_max - env_min) / env_mean)
                features.envelope_std_normalized = _validate_value(env_std / env_mean)

            features.feature_status["transients"] = FeatureResult(
                feature="transients",
                status=FeatureStatus.AVAILABLE,
                value=features.spectral_flux_normalized_mean,
                unit="normalized",
                method="numpy_fft",
            )
        except Exception as e:
            log("WARN", f"Transient extraction failed: {e}")
            features.feature_status["transients"] = FeatureResult(
                feature="transients",
                status=FeatureStatus.MEASUREMENT_FAILED,
                value=None,
                unit="normalized",
                method="numpy_fft",
                error=str(e),
            )


def extract_canonical_features(file_path: str) -> CanonicalFeatures:
    """
    Extract all canonical features from an audio file.

    Args:
        file_path: Path to audio file

    Returns:
        CanonicalFeatures object with all extracted features
    """
    extractor = CanonicalFeatureExtractor()
    return extractor.extract(file_path)
