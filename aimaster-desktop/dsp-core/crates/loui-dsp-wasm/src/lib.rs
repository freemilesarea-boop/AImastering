//! WebAssembly binding for `loui-dsp`.
//!
//! Exposes the M2-lite analyzer to browser / renderer / Web Worker /
//! AudioWorklet hosts as a thin wasm-bindgen wrapper.  The hot path
//! (`process_planar`) accepts `Float32Array` views with zero-copy
//! semantics: wasm-bindgen creates a typed view directly over the WASM
//! linear memory, and the JS side passes the underlying buffer without
//! a JS-side allocation beyond the Float32Array headers.
//!
//! Returned snapshots are plain wasm-bindgen-exposed structs whose
//! fields are accessed via getters (also zero-allocation on the JS side).
//!
//! Build:
//! ```sh
//! wasm-pack build --release --target web crates/loui-dsp-wasm/
//! ```
//!
//! See docs/redesign/loui-mastering-v2/m2-lite-next/01-WASM-BINDING.md.

#![forbid(unsafe_code)]

use wasm_bindgen::prelude::*;

use loui_dsp::{
    analyzer::{AnalyzerGraph, AnalyzerOptions},
    MeterSnapshot,
};

/// Initialise crate-wide handlers.  Call once from JS before constructing
/// any analyzer.  Idempotent.
#[wasm_bindgen(start)]
pub fn start() {
    #[cfg(feature = "console-panic")]
    console_error_panic_hook::set_once();
}

/// Lightweight snapshot exposed to JS — every field accessed via getter.
///
/// `f64::NEG_INFINITY` is preserved across the JS boundary as `-Infinity`
/// (wasm-bindgen number conversion).  `NaN` indicates a value that needs
/// the full `Analyzer::snapshot()` (gated calc) instead of `tick_snapshot()`.
#[wasm_bindgen]
#[derive(Clone, Copy)]
pub struct WasmMeterSnapshot {
    inner: MeterSnapshot,
}

#[wasm_bindgen]
impl WasmMeterSnapshot {
    /// Integrated LUFS (NaN in tick snapshots — call `snapshot()` instead).
    #[wasm_bindgen(getter, js_name = integratedLufs)]
    pub fn integrated_lufs(&self) -> f64 { self.inner.integrated_lufs }

    /// Short-term (3 s) LUFS.
    #[wasm_bindgen(getter, js_name = shortTermLufs)]
    pub fn short_term_lufs(&self) -> f64 { self.inner.short_term_lufs }

    /// Momentary (400 ms) LUFS.
    #[wasm_bindgen(getter, js_name = momentaryLufs)]
    pub fn momentary_lufs(&self) -> f64 { self.inner.momentary_lufs }

    /// EBU R128 LRA (NaN in tick snapshots).
    #[wasm_bindgen(getter, js_name = loudnessRange)]
    pub fn loudness_range(&self) -> f64 { self.inner.loudness_range }

    /// True peak in dBTP.
    #[wasm_bindgen(getter, js_name = truePeakDbtp)]
    pub fn true_peak_dbtp(&self) -> f64 { self.inner.true_peak_dbtp }

    /// Sample peak in dBFS.
    #[wasm_bindgen(getter, js_name = samplePeakDb)]
    pub fn sample_peak_db(&self) -> f64 { self.inner.sample_peak_db }

    /// Sliding-window RMS in dBFS.
    #[wasm_bindgen(getter, js_name = rmsDb)]
    pub fn rms_db(&self) -> f64 { self.inner.rms_db }

    /// L/R Pearson correlation (-1..+1).
    #[wasm_bindgen(getter)]
    pub fn correlation(&self) -> f64 { self.inner.correlation }

    /// Mid/Side ratio in dB (+Infinity for mono).
    #[wasm_bindgen(getter, js_name = msRatioDb)]
    pub fn ms_ratio_db(&self) -> f64 { self.inner.ms_ratio_db }

    /// Number of gated 400-ms blocks contributing to integrated LUFS.
    #[wasm_bindgen(getter, js_name = gatedBlocks)]
    pub fn gated_blocks(&self) -> u32 { self.inner.gated_blocks }

    /// Number of audio samples observed (per-channel).
    #[wasm_bindgen(getter, js_name = samplesProcessed)]
    pub fn samples_processed(&self) -> f64 { self.inner.samples_processed as f64 }
}

/// WASM analyzer handle.  One per audio track / session.
#[wasm_bindgen]
pub struct LouiAnalyzer {
    graph: AnalyzerGraph,
}

#[wasm_bindgen]
impl LouiAnalyzer {
    /// Construct an analyzer.  Sample rate must be > 0; channels in 1..=8.
    ///
    /// Allocates internal state — call once per session, off the audio
    /// thread.  After this, `processPlanar` and `tickSnapshot` are safe
    /// from an AudioWorklet `process` callback.
    #[wasm_bindgen(constructor)]
    pub fn new(sample_rate: f64, channels: u32) -> Result<LouiAnalyzer, JsError> {
        if sample_rate <= 0.0 {
            return Err(JsError::new("sample_rate must be > 0"));
        }
        if channels == 0 || channels > 8 {
            return Err(JsError::new("channels must be in 1..=8"));
        }
        let opts = AnalyzerOptions {
            sample_rate,
            channels: channels as usize,
            peak_rms_window_sec: 1.0,
            stereo_window_sec: 1.0,
        };
        Ok(Self { graph: AnalyzerGraph::new(opts) })
    }

    /// Process a planar audio block.  Pass per-channel `Float32Array`s.
    ///
    /// Zero-copy: wasm-bindgen creates a slice view directly into WASM
    /// memory (the Float32Array contents are already there since JS
    /// allocated it via wasm.memory).
    ///
    /// Both channel arrays must have the same length.
    #[wasm_bindgen(js_name = processPlanar)]
    pub fn process_planar(&mut self, left: &[f32], right: Option<Vec<f32>>) -> Result<(), JsError> {
        // wasm-bindgen reads Option<Vec<f32>> as nullable Float32Array; for
        // a typed slice we cannot accept &[f32] for "optional" so we use
        // Vec on the second channel.  In practice the host pre-allocates
        // both buffers; the Vec allocation here is cheap and per-block.
        // For zero-overhead mono use `processMono`.
        let ch = self.graph.options().channels;
        if ch == 1 {
            if right.is_some() {
                return Err(JsError::new("analyzer constructed for mono — pass right=null"));
            }
            self.graph.process_planar(&[left]);
        } else if ch == 2 {
            let Some(r) = right.as_ref() else {
                return Err(JsError::new("right channel required for stereo analyzer"));
            };
            if r.len() != left.len() {
                return Err(JsError::new("L and R channel lengths must match"));
            }
            self.graph.process_planar(&[left, r.as_slice()]);
        } else {
            return Err(JsError::new("processPlanar supports 1 or 2 channels in WASM binding"));
        }
        Ok(())
    }

    /// Mono fast path — single-channel, no allocation on the JS side.
    #[wasm_bindgen(js_name = processMono)]
    pub fn process_mono(&mut self, samples: &[f32]) -> Result<(), JsError> {
        if self.graph.options().channels != 1 {
            return Err(JsError::new("analyzer not constructed for mono"));
        }
        self.graph.process_planar(&[samples]);
        Ok(())
    }

    /// Stereo fast path — pass L and R as separate Float32Arrays.
    /// Same length, channels=2 only.
    #[wasm_bindgen(js_name = processStereo)]
    pub fn process_stereo(&mut self, left: &[f32], right: &[f32]) -> Result<(), JsError> {
        if self.graph.options().channels != 2 {
            return Err(JsError::new("analyzer not constructed for stereo"));
        }
        if left.len() != right.len() {
            return Err(JsError::new("L and R channel lengths must match"));
        }
        self.graph.process_planar(&[left, right]);
        Ok(())
    }

    /// Lightweight snapshot — momentary + short-term LUFS + TP + peak/RMS
    /// + correlation.  Allocation-free, safe to call every audio quantum.
    #[wasm_bindgen(js_name = tickSnapshot)]
    pub fn tick_snapshot(&self) -> WasmMeterSnapshot {
        WasmMeterSnapshot { inner: self.graph.tick_snapshot() }
    }

    /// Full snapshot including integrated LUFS + LRA.  Allocates briefly
    /// (gated-block series) — call off the audio thread (e.g. from a
    /// Worker or after `flush()` at end of file).
    #[wasm_bindgen(js_name = snapshot)]
    pub fn snapshot(&self) -> WasmMeterSnapshot {
        WasmMeterSnapshot { inner: self.graph.snapshot() }
    }

    /// Finalise any pending partial 100-ms block.  Call before the final
    /// `snapshot()` at end of input for accurate integrated LUFS.
    #[wasm_bindgen(js_name = flush)]
    pub fn flush(&mut self) {
        self.graph.flush();
    }

    /// Reset all internal state.  Call when seeking, switching tracks,
    /// or after a configuration change.
    #[wasm_bindgen(js_name = reset)]
    pub fn reset(&mut self) {
        self.graph.reset();
    }

    /// Sample rate the analyzer was constructed with.
    #[wasm_bindgen(getter, js_name = sampleRate)]
    pub fn sample_rate(&self) -> f64 { self.graph.options().sample_rate }

    /// Channel count.
    #[wasm_bindgen(getter)]
    pub fn channels(&self) -> u32 { self.graph.options().channels as u32 }
}

/// Crate version string ("0.1.0" at M2-lite-NEXT).  Useful for sanity-
/// checking the bundled binary on the JS side.
#[wasm_bindgen(js_name = crateVersion)]
pub fn crate_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
