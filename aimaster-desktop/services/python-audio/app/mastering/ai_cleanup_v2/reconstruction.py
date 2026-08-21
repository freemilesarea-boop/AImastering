"""
Reconstruction - Limited recovery of transients, harmonics, and HF texture.

P0 Reconstruction does NOT generate new audio content.
It only partially restores original content that may have been
over-attenuated during processing.

Design:
- Transient frame recovery: blend original magnitude on transients
- Harmonic recovery: reduce attenuation on detected harmonics
- HF residual recovery: limited restoration of HF energy if over-reduced
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import numpy as np

from .spectral_context import SpectralContext


# ============================================================================
# Constants
# ============================================================================

HF_THRESHOLD_HZ = 10000.0

# Recovery limits
DEFAULT_TRANSIENT_RECOVERY = 0.15    # Restore 15% of original on transients
DEFAULT_HARMONIC_RECOVERY = 0.25     # Restore 25% of attenuated harmonics
DEFAULT_HF_RECOVERY = 0.10           # Restore 10% of HF if over-reduced
DEFAULT_MAX_RECOVERY_DB = 1.0        # Never boost more than 1dB


# ============================================================================
# Configuration
# ============================================================================

@dataclass
class ReconstructionConfig:
    """Configuration for reconstruction."""
    enable: bool = True

    # Transient recovery
    transient_recovery: float = DEFAULT_TRANSIENT_RECOVERY
    transient_threshold: float = 0.5  # Minimum transient protection weight

    # Harmonic recovery
    harmonic_recovery: float = DEFAULT_HARMONIC_RECOVERY
    harmonic_threshold: float = 0.5  # Minimum harmonic weight

    # HF residual recovery
    hf_recovery: float = DEFAULT_HF_RECOVERY
    hf_threshold_hz: float = HF_THRESHOLD_HZ
    hf_drop_trigger: float = 0.3  # Trigger if HF dropped > 30%

    # Limits
    max_recovery_db: float = DEFAULT_MAX_RECOVERY_DB


# ============================================================================
# Reconstruction Functions
# ============================================================================

@dataclass
class ReconstructionResult:
    """Result of reconstruction."""
    reconstructed_magnitude: np.ndarray
    recovery_mask: np.ndarray  # How much was recovered per bin/frame
    stats: dict


def apply_reconstruction(
    processed_magnitude: np.ndarray,
    original_magnitude: np.ndarray,
    transient_protection: np.ndarray,
    harmonic_weight: np.ndarray,
    frequencies: np.ndarray,
    config: ReconstructionConfig = None,
) -> ReconstructionResult:
    """
    Apply limited reconstruction to processed magnitude.

    This restores some of the original content that may have been
    over-attenuated, without generating any new content.

    Args:
        processed_magnitude: Processed STFT magnitude (n_freq, n_frames)
        original_magnitude: Original STFT magnitude (n_freq, n_frames)
        transient_protection: Transient protection weights per frame (n_frames,)
        harmonic_weight: Harmonic weights per bin/frame (n_freq, n_frames)
        frequencies: Frequency axis (n_freq,)
        config: Reconstruction configuration

    Returns:
        ReconstructionResult with reconstructed magnitude and stats
    """
    if config is None:
        config = ReconstructionConfig()

    if not config.enable:
        return ReconstructionResult(
            reconstructed_magnitude=processed_magnitude.copy(),
            recovery_mask=np.zeros_like(processed_magnitude),
            stats={"enabled": False},
        )

    n_freq, n_frames = processed_magnitude.shape
    reconstructed = processed_magnitude.copy()
    recovery_mask = np.zeros_like(processed_magnitude)

    # Maximum recovery ratio (linear)
    max_recovery_ratio = 10 ** (config.max_recovery_db / 20)

    stats = {
        "enabled": True,
        "transient_recovery_applied": False,
        "harmonic_recovery_applied": False,
        "hf_recovery_applied": False,
    }

    # 1. Transient Recovery
    if config.transient_recovery > 0:
        for t in range(n_frames):
            if transient_protection[t] >= config.transient_threshold:
                # Blend original magnitude on transient frames
                blend = config.transient_recovery * transient_protection[t]
                orig = original_magnitude[:, t]
                proc = processed_magnitude[:, t]

                # Only recover where we attenuated
                recovery = blend * (orig - proc)
                recovery = np.maximum(recovery, 0)  # No reduction

                # Limit recovery
                max_boost = proc * (max_recovery_ratio - 1)
                recovery = np.minimum(recovery, max_boost)

                reconstructed[:, t] += recovery
                recovery_mask[:, t] += recovery / (orig + 1e-10)

        stats["transient_recovery_applied"] = bool(np.any(transient_protection >= config.transient_threshold))

    # 2. Harmonic Recovery
    if config.harmonic_recovery > 0:
        harmonic_bins = harmonic_weight >= config.harmonic_threshold

        if np.any(harmonic_bins):
            # Where we have harmonics, recover some attenuation
            orig = original_magnitude
            proc = processed_magnitude

            recovery = config.harmonic_recovery * harmonic_weight * (orig - proc)
            recovery = np.maximum(recovery, 0)  # No reduction

            # Limit recovery
            max_boost = proc * (max_recovery_ratio - 1)
            recovery = np.minimum(recovery, max_boost)

            reconstructed += recovery
            recovery_mask += recovery / (orig + 1e-10)

            stats["harmonic_recovery_applied"] = True
            stats["harmonic_bins_recovered"] = int(np.sum(harmonic_bins))

    # 3. HF Residual Recovery
    if config.hf_recovery > 0:
        hf_mask = frequencies >= config.hf_threshold_hz

        if np.any(hf_mask):
            # Check if HF was significantly reduced
            orig_hf_energy = np.sum(original_magnitude[hf_mask] ** 2)
            proc_hf_energy = np.sum(processed_magnitude[hf_mask] ** 2)

            if orig_hf_energy > 1e-10:
                hf_drop = 1.0 - (proc_hf_energy / orig_hf_energy)

                if hf_drop > config.hf_drop_trigger:
                    # Recover some HF
                    orig_hf = original_magnitude[hf_mask, :]
                    proc_hf = processed_magnitude[hf_mask, :]

                    recovery = config.hf_recovery * (orig_hf - proc_hf)
                    recovery = np.maximum(recovery, 0)

                    # Limit
                    max_boost = proc_hf * (max_recovery_ratio - 1)
                    recovery = np.minimum(recovery, max_boost)

                    reconstructed[hf_mask, :] += recovery
                    recovery_mask[hf_mask, :] += recovery / (orig_hf + 1e-10)

                    stats["hf_recovery_applied"] = True
                    stats["hf_drop_percent"] = float(hf_drop * 100)
                    stats["hf_recovery_percent"] = float(config.hf_recovery * 100)

    # Ensure no values exceed original (no generation)
    reconstructed = np.minimum(reconstructed, original_magnitude)

    # Compute aggregate stats
    total_recovery = np.sum(recovery_mask) / max(recovery_mask.size, 1)
    stats["mean_recovery_ratio"] = float(total_recovery)
    stats["max_recovery_ratio"] = float(np.max(recovery_mask))

    return ReconstructionResult(
        reconstructed_magnitude=reconstructed,
        recovery_mask=recovery_mask,
        stats=stats,
    )


def validate_reconstruction(
    original_magnitude: np.ndarray,
    reconstructed_magnitude: np.ndarray,
) -> dict:
    """
    Validate that reconstruction didn't create new content.

    Returns validation results and any issues found.
    """
    # Check if any bin exceeds original
    exceeds = reconstructed_magnitude > original_magnitude + 1e-10
    n_exceeds = np.sum(exceeds)

    # Measure energy
    orig_energy = np.sum(original_magnitude ** 2)
    recon_energy = np.sum(reconstructed_magnitude ** 2)
    energy_ratio = recon_energy / max(orig_energy, 1e-10)

    return {
        "valid": n_exceeds == 0,
        "bins_exceeding_original": int(n_exceeds),
        "original_energy": float(orig_energy),
        "reconstructed_energy": float(recon_energy),
        "energy_ratio": float(energy_ratio),
        "peak_original": float(np.max(original_magnitude)),
        "peak_reconstructed": float(np.max(reconstructed_magnitude)),
    }
