//! Streaming spectrum analyzer (M3 entry preparation).
//!
//! Maintains a ring buffer of recent samples, periodically computes a
//! windowed FFT, applies log/linear/third-octave binning, exponential
//! smoothing, and peak-hold.  Output is a bounded magnitude vector that
//! the binding layer can ship to the UI without further work.
//!
//! Realtime-safe contract:
//!   - All state pre-allocated in `new`.
//!   - `process_planar` is allocation-free.
//!   - `try_frame()` produces a borrowed slice — no allocation.
//!
//! Reference: docs/redesign/loui-mastering-v2/m3-entry/00-FFT-STREAMING.md.

use crate::fft::Fft;
use crate::window::Window;

/// How the magnitude output is binned along frequency.
#[derive(Debug, Clone, Copy)]
pub enum SpectrumBinning {
    /// ANSI S1.11 1/3-octave centres (30 bins, 25 Hz .. 20 kHz).
    /// Pre-defined; ignores any caller-supplied min/max/count.
    ThirdOctave,
    /// Log-spaced bins between min/max Hz.  Useful for spectrum visualisers.
    Log {
        /// Number of output bins.  Hard-capped at `MAX_OUTPUT_BINS = 256`.
        bins: usize,
        /// Lower frequency edge (Hz).
        min_hz: f32,
        /// Upper frequency edge (Hz).
        max_hz: f32,
    },
    /// Linear-spaced bins between min/max Hz.
    Linear {
        /// Number of output bins.  Hard-capped at `MAX_OUTPUT_BINS = 256`.
        bins: usize,
        /// Lower frequency edge (Hz).
        min_hz: f32,
        /// Upper frequency edge (Hz).
        max_hz: f32,
    },
}

/// Bin count cap.  Keeps `postMessage` payloads bounded and prevents
/// fingerprint-resolution misuse.
pub const MAX_OUTPUT_BINS: usize = 256;

/// FFT sizes the analyzer supports.  Power-of-two only (FFT constraint).
pub const SUPPORTED_FFT_SIZES: &[usize] = &[1024, 2048, 4096, 8192];

const THIRD_OCT_CENTRES: &[f32] = &[
    25.0, 31.5, 40.0, 50.0, 63.0, 80.0, 100.0, 125.0, 160.0, 200.0,
    250.0, 315.0, 400.0, 500.0, 630.0, 800.0, 1000.0, 1250.0, 1600.0, 2000.0,
    2500.0, 3150.0, 4000.0, 5000.0, 6300.0, 8000.0, 10000.0, 12500.0, 16000.0, 20000.0,
];

/// Streaming spectrum analyzer.
#[derive(Debug)]
pub struct SpectrumAnalyzer {
    sample_rate: f64,
    fft_size: usize,
    hop_size: usize,
    fft: Fft,
    win: Window,
    /// Ring buffer of input samples (mono — multi-channel mixed in).
    ring: Vec<f32>,
    ring_idx: usize,
    /// Samples accumulated since last FFT frame.
    accum: usize,
    /// Scratch buffers, pre-allocated.
    scratch_re: Vec<f64>,
    scratch_im: Vec<f64>,
    scratch_mag: Vec<f64>,
    /// Output bin definition.
    bin_centres_hz: Vec<f32>,
    /// Smoothed magnitude (dB) per output bin.
    smoothed_db: Vec<f32>,
    /// Peak-hold magnitude (dB) per output bin.
    peak_hold_db: Vec<f32>,
    /// Smoothing coefficient (0..1).  Larger = slower.
    smoothing_coef: f32,
    /// Peak-hold decay (dB per frame).
    peak_hold_decay_db: f32,
    /// Whether any FFT frame has been computed.
    has_frame: bool,
    samples_processed: u64,
}

/// Construction options for `SpectrumAnalyzer`.
#[derive(Debug, Clone, Copy)]
pub struct SpectrumOptions {
    /// FFT size — must be one of `SUPPORTED_FFT_SIZES`.
    pub fft_size: usize,
    /// Hop size in samples.  Default = `fft_size / 2` (50 % overlap).
    pub hop_size: Option<usize>,
    /// Output binning.
    pub binning: SpectrumBinning,
    /// Smoothing time constant (0..1).  0.5 default — frame-to-frame
    /// mixing of 50 %.
    pub smoothing: f32,
    /// Peak-hold decay rate, dB per FFT frame.  1.5 default.
    pub peak_hold_decay_db: f32,
}

impl Default for SpectrumOptions {
    fn default() -> Self {
        Self {
            fft_size: 2048,
            hop_size: None,
            binning: SpectrumBinning::Log { bins: 128, min_hz: 20.0, max_hz: 20_000.0 },
            smoothing: 0.5,
            peak_hold_decay_db: 1.5,
        }
    }
}

impl SpectrumAnalyzer {
    /// Construct.  Allocates internal buffers.
    pub fn new(sample_rate: f64, options: SpectrumOptions) -> Self {
        assert!(sample_rate > 0.0, "sample_rate must be > 0");
        assert!(
            SUPPORTED_FFT_SIZES.contains(&options.fft_size),
            "fft_size must be one of {:?}",
            SUPPORTED_FFT_SIZES
        );
        let fft_size = options.fft_size;
        let hop_size = options.hop_size.unwrap_or(fft_size / 2).max(1);
        let win = Window::hann(fft_size);
        let fft = Fft::new(fft_size);
        let bin_centres_hz = build_centres(sample_rate, fft_size, options.binning);
        let n = bin_centres_hz.len();
        Self {
            sample_rate,
            fft_size,
            hop_size,
            fft,
            win,
            ring: vec![0.0; fft_size],
            ring_idx: 0,
            accum: 0,
            scratch_re: vec![0.0; fft_size],
            scratch_im: vec![0.0; fft_size],
            scratch_mag: vec![0.0; fft_size / 2 + 1],
            bin_centres_hz,
            smoothed_db: vec![f32::NEG_INFINITY; n],
            peak_hold_db: vec![f32::NEG_INFINITY; n],
            smoothing_coef: options.smoothing.clamp(0.0, 0.999),
            peak_hold_decay_db: options.peak_hold_decay_db.max(0.0),
            has_frame: false,
            samples_processed: 0,
        }
    }

    /// Sample rate.
    pub fn sample_rate(&self) -> f64 { self.sample_rate }
    /// FFT size.
    pub fn fft_size(&self) -> usize { self.fft_size }
    /// Hop size in samples.
    pub fn hop_size(&self) -> usize { self.hop_size }
    /// Number of output bins.
    pub fn bin_count(&self) -> usize { self.bin_centres_hz.len() }
    /// Bin centre frequencies in Hz.
    pub fn bin_centres(&self) -> &[f32] { &self.bin_centres_hz }
    /// Samples processed (per-channel input).
    pub fn samples_processed(&self) -> u64 { self.samples_processed }

    /// Reset all internal state.
    pub fn reset(&mut self) {
        for v in self.ring.iter_mut()         { *v = 0.0; }
        for v in self.smoothed_db.iter_mut()  { *v = f32::NEG_INFINITY; }
        for v in self.peak_hold_db.iter_mut() { *v = f32::NEG_INFINITY; }
        self.ring_idx = 0;
        self.accum = 0;
        self.has_frame = false;
        self.samples_processed = 0;
    }

    /// Process a planar block.  Mixes channels to mono for spectrum
    /// analysis (perceptual visualisers want a single curve).
    pub fn process_planar(&mut self, channels: &[&[f32]]) {
        if channels.is_empty() {
            return;
        }
        let frames = channels[0].len();
        let inv_ch = 1.0 / channels.len() as f32;
        for i in 0..frames {
            let mut s = 0.0f32;
            for ch in channels {
                s += ch[i];
            }
            s *= inv_ch;
            self.ring[self.ring_idx] = s;
            self.ring_idx += 1;
            if self.ring_idx >= self.fft_size {
                self.ring_idx = 0;
            }
            self.accum += 1;
        }
        self.samples_processed += frames as u64;
    }

    /// Try to compute an FFT frame if enough hop-sized samples have
    /// accumulated.  Returns true if a frame was produced; the magnitudes
    /// are accessible via `magnitude_db()` / `peak_hold_db()`.
    ///
    /// Realtime-safe: zero allocation.
    pub fn try_frame(&mut self) -> bool {
        if self.accum < self.hop_size {
            return false;
        }
        self.accum = 0;

        // Copy ring (oldest first) into scratch_re.
        for i in 0..self.fft_size {
            let read = (self.ring_idx + i) % self.fft_size;
            self.scratch_re[i] = self.ring[read] as f64;
            self.scratch_im[i] = 0.0;
        }
        // Apply window.
        // Window stores f32 coeffs; we multiply into the f64 scratch.
        // No alloc.
        self.apply_window_to_scratch();
        // FFT in place.
        self.fft.process(&mut self.scratch_re, &mut self.scratch_im);
        // Magnitudes.
        let half = self.fft_size / 2;
        let norm = (self.win.coefficient_sum() as f64) / 2.0;
        for k in 0..=half {
            let r = self.scratch_re[k];
            let i = self.scratch_im[k];
            self.scratch_mag[k] = (r * r + i * i).sqrt() / norm;
        }
        // Bin to output centres + log-magnitude + smooth + peak-hold.
        self.bin_and_smooth();
        self.has_frame = true;
        true
    }

    fn apply_window_to_scratch(&mut self) {
        // Apply the Hann window (f32 coeffs) to the f64 scratch.  Iterate
        // by index to avoid borrow-checker grief.
        let coeffs = self.win.coeffs();
        for i in 0..self.fft_size {
            self.scratch_re[i] *= coeffs[i] as f64;
        }
    }

    fn bin_and_smooth(&mut self) {
        let half = self.fft_size / 2;
        let freq_step = self.sample_rate as f32 / self.fft_size as f32;
        let coef = self.smoothing_coef;
        let one_minus_coef = 1.0 - coef;
        let decay = self.peak_hold_decay_db;

        for (out_idx, &cf) in self.bin_centres_hz.iter().enumerate() {
            // Map centre frequency to an FFT bin range.  Use ±half-bin
            // for linear, log-spaced for log/3-oct.
            let (lo, hi) = bin_range(cf, &self.bin_centres_hz, out_idx, freq_step);
            let lo_bin = ((lo / freq_step).round() as usize).min(half);
            let hi_bin = ((hi / freq_step).round() as usize).min(half).max(lo_bin + 1);

            let mut sum = 0.0f64;
            let mut count = 0usize;
            for k in lo_bin..hi_bin.min(half + 1) {
                let m = self.scratch_mag[k];
                sum += m * m;
                count += 1;
            }
            let new_db = if count == 0 {
                f32::NEG_INFINITY
            } else {
                let rms = (sum / count as f64).sqrt();
                if rms > 0.0 {
                    (20.0 * rms.log10()) as f32
                } else {
                    f32::NEG_INFINITY
                }
            };

            // Smoothing (linear-dB EMA).
            let prev = self.smoothed_db[out_idx];
            let cur = if prev.is_finite() && new_db.is_finite() {
                coef * prev + one_minus_coef * new_db
            } else if new_db.is_finite() {
                new_db
            } else {
                prev
            };
            self.smoothed_db[out_idx] = cur;

            // Peak hold.
            let prev_peak = self.peak_hold_db[out_idx];
            let decayed = if prev_peak.is_finite() {
                prev_peak - decay
            } else {
                f32::NEG_INFINITY
            };
            self.peak_hold_db[out_idx] = if cur.is_finite() && cur > decayed {
                cur
            } else {
                decayed
            };
        }
    }

    /// Smoothed magnitude in dB per output bin.  Same length as `bin_centres()`.
    pub fn magnitude_db(&self) -> &[f32] { &self.smoothed_db }

    /// Peak-hold magnitude in dB per output bin.
    pub fn peak_hold_db(&self) -> &[f32] { &self.peak_hold_db }

    /// Whether at least one frame has been produced.
    pub fn has_frame(&self) -> bool { self.has_frame }
}

/// Compute the [lo, hi) Hz range an output bin represents.
fn bin_range(cf: f32, centres: &[f32], idx: usize, freq_step: f32) -> (f32, f32) {
    let lo = if idx == 0 {
        // First bin: from DC (or freq_step) to midpoint to next centre.
        (centres[1] * cf).sqrt().max(freq_step)
    } else {
        (centres[idx - 1] * cf).sqrt()
    };
    let hi = if idx + 1 == centres.len() {
        cf * 2.0  // last bin: one octave above
    } else {
        (centres[idx + 1] * cf).sqrt()
    };
    (lo, hi)
}

/// Build bin centre frequency table.
fn build_centres(sample_rate: f64, _fft_size: usize, binning: SpectrumBinning) -> Vec<f32> {
    let nyquist = (sample_rate / 2.0) as f32;
    let max_useful = nyquist.min(20_000.0);
    let initial: Vec<f32> = match binning {
        SpectrumBinning::ThirdOctave => {
            THIRD_OCT_CENTRES
                .iter()
                .copied()
                .filter(|c| *c <= max_useful)
                .collect()
        }
        SpectrumBinning::Log { bins, min_hz, max_hz } => {
            let bins = bins.min(MAX_OUTPUT_BINS).max(2);
            let mn = min_hz.max(1.0);
            let mx = max_hz.min(max_useful);
            let log_min = mn.log10();
            let log_max = mx.log10();
            let step = (log_max - log_min) / (bins - 1) as f32;
            (0..bins)
                .map(|i| 10f32.powf(log_min + step * i as f32))
                .collect()
        }
        SpectrumBinning::Linear { bins, min_hz, max_hz } => {
            let bins = bins.min(MAX_OUTPUT_BINS).max(2);
            let mn = min_hz.max(0.0);
            let mx = max_hz.min(max_useful);
            let step = (mx - mn) / (bins - 1) as f32;
            (0..bins).map(|i| mn + step * i as f32).collect()
        }
    };
    // Filter is tolerant — float rounding can push the last bin a hair
    // above max_useful, which is harmless.  We keep anything within 1 Hz.
    initial
        .into_iter()
        .filter(|c| *c >= 1.0 && *c <= max_useful + 1.0)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A 1 kHz sine should produce a peak in the bin nearest 1 kHz.
    #[test]
    fn one_khz_sine_peak_at_correct_bin() {
        let sr = 48_000.0;
        let opts = SpectrumOptions {
            fft_size: 4096,
            hop_size: Some(2048),
            binning: SpectrumBinning::ThirdOctave,
            smoothing: 0.0, // no smoothing — single frame should be enough
            peak_hold_decay_db: 0.0,
        };
        let mut sa = SpectrumAnalyzer::new(sr, opts);
        let n = 4096 * 8;
        let buf: Vec<f32> = (0..n)
            .map(|i| (2.0 * std::f32::consts::PI * 1000.0 * i as f32 / sr as f32).sin())
            .collect();
        sa.process_planar(&[&buf]);
        let mut produced = 0;
        while sa.try_frame() { produced += 1; }
        assert!(produced >= 1, "no frame produced");
        assert!(sa.has_frame());

        let mag = sa.magnitude_db();
        let centres = sa.bin_centres();
        // Find peak bin.
        let mut peak_idx = 0usize;
        let mut peak_db = f32::NEG_INFINITY;
        for (i, &v) in mag.iter().enumerate() {
            if v > peak_db { peak_db = v; peak_idx = i; }
        }
        let peak_cf = centres[peak_idx];
        // 1/3-oct bin nearest 1 kHz is 1000 Hz exactly.  Tolerance ±1/3 oct.
        assert!(
            (peak_cf / 1000.0).log2().abs() < 0.4,
            "peak bin {} Hz not near 1 kHz (db={})", peak_cf, peak_db,
        );
    }

    /// DC signal should put energy in the low end (Hann window leakage
    /// spreads from FFT bin 0 across the first few bins).  We check that
    /// the peak sits in the lowest 5 output bins, not strictly bin 0.
    #[test]
    fn dc_input_peaks_at_low_end() {
        let mut sa = SpectrumAnalyzer::new(48_000.0, SpectrumOptions {
            fft_size: 2048,
            hop_size: Some(1024),
            binning: SpectrumBinning::ThirdOctave,
            smoothing: 0.0,
            peak_hold_decay_db: 0.0,
        });
        let buf = vec![1.0f32; 8192];
        sa.process_planar(&[&buf]);
        while sa.try_frame() {}
        let mag = sa.magnitude_db();
        let max_idx = mag
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.partial_cmp(b.1).unwrap())
            .unwrap()
            .0;
        assert!(max_idx < 5, "DC peak at bin {max_idx} — expected low-end");
    }

    /// Silent input should yield -Infinity magnitudes everywhere.
    #[test]
    fn silence_yields_neg_inf() {
        let mut sa = SpectrumAnalyzer::new(48_000.0, SpectrumOptions::default());
        let buf = vec![0.0f32; 16384];
        sa.process_planar(&[&buf]);
        while sa.try_frame() {}
        for &v in sa.magnitude_db() {
            assert!(v < -200.0 || !v.is_finite(), "silence non-neg-inf: {v}");
        }
    }

    /// Log binning must produce monotonically increasing bin centres.
    #[test]
    fn log_centres_monotonic() {
        let sa = SpectrumAnalyzer::new(48_000.0, SpectrumOptions {
            fft_size: 2048,
            hop_size: None,
            binning: SpectrumBinning::Log { bins: 64, min_hz: 20.0, max_hz: 20_000.0 },
            smoothing: 0.5,
            peak_hold_decay_db: 1.5,
        });
        let cs = sa.bin_centres();
        for w in cs.windows(2) {
            assert!(w[1] > w[0], "non-monotonic: {} → {}", w[0], w[1]);
        }
        assert!((cs[0] - 20.0).abs() < 0.5);
        assert!((cs.last().unwrap() - 20_000.0).abs() < 1.0);
    }

    /// Bin count is capped at MAX_OUTPUT_BINS.
    #[test]
    fn bin_count_capped() {
        let sa = SpectrumAnalyzer::new(48_000.0, SpectrumOptions {
            fft_size: 4096,
            hop_size: None,
            binning: SpectrumBinning::Log { bins: 1024, min_hz: 20.0, max_hz: 20_000.0 },
            smoothing: 0.5,
            peak_hold_decay_db: 1.5,
        });
        assert!(sa.bin_count() <= MAX_OUTPUT_BINS);
    }
}
