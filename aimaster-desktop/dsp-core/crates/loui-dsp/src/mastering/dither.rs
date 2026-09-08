//! Dither + quantisation — the last thing that happens to the audio.
//!
//! Reducing bit depth throws information away.  Doing it by rounding alone
//! produces *correlated* error: the distortion tracks the signal, so a
//! fading reverb tail turns grainy and a quiet passage develops a buzz that
//! moves with the music.  Adding a small amount of noise BEFORE the rounding
//! decorrelates the error — the distortion becomes a constant, benign hiss
//! instead, which is the whole point of dither.
//!
//! Three modes, matching what the export panel offers:
//!
//! | Mode | Behaviour |
//! |---|---|
//! | `None` | Quantise only. Audibly grainy at 16-bit — useful for A/B |
//! | `Tpdf` | Triangular-PDF noise, ±1 LSB. The safe default |
//! | `Shaped` | TPDF plus 2nd-order error feedback, moving noise upward |
//!
//! **The module quantises even in `None` mode.** That is deliberate: it is
//! how you hear what your dither choice is doing before you commit to a
//! file.  A module that only added noise and left the rounding to the file
//! writer could not be auditioned at all.
//!
//! At 32-bit float there is no quantisation step to dither, so the module
//! passes through untouched no matter what mode is selected.
//!
//! # Noise shaping
//!
//! `Shaped` uses a 2nd-order highpass error feedback, noise transfer
//! `(1 - z⁻¹)²`.  It moves quantisation noise out of the midrange and into
//! the top octave, where the ear is far less sensitive — roughly 5-7 dB of
//! perceived improvement at 16-bit for free.
//!
//! It is NOT a psychoacoustically-weighted curve.  High-order weighted
//! shapers sound better still, but they need listening validation to tune
//! and can ring or go unstable when pushed.  A 2nd-order shaper is
//! unconditionally stable and its behaviour is exactly what it says.
//!
//! # Auto-blanking
//!
//! Dither noise in a digitally silent passage is just noise on silence —
//! audible in a fade-out or between tracks.  With `auto_blank` on, the
//! module stops adding noise after a run of silent samples and resumes the
//! instant signal returns.
//!
//! Realtime-safe: fixed state, no allocation, no locks.

use super::config::{DitherConfig, DitherMode};
use super::StereoModule;

/// Samples of digital silence before auto-blanking engages (~85 ms @ 48 kHz).
const BLANK_AFTER: u32 = 4_096;

/// Error-feedback coefficients for the 2nd-order shaper.
///
/// With the loop written as
///
/// ```text
///   w[n] = x[n] - Σ h_k · e[n-k]
///   y[n] = Q(w[n])
///   e[n] = y[n] - w[n]
/// ```
///
/// the noise transfer function is `1 - H(z)`.  For the highpass shape
/// `(1 - z⁻¹)² = 1 - 2z⁻¹ + z⁻²` that makes `H(z) = 2z⁻¹ - z⁻²`, i.e.
/// `h = [2, -1]`.
///
/// Getting this sign backwards inverts the shaping — the NTF becomes a
/// lowpass and the module piles noise INTO the midrange instead of out of
/// it.  `shaping_moves_noise_upward` is what pins it down.
const SHAPER: [f64; 2] = [2.0, -1.0];

/// One channel's noise generator and error history.
#[derive(Clone, Copy)]
struct ChannelState {
    /// xorshift64 state.  Seeded differently per channel — correlated
    /// dither across L/R would place its noise in the phantom centre
    /// instead of spreading it across the image.
    rng: u64,
    /// Past quantisation errors, newest first.
    err: [f64; 2],
    /// Consecutive silent samples seen.
    silent_run: u32,
}

impl ChannelState {
    fn new(seed: u64) -> Self {
        Self { rng: seed, err: [0.0; 2], silent_run: 0 }
    }

    /// Uniform in [-0.5, 0.5).
    #[inline]
    fn uniform(&mut self) -> f64 {
        // xorshift64 — cheap, no allocation, good enough for dither noise.
        self.rng ^= self.rng << 13;
        self.rng ^= self.rng >> 7;
        self.rng ^= self.rng << 17;
        // Take 32 bits and map to [-0.5, 0.5).
        ((self.rng >> 32) as u32 as f64) / 4_294_967_296.0 - 0.5
    }

    /// Triangular PDF in [-1, 1) — the sum of two independent uniforms.
    #[inline]
    fn tpdf(&mut self) -> f64 {
        self.uniform() + self.uniform()
    }

    fn reset(&mut self) {
        self.err = [0.0; 2];
        self.silent_run = 0;
    }
}

/// Dither + quantiser.
pub struct Dither {
    cfg: DitherConfig,
    left: ChannelState,
    right: ChannelState,
    /// Quantisation step (1 LSB) for the configured depth.
    step: f64,
    /// Reciprocal of `step`, i.e. the integer full-scale value.
    scale: f64,
}

/// Quantise one sample to a bit depth.
///
/// Clamped to the representable integer range: a converter's positive full
/// scale is `2^(b-1) - 1`, one step short of its negative full scale, so a
/// sample sitting at +1.0 must not round up and wrap to negative.
#[inline]
fn quantise(x: f64, step: f64, scale: f64) -> f64 {
    (x * scale).round().clamp(-scale, scale - 1.0) * step
}

/// Quantisation step and scale for a bit depth.
fn step_for(bits: u32) -> (f64, f64) {
    // 16-bit → scale 32768, step 1/32768.
    let scale = (1u64 << (bits.clamp(2, 24) - 1)) as f64;
    (1.0 / scale, scale)
}

impl Dither {
    /// Construct from a sample rate + config.  The sample rate is unused —
    /// dither is a per-sample operation — but the signature matches the
    /// other modules so the chain can build them uniformly.
    pub fn new(_sample_rate: f64, cfg: DitherConfig) -> Self {
        let (step, scale) = step_for(cfg.bit_depth);
        Self {
            cfg,
            // Two arbitrary odd seeds — any non-zero pair works for xorshift.
            left: ChannelState::new(0x2545_F491_4F6C_DD1D),
            right: ChannelState::new(0x9E37_79B9_7F4A_7C15),
            step,
            scale,
        }
    }

    /// Update parameters.
    pub fn set_config(&mut self, cfg: DitherConfig) {
        self.cfg = cfg;
        let (step, scale) = step_for(cfg.bit_depth);
        self.step = step;
        self.scale = scale;
    }

    /// True when the module would change the signal.
    ///
    /// 32-bit float output has no quantisation step, so there is nothing to
    /// dither and the module is skipped outright — it must not add noise to
    /// a float master.
    fn is_active(&self) -> bool {
        !self.cfg.bypass && self.cfg.bit_depth < 32
    }

    /// Whether dither is currently applied (false at 32-bit or when
    /// bypassed).  Drives the UI's "dither is doing nothing here" note.
    pub fn is_engaged(&self) -> bool {
        self.is_active()
    }

    /// The quantisation step for the configured depth, in dBFS.  This is
    /// the noise floor the export will sit on.
    pub fn lsb_dbfs(&self) -> f64 {
        if !self.is_active() {
            return f64::NEG_INFINITY;
        }
        20.0 * self.step.log10()
    }

    /// Process one sample for a channel.
    #[inline]
    fn process_sample(
        ch: &mut ChannelState,
        x: f64,
        step: f64,
        scale: f64,
        mode: DitherMode,
        auto_blank: bool,
    ) -> f64 {
        // Silence tracking: a sample that would quantise to zero counts as
        // silent.  The run resets the moment real signal returns.
        if x.abs() < step * 0.5 {
            ch.silent_run = ch.silent_run.saturating_add(1);
        } else {
            ch.silent_run = 0;
        }
        let blanked = auto_blank && ch.silent_run >= BLANK_AFTER;
        if blanked {
            // Clear the shaper so it cannot ring noise back out when the
            // signal returns.
            ch.err = [0.0; 2];
            return quantise(x, step, scale);
        }

        // Error feedback (shaped mode only).
        let fed = match mode {
            DitherMode::Shaped => x - (SHAPER[0] * ch.err[0] + SHAPER[1] * ch.err[1]) * step,
            _ => x,
        };

        // Dither noise, scaled to ±1 LSB.
        let noise = match mode {
            DitherMode::None => 0.0,
            DitherMode::Tpdf | DitherMode::Shaped => ch.tpdf() * step,
        };

        let w = fed + noise;
        let y = quantise(w, step, scale);

        if mode == DitherMode::Shaped {
            // Track the quantisation error only — in LSBs, so the feedback
            // coefficients stay dimensionless.
            let e = (y - w) / step;
            ch.err[1] = ch.err[0];
            // A runaway shaper is the one way this module could make noise
            // rather than remove it; bound the history so it cannot.
            ch.err[0] = e.clamp(-4.0, 4.0);
        }

        y
    }
}

impl StereoModule for Dither {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        if !self.is_active() {
            return;
        }
        let n = left.len().min(right.len());
        let (step, scale) = (self.step, self.scale);
        let mode = self.cfg.mode;
        let blank = self.cfg.auto_blank;

        for i in 0..n {
            left[i] =
                Self::process_sample(&mut self.left, left[i] as f64, step, scale, mode, blank) as f32;
            right[i] =
                Self::process_sample(&mut self.right, right[i] as f64, step, scale, mode, blank) as f32;
        }
    }

    fn reset(&mut self) {
        self.left.reset();
        self.right.reset();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(bits: u32, mode: DitherMode) -> DitherConfig {
        DitherConfig { bit_depth: bits, mode, auto_blank: false, bypass: false }
    }

    fn sine(n: usize, freq: f64, sr: f64, amp: f32) -> Vec<f32> {
        (0..n).map(|i| (2.0 * std::f64::consts::PI * freq * i as f64 / sr).sin() as f32 * amp).collect()
    }

    /// True when every sample is an exact multiple of the LSB.
    fn is_quantised(x: &[f32], bits: u32) -> bool {
        let scale = (1u64 << (bits - 1)) as f64;
        x.iter().all(|&s| {
            let n = s as f64 * scale;
            (n - n.round()).abs() < 1e-6
        })
    }

    fn rms(x: &[f32]) -> f64 {
        (x.iter().map(|v| (*v as f64) * (*v as f64)).sum::<f64>() / x.len() as f64).sqrt()
    }

    #[test]
    fn bypass_is_passthrough() {
        let mut d = Dither::new(48_000.0, DitherConfig { bypass: true, ..cfg(16, DitherMode::Tpdf) });
        let input = sine(512, 1_000.0, 48_000.0, 0.4);
        let mut l = input.clone();
        let mut r = input.clone();
        d.process_stereo(&mut l, &mut r);
        assert_eq!(l, input);
    }

    /// 32-bit float has no quantisation step — the module must not add
    /// noise to a float master under any mode.
    #[test]
    fn float_output_is_untouched() {
        for mode in [DitherMode::None, DitherMode::Tpdf, DitherMode::Shaped] {
            let mut d = Dither::new(48_000.0, cfg(32, mode));
            let input = sine(512, 1_000.0, 48_000.0, 0.4);
            let mut l = input.clone();
            let mut r = input.clone();
            d.process_stereo(&mut l, &mut r);
            assert_eq!(l, input, "{mode:?} altered a 32-bit float master");
            assert!(!d.is_engaged());
        }
    }

    #[test]
    fn output_is_quantised_to_the_target_depth() {
        for bits in [16u32, 24] {
            for mode in [DitherMode::None, DitherMode::Tpdf, DitherMode::Shaped] {
                let mut d = Dither::new(48_000.0, cfg(bits, mode));
                let mut l = sine(4096, 1_000.0, 48_000.0, 0.4);
                let mut r = l.clone();
                d.process_stereo(&mut l, &mut r);
                assert!(is_quantised(&l, bits), "{bits}-bit {mode:?} left unquantised output");
            }
        }
    }

    /// The point of dither: the error must stop tracking the signal.
    ///
    /// A very quiet tone quantised without dither collapses onto a handful
    /// of levels, so the error is periodic and correlates strongly with the
    /// input.  With TPDF it should not.
    #[test]
    fn dither_decorrelates_the_error() {
        let n = 16_384;
        // ~3 LSBs at 16-bit — quiet enough that truncation is gross.
        let input = sine(n, 997.0, 48_000.0, 3.0 / 32_768.0);

        let correlation = |mode: DitherMode| -> f64 {
            let mut d = Dither::new(48_000.0, cfg(16, mode));
            let mut l = input.clone();
            let mut r = input.clone();
            d.process_stereo(&mut l, &mut r);
            let err: Vec<f64> = l.iter().zip(input.iter()).map(|(a, b)| (*a - *b) as f64).collect();
            let sig: Vec<f64> = input.iter().map(|v| *v as f64).collect();
            let mean_e = err.iter().sum::<f64>() / n as f64;
            let mean_s = sig.iter().sum::<f64>() / n as f64;
            let mut num = 0.0;
            let mut de = 0.0;
            let mut ds = 0.0;
            for i in 0..n {
                let a = err[i] - mean_e;
                let b = sig[i] - mean_s;
                num += a * b;
                de += a * a;
                ds += b * b;
            }
            (num / (de.sqrt() * ds.sqrt())).abs()
        };

        let undithered = correlation(DitherMode::None);
        let dithered = correlation(DitherMode::Tpdf);
        assert!(
            dithered < undithered * 0.5,
            "TPDF should decorrelate the error: none={undithered:.3} tpdf={dithered:.3}",
        );
    }

    /// Noise shaping must move noise upward in frequency, not add more of
    /// it in the midrange.
    #[test]
    fn shaping_moves_noise_upward() {
        use crate::fft::Fft;
        let n = 16_384;
        let input = vec![0.0f32; n]; // silence — measure the noise alone

        let spectrum = |mode: DitherMode| -> (f64, f64) {
            let mut d = Dither::new(48_000.0, cfg(16, mode));
            let mut l = input.clone();
            let mut r = input.clone();
            d.process_stereo(&mut l, &mut r);
            let size = 4096;
            let fft = Fft::new(size);
            let win = crate::window::Window::hann(size);
            let mut buf = vec![0.0f32; size];
            win.apply(&l[n - size..], &mut buf);
            let mut mag = vec![0.0; size / 2 + 1];
            let mut re = vec![0.0; size];
            let mut im = vec![0.0; size];
            fft.magnitude(&buf, &mut mag, &mut re, &mut im);
            // Low band ≈ 0-6 kHz, high band ≈ 18-24 kHz.
            let bin_hz = 48_000.0 / size as f64;
            let lo_end = (6_000.0 / bin_hz) as usize;
            let hi_start = (18_000.0 / bin_hz) as usize;
            let low: f64 = mag[1..lo_end].iter().sum();
            let high: f64 = mag[hi_start..].iter().sum();
            (low, high)
        };

        let (tpdf_low, tpdf_high) = spectrum(DitherMode::Tpdf);
        let (shaped_low, shaped_high) = spectrum(DitherMode::Shaped);

        assert!(
            shaped_low < tpdf_low,
            "shaping should cut midrange noise: tpdf={tpdf_low:.4} shaped={shaped_low:.4}",
        );
        assert!(
            shaped_high / shaped_low > tpdf_high / tpdf_low,
            "shaping should tilt noise upward",
        );
    }

    /// Auto-blanking must leave a digitally silent passage silent.
    #[test]
    fn auto_blank_silences_dither_noise() {
        let n = 48_000;
        let silence = vec![0.0f32; n];

        let mut on = Dither::new(48_000.0, DitherConfig {
            auto_blank: true, ..cfg(16, DitherMode::Tpdf)
        });
        let mut l = silence.clone();
        let mut r = silence.clone();
        on.process_stereo(&mut l, &mut r);
        // The tail (well past the blanking threshold) must be pure silence.
        assert!(l[n / 2..].iter().all(|&s| s == 0.0), "auto-blank left noise in silence");

        let mut off = Dither::new(48_000.0, cfg(16, DitherMode::Tpdf));
        let mut l2 = silence.clone();
        let mut r2 = silence.clone();
        off.process_stereo(&mut l2, &mut r2);
        assert!(rms(&l2[n / 2..]) > 0.0, "without auto-blank there should be dither noise");
    }

    /// Signal returning after a blanked passage must be dithered again.
    #[test]
    fn auto_blank_releases_on_signal() {
        let n = 48_000;
        let mut input = vec![0.0f32; n];
        for (i, s) in input.iter_mut().enumerate().skip(n / 2) {
            *s = ((2.0 * std::f64::consts::PI * 1_000.0 * i as f64 / 48_000.0).sin() * 0.3) as f32;
        }
        let mut d = Dither::new(48_000.0, DitherConfig {
            auto_blank: true, ..cfg(16, DitherMode::Tpdf)
        });
        let mut l = input.clone();
        let mut r = input.clone();
        d.process_stereo(&mut l, &mut r);
        // Blanking engages after BLANK_AFTER samples of silence, so noise
        // in the run-in is expected; everything past it must be silent.
        let blanked_from = BLANK_AFTER as usize + 64;
        assert!(
            l[blanked_from..n / 2].iter().all(|&s| s == 0.0),
            "silence past the blanking threshold should be silent",
        );
        assert!(rms(&l[n / 2 + 1000..]) > 0.1, "signal should come back");
    }

    /// Noise must sit around 1 LSB — not louder, or it is just hiss.
    #[test]
    fn noise_floor_is_about_one_lsb() {
        let n = 16_384;
        let mut d = Dither::new(48_000.0, cfg(16, DitherMode::Tpdf));
        let mut l = vec![0.0f32; n];
        let mut r = vec![0.0f32; n];
        d.process_stereo(&mut l, &mut r);
        let lsb = 1.0 / 32_768.0;
        let noise_lsbs = rms(&l) / lsb;
        assert!(
            (0.3..3.0).contains(&noise_lsbs),
            "TPDF noise should be about 1 LSB RMS, got {noise_lsbs:.2}",
        );
    }

    /// Full-scale input must not wrap when it rounds.
    #[test]
    fn full_scale_does_not_wrap() {
        for mode in [DitherMode::None, DitherMode::Tpdf, DitherMode::Shaped] {
            let mut d = Dither::new(48_000.0, cfg(16, mode));
            let mut l = vec![1.0f32; 512];
            let mut r = vec![-1.0f32; 512];
            d.process_stereo(&mut l, &mut r);
            assert!(l.iter().all(|&s| s <= 1.0 && s > 0.9), "{mode:?} positive full scale wrapped");
            assert!(r.iter().all(|&s| s >= -1.0 && s < -0.9), "{mode:?} negative full scale wrapped");
        }
    }

    /// The two channels must not share a noise sequence — correlated dither
    /// would put its noise in the phantom centre.
    #[test]
    fn channels_get_independent_noise() {
        let mut d = Dither::new(48_000.0, cfg(16, DitherMode::Tpdf));
        let mut l = vec![0.0f32; 8192];
        let mut r = vec![0.0f32; 8192];
        d.process_stereo(&mut l, &mut r);
        let identical = l.iter().zip(r.iter()).all(|(a, b)| a == b);
        assert!(!identical, "L and R received the same dither noise");
    }

    #[test]
    fn output_stays_finite_on_extremes() {
        let mut d = Dither::new(48_000.0, cfg(16, DitherMode::Shaped));
        let mut l = vec![0.0f32; 8192];
        for (i, s) in l.iter_mut().enumerate() {
            *s = if i % 2 == 0 { 4.0 } else { -4.0 };
        }
        let mut r = l.clone();
        d.process_stereo(&mut l, &mut r);
        assert!(l.iter().all(|s| s.is_finite()));
    }

    #[test]
    fn lsb_dbfs_reports_the_floor() {
        let d16 = Dither::new(48_000.0, cfg(16, DitherMode::Tpdf));
        let d24 = Dither::new(48_000.0, cfg(24, DitherMode::Tpdf));
        assert!((d16.lsb_dbfs() - (-90.3)).abs() < 0.5, "16-bit LSB = {}", d16.lsb_dbfs());
        assert!((d24.lsb_dbfs() - (-138.5)).abs() < 0.5, "24-bit LSB = {}", d24.lsb_dbfs());
    }
}
