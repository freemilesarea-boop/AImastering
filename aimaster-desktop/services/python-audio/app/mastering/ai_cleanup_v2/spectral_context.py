"""
SpectralContext - Single STFT computation shared across all processing stages.

NumPy-only implementation. No scipy, librosa, or other dependencies.

Design:
- n_fft = 2048
- hop_length = 512 (75% overlap)
- Hann window with COLA normalization
- Center mode with reflection padding
- Perfect reconstruction guarantee when mask = 1.0
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Optional, Tuple

import numpy as np


# ============================================================================
# Constants
# ============================================================================

DEFAULT_N_FFT = 2048
DEFAULT_HOP_LENGTH = 512  # 75% overlap


# ============================================================================
# STFT / ISTFT Functions (NumPy only)
# ============================================================================

def _create_hann_window(n_fft: int) -> np.ndarray:
    """
    Create Hann window. Matches numpy.hanning().
    """
    return np.hanning(n_fft).astype(np.float64)


def _pad_center(audio: np.ndarray, n_fft: int) -> np.ndarray:
    """
    Pad audio with reflection at both ends for center mode STFT.
    This ensures the first frame is centered at sample 0.
    """
    pad_length = n_fft // 2
    if audio.ndim == 1:
        return np.pad(audio, pad_length, mode='reflect')
    else:
        # (samples, channels)
        return np.pad(audio, ((pad_length, pad_length), (0, 0)), mode='reflect')


def stft(
    audio: np.ndarray,
    n_fft: int = DEFAULT_N_FFT,
    hop_length: int = DEFAULT_HOP_LENGTH,
    window: Optional[np.ndarray] = None,
    center: bool = True,
) -> np.ndarray:
    """
    Short-Time Fourier Transform (NumPy only).

    Args:
        audio: Input audio, shape (samples,) for mono or (samples, channels) for stereo
        n_fft: FFT size
        hop_length: Hop between frames
        window: Analysis window (default: Hann)
        center: If True, pad audio so frames are centered

    Returns:
        Complex STFT array:
        - Mono: (n_freq, n_frames) where n_freq = n_fft // 2 + 1
        - Stereo: (channels, n_freq, n_frames)
    """
    if window is None:
        window = _create_hann_window(n_fft)

    # Ensure float64 for precision
    audio = np.asarray(audio, dtype=np.float64)

    # Handle mono vs stereo
    if audio.ndim == 1:
        return _stft_mono(audio, n_fft, hop_length, window, center)
    elif audio.ndim == 2:
        n_channels = audio.shape[1]
        results = []
        for ch in range(n_channels):
            ch_stft = _stft_mono(audio[:, ch], n_fft, hop_length, window, center)
            results.append(ch_stft)
        return np.stack(results, axis=0)
    else:
        raise ValueError(f"Expected 1D or 2D audio, got shape {audio.shape}")


def _stft_mono(
    audio: np.ndarray,
    n_fft: int,
    hop_length: int,
    window: np.ndarray,
    center: bool,
) -> np.ndarray:
    """
    STFT for mono audio.

    Returns: (n_freq, n_frames) complex array
    """
    if center:
        audio = _pad_center(audio, n_fft)

    # Calculate number of frames
    n_samples = len(audio)
    n_frames = 1 + (n_samples - n_fft) // hop_length

    if n_frames <= 0:
        raise ValueError(f"Audio too short: {len(audio)} samples for n_fft={n_fft}")

    n_freq = n_fft // 2 + 1
    result = np.zeros((n_freq, n_frames), dtype=np.complex128)

    for i in range(n_frames):
        start = i * hop_length
        frame = audio[start:start + n_fft] * window
        result[:, i] = np.fft.rfft(frame)

    return result


def istft(
    stft_matrix: np.ndarray,
    hop_length: int = DEFAULT_HOP_LENGTH,
    window: Optional[np.ndarray] = None,
    n_fft: Optional[int] = None,
    original_length: Optional[int] = None,
    center: bool = True,
) -> np.ndarray:
    """
    Inverse Short-Time Fourier Transform (NumPy only).

    Uses overlap-add with COLA normalization for perfect reconstruction.

    Args:
        stft_matrix: Complex STFT array
            - Mono: (n_freq, n_frames)
            - Stereo: (channels, n_freq, n_frames)
        hop_length: Hop between frames
        window: Synthesis window (default: Hann)
        n_fft: FFT size (inferred from stft_matrix if not provided)
        original_length: Target output length (for center mode trimming)
        center: If True, trim center padding

    Returns:
        Reconstructed audio:
        - Mono: (samples,)
        - Stereo: (samples, channels)
    """
    # Handle stereo
    if stft_matrix.ndim == 3:
        n_channels = stft_matrix.shape[0]
        results = []
        for ch in range(n_channels):
            ch_audio = _istft_mono(
                stft_matrix[ch], hop_length, window, n_fft, original_length, center
            )
            results.append(ch_audio)
        # Stack as (samples, channels)
        return np.stack(results, axis=1)
    else:
        return _istft_mono(stft_matrix, hop_length, window, n_fft, original_length, center)


def _istft_mono(
    stft_matrix: np.ndarray,
    hop_length: int,
    window: Optional[np.ndarray],
    n_fft: Optional[int],
    original_length: Optional[int],
    center: bool,
) -> np.ndarray:
    """
    ISTFT for mono STFT matrix.

    Returns: (samples,) array
    """
    n_freq, n_frames = stft_matrix.shape

    # Infer n_fft from frequency bins
    if n_fft is None:
        n_fft = (n_freq - 1) * 2

    if window is None:
        window = _create_hann_window(n_fft)

    # Output length before trimming
    output_length = n_fft + (n_frames - 1) * hop_length

    output = np.zeros(output_length, dtype=np.float64)
    window_sum = np.zeros(output_length, dtype=np.float64)

    for i in range(n_frames):
        start = i * hop_length
        # Inverse FFT
        frame = np.fft.irfft(stft_matrix[:, i], n=n_fft)
        # Apply synthesis window
        frame = frame * window
        # Overlap-add
        output[start:start + n_fft] += frame
        window_sum[start:start + n_fft] += window ** 2

    # COLA normalization: divide by squared window sum
    # Avoid division by zero in regions with insufficient overlap
    window_sum = np.maximum(window_sum, 1e-10)
    output = output / window_sum

    # Trim center padding
    if center:
        pad_length = n_fft // 2
        output = output[pad_length:]
        if original_length is not None:
            output = output[:original_length]

    return output


# ============================================================================
# SpectralContext Class
# ============================================================================

@dataclass
class SpectralContext:
    """
    Single STFT computation shared across all processing stages.

    Attributes:
        sample_rate: Sample rate in Hz
        channels: Number of channels (1 or 2)
        original_length: Original audio length in samples
        n_fft: FFT size
        hop_length: Hop length
        window: Analysis/synthesis window
        complex_stft: Complex STFT array (channels, n_freq, n_frames) or (n_freq, n_frames)
        linked_magnitude: Stereo-linked magnitude for mask computation (n_freq, n_frames)
        per_channel_magnitude: Per-channel magnitude (channels, n_freq, n_frames) or (n_freq, n_frames)
        per_channel_phase: Per-channel phase (channels, n_freq, n_frames) or (n_freq, n_frames)
        frequencies: Frequency axis in Hz (n_freq,)
        frame_times: Frame center times in seconds (n_frames,)
        frame_energy: Per-frame total energy (n_frames,)
        spectral_flux: Frame-to-frame spectral change (n_frames,)
    """
    sample_rate: int
    channels: int
    original_length: int
    n_fft: int
    hop_length: int
    window: np.ndarray
    complex_stft: np.ndarray
    linked_magnitude: np.ndarray
    per_channel_magnitude: np.ndarray
    per_channel_phase: np.ndarray
    frequencies: np.ndarray
    frame_times: np.ndarray
    frame_energy: np.ndarray
    spectral_flux: np.ndarray

    @classmethod
    def from_audio(
        cls,
        audio: np.ndarray,
        sample_rate: int,
        n_fft: int = DEFAULT_N_FFT,
        hop_length: int = DEFAULT_HOP_LENGTH,
    ) -> "SpectralContext":
        """
        Create SpectralContext from audio array.

        Args:
            audio: Audio array, shape (samples,) or (samples, channels)
            sample_rate: Sample rate in Hz
            n_fft: FFT size
            hop_length: Hop length

        Returns:
            SpectralContext instance
        """
        audio = np.asarray(audio, dtype=np.float64)

        # Determine channels
        if audio.ndim == 1:
            channels = 1
            original_length = len(audio)
        else:
            original_length, channels = audio.shape

        # Create window
        window = _create_hann_window(n_fft)

        # Compute STFT
        complex_stft = stft(audio, n_fft, hop_length, window, center=True)

        # Compute magnitude and phase
        if channels == 1:
            per_channel_magnitude = np.abs(complex_stft)
            per_channel_phase = np.angle(complex_stft)
            linked_magnitude = per_channel_magnitude
        else:
            # Stereo: complex_stft is (channels, n_freq, n_frames)
            per_channel_magnitude = np.abs(complex_stft)
            per_channel_phase = np.angle(complex_stft)
            # Stereo-linked: RMS of both channels
            linked_magnitude = np.sqrt(
                (per_channel_magnitude[0] ** 2 + per_channel_magnitude[1] ** 2) / 2
            )

        # Frequency axis
        frequencies = np.fft.rfftfreq(n_fft, 1.0 / sample_rate)

        # Frame times
        n_frames = linked_magnitude.shape[-1]
        frame_times = np.arange(n_frames) * hop_length / sample_rate

        # Frame energy (sum of magnitude squared per frame)
        frame_energy = np.sum(linked_magnitude ** 2, axis=0)

        # Spectral flux (L2 norm of frame-to-frame magnitude difference)
        if n_frames > 1:
            mag_diff = np.diff(linked_magnitude, axis=-1)
            spectral_flux = np.zeros(n_frames)
            spectral_flux[1:] = np.sqrt(np.sum(mag_diff ** 2, axis=0))
        else:
            spectral_flux = np.zeros(n_frames)

        return cls(
            sample_rate=sample_rate,
            channels=channels,
            original_length=original_length,
            n_fft=n_fft,
            hop_length=hop_length,
            window=window,
            complex_stft=complex_stft,
            linked_magnitude=linked_magnitude,
            per_channel_magnitude=per_channel_magnitude,
            per_channel_phase=per_channel_phase,
            frequencies=frequencies,
            frame_times=frame_times,
            frame_energy=frame_energy,
            spectral_flux=spectral_flux,
        )

    @property
    def n_freq(self) -> int:
        """Number of frequency bins."""
        return self.n_fft // 2 + 1

    @property
    def n_frames(self) -> int:
        """Number of time frames."""
        return self.linked_magnitude.shape[-1]

    @property
    def duration(self) -> float:
        """Duration in seconds."""
        return self.original_length / self.sample_rate

    def apply_mask(self, mask: np.ndarray) -> np.ndarray:
        """
        Apply magnitude mask to STFT and return modified complex STFT.

        Args:
            mask: Magnitude mask (n_freq, n_frames), values in [0, 1]

        Returns:
            Modified complex STFT array
        """
        if self.channels == 1:
            # Mono: mask directly
            return self.complex_stft * mask
        else:
            # Stereo: apply same mask to both channels
            result = np.zeros_like(self.complex_stft)
            result[0] = self.complex_stft[0] * mask
            result[1] = self.complex_stft[1] * mask
            return result

    def reconstruct(
        self,
        modified_stft: Optional[np.ndarray] = None,
        mask: Optional[np.ndarray] = None,
    ) -> np.ndarray:
        """
        Reconstruct audio from STFT.

        Args:
            modified_stft: Modified complex STFT (if None, uses original)
            mask: If provided, apply this mask to original STFT first

        Returns:
            Reconstructed audio array
        """
        if modified_stft is None:
            if mask is not None:
                modified_stft = self.apply_mask(mask)
            else:
                modified_stft = self.complex_stft

        return istft(
            modified_stft,
            hop_length=self.hop_length,
            window=self.window,
            n_fft=self.n_fft,
            original_length=self.original_length,
            center=True,
        )

    def get_band_mask(
        self,
        low_hz: float,
        high_hz: float,
    ) -> np.ndarray:
        """
        Get boolean mask for frequency band.

        Args:
            low_hz: Lower frequency bound
            high_hz: Upper frequency bound

        Returns:
            Boolean mask (n_freq,)
        """
        return (self.frequencies >= low_hz) & (self.frequencies < high_hz)

    def get_band_energy(
        self,
        low_hz: float,
        high_hz: float,
    ) -> float:
        """
        Get total energy in frequency band.

        Args:
            low_hz: Lower frequency bound
            high_hz: Upper frequency bound

        Returns:
            Total energy (linear scale)
        """
        band_mask = self.get_band_mask(low_hz, high_hz)
        return float(np.sum(self.linked_magnitude[band_mask] ** 2))


def measure_round_trip_error(
    original: np.ndarray,
    reconstructed: np.ndarray,
) -> dict:
    """
    Measure round-trip reconstruction error.

    Returns dict with:
        - rms_error_db: RMS of difference in dB
        - peak_error_db: Peak of difference in dB
        - max_sample_diff: Maximum absolute sample difference
        - length_match: Whether lengths match
        - has_nan: Whether output contains NaN
        - has_inf: Whether output contains Inf
    """
    original = np.asarray(original, dtype=np.float64)
    reconstructed = np.asarray(reconstructed, dtype=np.float64)

    # Check for NaN/Inf
    has_nan = bool(np.any(np.isnan(reconstructed)))
    has_inf = bool(np.any(np.isinf(reconstructed)))

    # Length check
    length_match = original.shape == reconstructed.shape

    if not length_match:
        # Truncate to common length for error measurement
        min_len = min(len(original), len(reconstructed))
        original = original[:min_len]
        reconstructed = reconstructed[:min_len]

    # Difference
    diff = reconstructed - original

    # Flatten for stereo
    diff_flat = diff.flatten()
    original_flat = original.flatten()

    # RMS error
    rms_diff = np.sqrt(np.mean(diff_flat ** 2))
    rms_error_db = 20 * np.log10(max(rms_diff, 1e-12))

    # Peak error
    peak_diff = np.max(np.abs(diff_flat))
    peak_error_db = 20 * np.log10(max(peak_diff, 1e-12))

    # Original stats for reference
    orig_peak = np.max(np.abs(original_flat))
    orig_rms = np.sqrt(np.mean(original_flat ** 2))

    # Relative metrics
    peak_delta_db = 0.0
    if orig_peak > 1e-12:
        recon_peak = np.max(np.abs(reconstructed.flatten()))
        peak_delta_db = 20 * np.log10(max(recon_peak, 1e-12)) - 20 * np.log10(orig_peak)

    # Stereo correlation (if stereo)
    orig_corr = None
    recon_corr = None
    corr_delta = None
    if original.ndim == 2 and original.shape[1] == 2:
        if np.std(original[:, 0]) > 1e-12 and np.std(original[:, 1]) > 1e-12:
            orig_corr = float(np.corrcoef(original[:, 0], original[:, 1])[0, 1])
        if np.std(reconstructed[:, 0]) > 1e-12 and np.std(reconstructed[:, 1]) > 1e-12:
            recon_corr = float(np.corrcoef(reconstructed[:, 0], reconstructed[:, 1])[0, 1])
        if orig_corr is not None and recon_corr is not None:
            corr_delta = abs(recon_corr - orig_corr)

    return {
        "rms_error_db": float(rms_error_db),
        "peak_error_db": float(peak_error_db),
        "max_sample_diff": float(peak_diff),
        "peak_delta_db": float(peak_delta_db),
        "length_match": length_match,
        "has_nan": has_nan,
        "has_inf": has_inf,
        "original_peak": float(orig_peak),
        "original_rms_db": float(20 * np.log10(max(orig_rms, 1e-12))),
        "stereo_correlation_original": orig_corr,
        "stereo_correlation_reconstructed": recon_corr,
        "stereo_correlation_delta": corr_delta,
    }
