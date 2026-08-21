"""
Protection - Transient, Harmonic, and Vocal band protection.

NumPy-only implementation. No scipy.

Design:
- Transient protection via spectral flux onset detection
- Harmonic protection via local maxima detection
- Vocal band guard (2-6kHz hard limit)
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Tuple

import numpy as np

from .spectral_context import SpectralContext


# ============================================================================
# Constants
# ============================================================================

VOCAL_BAND_LOW = 2000.0
VOCAL_BAND_HIGH = 6000.0

# Transient detection
DEFAULT_FLUX_PERCENTILE = 85  # Top 15% of flux = transient
DEFAULT_TRANSIENT_WINDOW = 3  # Frames around transient to protect

# Harmonic detection
DEFAULT_HARMONIC_PROMINENCE = 1.5  # Local max must be 1.5x neighbors
DEFAULT_HARMONIC_PERSISTENCE = 3   # Must persist for N frames


# ============================================================================
# Configuration
# ============================================================================

@dataclass
class ProtectionConfig:
    """Configuration for protection modules."""
    # Transient protection
    enable_transient: bool = True
    flux_percentile: float = DEFAULT_FLUX_PERCENTILE
    transient_window: int = DEFAULT_TRANSIENT_WINDOW
    transient_protection_amount: float = 0.7  # Blend 70% original on transients

    # Harmonic protection
    enable_harmonic: bool = True
    harmonic_prominence: float = DEFAULT_HARMONIC_PROMINENCE
    harmonic_persistence: int = DEFAULT_HARMONIC_PERSISTENCE
    harmonic_protection_amount: float = 0.5  # Reduce attenuation by 50% on harmonics

    # Vocal band
    enable_vocal_guard: bool = True
    vocal_max_attenuation_db: float = 0.5  # Absolute max for vocal band


# ============================================================================
# Transient Detection
# ============================================================================

def detect_transients(
    spectral_flux: np.ndarray,
    percentile: float = DEFAULT_FLUX_PERCENTILE,
) -> np.ndarray:
    """
    Detect transient frames using spectral flux.

    Args:
        spectral_flux: Spectral flux per frame (n_frames,)
        percentile: Percentile threshold for transient detection

    Returns:
        Boolean mask of transient frames (n_frames,)
    """
    if len(spectral_flux) <= 1:
        return np.zeros(len(spectral_flux), dtype=bool)

    threshold = np.percentile(spectral_flux, percentile)
    return spectral_flux > threshold


def create_transient_protection_mask(
    transient_frames: np.ndarray,
    n_frames: int,
    window: int = DEFAULT_TRANSIENT_WINDOW,
) -> np.ndarray:
    """
    Create protection mask around transient frames.

    Args:
        transient_frames: Boolean mask of transient frames
        n_frames: Total number of frames
        window: Number of frames before/after transient to protect

    Returns:
        Protection weight per frame (n_frames,)
        1.0 = full protection, 0.0 = no protection
    """
    protection = np.zeros(n_frames)

    transient_indices = np.where(transient_frames)[0]

    for idx in transient_indices:
        start = max(0, idx - window)
        end = min(n_frames, idx + window + 1)

        # Create triangular window centered on transient
        for i in range(start, end):
            dist = abs(i - idx)
            weight = 1.0 - (dist / (window + 1))
            protection[i] = max(protection[i], weight)

    return protection


# ============================================================================
# Harmonic Detection (NumPy only, no scipy)
# ============================================================================

def detect_local_maxima(
    magnitude: np.ndarray,
    prominence: float = DEFAULT_HARMONIC_PROMINENCE,
) -> np.ndarray:
    """
    Detect local maxima in frequency axis.

    A bin is a local max if it's larger than its neighbors by
    the prominence factor.

    Args:
        magnitude: Magnitude spectrum (n_freq,) or (n_freq, n_frames)
        prominence: Required prominence factor

    Returns:
        Boolean mask of local maxima
    """
    if magnitude.ndim == 1:
        return _detect_local_maxima_1d(magnitude, prominence)
    else:
        # Per-frame detection
        n_freq, n_frames = magnitude.shape
        result = np.zeros((n_freq, n_frames), dtype=bool)
        for t in range(n_frames):
            result[:, t] = _detect_local_maxima_1d(magnitude[:, t], prominence)
        return result


def _detect_local_maxima_1d(spectrum: np.ndarray, prominence: float) -> np.ndarray:
    """Detect local maxima in 1D spectrum."""
    n = len(spectrum)
    if n < 3:
        return np.zeros(n, dtype=bool)

    is_max = np.zeros(n, dtype=bool)

    for i in range(1, n - 1):
        left = spectrum[i - 1]
        center = spectrum[i]
        right = spectrum[i + 1]

        # Must be larger than both neighbors
        if center > left and center > right:
            # Check prominence
            avg_neighbor = (left + right) / 2
            if avg_neighbor > 1e-12 and center > avg_neighbor * prominence:
                is_max[i] = True

    return is_max


def detect_persistent_harmonics(
    magnitude: np.ndarray,
    prominence: float = DEFAULT_HARMONIC_PROMINENCE,
    min_persistence: int = DEFAULT_HARMONIC_PERSISTENCE,
) -> np.ndarray:
    """
    Detect harmonics that persist over time.

    A frequency bin is considered harmonic if it's a local maximum
    in multiple consecutive frames.

    Args:
        magnitude: STFT magnitude (n_freq, n_frames)
        prominence: Required prominence factor
        min_persistence: Minimum frames a peak must persist

    Returns:
        Harmonic weight per bin/frame (n_freq, n_frames)
        Higher values = more likely to be harmonic
    """
    n_freq, n_frames = magnitude.shape

    # Detect local maxima per frame
    local_max = detect_local_maxima(magnitude, prominence)

    # Count persistence (how many consecutive frames is this bin a max?)
    persistence = np.zeros((n_freq, n_frames), dtype=int)

    for f in range(n_freq):
        count = 0
        for t in range(n_frames):
            if local_max[f, t]:
                count += 1
            else:
                count = 0
            persistence[f, t] = count

    # Backward pass to propagate persistence
    for f in range(n_freq):
        max_count = 0
        for t in range(n_frames - 1, -1, -1):
            if persistence[f, t] > 0:
                max_count = max(max_count, persistence[f, t])
                persistence[f, t] = max_count
            else:
                max_count = 0

    # Convert to harmonic weight
    harmonic_weight = np.minimum(persistence / min_persistence, 1.0)

    return harmonic_weight


# ============================================================================
# Apply Protection to Mask
# ============================================================================

@dataclass
class ProtectionResult:
    """Result of protection application."""
    protected_mask: np.ndarray
    transient_frames: np.ndarray
    transient_protection: np.ndarray
    harmonic_weight: np.ndarray
    stats: dict


def apply_protection(
    mask: np.ndarray,
    ctx: SpectralContext,
    config: ProtectionConfig = None,
) -> ProtectionResult:
    """
    Apply all protection measures to mask.

    Args:
        mask: Input attenuation mask (n_freq, n_frames)
        ctx: SpectralContext with STFT data
        config: Protection configuration

    Returns:
        ProtectionResult with protected mask and metadata
    """
    if config is None:
        config = ProtectionConfig()

    n_freq, n_frames = mask.shape
    protected_mask = mask.copy()

    # Initialize outputs
    transient_frames = np.zeros(n_frames, dtype=bool)
    transient_protection = np.zeros(n_frames)
    harmonic_weight = np.zeros((n_freq, n_frames))

    stats = {
        "transient_enabled": config.enable_transient,
        "harmonic_enabled": config.enable_harmonic,
        "vocal_guard_enabled": config.enable_vocal_guard,
    }

    # 1. Transient Protection
    if config.enable_transient:
        transient_frames = detect_transients(
            ctx.spectral_flux,
            percentile=config.flux_percentile,
        )
        transient_protection = create_transient_protection_mask(
            transient_frames,
            n_frames,
            window=config.transient_window,
        )

        # Apply: blend original (mask=1) where transients are
        # protected_mask = mask * (1 - protection) + 1.0 * protection
        # = mask + protection * (1 - mask)
        protection_amount = config.transient_protection_amount
        for t in range(n_frames):
            if transient_protection[t] > 0:
                p = transient_protection[t] * protection_amount
                protected_mask[:, t] = mask[:, t] + p * (1.0 - mask[:, t])

        stats["transient_frames_detected"] = int(np.sum(transient_frames))
        stats["transient_frames_protected"] = int(np.sum(transient_protection > 0))

    # 2. Harmonic Protection
    if config.enable_harmonic:
        harmonic_weight = detect_persistent_harmonics(
            ctx.linked_magnitude,
            prominence=config.harmonic_prominence,
            min_persistence=config.harmonic_persistence,
        )

        # Apply: reduce attenuation on harmonics
        # If mask = 0.8 and harmonic_weight = 1.0 and amount = 0.5:
        # new_mask = 0.8 + 0.5 * 1.0 * (1 - 0.8) = 0.8 + 0.1 = 0.9
        amount = config.harmonic_protection_amount
        protected_mask = protected_mask + amount * harmonic_weight * (1.0 - protected_mask)

        stats["harmonic_bins_detected"] = int(np.sum(harmonic_weight > 0.5))

    # 3. Vocal Band Guard
    if config.enable_vocal_guard:
        vocal_min_mask = 10 ** (-config.vocal_max_attenuation_db / 20)
        vocal_band = (ctx.frequencies >= VOCAL_BAND_LOW) & (ctx.frequencies < VOCAL_BAND_HIGH)

        # Enforce minimum mask value in vocal band
        protected_mask[vocal_band, :] = np.maximum(
            protected_mask[vocal_band, :],
            vocal_min_mask,
        )

        stats["vocal_min_mask"] = float(vocal_min_mask)
        stats["vocal_bins"] = int(np.sum(vocal_band))

    # Ensure mask stays valid
    protected_mask = np.clip(protected_mask, 0.0, 1.0)

    return ProtectionResult(
        protected_mask=protected_mask,
        transient_frames=transient_frames,
        transient_protection=transient_protection,
        harmonic_weight=harmonic_weight,
        stats=stats,
    )


# ============================================================================
# Stereo-linked Protection
# ============================================================================

def get_stereo_linked_mask(
    left_mask: np.ndarray,
    right_mask: np.ndarray,
) -> np.ndarray:
    """
    Compute stereo-linked mask (same for both channels).

    Uses minimum of both channels to ensure consistent
    attenuation and preserve stereo image.

    Args:
        left_mask: Left channel mask
        right_mask: Right channel mask

    Returns:
        Linked mask (minimum of both)
    """
    return np.minimum(left_mask, right_mask)
