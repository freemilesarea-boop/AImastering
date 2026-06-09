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
mod eq;
mod parametric_eq;
mod crossover;
mod dynamics;
mod multiband;
mod imager;
mod limiter;
mod chain;

pub use config::{
    MasteringChainConfig, EqConfig, DynamicsConfig, MultibandConfig, MultibandBandConfig,
    ImagerConfig, LimiterConfig,
};
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
