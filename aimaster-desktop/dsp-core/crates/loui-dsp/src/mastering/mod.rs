//! Mastering chain (M2-full) — realtime-safe preview mastering.
//!
//! A small, stable chain that lets the product UI's parameter changes be
//! *heard* in a low-latency preview, in the same module order the offline
//! Python/Rust render uses:
//!
//!   1. Input gain / gain staging
//!   2. EQ (gentle tone shaping)
//!   3. Dynamics (single-band glue compressor)
//!   4. Imager (M/S width + low-mono)
//!   5. Limiter (lookahead, true-peak-safe ceiling)
//!   6. Output gain
//!
//! Scope discipline (per M2-full brief): a SAFE preview chain, not an
//! Ozone-grade mastering suite.  Each module is realtime-safe:
//!   * all state pre-allocated in the constructor
//!   * no allocation / locks / I/O in `process_*`
//!   * bounded loops
//!
//! The preview is a *low-latency approximation*; the final export remains
//! the Python offline render (see PREVIEW_EXPORT_CONSISTENCY.md).  Both
//! consume the same EnginePreset / parameter values — only the engine
//! differs.

mod config;
mod gain;
mod declick;
mod dehum;
mod denoise;
mod deess;
mod dither;
mod dynamic_eq;
mod exciter;
mod impact;
mod low_end_focus;
mod monitor;
mod multiband;
mod spectral;
mod vintage;
mod eq;
mod parametric_eq;
mod dynamics;
mod imager;
mod delay;
mod reverb;
mod limiter;
mod chain;

pub use config::{
    MasteringChainConfig, EqConfig, DynamicsConfig, ImagerConfig, LimiterConfig,
    DenoiseConfig, DehumConfig, DeclickConfig, DeessConfig,
    DynamicEqConfig, DynEqBandConfig, DynEqBandShape, DynEqMode,
    MultibandConfig, MultibandBandConfig, MultibandMode,
    ExciterConfig, ExciterMode,
    ImpactConfig,
    LowEndFocusConfig, LowEndFocusMode,
    SpectralConfig, SPECTRAL_CURVE_BANDS,
    VintageEqConfig, VintageCompressorConfig, VintageTapeConfig, TapeSpeed,
    DitherConfig, DitherMode,
    MonitorConfig, MonitorMode, MatchTarget,
};
pub use monitor::{Monitor, MAX_ALIGN_SAMPLES};
pub use dither::Dither;
pub use spectral::{Spectral, CURVE_BANDS, curve_band_hz};
pub use vintage::{VintageEq, VintageCompressor, VintageTape};
pub use dynamic_eq::{DynamicEq, DYN_EQ_BANDS};
pub use exciter::Exciter;
pub use impact::Impact;
pub use low_end_focus::LowEndFocus;
pub use multiband::Multiband;
pub use declick::Declick;
pub use dehum::Dehum;
pub use denoise::{Denoise, DENOISE_FRAME};

/// Number of FFT bins in a de-noise profile (`DENOISE_FRAME / 2 + 1`).
pub const DENOISE_PROFILE_BINS: usize = DENOISE_FRAME / 2 + 1;
pub use deess::Deess;
pub use delay::{Delay, MAX_DELAY_S};
pub use reverb::{Reverb, MAX_PREDELAY_S};
pub use parametric_eq::{ParametricBand, ParametricBandType, MAX_PARAMETRIC_BANDS};
pub use chain::{MasteringChain, GainReduction};

/// A stereo processing module in the mastering chain.
///
/// Modules process planar stereo in place.  `bypass` short-circuits to a
/// pass-through.  `reset` clears internal state (filters, envelopes,
/// delay lines) — call on transport seek / source swap.
pub trait StereoModule {
    /// Process one block of planar stereo audio in place.
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]);
    /// Clear internal state.
    fn reset(&mut self);
}
