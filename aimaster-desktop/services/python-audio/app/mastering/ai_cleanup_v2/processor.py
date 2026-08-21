"""
Processor - Main orchestrator for AI Cleanup v2.

Integrates all processing stages:
1. SpectralContext (STFT)
2. Spectral Mask generation
3. Smoothing
4. Protection
5. Reconstruction
6. ISTFT
7. Blend
8. Peak Control
9. Safety Gate
10. Adaptive Retry
"""
from __future__ import annotations

import os
import tempfile
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

import numpy as np

try:
    import soundfile as sf
    _HAS_SF = True
except ImportError:
    _HAS_SF = False

from .spectral_context import SpectralContext, measure_round_trip_error
from .spectral_mask import (
    MaskResult,
    generate_spectral_mask,
    get_strength_preset,
    validate_mask,
)
from .smoothing import SmoothingConfig, smooth_mask
from .protection import ProtectionConfig, ProtectionResult, apply_protection
from .reconstruction import (
    ReconstructionConfig,
    ReconstructionResult,
    apply_reconstruction,
    validate_reconstruction,
)
from .blend import BlendResult, blend_dry_wet, get_default_wet_ratio
from .peak_control import (
    PeakControlResult,
    apply_peak_control,
    check_clipping,
    measure_peak_stats,
    measure_true_peak_ffmpeg,
)
from .safety_gate import (
    RetryConfig,
    RetryHistory,
    RetryAttempt,
    SafetyResult,
    SafetyThresholds,
    calculate_retry_params,
    evaluate_safety,
    measure_metrics,
    should_continue_retry,
)


# ============================================================================
# Configuration
# ============================================================================

@dataclass
class ProcessorConfig:
    """Complete processor configuration."""
    # Core settings
    strength: str = "gentle"
    wet_ratio: Optional[float] = None  # None = auto from strength

    # Feature toggles
    reconstruction_enabled: bool = True
    retry_enabled: bool = True

    # Sub-module configs
    smoothing: SmoothingConfig = field(default_factory=SmoothingConfig)
    protection: ProtectionConfig = field(default_factory=ProtectionConfig)
    reconstruction: ReconstructionConfig = field(default_factory=ReconstructionConfig)
    retry: RetryConfig = field(default_factory=RetryConfig)
    safety_thresholds: SafetyThresholds = field(default_factory=SafetyThresholds)

    def get_wet_ratio(self) -> float:
        """Get wet ratio, using default if not specified."""
        if self.wet_ratio is not None:
            return self.wet_ratio
        return get_default_wet_ratio(self.strength)


# ============================================================================
# Processing Result
# ============================================================================

@dataclass
class ProcessingResult:
    """Complete result of processing."""
    # Output audio
    original: np.ndarray
    processed_wet: np.ndarray  # Pure wet signal before blend
    cleaned: np.ndarray        # Final blended output

    # Metadata
    sample_rate: int
    channels: int
    duration_sec: float

    # Stage results
    mask_result: MaskResult
    smoothing_stats: dict
    protection_result: ProtectionResult
    reconstruction_result: Optional[ReconstructionResult]
    blend_result: BlendResult
    peak_control_result: PeakControlResult
    safety_result: SafetyResult
    retry_history: RetryHistory

    # Metrics
    original_metrics: dict
    processed_metrics: dict
    difference_metrics: dict

    # Timing
    processing_time_ms: int

    # Status
    bypassed: bool = False
    bypass_reason: Optional[str] = None


# ============================================================================
# Main Processor
# ============================================================================

class Processor:
    """Main AI Cleanup v2 processor."""

    def __init__(self, config: ProcessorConfig = None):
        """Initialize processor with configuration."""
        self.config = config or ProcessorConfig()

    def process(
        self,
        audio: np.ndarray,
        sample_rate: int,
        temp_dir: Optional[str] = None,
    ) -> ProcessingResult:
        """
        Process audio through the full pipeline.

        Args:
            audio: Input audio array (samples,) or (samples, channels)
            sample_rate: Sample rate
            temp_dir: Directory for temporary files (for FFmpeg measurements)

        Returns:
            ProcessingResult with all outputs and metadata
        """
        t0 = time.time()

        # Ensure 2D array
        if audio.ndim == 1:
            audio = audio[:, np.newaxis]

        original = audio.copy()
        channels = audio.shape[1]
        duration_sec = len(audio) / sample_rate

        # Measure original metrics
        original_metrics = self._measure_full_metrics(original, sample_rate, temp_dir)

        # Initialize retry history
        retry_history = RetryHistory()

        # Get initial wet ratio
        initial_wet = self.config.get_wet_ratio()

        # Process with retry loop
        attempt = 0
        best_result = None
        best_safety = None

        while True:
            attempt += 1

            # Calculate retry parameters
            wet_ratio, recon_enabled = calculate_retry_params(
                attempt, initial_wet, self.config.retry
            )

            # Check for bypass
            if wet_ratio <= 0:
                # Complete bypass
                return self._create_bypass_result(
                    original, sample_rate, channels, duration_sec,
                    original_metrics, t0, "Wet ratio too low after retries"
                )

            # Create attempt config
            attempt_config = ProcessorConfig(
                strength=self.config.strength,
                wet_ratio=wet_ratio,
                reconstruction_enabled=recon_enabled and self.config.reconstruction_enabled,
                retry_enabled=False,  # Don't nest retries
                smoothing=self.config.smoothing,
                protection=self.config.protection,
                reconstruction=self.config.reconstruction,
                retry=self.config.retry,
                safety_thresholds=self.config.safety_thresholds,
            )

            # Process single attempt
            result = self._process_single(
                original, sample_rate, attempt_config, original_metrics, temp_dir
            )

            # Record attempt
            retry_history.attempts.append(RetryAttempt(
                attempt=attempt,
                wet_ratio=wet_ratio,
                reconstruction_enabled=recon_enabled,
                safety_result=result.safety_result,
            ))

            # Check if passed
            if result.safety_result.passed:
                retry_history.final_attempt = attempt
                retry_history.final_wet_ratio = wet_ratio
                retry_history.success = True
                result.retry_history = retry_history
                result.processing_time_ms = int((time.time() - t0) * 1000)
                return result

            # Save best result so far
            if best_result is None or (
                result.safety_result.can_retry and
                len(result.safety_result.failures) < len(best_safety.failures)
            ):
                best_result = result
                best_safety = result.safety_result

            # Check if should retry
            if not self.config.retry_enabled:
                break

            if not should_continue_retry(
                result.safety_result, attempt, wet_ratio, self.config.retry
            ):
                break

        # All retries exhausted or non-retryable failure
        retry_history.final_attempt = attempt
        retry_history.final_wet_ratio = wet_ratio if best_result else 0
        retry_history.bypassed = True
        retry_history.success = False

        # Return original on failure
        return self._create_bypass_result(
            original, sample_rate, channels, duration_sec,
            original_metrics, t0,
            f"Safety gate failed after {attempt} attempts",
            retry_history=retry_history,
            last_safety=best_safety,
        )

    def _process_single(
        self,
        original: np.ndarray,
        sample_rate: int,
        config: ProcessorConfig,
        original_metrics: dict,
        temp_dir: Optional[str],
    ) -> ProcessingResult:
        """Process a single attempt (no retry)."""
        t0 = time.time()

        # Make defensive copy of original to prevent any modification issues
        original = np.asarray(original, dtype=np.float64).copy()

        channels = original.shape[1]
        duration_sec = len(original) / sample_rate
        n_samples = original.shape[0]

        # WORKAROUND for Python 3.14/NumPy memory corruption:
        # Store original values in Python lists immediately to avoid memory corruption
        # that can occur when accessing NumPy array elements later.
        original_lists = []
        for c in range(channels):
            col_slice = original[:, c]
            original_lists.append([float(col_slice[i]) for i in range(n_samples)])

        # 1. Create SpectralContext
        ctx = SpectralContext.from_audio(original, sample_rate)

        # 2. Generate mask
        mask_result = generate_spectral_mask(ctx, config.strength)

        # Validate mask
        mask_valid, mask_issues = validate_mask(mask_result.mask)
        if not mask_valid:
            # Return bypass on invalid mask
            return self._create_error_result(
                original, sample_rate, channels, duration_sec,
                original_metrics, t0, f"Invalid mask: {mask_issues}"
            )

        # 3. Smooth mask
        smoothed_mask, smoothing_stats = smooth_mask(mask_result.mask, config.smoothing)

        # 4. Apply protection
        protection_result = apply_protection(smoothed_mask, ctx, config.protection)

        # 5. Apply mask to get processed magnitude
        processed_magnitude = ctx.linked_magnitude * protection_result.protected_mask

        # 6. Optional reconstruction
        reconstruction_result = None
        if config.reconstruction_enabled:
            reconstruction_result = apply_reconstruction(
                processed_magnitude,
                ctx.linked_magnitude,
                protection_result.transient_protection,
                protection_result.harmonic_weight,
                ctx.frequencies,
                config.reconstruction,
            )
            processed_magnitude = reconstruction_result.reconstructed_magnitude

        # 7. Reconstruct audio (ISTFT)
        # Apply same mask to both channels (stereo-linked)
        if channels == 2:
            # Create modified STFT for each channel
            modified_stft = np.zeros_like(ctx.complex_stft)
            for ch in range(channels):
                # Get per-channel magnitude
                ch_mag = ctx.per_channel_magnitude[ch]
                ch_phase = ctx.per_channel_phase[ch]

                # Scale magnitude (mask is based on linked_magnitude)
                # Scale factor = processed_magnitude / linked_magnitude
                # Cap scale to prevent numerical explosion (max +6 dB gain)
                scale = processed_magnitude / (ctx.linked_magnitude + 1e-10)
                scale = np.clip(scale, 0.0, 2.0)  # Limit to max 2x (+6 dB)
                scaled_mag = ch_mag * scale

                # Reconstruct complex
                modified_stft[ch] = scaled_mag * np.exp(1j * ch_phase)

            processed_wet = ctx.reconstruct(modified_stft)
        else:
            # Mono: simple mask application
            modified_stft = ctx.apply_mask(protection_result.protected_mask)
            processed_wet = ctx.reconstruct(modified_stft)

        # 8. Blend dry/wet
        wet_ratio = config.get_wet_ratio()

        # WORKAROUND for Python 3.14/NumPy memory corruption:
        # Extract wet signal values to Python lists immediately to avoid corruption
        wet_list = []
        for c in range(channels):
            wet_slice = processed_wet[:, c]
            wet_list.append([float(wet_slice[i]) for i in range(n_samples)])

        # Blend in pure Python using the captured values
        dry_ratio = 1.0 - wet_ratio
        blended_list = []
        for ch in range(channels):
            ch_blended = []
            for i in range(n_samples):
                val = dry_ratio * original_lists[ch][i] + wet_ratio * wet_list[ch][i]
                ch_blended.append(val)
            blended_list.append(ch_blended)

        # Convert back to numpy array
        blended = np.array(blended_list, dtype=np.float64).T

        # Compute RMS from original lists for blend result
        dry_rms = np.sqrt(np.mean([v*v for ch in original_lists for v in ch]))
        wet_rms = np.sqrt(np.mean([v*v for ch in wet_list for v in ch]))
        dry_rms_db = float(20 * np.log10(max(dry_rms, 1e-12)))
        wet_rms_db = float(20 * np.log10(max(wet_rms, 1e-12)))

        # Create BlendResult manually (bypassing blend_dry_wet due to memory corruption)
        from .blend import BlendResult
        blend_result = BlendResult(
            blended=blended,
            wet_ratio=wet_ratio,
            dry_rms_db=dry_rms_db,
            wet_rms_db_original=wet_rms_db,
            wet_rms_db_matched=wet_rms_db,  # No RMS matching for now
            gain_applied_db=0.0,
        )

        # 9. Peak control
        original_tp = original_metrics.get("true_peak_dbtp")
        if original_tp is None:
            # Estimate from sample peak
            original_tp = original_metrics.get("peak_db", 0)

        peak_control_result = apply_peak_control(
            blended, original_tp, sample_rate, temp_dir=temp_dir
        )
        cleaned = peak_control_result.audio

        # 10. Measure processed metrics
        processed_metrics = self._measure_full_metrics(cleaned, sample_rate, temp_dir)

        # Build original_for_blend from stored lists for safety evaluation
        original_for_blend = np.array(original_lists, dtype=np.float64).T

        # 11. Safety evaluation
        safety_result = evaluate_safety(
            original_for_blend, cleaned,
            sample_rate, sample_rate,
            original_metrics, processed_metrics,
            config.safety_thresholds,
        )

        # Compute difference metrics (use preserved original)
        difference = cleaned - original_for_blend
        difference_metrics = {
            "rms_db": float(20 * np.log10(max(np.sqrt(np.mean(difference ** 2)), 1e-12))),
            "peak_db": float(20 * np.log10(max(np.max(np.abs(difference)), 1e-12))),
        }

        return ProcessingResult(
            original=original_for_blend,
            processed_wet=processed_wet,
            cleaned=cleaned,
            sample_rate=sample_rate,
            channels=channels,
            duration_sec=duration_sec,
            mask_result=mask_result,
            smoothing_stats=smoothing_stats,
            protection_result=protection_result,
            reconstruction_result=reconstruction_result,
            blend_result=blend_result,
            peak_control_result=peak_control_result,
            safety_result=safety_result,
            retry_history=RetryHistory(),
            original_metrics=original_metrics,
            processed_metrics=processed_metrics,
            difference_metrics=difference_metrics,
            processing_time_ms=int((time.time() - t0) * 1000),
        )

    def _measure_full_metrics(
        self,
        audio: np.ndarray,
        sample_rate: int,
        temp_dir: Optional[str],
    ) -> dict:
        """Measure complete metrics including True Peak via FFmpeg."""
        metrics = measure_metrics(audio, sample_rate)

        # Add True Peak via FFmpeg if possible
        if temp_dir and _HAS_SF:
            try:
                with tempfile.NamedTemporaryFile(
                    suffix=".wav", dir=temp_dir, delete=False
                ) as f:
                    temp_path = f.name
                sf.write(temp_path, audio.astype(np.float32), sample_rate)
                tp = measure_true_peak_ffmpeg(temp_path)
                if tp is not None:
                    metrics["true_peak_dbtp"] = tp
                os.unlink(temp_path)
            except Exception:
                pass

        # Add clipping info
        clipping_info = check_clipping(audio)
        metrics.update(clipping_info)

        return metrics

    def _create_bypass_result(
        self,
        original: np.ndarray,
        sample_rate: int,
        channels: int,
        duration_sec: float,
        original_metrics: dict,
        t0: float,
        reason: str,
        retry_history: RetryHistory = None,
        last_safety: SafetyResult = None,
    ) -> ProcessingResult:
        """Create a bypass result (returns original)."""
        if retry_history is None:
            retry_history = RetryHistory()

        # Create dummy results for bypass
        ctx = SpectralContext.from_audio(original, sample_rate)
        mask_result = MaskResult(
            mask=np.ones((ctx.n_freq, ctx.n_frames)),
            noise_floor=np.zeros(ctx.n_freq),
            attenuation_limit=np.ones(ctx.n_freq),
            stats={"bypassed": True},
        )

        return ProcessingResult(
            original=original,
            processed_wet=original.copy(),
            cleaned=original.copy(),
            sample_rate=sample_rate,
            channels=channels,
            duration_sec=duration_sec,
            mask_result=mask_result,
            smoothing_stats={"bypassed": True},
            protection_result=ProtectionResult(
                protected_mask=np.ones((ctx.n_freq, ctx.n_frames)),
                transient_frames=np.zeros(ctx.n_frames, dtype=bool),
                transient_protection=np.zeros(ctx.n_frames),
                harmonic_weight=np.zeros((ctx.n_freq, ctx.n_frames)),
                stats={"bypassed": True},
            ),
            reconstruction_result=None,
            blend_result=BlendResult(
                blended=original.copy(),
                wet_ratio=0.0,
                dry_rms_db=original_metrics.get("rms_db", -60),
                wet_rms_db_original=original_metrics.get("rms_db", -60),
                wet_rms_db_matched=original_metrics.get("rms_db", -60),
                gain_applied_db=0.0,
            ),
            peak_control_result=PeakControlResult(
                audio=original.copy(),
                original_peak_dbtp=original_metrics.get("peak_db", 0),
                processed_peak_dbtp=original_metrics.get("peak_db", 0),
                corrected_peak_dbtp=original_metrics.get("peak_db", 0),
                gain_applied_db=0.0,
                clipping_introduced=False,
                measurement_method="bypass",
            ),
            safety_result=last_safety or SafetyResult(passed=True),
            retry_history=retry_history,
            original_metrics=original_metrics,
            processed_metrics=original_metrics.copy(),
            difference_metrics={"rms_db": -120, "peak_db": -120},
            processing_time_ms=int((time.time() - t0) * 1000),
            bypassed=True,
            bypass_reason=reason,
        )

    def _create_error_result(
        self,
        original: np.ndarray,
        sample_rate: int,
        channels: int,
        duration_sec: float,
        original_metrics: dict,
        t0: float,
        error: str,
    ) -> ProcessingResult:
        """Create an error result."""
        return self._create_bypass_result(
            original, sample_rate, channels, duration_sec,
            original_metrics, t0, f"Error: {error}"
        )


# ============================================================================
# Convenience function
# ============================================================================

def process_audio(
    audio: np.ndarray,
    sample_rate: int,
    strength: str = "gentle",
    wet_ratio: Optional[float] = None,
    reconstruction: bool = True,
    retry: bool = True,
    temp_dir: Optional[str] = None,
) -> ProcessingResult:
    """
    Convenience function for processing audio.

    Args:
        audio: Input audio
        sample_rate: Sample rate
        strength: Strength preset ("gentle" or "balanced")
        wet_ratio: Wet ratio (None = auto)
        reconstruction: Enable reconstruction
        retry: Enable adaptive retry
        temp_dir: Directory for temp files

    Returns:
        ProcessingResult
    """
    config = ProcessorConfig(
        strength=strength,
        wet_ratio=wet_ratio,
        reconstruction_enabled=reconstruction,
        retry_enabled=retry,
    )

    processor = Processor(config)
    return processor.process(audio, sample_rate, temp_dir)
