"""
STFT/ISTFT Round-trip verification tests.

These tests MUST pass before any denoise implementation proceeds.
"""
import os
import sys

import numpy as np

# Add app to path
_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(_HERE)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from app.mastering.ai_cleanup_v2.spectral_context import (
    SpectralContext,
    stft,
    istft,
    measure_round_trip_error,
    DEFAULT_N_FFT,
    DEFAULT_HOP_LENGTH,
)


def test_stft_istft_sine_mono():
    """Test round-trip on a mono sine wave."""
    sr = 44100
    duration = 1.0
    freq = 440.0

    t = np.arange(int(sr * duration)) / sr
    audio = 0.5 * np.sin(2 * np.pi * freq * t)

    ctx = SpectralContext.from_audio(audio, sr)
    reconstructed = ctx.reconstruct()

    error = measure_round_trip_error(audio, reconstructed)

    print(f"Mono sine: RMS error = {error['rms_error_db']:.2f} dB, "
          f"Peak error = {error['peak_error_db']:.2f} dB, "
          f"Peak delta = {error['peak_delta_db']:.4f} dB")

    assert error["length_match"], "Length mismatch"
    assert not error["has_nan"], "Output contains NaN"
    assert not error["has_inf"], "Output contains Inf"
    assert error["rms_error_db"] < -60, f"RMS error too high: {error['rms_error_db']}"
    assert abs(error["peak_delta_db"]) < 0.1, f"Peak delta too high: {error['peak_delta_db']}"


def test_stft_istft_sine_stereo():
    """Test round-trip on a stereo sine wave."""
    sr = 44100
    duration = 1.0

    t = np.arange(int(sr * duration)) / sr
    left = 0.5 * np.sin(2 * np.pi * 440.0 * t)
    right = 0.5 * np.sin(2 * np.pi * 880.0 * t)
    audio = np.column_stack([left, right])

    ctx = SpectralContext.from_audio(audio, sr)
    reconstructed = ctx.reconstruct()

    error = measure_round_trip_error(audio, reconstructed)

    print(f"Stereo sine: RMS error = {error['rms_error_db']:.2f} dB, "
          f"Peak error = {error['peak_error_db']:.2f} dB, "
          f"Peak delta = {error['peak_delta_db']:.4f} dB, "
          f"Corr delta = {error['stereo_correlation_delta']}")

    assert error["length_match"], "Length mismatch"
    assert not error["has_nan"], "Output contains NaN"
    assert not error["has_inf"], "Output contains Inf"
    assert error["rms_error_db"] < -60, f"RMS error too high: {error['rms_error_db']}"
    assert abs(error["peak_delta_db"]) < 0.1, f"Peak delta too high: {error['peak_delta_db']}"
    if error["stereo_correlation_delta"] is not None:
        assert error["stereo_correlation_delta"] < 0.01, f"Stereo correlation changed too much"


def test_stft_istft_impulse():
    """Test round-trip on an impulse (tests transient preservation)."""
    sr = 44100
    duration = 0.5

    audio = np.zeros(int(sr * duration))
    audio[sr // 4] = 1.0  # Impulse at 0.25s

    ctx = SpectralContext.from_audio(audio, sr)
    reconstructed = ctx.reconstruct()

    error = measure_round_trip_error(audio, reconstructed)

    print(f"Impulse: RMS error = {error['rms_error_db']:.2f} dB, "
          f"Peak error = {error['peak_error_db']:.2f} dB, "
          f"Peak delta = {error['peak_delta_db']:.4f} dB")

    assert error["length_match"], "Length mismatch"
    assert not error["has_nan"], "Output contains NaN"
    assert not error["has_inf"], "Output contains Inf"
    # Impulse is harder to reconstruct perfectly
    assert error["rms_error_db"] < -50, f"RMS error too high: {error['rms_error_db']}"
    assert abs(error["peak_delta_db"]) < 0.5, f"Peak delta too high: {error['peak_delta_db']}"


def test_stft_istft_white_noise():
    """Test round-trip on white noise."""
    sr = 44100
    duration = 1.0

    np.random.seed(42)
    audio = 0.5 * np.random.randn(int(sr * duration))

    ctx = SpectralContext.from_audio(audio, sr)
    reconstructed = ctx.reconstruct()

    error = measure_round_trip_error(audio, reconstructed)

    print(f"White noise: RMS error = {error['rms_error_db']:.2f} dB, "
          f"Peak error = {error['peak_error_db']:.2f} dB, "
          f"Peak delta = {error['peak_delta_db']:.4f} dB")

    assert error["length_match"], "Length mismatch"
    assert not error["has_nan"], "Output contains NaN"
    assert not error["has_inf"], "Output contains Inf"
    assert error["rms_error_db"] < -60, f"RMS error too high: {error['rms_error_db']}"
    assert abs(error["peak_delta_db"]) < 0.1, f"Peak delta too high: {error['peak_delta_db']}"


def test_stft_istft_short_audio():
    """Test round-trip on very short audio (edge case)."""
    sr = 44100
    # Just slightly longer than n_fft
    duration_samples = DEFAULT_N_FFT + 100

    t = np.arange(duration_samples) / sr
    audio = 0.5 * np.sin(2 * np.pi * 440.0 * t)

    ctx = SpectralContext.from_audio(audio, sr)
    reconstructed = ctx.reconstruct()

    error = measure_round_trip_error(audio, reconstructed)

    print(f"Short audio ({duration_samples} samples): "
          f"RMS error = {error['rms_error_db']:.2f} dB, "
          f"Peak delta = {error['peak_delta_db']:.4f} dB")

    assert error["length_match"], "Length mismatch"
    assert not error["has_nan"], "Output contains NaN"
    assert not error["has_inf"], "Output contains Inf"


def test_stft_istft_unaligned_length():
    """Test round-trip on audio length that doesn't align with hop."""
    sr = 44100
    # Pick a length that doesn't align with hop_length
    duration_samples = DEFAULT_N_FFT + DEFAULT_HOP_LENGTH * 7 + 137

    t = np.arange(duration_samples) / sr
    audio = 0.5 * np.sin(2 * np.pi * 440.0 * t)

    ctx = SpectralContext.from_audio(audio, sr)
    reconstructed = ctx.reconstruct()

    error = measure_round_trip_error(audio, reconstructed)

    print(f"Unaligned length ({duration_samples} samples): "
          f"RMS error = {error['rms_error_db']:.2f} dB, "
          f"Peak delta = {error['peak_delta_db']:.4f} dB")

    assert error["length_match"], f"Length mismatch: orig={len(audio)}, recon={len(reconstructed)}"
    assert not error["has_nan"], "Output contains NaN"
    assert not error["has_inf"], "Output contains Inf"


def test_mask_unity_passthrough():
    """Test that unity mask (all 1.0) gives perfect reconstruction."""
    sr = 44100
    duration = 1.0

    np.random.seed(42)
    audio = 0.5 * np.random.randn(int(sr * duration))

    ctx = SpectralContext.from_audio(audio, sr)

    # Unity mask
    mask = np.ones((ctx.n_freq, ctx.n_frames))

    reconstructed = ctx.reconstruct(mask=mask)

    error = measure_round_trip_error(audio, reconstructed)

    print(f"Unity mask: RMS error = {error['rms_error_db']:.2f} dB, "
          f"Peak delta = {error['peak_delta_db']:.4f} dB")

    assert error["length_match"], "Length mismatch"
    assert not error["has_nan"], "Output contains NaN"
    assert not error["has_inf"], "Output contains Inf"
    assert error["rms_error_db"] < -60, f"RMS error too high: {error['rms_error_db']}"


def test_spectral_context_attributes():
    """Test SpectralContext attributes are correct."""
    sr = 44100
    duration = 1.0

    t = np.arange(int(sr * duration)) / sr
    audio = 0.5 * np.sin(2 * np.pi * 440.0 * t)

    ctx = SpectralContext.from_audio(audio, sr)

    assert ctx.sample_rate == sr
    assert ctx.channels == 1
    assert ctx.original_length == len(audio)
    assert ctx.n_fft == DEFAULT_N_FFT
    assert ctx.hop_length == DEFAULT_HOP_LENGTH
    assert ctx.n_freq == DEFAULT_N_FFT // 2 + 1
    assert len(ctx.frequencies) == ctx.n_freq
    assert ctx.frequencies[0] == 0.0
    assert ctx.frequencies[-1] == sr / 2
    assert ctx.linked_magnitude.shape == (ctx.n_freq, ctx.n_frames)
    assert ctx.frame_energy.shape == (ctx.n_frames,)
    assert ctx.spectral_flux.shape == (ctx.n_frames,)

    print(f"SpectralContext: {ctx.n_frames} frames, {ctx.n_freq} freq bins, "
          f"duration = {ctx.duration:.3f}s")


def test_spectral_context_stereo():
    """Test SpectralContext with stereo audio."""
    sr = 44100
    duration = 1.0

    t = np.arange(int(sr * duration)) / sr
    left = 0.5 * np.sin(2 * np.pi * 440.0 * t)
    right = 0.3 * np.sin(2 * np.pi * 880.0 * t)
    audio = np.column_stack([left, right])

    ctx = SpectralContext.from_audio(audio, sr)

    assert ctx.channels == 2
    assert ctx.complex_stft.shape[0] == 2
    assert ctx.per_channel_magnitude.shape[0] == 2
    assert ctx.per_channel_phase.shape[0] == 2
    # linked_magnitude should be 2D (averaged)
    assert ctx.linked_magnitude.ndim == 2
    assert ctx.linked_magnitude.shape == (ctx.n_freq, ctx.n_frames)

    print(f"Stereo SpectralContext: {ctx.n_frames} frames, channels = {ctx.channels}")


def test_band_energy():
    """Test frequency band energy calculation."""
    sr = 44100
    duration = 1.0

    # Create signal with energy at 440 Hz
    t = np.arange(int(sr * duration)) / sr
    audio = 0.5 * np.sin(2 * np.pi * 440.0 * t)

    ctx = SpectralContext.from_audio(audio, sr)

    # Energy should be concentrated around 440 Hz
    energy_low = ctx.get_band_energy(0, 200)
    energy_mid = ctx.get_band_energy(400, 500)  # Contains 440 Hz
    energy_high = ctx.get_band_energy(1000, 2000)

    print(f"Band energy: 0-200Hz = {energy_low:.2e}, "
          f"400-500Hz = {energy_mid:.2e}, "
          f"1000-2000Hz = {energy_high:.2e}")

    assert energy_mid > energy_low * 10, "440Hz should have more energy than sub-200Hz"
    assert energy_mid > energy_high * 10, "440Hz should have more energy than 1-2kHz"


def run_all_tests():
    """Run all round-trip tests."""
    tests = [
        ("Mono sine", test_stft_istft_sine_mono),
        ("Stereo sine", test_stft_istft_sine_stereo),
        ("Impulse", test_stft_istft_impulse),
        ("White noise", test_stft_istft_white_noise),
        ("Short audio", test_stft_istft_short_audio),
        ("Unaligned length", test_stft_istft_unaligned_length),
        ("Unity mask", test_mask_unity_passthrough),
        ("Context attributes", test_spectral_context_attributes),
        ("Context stereo", test_spectral_context_stereo),
        ("Band energy", test_band_energy),
    ]

    passed = 0
    failed = 0

    print("=" * 60)
    print("STFT/ISTFT Round-trip Tests")
    print("=" * 60)

    for name, test_func in tests:
        try:
            test_func()
            print(f"  [PASS] {name}")
            passed += 1
        except AssertionError as e:
            print(f"  [FAIL] {name}: {e}")
            failed += 1
        except Exception as e:
            print(f"  [ERROR] {name}: {type(e).__name__}: {e}")
            failed += 1

    print("=" * 60)
    print(f"Results: {passed} passed, {failed} failed")
    print("=" * 60)

    return failed == 0


if __name__ == "__main__":
    success = run_all_tests()
    sys.exit(0 if success else 1)
