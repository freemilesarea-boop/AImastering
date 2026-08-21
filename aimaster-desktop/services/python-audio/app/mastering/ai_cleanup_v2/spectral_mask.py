"""
Spectral Mask - Frequency-dependent attenuation mask generation.

P0 implementation uses fixed strength-based attenuation limits,
not AI artifact score detection.

Design:
- Target 6kHz+ broadband/grain-like components
- Protect 2-6kHz vocal band
- Adaptive noise floor estimation
- Spectral floor to prevent over-attenuation
- All mask values in (0, 1] - no complete removal
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Tuple

import numpy as np

from .spectral_context import SpectralContext


# ============================================================================
# Constants
# ============================================================================

# Frequency bands (Hz)
VOCAL_BAND_LOW = 2000.0
VOCAL_BAND_HIGH = 6000.0
MID_HF_BAND_HIGH = 10000.0

# Noise floor estimation
DEFAULT_QUIET_PERCENTILE = 15  # Use quietest 15% of frames
MIN_QUIET_FRAMES = 3


# ============================================================================
# Strength Presets
# ============================================================================

@dataclass(frozen=True)
class StrengthPreset:
    """
    Attenuation limits for each frequency band.

    All values in dB (positive = attenuation amount).
    """
    name: str
    # Maximum attenuation per band (dB)
    vocal_max_db: float      # 2-6 kHz
    mid_hf_max_db: float     # 6-10 kHz
    high_max_db: float       # 10 kHz+
    # Oversubtraction factor
    oversubtraction: float
    # Spectral floor (minimum mask value)
    spectral_floor: float


STRENGTH_PRESETS = {
    "gentle": StrengthPreset(
        name="gentle",
        vocal_max_db=0.5,
        mid_hf_max_db=1.5,
        high_max_db=2.0,
        oversubtraction=1.2,
        spectral_floor=0.80,  # min 80% of original
    ),
    "balanced": StrengthPreset(
        name="balanced",
        vocal_max_db=1.0,
        mid_hf_max_db=2.0,
        high_max_db=3.0,
        oversubtraction=1.5,
        spectral_floor=0.70,
    ),
    # "strong" excluded from P0 per requirements
}


def get_strength_preset(strength: str) -> StrengthPreset:
    """Get strength preset, defaulting to gentle if unknown."""
    return STRENGTH_PRESETS.get(strength, STRENGTH_PRESETS["gentle"])


# ============================================================================
# Noise Floor Estimation
# ============================================================================

def estimate_noise_floor(
    magnitude: np.ndarray,
    frame_energy: np.ndarray,
    quiet_percentile: int = DEFAULT_QUIET_PERCENTILE,
) -> np.ndarray:
    """
    Estimate noise floor per frequency bin from quiet frames.

    Args:
        magnitude: STFT magnitude (n_freq, n_frames)
        frame_energy: Per-frame total energy (n_frames,)
        quiet_percentile: Percentile threshold for quiet frames

    Returns:
        Noise floor estimate per frequency bin (n_freq,)
    """
    n_freq, n_frames = magnitude.shape

    # Find quiet frames
    energy_threshold = np.percentile(frame_energy, quiet_percentile)
    quiet_mask = frame_energy <= energy_threshold

    n_quiet = np.sum(quiet_mask)

    if n_quiet < MIN_QUIET_FRAMES:
        # Not enough quiet frames: use per-bin percentile
        # This is more conservative (likely overestimates noise)
        return np.percentile(magnitude, quiet_percentile, axis=1)

    # Average magnitude of quiet frames per bin
    quiet_mag = magnitude[:, quiet_mask]
    return np.mean(quiet_mag, axis=1)


def estimate_noise_floor_adaptive(
    magnitude: np.ndarray,
    frame_energy: np.ndarray,
    frequencies: np.ndarray,
) -> np.ndarray:
    """
    Adaptive noise floor estimation with frequency-dependent percentiles.

    Higher frequencies often have more noise, so we use slightly
    higher percentiles for HF bands.

    Args:
        magnitude: STFT magnitude (n_freq, n_frames)
        frame_energy: Per-frame total energy (n_frames,)
        frequencies: Frequency axis (n_freq,)

    Returns:
        Noise floor estimate per frequency bin (n_freq,)
    """
    n_freq, n_frames = magnitude.shape
    noise_floor = np.zeros(n_freq)

    # Define percentiles per band
    band_configs = [
        (0, VOCAL_BAND_LOW, 10),           # Sub-vocal: 10th percentile
        (VOCAL_BAND_LOW, VOCAL_BAND_HIGH, 8),  # Vocal: 8th percentile (conservative)
        (VOCAL_BAND_HIGH, MID_HF_BAND_HIGH, 12),  # Mid-HF: 12th percentile
        (MID_HF_BAND_HIGH, np.inf, 15),    # High: 15th percentile
    ]

    for low_hz, high_hz, percentile in band_configs:
        band_mask = (frequencies >= low_hz) & (frequencies < high_hz)
        if not np.any(band_mask):
            continue

        band_mag = magnitude[band_mask, :]

        # Find quiet frames based on this band's energy
        band_energy = np.sum(band_mag ** 2, axis=0)
        energy_threshold = np.percentile(band_energy, percentile)
        quiet_mask = band_energy <= energy_threshold

        n_quiet = np.sum(quiet_mask)

        if n_quiet < MIN_QUIET_FRAMES:
            # Fallback: per-bin percentile
            noise_floor[band_mask] = np.percentile(band_mag, percentile, axis=1)
        else:
            # Average of quiet frames
            noise_floor[band_mask] = np.mean(band_mag[:, quiet_mask], axis=1)

    return noise_floor


# ============================================================================
# Attenuation Limit Map
# ============================================================================

def create_attenuation_limit_map(
    frequencies: np.ndarray,
    preset: StrengthPreset,
) -> np.ndarray:
    """
    Create per-frequency maximum attenuation map.

    Args:
        frequencies: Frequency axis (n_freq,)
        preset: Strength preset

    Returns:
        Maximum attenuation ratio per bin (n_freq,)
        Values are in linear scale (e.g., 0.8 = 20% attenuation max)
    """
    n_freq = len(frequencies)
    max_atten = np.ones(n_freq)  # Default: no attenuation

    # Below vocal band: no attenuation (protect bass/low-mids)
    # This is implicit in the default of 1.0

    # Vocal band: 2-6 kHz
    vocal_mask = (frequencies >= VOCAL_BAND_LOW) & (frequencies < VOCAL_BAND_HIGH)
    vocal_atten_linear = 10 ** (-preset.vocal_max_db / 20)
    max_atten[vocal_mask] = vocal_atten_linear

    # Mid-HF band: 6-10 kHz
    mid_hf_mask = (frequencies >= VOCAL_BAND_HIGH) & (frequencies < MID_HF_BAND_HIGH)
    mid_hf_atten_linear = 10 ** (-preset.mid_hf_max_db / 20)
    max_atten[mid_hf_mask] = mid_hf_atten_linear

    # High band: 10 kHz+
    high_mask = frequencies >= MID_HF_BAND_HIGH
    high_atten_linear = 10 ** (-preset.high_max_db / 20)
    max_atten[high_mask] = high_atten_linear

    return max_atten


# ============================================================================
# Spectral Mask Generation
# ============================================================================

@dataclass
class MaskResult:
    """Result of spectral mask generation."""
    mask: np.ndarray  # (n_freq, n_frames)
    noise_floor: np.ndarray  # (n_freq,)
    attenuation_limit: np.ndarray  # (n_freq,)
    stats: dict


def generate_spectral_mask(
    ctx: SpectralContext,
    strength: str = "gentle",
    quiet_percentile: int = DEFAULT_QUIET_PERCENTILE,
) -> MaskResult:
    """
    Generate spectral attenuation mask.

    Args:
        ctx: SpectralContext with STFT data
        strength: Strength preset name
        quiet_percentile: Percentile for noise floor estimation

    Returns:
        MaskResult with mask array and metadata
    """
    preset = get_strength_preset(strength)
    magnitude = ctx.linked_magnitude
    n_freq, n_frames = magnitude.shape

    # 1. Estimate noise floor
    noise_floor = estimate_noise_floor_adaptive(
        magnitude, ctx.frame_energy, ctx.frequencies
    )

    # 2. Create attenuation limit map
    attenuation_limit = create_attenuation_limit_map(ctx.frequencies, preset)

    # 3. Compute raw mask via spectral subtraction
    # mask = 1 - (oversubtraction * noise_floor / magnitude)
    # Clamped to [spectral_floor, 1.0]

    # Expand noise_floor to match magnitude shape
    noise_floor_expanded = noise_floor[:, np.newaxis]

    # Avoid division by zero
    safe_magnitude = np.maximum(magnitude, 1e-10)

    # Spectral subtraction ratio
    subtraction_ratio = preset.oversubtraction * noise_floor_expanded / safe_magnitude

    # Raw mask (before limiting)
    raw_mask = 1.0 - subtraction_ratio

    # 4. Apply spectral floor (minimum mask value)
    mask = np.maximum(raw_mask, preset.spectral_floor)

    # 5. Apply attenuation limits per frequency
    # attenuation_limit is the minimum allowed mask value per frequency
    attenuation_limit_expanded = attenuation_limit[:, np.newaxis]
    mask = np.maximum(mask, attenuation_limit_expanded)

    # 6. Ensure mask is in valid range [spectral_floor, 1.0]
    mask = np.clip(mask, preset.spectral_floor, 1.0)

    # 7. Compute statistics
    stats = _compute_mask_stats(mask, ctx.frequencies, preset)

    return MaskResult(
        mask=mask,
        noise_floor=noise_floor,
        attenuation_limit=attenuation_limit,
        stats=stats,
    )


def _compute_mask_stats(
    mask: np.ndarray,
    frequencies: np.ndarray,
    preset: StrengthPreset,
) -> dict:
    """Compute mask statistics for reporting."""
    n_freq, n_frames = mask.shape

    # Overall stats
    mean_mask = float(np.mean(mask))
    min_mask = float(np.min(mask))
    max_mask = float(np.max(mask))

    # Per-band stats
    def band_stats(low_hz: float, high_hz: float) -> dict:
        band_mask_idx = (frequencies >= low_hz) & (frequencies < high_hz)
        if not np.any(band_mask_idx):
            return {"mean": 1.0, "min": 1.0, "attenuation_db": 0.0}
        band_values = mask[band_mask_idx, :]
        mean_val = float(np.mean(band_values))
        min_val = float(np.min(band_values))
        atten_db = float(-20 * np.log10(max(mean_val, 1e-10)))
        return {
            "mean": mean_val,
            "min": min_val,
            "attenuation_db": atten_db,
        }

    return {
        "strength": preset.name,
        "spectral_floor": preset.spectral_floor,
        "mean_mask": mean_mask,
        "min_mask": min_mask,
        "max_mask": max_mask,
        "band_0_2k": band_stats(0, VOCAL_BAND_LOW),
        "band_2_6k": band_stats(VOCAL_BAND_LOW, VOCAL_BAND_HIGH),
        "band_6_10k": band_stats(VOCAL_BAND_HIGH, MID_HF_BAND_HIGH),
        "band_10k_plus": band_stats(MID_HF_BAND_HIGH, 22050),
    }


# ============================================================================
# Mask Validation
# ============================================================================

def validate_mask(mask: np.ndarray) -> Tuple[bool, list]:
    """
    Validate mask array.

    Returns:
        (is_valid, list_of_issues)
    """
    issues = []

    # Check for NaN
    if np.any(np.isnan(mask)):
        issues.append("Mask contains NaN")

    # Check for Inf
    if np.any(np.isinf(mask)):
        issues.append("Mask contains Inf")

    # Check range
    if np.any(mask < 0):
        issues.append(f"Mask has negative values (min={np.min(mask)})")

    if np.any(mask > 1):
        issues.append(f"Mask exceeds 1.0 (max={np.max(mask)})")

    # Check for zeros (complete removal not allowed)
    if np.any(mask == 0):
        n_zeros = np.sum(mask == 0)
        issues.append(f"Mask has {n_zeros} zero values (complete removal)")

    return len(issues) == 0, issues
