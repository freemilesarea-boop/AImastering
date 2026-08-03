"""
Smoothing - Temporal and frequency smoothing for musical noise prevention.

NumPy-only implementation. No scipy.

Design:
- Temporal smoothing with attack/release separation
- Frequency smoothing with moving average or triangular kernel
- Prevents musical noise (twittering) artifacts
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Tuple

import numpy as np


# ============================================================================
# Constants
# ============================================================================

DEFAULT_TEMPORAL_ATTACK_FRAMES = 2   # Fast attack (attenuation onset)
DEFAULT_TEMPORAL_RELEASE_FRAMES = 5  # Slower release (gain recovery)
DEFAULT_FREQ_KERNEL_SIZE = 5         # 5 bins for frequency smoothing


# ============================================================================
# Smoothing Configuration
# ============================================================================

@dataclass
class SmoothingConfig:
    """Configuration for mask smoothing."""
    # Temporal smoothing
    temporal_attack_frames: int = DEFAULT_TEMPORAL_ATTACK_FRAMES
    temporal_release_frames: int = DEFAULT_TEMPORAL_RELEASE_FRAMES

    # Frequency smoothing
    freq_kernel_size: int = DEFAULT_FREQ_KERNEL_SIZE
    freq_kernel_type: str = "triangular"  # "uniform" or "triangular"


# ============================================================================
# Temporal Smoothing
# ============================================================================

def temporal_smooth(
    mask: np.ndarray,
    attack_frames: int = DEFAULT_TEMPORAL_ATTACK_FRAMES,
    release_frames: int = DEFAULT_TEMPORAL_RELEASE_FRAMES,
) -> np.ndarray:
    """
    Apply temporal smoothing with separate attack/release.

    Attack (mask decreasing = attenuation increasing): fast
    Release (mask increasing = gain recovering): slow

    This prevents sudden gain changes that cause musical noise.

    Args:
        mask: Input mask (n_freq, n_frames)
        attack_frames: Attack time constant in frames
        release_frames: Release time constant in frames

    Returns:
        Smoothed mask (n_freq, n_frames)
    """
    n_freq, n_frames = mask.shape

    if n_frames <= 1:
        return mask.copy()

    # Compute coefficients (exponential smoothing)
    # Higher coefficient = faster response
    attack_coeff = 1.0 / max(attack_frames, 1)
    release_coeff = 1.0 / max(release_frames, 1)

    smoothed = np.zeros_like(mask)
    smoothed[:, 0] = mask[:, 0]

    for t in range(1, n_frames):
        # Current vs previous
        current = mask[:, t]
        previous = smoothed[:, t - 1]

        # Determine direction: attack (decreasing) or release (increasing)
        # Per-bin direction
        is_attack = current < previous

        # Apply appropriate coefficient
        coeff = np.where(is_attack, attack_coeff, release_coeff)

        # Exponential smoothing: new = coeff * current + (1 - coeff) * previous
        smoothed[:, t] = coeff * current + (1 - coeff) * previous

    return smoothed


def temporal_smooth_minfilter(
    mask: np.ndarray,
    window_size: int = 3,
) -> np.ndarray:
    """
    Apply minimum filter for temporal smoothing.

    This ensures the mask responds quickly to attenuation needs
    by taking the minimum over a window.

    Args:
        mask: Input mask (n_freq, n_frames)
        window_size: Window size for minimum filter

    Returns:
        Smoothed mask (n_freq, n_frames)
    """
    n_freq, n_frames = mask.shape

    if n_frames <= window_size:
        return mask.copy()

    smoothed = np.zeros_like(mask)

    half_window = window_size // 2

    for t in range(n_frames):
        start = max(0, t - half_window)
        end = min(n_frames, t + half_window + 1)
        smoothed[:, t] = np.min(mask[:, start:end], axis=1)

    return smoothed


# ============================================================================
# Frequency Smoothing
# ============================================================================

def _create_kernel(size: int, kernel_type: str) -> np.ndarray:
    """Create smoothing kernel."""
    if kernel_type == "uniform":
        return np.ones(size) / size
    elif kernel_type == "triangular":
        # Triangular window (more weight to center)
        half = size // 2
        kernel = np.concatenate([
            np.arange(1, half + 1),
            [half + 1],
            np.arange(half, 0, -1),
        ])
        if len(kernel) > size:
            kernel = kernel[:size]
        elif len(kernel) < size:
            kernel = np.pad(kernel, (0, size - len(kernel)), constant_values=1)
        return kernel / kernel.sum()
    else:
        raise ValueError(f"Unknown kernel type: {kernel_type}")


def frequency_smooth(
    mask: np.ndarray,
    kernel_size: int = DEFAULT_FREQ_KERNEL_SIZE,
    kernel_type: str = "triangular",
) -> np.ndarray:
    """
    Apply frequency smoothing to prevent spectral discontinuities.

    Args:
        mask: Input mask (n_freq, n_frames)
        kernel_size: Kernel size (must be odd)
        kernel_type: "uniform" or "triangular"

    Returns:
        Smoothed mask (n_freq, n_frames)
    """
    n_freq, n_frames = mask.shape

    # Ensure odd kernel size
    if kernel_size % 2 == 0:
        kernel_size += 1

    if kernel_size >= n_freq:
        return mask.copy()

    kernel = _create_kernel(kernel_size, kernel_type)
    half_k = kernel_size // 2

    smoothed = np.zeros_like(mask)

    # Manual convolution along frequency axis
    for f in range(n_freq):
        for t in range(n_frames):
            total = 0.0
            weight_sum = 0.0
            for k in range(kernel_size):
                f_idx = f - half_k + k
                if 0 <= f_idx < n_freq:
                    total += mask[f_idx, t] * kernel[k]
                    weight_sum += kernel[k]
            if weight_sum > 0:
                smoothed[f, t] = total / weight_sum
            else:
                smoothed[f, t] = mask[f, t]

    return smoothed


def frequency_smooth_fast(
    mask: np.ndarray,
    kernel_size: int = DEFAULT_FREQ_KERNEL_SIZE,
) -> np.ndarray:
    """
    Fast uniform frequency smoothing using cumsum trick.

    Args:
        mask: Input mask (n_freq, n_frames)
        kernel_size: Kernel size (must be odd)

    Returns:
        Smoothed mask (n_freq, n_frames)
    """
    n_freq, n_frames = mask.shape

    if kernel_size % 2 == 0:
        kernel_size += 1

    if kernel_size >= n_freq:
        return mask.copy()

    half_k = kernel_size // 2

    # Use the slower but correct manual convolution
    # (cumsum trick has edge issues that change output size)
    return frequency_smooth(mask, kernel_size, "uniform")


# ============================================================================
# Combined Smoothing
# ============================================================================

def smooth_mask(
    mask: np.ndarray,
    config: SmoothingConfig = None,
) -> Tuple[np.ndarray, dict]:
    """
    Apply full smoothing pipeline.

    Args:
        mask: Input mask (n_freq, n_frames)
        config: Smoothing configuration

    Returns:
        (smoothed_mask, stats)
    """
    if config is None:
        config = SmoothingConfig()

    # Measure pre-smoothing variance
    pre_temporal_var = _measure_temporal_variance(mask)
    pre_freq_disc = _measure_frequency_discontinuity(mask)

    # 1. Temporal smoothing
    temp_smoothed = temporal_smooth(
        mask,
        attack_frames=config.temporal_attack_frames,
        release_frames=config.temporal_release_frames,
    )

    # 2. Frequency smoothing
    smoothed = frequency_smooth_fast(
        temp_smoothed,
        kernel_size=config.freq_kernel_size,
    )

    # Measure post-smoothing variance
    post_temporal_var = _measure_temporal_variance(smoothed)
    post_freq_disc = _measure_frequency_discontinuity(smoothed)

    stats = {
        "temporal_variance_before": float(pre_temporal_var),
        "temporal_variance_after": float(post_temporal_var),
        "temporal_variance_reduction": float(1 - post_temporal_var / max(pre_temporal_var, 1e-10)),
        "frequency_discontinuity_before": float(pre_freq_disc),
        "frequency_discontinuity_after": float(post_freq_disc),
        "frequency_discontinuity_reduction": float(1 - post_freq_disc / max(pre_freq_disc, 1e-10)),
        "config": {
            "temporal_attack_frames": config.temporal_attack_frames,
            "temporal_release_frames": config.temporal_release_frames,
            "freq_kernel_size": config.freq_kernel_size,
            "freq_kernel_type": config.freq_kernel_type,
        },
    }

    return smoothed, stats


# ============================================================================
# Metrics
# ============================================================================

def _measure_temporal_variance(mask: np.ndarray) -> float:
    """
    Measure frame-to-frame gain variance.

    Lower is better (smoother).
    """
    if mask.shape[1] <= 1:
        return 0.0

    # Frame-to-frame difference
    diff = np.diff(mask, axis=1)

    # Mean squared difference
    return float(np.mean(diff ** 2))


def _measure_frequency_discontinuity(mask: np.ndarray) -> float:
    """
    Measure frequency-axis discontinuity.

    Lower is better (smoother).
    """
    if mask.shape[0] <= 1:
        return 0.0

    # Bin-to-bin difference
    diff = np.diff(mask, axis=0)

    # Mean squared difference
    return float(np.mean(diff ** 2))
