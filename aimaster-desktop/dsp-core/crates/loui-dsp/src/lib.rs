//! Loui Mastering — DSP core (M2-lite).
//!
//! This crate provides realtime-safe analysis and metering primitives for the
//! Loui Mastering pipeline.  Scope intentionally narrow (per M2-lite brief):
//!
//!   * FFT analyzer (Cooley-Tukey radix-2)
//!   * EBU R128 LUFS meter (momentary / short-term / integrated + LRA)
//!   * 4× oversampled true-peak detector
//!   * Half-band FIR oversampler
//!   * Peak / RMS realtime meter
//!   * Stereo correlation + MS ratio meter
//!   * Audio buffer types + analyzer-graph foundation
//!
//! Out of scope (do NOT add to this crate without redesign): EQ, compressor,
//! saturator, limiter, full mastering chain.  Those remain in the Python
//! pipeline through M2-lite.  See
//! `docs/redesign/loui-mastering-v2/m2-lite/00-M2-LITE-SCOPE.md`.
//!
//! # Realtime-safety contract
//!
//! All processors:
//!   * Pre-allocate state in the constructor.
//!   * Never call `.alloc()`/`.dealloc()` in `process`/`tick` paths.
//!   * Never take locks.
//!   * Never block on I/O.
//!   * Are bounded — every loop has a compile-time or constructor-time bound.
//!
//! Violations are bugs.  See `src/realtime_contract.rs` (TODO M2-lite-NEXT)
//! for the planned `#[realtime_safe]` proc-macro that enforces this at
//! compile time.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

pub mod analyzer;
pub mod biquad;
pub mod buffer;
pub mod fft;
pub mod k_weighting;
pub mod lufs;
pub mod mastering;
pub mod oversample;
pub mod peak_rms;
pub mod spectrum;
pub mod stereo;
pub mod true_peak;
pub mod window;

/// Crate semver (M2-lite initial).
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Snapshot of all M2-lite meter outputs at a point in time.
///
/// Designed to be cheap-copy and serialisable to JSON / postMessage.
/// Field names mirror `ReferenceProfile.features.*` from
/// `packages/shared-types/src/profile/profile.ts` so the dsp-core output
/// is convertible to a partial profile without name remapping.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MeterSnapshot {
    /// Integrated LUFS (BS.1770-4).  -Infinity if no gated blocks observed.
    pub integrated_lufs: f64,
    /// Short-term LUFS — last 3-second window.  -Infinity for silence.
    pub short_term_lufs: f64,
    /// Momentary LUFS — last 400-ms window.  -Infinity for silence.
    pub momentary_lufs: f64,
    /// Loudness Range (EBU R128).
    pub loudness_range: f64,
    /// True peak in dBTP (4× oversampled).
    pub true_peak_dbtp: f64,
    /// Sample peak in dBFS.
    pub sample_peak_db: f64,
    /// Sliding-window RMS in dBFS.
    pub rms_db: f64,
    /// Pearson correlation between L and R (-1..+1).  +1.0 if mono.
    pub correlation: f64,
    /// Mid/Side energy ratio in dB.  +Infinity if mono.
    pub ms_ratio_db: f64,
    /// Number of blocks the LUFS gate has accepted so far.
    pub gated_blocks: u32,
    /// Number of audio samples processed (per-channel).
    pub samples_processed: u64,
}

impl Default for MeterSnapshot {
    fn default() -> Self {
        Self {
            integrated_lufs: f64::NEG_INFINITY,
            short_term_lufs: f64::NEG_INFINITY,
            momentary_lufs:  f64::NEG_INFINITY,
            loudness_range:  0.0,
            true_peak_dbtp:  f64::NEG_INFINITY,
            sample_peak_db:  f64::NEG_INFINITY,
            rms_db:          f64::NEG_INFINITY,
            correlation:     1.0,
            ms_ratio_db:     f64::INFINITY,
            gated_blocks:    0,
            samples_processed: 0,
        }
    }
}

// Re-exports of the most commonly used types.
pub use analyzer::{AnalyzerGraph, AnalyzerOptions};
pub use buffer::{AudioBlockMut, AudioBlockRef, AudioBuffer};
pub use mastering::{
    MasteringChain, MasteringChainConfig, GainReduction,
    EqConfig, DynamicsConfig, MultibandConfig, MultibandBandConfig,
    SaturationConfig, SaturationCharacter, ImagerConfig, LimiterConfig,
    ParametricBand, ParametricBandType, MAX_PARAMETRIC_BANDS,
};
