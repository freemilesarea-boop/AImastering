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
    spectrum::{SpectrumAnalyzer, SpectrumBinning, SpectrumOptions},
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

// ── Spectrum analyzer (M3-prep) ─────────────────────────────────────────────

/// Bin-layout enumeration mirrored on the JS side.
/// Construct via `WasmSpectrumOptions.binning*` factory methods to avoid
/// having to pass a tagged union across the FFI boundary.
#[derive(Clone, Copy)]
enum WasmBinning {
    ThirdOctave,
    Log { bins: usize, min_hz: f32, max_hz: f32 },
    Linear { bins: usize, min_hz: f32, max_hz: f32 },
}

/// JS-side construction options for `LouiSpectrumAnalyzer`.  Use the
/// builder methods (`thirdOctave`, `log`, `linear`) to set the binning.
#[wasm_bindgen]
pub struct WasmSpectrumOptions {
    fft_size: usize,
    hop_size: Option<usize>,
    binning: WasmBinning,
    smoothing: f32,
    peak_hold_decay_db: f32,
}

#[wasm_bindgen]
impl WasmSpectrumOptions {
    /// Construct with defaults (fft 2048 / log 128 bins / 50 % smoothing).
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            fft_size: 2048,
            hop_size: None,
            binning: WasmBinning::Log { bins: 128, min_hz: 20.0, max_hz: 20_000.0 },
            smoothing: 0.5,
            peak_hold_decay_db: 1.5,
        }
    }

    #[wasm_bindgen(js_name = setFftSize)]
    pub fn set_fft_size(mut self, n: usize) -> Self { self.fft_size = n; self }

    #[wasm_bindgen(js_name = setHopSize)]
    pub fn set_hop_size(mut self, n: usize) -> Self { self.hop_size = Some(n); self }

    #[wasm_bindgen(js_name = setSmoothing)]
    pub fn set_smoothing(mut self, s: f32) -> Self { self.smoothing = s; self }

    #[wasm_bindgen(js_name = setPeakHoldDecayDb)]
    pub fn set_peak_hold_decay_db(mut self, d: f32) -> Self { self.peak_hold_decay_db = d; self }

    /// Use ANSI 1/3-octave centres.
    #[wasm_bindgen(js_name = useThirdOctave)]
    pub fn use_third_octave(mut self) -> Self {
        self.binning = WasmBinning::ThirdOctave;
        self
    }

    /// Use log-spaced centres between min/max Hz.
    #[wasm_bindgen(js_name = useLog)]
    pub fn use_log(mut self, bins: usize, min_hz: f32, max_hz: f32) -> Self {
        self.binning = WasmBinning::Log { bins, min_hz, max_hz };
        self
    }

    /// Use linear-spaced centres between min/max Hz.
    #[wasm_bindgen(js_name = useLinear)]
    pub fn use_linear(mut self, bins: usize, min_hz: f32, max_hz: f32) -> Self {
        self.binning = WasmBinning::Linear { bins, min_hz, max_hz };
        self
    }
}

impl WasmSpectrumOptions {
    fn into_core(self) -> SpectrumOptions {
        SpectrumOptions {
            fft_size: self.fft_size,
            hop_size: self.hop_size,
            binning: match self.binning {
                WasmBinning::ThirdOctave => SpectrumBinning::ThirdOctave,
                WasmBinning::Log { bins, min_hz, max_hz } => {
                    SpectrumBinning::Log { bins, min_hz, max_hz }
                }
                WasmBinning::Linear { bins, min_hz, max_hz } => {
                    SpectrumBinning::Linear { bins, min_hz, max_hz }
                }
            },
            smoothing: self.smoothing,
            peak_hold_decay_db: self.peak_hold_decay_db,
        }
    }
}

/// Streaming FFT spectrum analyzer exposed to JS.
///
/// One per session.  Feed audio via `processMono` / `processStereo`,
/// poll `tryFrame()` to see whether new magnitudes are ready, then read
/// `magnitudeDb` / `peakHoldDb`.  The `binCentresHz` array is fixed for
/// the analyzer's lifetime.
#[wasm_bindgen]
pub struct LouiSpectrumAnalyzer {
    inner: SpectrumAnalyzer,
}

#[wasm_bindgen]
impl LouiSpectrumAnalyzer {
    /// Construct an analyzer.
    #[wasm_bindgen(constructor)]
    pub fn new(
        sample_rate: f64,
        options: WasmSpectrumOptions,
    ) -> Result<LouiSpectrumAnalyzer, JsError> {
        if sample_rate <= 0.0 {
            return Err(JsError::new("sample_rate must be > 0"));
        }
        if ![1024usize, 2048, 4096, 8192].contains(&options.fft_size) {
            return Err(JsError::new("fft_size must be 1024 / 2048 / 4096 / 8192"));
        }
        Ok(Self { inner: SpectrumAnalyzer::new(sample_rate, options.into_core()) })
    }

    /// Process a mono block — zero-copy from `Float32Array`.
    #[wasm_bindgen(js_name = processMono)]
    pub fn process_mono(&mut self, samples: &[f32]) {
        self.inner.process_planar(&[samples]);
    }

    /// Process a stereo block — channels are averaged to mono internally
    /// for spectrum analysis (perceptual visualisers want one curve).
    #[wasm_bindgen(js_name = processStereo)]
    pub fn process_stereo(&mut self, left: &[f32], right: &[f32]) -> Result<(), JsError> {
        if left.len() != right.len() {
            return Err(JsError::new("L and R channel lengths must match"));
        }
        self.inner.process_planar(&[left, right]);
        Ok(())
    }

    /// Try to compute an FFT frame.  Returns `true` iff a new frame is
    /// available — read magnitudes via `magnitudeDb` / `peakHoldDb`.
    #[wasm_bindgen(js_name = tryFrame)]
    pub fn try_frame(&mut self) -> bool {
        self.inner.try_frame()
    }

    /// Number of output bins.
    #[wasm_bindgen(getter, js_name = binCount)]
    pub fn bin_count(&self) -> usize {
        self.inner.bin_count()
    }

    /// Bin centre frequencies in Hz.  Fixed for the analyzer's lifetime
    /// — caller should cache this on first call.
    ///
    /// Returns a `Float32Array` view directly into WASM linear memory
    /// (zero-copy).  The view is valid until the analyzer is mutated;
    /// for safety, copy into a JS Float32Array if storing across calls.
    #[wasm_bindgen(getter, js_name = binCentresHz)]
    pub fn bin_centres_hz(&self) -> Vec<f32> {
        self.inner.bin_centres().to_vec()
    }

    /// Smoothed magnitude per bin in dB.  Same length as `binCount`.
    /// Returned as a copy — the underlying buffer is mutated by every
    /// `tryFrame` call.
    #[wasm_bindgen(getter, js_name = magnitudeDb)]
    pub fn magnitude_db(&self) -> Vec<f32> {
        self.inner.magnitude_db().to_vec()
    }

    /// Peak-hold magnitude per bin in dB.
    #[wasm_bindgen(getter, js_name = peakHoldDb)]
    pub fn peak_hold_db(&self) -> Vec<f32> {
        self.inner.peak_hold_db().to_vec()
    }

    /// Sample rate.
    #[wasm_bindgen(getter, js_name = sampleRate)]
    pub fn sample_rate(&self) -> f64 {
        self.inner.sample_rate()
    }

    /// FFT size in samples.
    #[wasm_bindgen(getter, js_name = fftSize)]
    pub fn fft_size(&self) -> usize {
        self.inner.fft_size()
    }

    /// Number of audio samples processed so far.
    #[wasm_bindgen(getter, js_name = samplesProcessed)]
    pub fn samples_processed(&self) -> f64 {
        self.inner.samples_processed() as f64
    }

    /// Reset analyzer state.
    #[wasm_bindgen(js_name = reset)]
    pub fn reset(&mut self) {
        self.inner.reset();
    }
}

// ── Mastering chain (M2-full) ───────────────────────────────────────────────
//
// Realtime-safe preview mastering chain exposed to the AudioWorklet tap.
// Configured from the product UI's renderable parameters; processes planar
// stereo in place.  The preview is a low-latency APPROXIMATION — the final
// export remains the Python/Rust offline render (see
// docs/.../m2-full/PREVIEW_EXPORT_CONSISTENCY.md).

use loui_dsp::{
    MasteringChain, MasteringChainConfig,
    EqConfig, DynamicsConfig, ImagerConfig, LimiterConfig,
    ParametricBand, ParametricBandType,
};

/// WASM handle for the preview mastering chain.
#[wasm_bindgen]
pub struct LouiMasteringChain {
    inner: MasteringChain,
}

#[wasm_bindgen]
impl LouiMasteringChain {
    /// Construct the chain for a sample rate.  Starts at unity (default
    /// config = transparent pass-through until the UI sets parameters).
    #[wasm_bindgen(constructor)]
    pub fn new(sample_rate: f64) -> LouiMasteringChain {
        LouiMasteringChain {
            inner: MasteringChain::new(sample_rate, MasteringChainConfig::default()),
        }
    }

    /// Update the full configuration from the UI parameters.  Flat
    /// argument list keeps the JS binding simple + zero-alloc.  Units are
    /// UI space (e.g. `width_pct` 0..200, `mix_pct` 0..100).
    #[allow(clippy::too_many_arguments)]
    /// Legacy positional configuration — the original five-module chain.
    ///
    /// Kept for hosts built before the full module suite existed.  Modules
    /// it does not mention are reset to their neutral defaults, so calling
    /// it gives exactly the old behaviour.  New hosts should call
    /// [`LouiMasteringChain::set_config_json`], which can address every
    /// module and only needs to send the ones it uses.
    #[wasm_bindgen(js_name = setConfig)]
    pub fn set_config(
        &mut self,
        input_gain_db: f64,
        // EQ
        eq_low_cut_hz: f64, eq_low_shelf_db: f64, eq_presence_db: f64, eq_air_db: f64,
        eq_adaptive: bool, eq_bypass: bool,
        // Dynamics
        dyn_threshold_db: f64, dyn_ratio: f64, dyn_attack_ms: f64, dyn_release_ms: f64,
        dyn_mix_pct: f64, dyn_bypass: bool,
        // Imager
        img_width_pct: f64, img_low_mono_hz: f64, img_bypass: bool,
        // Limiter
        lim_ceiling_dbtp: f64, lim_lookahead_ms: f64, lim_isp: bool, lim_bypass: bool,
        // Output
        output_gain_db: f64,
        master_bypass: bool,
    ) {
        self.inner.set_config(MasteringChainConfig {
            input_gain_db,
            eq: EqConfig {
                low_cut_hz: eq_low_cut_hz, low_shelf_db: eq_low_shelf_db,
                presence_db: eq_presence_db, air_db: eq_air_db,
                adaptive: eq_adaptive, bypass: eq_bypass,
            },
            dynamics: DynamicsConfig {
                threshold_db: dyn_threshold_db, ratio: dyn_ratio,
                attack_ms: dyn_attack_ms, release_ms: dyn_release_ms,
                mix_pct: dyn_mix_pct, bypass: dyn_bypass,
            },
            imager: ImagerConfig {
                width_pct: img_width_pct, low_mono_hz: img_low_mono_hz, bypass: img_bypass,
                ..ImagerConfig::default()
            },
            limiter: LimiterConfig {
                ceiling_dbtp: lim_ceiling_dbtp, lookahead_ms: lim_lookahead_ms,
                isp: lim_isp, bypass: lim_bypass,
                ..LimiterConfig::default()
            },
            output_gain_db,
            bypass: master_bypass,
            // Everything the legacy positional setter does not name keeps its
            // neutral default, so an old host gets exactly the old chain.
            ..MasteringChainConfig::default()
        });
    }

    /// Process one block of planar stereo audio in place.  The mutations
    /// are reflected back into the JS-side Float32Arrays.
    /// Configure the whole chain from a JSON object.
    ///
    /// Keys are camelCase and every one is optional — an absent module (or
    /// an absent field within one) keeps its neutral default.  That is what
    /// lets the UI send only the modules the user has touched instead of
    /// serialising 150 parameters on every knob move.
    ///
    /// Returns an error (leaving the chain untouched) when the JSON does not
    /// parse or a value has the wrong type, so a bad config can never put
    /// the audio thread into a half-applied state.
    #[wasm_bindgen(js_name = setConfigJson)]
    pub fn set_config_json(&mut self, json: &str) -> Result<(), JsError> {
        let cfg: MasteringChainConfig = serde_json::from_str(json)
            .map_err(|e| JsError::new(&format!("invalid chain config: {e}")))?;
        self.inner.set_config(cfg);
        Ok(())
    }

    /// Whether the dither stage is quantising.
    ///
    /// The export path reads this to decide whether the file writer should
    /// dither as well — dithering twice adds a second, uncorrelated noise
    /// floor for no benefit.
    #[wasm_bindgen(js_name = ditherEngaged)]
    pub fn dither_engaged(&self) -> bool {
        self.inner.dither_engaged()
    }

    /// The quantisation step the dither stage targets, in dBFS.
    /// Negative infinity when it is not quantising.
    #[wasm_bindgen(js_name = ditherLsbDbfs)]
    pub fn dither_lsb_dbfs(&self) -> f64 {
        self.inner.dither_lsb_dbfs()
    }

    /// Total processing latency in samples for the current config.
    #[wasm_bindgen(js_name = latencySamples)]
    pub fn latency_samples(&self) -> u32 {
        self.inner.latency_samples() as u32
    }

    /// Multiband dynamics gain reduction per band, low → high (dB, ≥ 0).
    #[wasm_bindgen(js_name = multibandGrDb)]
    pub fn multiband_gr_db(&self) -> Vec<f64> {
        self.inner.gain_reduction().multiband_db.to_vec()
    }

    /// De-esser gain reduction (dB, ≥ 0).
    #[wasm_bindgen(js_name = deessGrDb)]
    pub fn deess_gr_db(&self) -> f64 {
        self.inner.gain_reduction().deess_db
    }

    /// Vintage compressor gain reduction (dB, ≥ 0).
    #[wasm_bindgen(js_name = vintageCompGrDb)]
    pub fn vintage_comp_gr_db(&self) -> f64 {
        self.inner.gain_reduction().vintage_comp_db
    }

    /// Signed gain applied by each dynamic-EQ band (dB).
    #[wasm_bindgen(js_name = dynamicEqGainsDb)]
    pub fn dynamic_eq_gains_db(&self) -> Vec<f64> {
        self.inner.gain_reduction().dynamic_eq_db.to_vec()
    }

    /// Signed gain applied by each Impact band (dB).
    #[wasm_bindgen(js_name = impactMoveDb)]
    pub fn impact_move_db(&self) -> Vec<f64> {
        self.inner.gain_reduction().impact_db.to_vec()
    }

    /// Signed gain Low End Focus applied (dB).
    #[wasm_bindgen(js_name = lowEndFocusMoveDb)]
    pub fn low_end_focus_move_db(&self) -> f64 {
        self.inner.gain_reduction().low_end_focus_db
    }

    /// Deepest hum notch currently applied (dB, ≥ 0).
    #[wasm_bindgen(js_name = dehumDepthDb)]
    pub fn dehum_depth_db(&self) -> f64 {
        self.inner.gain_reduction().dehum_db
    }

    /// Measured long-term tonal curve, dB per curve band (Tonal Balance).
    /// Bands not yet observed read as a very low value rather than -inf, so
    /// the array survives the trip through JSON.
    #[wasm_bindgen(js_name = tonalCurveDb)]
    pub fn tonal_curve_db(&self) -> Vec<f64> {
        self.inner.tonal_curve_db().iter().map(|v| if v.is_finite() { *v } else { -140.0 }).collect()
    }

    /// Deviation of the tonal curve from the configured target, per band.
    #[wasm_bindgen(js_name = tonalDeviationDb)]
    pub fn tonal_deviation_db(&self) -> Vec<f64> {
        self.inner.tonal_deviation_db().to_vec()
    }

    /// The spectral correction currently applied, per curve band.
    #[wasm_bindgen(js_name = spectralCorrectionDb)]
    pub fn spectral_correction_db(&self) -> Vec<f64> {
        self.inner.spectral_correction_db().to_vec()
    }

    /// Whether the tonal analysis has observed enough audio to be trusted.
    #[wasm_bindgen(js_name = tonalAnalysisReady)]
    pub fn tonal_analysis_ready(&self) -> bool {
        self.inner.tonal_analysis_ready()
    }

    /// Samples the de-clicker has repaired since the last reset.
    #[wasm_bindgen(js_name = declickRepairCount)]
    pub fn declick_repair_count(&self) -> u32 {
        self.inner.declick_repair_count()
    }

    /// Start capturing a de-noise profile from the audio that follows.
    #[wasm_bindgen(js_name = denoiseBeginLearn)]
    pub fn denoise_begin_learn(&mut self) {
        self.inner.denoise_begin_learn();
    }

    /// Finish a de-noise profile capture.  Returns false (keeping the old
    /// profile) when nothing was captured.
    #[wasm_bindgen(js_name = denoiseFinishLearn)]
    pub fn denoise_finish_learn(&mut self) -> bool {
        self.inner.denoise_finish_learn()
    }

    /// Whether a usable de-noise profile exists.
    #[wasm_bindgen(js_name = denoiseHasProfile)]
    pub fn denoise_has_profile(&self) -> bool {
        self.inner.denoise_has_profile()
    }

    /// The learned noise floor, dBFS per FFT bin.
    #[wasm_bindgen(js_name = denoiseProfileDb)]
    pub fn denoise_profile_db(&self) -> Vec<f64> {
        let mut out = vec![0.0; loui_dsp::mastering::DENOISE_PROFILE_BINS];
        self.inner.denoise_profile_db(&mut out);
        out
    }

    #[wasm_bindgen(js_name = processStereo)]
    pub fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        self.inner.process_stereo_block(left, right);
    }

    /// Limiter gain reduction (dB, ≥ 0) from the last block.
    #[wasm_bindgen(js_name = limiterGrDb)]
    pub fn limiter_gr_db(&self) -> f64 {
        self.inner.gain_reduction().limiter_db
    }

    /// Dynamics (compressor) gain reduction (dB, ≥ 0) from the last block.
    #[wasm_bindgen(js_name = dynamicsGrDb)]
    pub fn dynamics_gr_db(&self) -> f64 {
        self.inner.gain_reduction().dynamics_db
    }

    /// Count of blocks the output-safety layer had to replace with the dry
    /// signal (non-finite or absurd peak).  0 in healthy operation.
    #[wasm_bindgen(js_name = safetyEvents)]
    pub fn safety_events(&self) -> u32 {
        self.inner.safety_events()
    }

    /// Clear all module state (transport seek / source swap).
    pub fn reset(&mut self) {
        self.inner.reset();
    }

    /// Replace the free parametric EQ band list.  Bands are passed as five
    /// parallel typed arrays so JS can populate them without per-band JS
    /// object overhead (single zero-copy pass into WASM memory):
    ///
    ///   types:    Uint8Array      0=HighPass, 1=LowPass, 2=Bell, 3=LowShelf, 4=HighShelf
    ///   freqs:    Float64Array    Hz
    ///   gains:    Float64Array    dB (ignored for cuts/passes)
    ///   qs:       Float64Array    Q (0.1..18)
    ///   enableds: Uint8Array      0 = off, non-zero = on
    ///
    /// All arrays must have the same length.  Pass empty arrays to clear
    /// all bands (chain becomes a parametric-EQ passthrough).
    #[wasm_bindgen(js_name = setParametricEqBands)]
    pub fn set_parametric_eq_bands(
        &mut self,
        types: &[u8], freqs: &[f64], gains: &[f64], qs: &[f64], enableds: &[u8],
    ) -> Result<(), JsError> {
        let n = types.len();
        if freqs.len() != n || gains.len() != n || qs.len() != n || enableds.len() != n {
            return Err(JsError::new("parametric EQ arrays must have equal length"));
        }
        // Build a small stack-friendly Vec; n is bounded by UI cap (7) but the
        // Rust chain accepts up to MAX_PARAMETRIC_BANDS (16).
        let mut bands: Vec<ParametricBand> = Vec::with_capacity(n);
        for i in 0..n {
            let kind = match types[i] {
                0 => ParametricBandType::HighPass,
                1 => ParametricBandType::LowPass,
                2 => ParametricBandType::Bell,
                3 => ParametricBandType::LowShelf,
                4 => ParametricBandType::HighShelf,
                other => return Err(JsError::new(&format!("invalid band type {other} at index {i}"))),
            };
            bands.push(ParametricBand {
                kind,
                frequency_hz: freqs[i],
                gain_db: gains[i],
                q: qs[i],
                enabled: enableds[i] != 0,
            });
        }
        self.inner.set_parametric_eq_bands(&bands);
        Ok(())
    }

    /// Count of currently-active parametric EQ bands (for diagnostics).
    #[wasm_bindgen(js_name = parametricEqBandCount)]
    pub fn parametric_eq_band_count(&self) -> u32 {
        self.inner.parametric_eq_band_count() as u32
    }
}
