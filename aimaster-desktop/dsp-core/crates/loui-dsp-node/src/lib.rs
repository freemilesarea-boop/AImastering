//! Node.js / Electron native binding for `loui-dsp` via `napi-rs`.
//!
//! Exposes the M2-lite analyzer to Electron main / renderer JS as a
//! `.node` add-on.  In-process call latency is < 1 µs per `processStereo`
//! invocation (compare with WASM at ~2 µs and subprocess `analyze_wav`
//! at ~5 ms).
//!
//! Build:
//! ```sh
//! # one-time: install napi-rs CLI
//! npm install -g @napi-rs/cli
//!
//! # build for the host platform
//! cd crates/loui-dsp-node
//! napi build --release --platform
//! ```
//!
//! The resulting `loui-dsp-node.<platform>.node` is loaded from JS via
//! `require('./loui-dsp-node.linux-x64-gnu.node')` or similar.
//!
//! See docs/redesign/loui-mastering-v2/m2-lite-next/02-N-API-BINDING.md.

#![deny(clippy::all)]
#![forbid(unsafe_code)]

#[macro_use]
extern crate napi_derive;

use napi::bindgen_prelude::*;

use loui_dsp::{
    analyzer::{AnalyzerGraph, AnalyzerOptions},
    MeterSnapshot,
};

/// `MeterSnapshot` mirror with napi-derive auto-serialisation.
///
/// All fields are camelCase on the JS side (napi-rs default).  `f64::NAN`
/// becomes `NaN` in JS; `f64::NEG_INFINITY` becomes `-Infinity`.
#[napi(object)]
pub struct JsMeterSnapshot {
    pub integrated_lufs: f64,
    pub short_term_lufs: f64,
    pub momentary_lufs: f64,
    pub loudness_range: f64,
    pub true_peak_dbtp: f64,
    pub sample_peak_db: f64,
    pub rms_db: f64,
    pub correlation: f64,
    pub ms_ratio_db: f64,
    pub gated_blocks: u32,
    /// JS `Number` precision covers > 9 × 10¹⁵ — enough for ~5,800 years
    /// of 48-kHz audio.  No BigInt needed.
    pub samples_processed: f64,
}

impl From<MeterSnapshot> for JsMeterSnapshot {
    fn from(s: MeterSnapshot) -> Self {
        Self {
            integrated_lufs: s.integrated_lufs,
            short_term_lufs: s.short_term_lufs,
            momentary_lufs: s.momentary_lufs,
            loudness_range: s.loudness_range,
            true_peak_dbtp: s.true_peak_dbtp,
            sample_peak_db: s.sample_peak_db,
            rms_db: s.rms_db,
            correlation: s.correlation,
            ms_ratio_db: s.ms_ratio_db,
            gated_blocks: s.gated_blocks,
            samples_processed: s.samples_processed as f64,
        }
    }
}

/// Native analyzer handle.  One per audio session.
///
/// **Memory ownership:** the underlying `AnalyzerGraph` lives on the Rust
/// side.  JS holds a reference via the napi object handle; when the JS
/// object is GC'd, `Drop` is called and the Rust state is released.
/// Caller is responsible for not retaining the handle across track
/// changes if the channel count changes (recreate instead).
#[napi]
pub struct LouiAnalyzer {
    inner: AnalyzerGraph,
}

#[napi]
impl LouiAnalyzer {
    /// Construct an analyzer.  `sampleRate > 0`, `channels` in 1..=8.
    #[napi(constructor)]
    pub fn new(sample_rate: f64, channels: u32) -> Result<LouiAnalyzer> {
        if sample_rate <= 0.0 {
            return Err(Error::new(Status::InvalidArg, "sampleRate must be > 0".to_string()));
        }
        if !(1..=8).contains(&channels) {
            return Err(Error::new(Status::InvalidArg, "channels must be in 1..=8".to_string()));
        }
        Ok(Self {
            inner: AnalyzerGraph::new(AnalyzerOptions {
                sample_rate,
                channels: channels as usize,
                peak_rms_window_sec: 1.0,
                stereo_window_sec: 1.0,
            }),
        })
    }

    /// Mono fast path.  Accepts a `Float32Array` (zero-copy view over the
    /// V8 typed-array buffer).
    #[napi]
    pub fn process_mono(&mut self, samples: Float32Array) -> Result<()> {
        if self.inner.options().channels != 1 {
            return Err(Error::new(Status::InvalidArg, "analyzer not mono".to_string()));
        }
        self.inner.process_planar(&[samples.as_ref()]);
        Ok(())
    }

    /// Stereo fast path.  `left.length === right.length`.
    #[napi]
    pub fn process_stereo(
        &mut self,
        left: Float32Array,
        right: Float32Array,
    ) -> Result<()> {
        if self.inner.options().channels != 2 {
            return Err(Error::new(Status::InvalidArg, "analyzer not stereo".to_string()));
        }
        let l = left.as_ref();
        let r = right.as_ref();
        if l.len() != r.len() {
            return Err(Error::new(
                Status::InvalidArg,
                "L and R channel lengths must match".to_string(),
            ));
        }
        self.inner.process_planar(&[l, r]);
        Ok(())
    }

    /// Lightweight snapshot (audio-thread safe).
    #[napi]
    pub fn tick_snapshot(&self) -> JsMeterSnapshot {
        self.inner.tick_snapshot().into()
    }

    /// Full snapshot — includes integrated LUFS + LRA.  Allocates briefly
    /// during gated-block calculation; call off the audio thread.
    #[napi]
    pub fn snapshot(&self) -> JsMeterSnapshot {
        self.inner.snapshot().into()
    }

    /// Finalise any pending partial 100-ms block before the last
    /// `snapshot()`.
    #[napi]
    pub fn flush(&mut self) {
        self.inner.flush();
    }

    /// Reset analyzer state.  Use at end-of-track or on configuration change.
    #[napi]
    pub fn reset(&mut self) {
        self.inner.reset();
    }

    #[napi(getter)]
    pub fn sample_rate(&self) -> f64 {
        self.inner.options().sample_rate
    }

    #[napi(getter)]
    pub fn channels(&self) -> u32 {
        self.inner.options().channels as u32
    }
}

/// Crate version string.  Useful for the JS host to sanity-check the
/// bundled `.node` file matches expectations.
#[napi]
pub fn crate_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
