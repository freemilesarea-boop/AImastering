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
    spectrum::{SpectrumAnalyzer, SpectrumBinning, SpectrumOptions},
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

// ── Spectrum analyzer (M3-prep) ─────────────────────────────────────────────

/// Frame returned by the spectrum analyzer.  All arrays have the same
/// length (= bin count), determined once at construction.
///
/// Arrays are `Vec<f64>` because napi-rs auto-serialises `Vec<f64>` to JS
/// Number arrays.  For zero-copy `Float32Array` transfer, callers may
/// invoke `tryFrameTyped` (M3-follow-up) which copies into a caller-
/// supplied buffer.
#[napi(object)]
pub struct JsFftFrame {
    pub bin_centres_hz: Vec<f64>,
    pub magnitude_db: Vec<f64>,
    pub peak_hold_db: Vec<f64>,
    pub samples_processed: f64,
    pub sample_rate: f64,
    pub fft_size: u32,
}

/// Bin-layout enumeration for N-API constructor.
///
/// Use one of:
///   - `{ kind: 'thirdOctave' }`
///   - `{ kind: 'log',    bins: 128, minHz: 20, maxHz: 20000 }`
///   - `{ kind: 'linear', bins: 256, minHz: 0,  maxHz: 24000 }`
#[napi(object)]
pub struct JsSpectrumBinning {
    pub kind: String,
    pub bins: Option<u32>,
    pub min_hz: Option<f64>,
    pub max_hz: Option<f64>,
}

/// Construction-time options for the spectrum analyzer.
#[napi(object)]
pub struct JsSpectrumOptions {
    pub fft_size: u32,
    pub hop_size: Option<u32>,
    pub binning: JsSpectrumBinning,
    pub smoothing: f64,
    pub peak_hold_decay_db: f64,
}

fn binning_from_js(b: &JsSpectrumBinning) -> Result<SpectrumBinning> {
    match b.kind.as_str() {
        "thirdOctave" => Ok(SpectrumBinning::ThirdOctave),
        "log" => Ok(SpectrumBinning::Log {
            bins: b.bins.unwrap_or(128) as usize,
            min_hz: b.min_hz.unwrap_or(20.0) as f32,
            max_hz: b.max_hz.unwrap_or(20_000.0) as f32,
        }),
        "linear" => Ok(SpectrumBinning::Linear {
            bins: b.bins.unwrap_or(256) as usize,
            min_hz: b.min_hz.unwrap_or(0.0) as f32,
            max_hz: b.max_hz.unwrap_or(20_000.0) as f32,
        }),
        other => Err(Error::new(
            Status::InvalidArg,
            format!("unknown binning kind: {other:?}"),
        )),
    }
}

/// Streaming FFT spectrum analyzer.
#[napi]
pub struct LouiSpectrumAnalyzer {
    inner: SpectrumAnalyzer,
}

#[napi]
impl LouiSpectrumAnalyzer {
    #[napi(constructor)]
    pub fn new(sample_rate: f64, options: JsSpectrumOptions) -> Result<LouiSpectrumAnalyzer> {
        if sample_rate <= 0.0 {
            return Err(Error::new(Status::InvalidArg, "sampleRate must be > 0".to_string()));
        }
        let fft_size = options.fft_size as usize;
        if ![1024usize, 2048, 4096, 8192].contains(&fft_size) {
            return Err(Error::new(
                Status::InvalidArg,
                "fftSize must be one of 1024 / 2048 / 4096 / 8192".to_string(),
            ));
        }
        let core_opts = SpectrumOptions {
            fft_size,
            hop_size: options.hop_size.map(|h| h as usize),
            binning: binning_from_js(&options.binning)?,
            smoothing: options.smoothing as f32,
            peak_hold_decay_db: options.peak_hold_decay_db as f32,
        };
        Ok(Self { inner: SpectrumAnalyzer::new(sample_rate, core_opts) })
    }

    #[napi]
    pub fn process_mono(&mut self, samples: Float32Array) {
        self.inner.process_planar(&[samples.as_ref()]);
    }

    #[napi]
    pub fn process_stereo(
        &mut self,
        left: Float32Array,
        right: Float32Array,
    ) -> Result<()> {
        if left.len() != right.len() {
            return Err(Error::new(
                Status::InvalidArg,
                "L and R lengths must match".to_string(),
            ));
        }
        self.inner.process_planar(&[left.as_ref(), right.as_ref()]);
        Ok(())
    }

    /// Try to compute an FFT frame.  Returns the frame if one was produced,
    /// or `null` if not enough samples have accumulated yet.
    #[napi]
    pub fn try_frame(&mut self) -> Option<JsFftFrame> {
        if !self.inner.try_frame() {
            return None;
        }
        Some(JsFftFrame {
            bin_centres_hz: self.inner.bin_centres().iter().map(|&v| v as f64).collect(),
            magnitude_db:   self.inner.magnitude_db().iter().map(|&v| v as f64).collect(),
            peak_hold_db:   self.inner.peak_hold_db().iter().map(|&v| v as f64).collect(),
            samples_processed: self.inner.samples_processed() as f64,
            sample_rate:    self.inner.sample_rate(),
            fft_size:       self.inner.fft_size() as u32,
        })
    }

    #[napi]
    pub fn reset(&mut self) {
        self.inner.reset();
    }

    #[napi(getter)]
    pub fn sample_rate(&self) -> f64 { self.inner.sample_rate() }

    #[napi(getter)]
    pub fn fft_size(&self) -> u32 { self.inner.fft_size() as u32 }

    #[napi(getter)]
    pub fn bin_count(&self) -> u32 { self.inner.bin_count() as u32 }
}
