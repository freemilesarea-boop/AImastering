//! ITU-R BS.1770-4 K-weighting filter.
//!
//! Two stages:
//!   1. High-shelf at 1681.97 Hz, gain ≈ +4 dB, Q ≈ 0.7071.
//!   2. RLB high-pass at ≈ 38.13 Hz, Q ≈ 0.5003.
//!
//! Coefficients are recomputed for the actual sample rate via the standard
//! pre-warped bilinear transform (cookbook RBJ formulas).  Reference
//! `loudnessCore.ts` in the renderer audio runtime uses the same constants.

use crate::biquad::{Biquad, BiquadCoeffs};

/// BS.1770-4 stage-1 shelving filter centre.
pub const STAGE1_F0_HZ: f64 = 1_681.974_450_955_533;
/// BS.1770-4 stage-1 gain (dB).
pub const STAGE1_GAIN_DB: f64 = 3.999_843_853_973_347;
/// BS.1770-4 stage-1 Q.
pub const STAGE1_Q: f64 = 0.707_175_237_0;

/// BS.1770-4 stage-2 high-pass centre.
pub const STAGE2_F0_HZ: f64 = 38.135_470_88;
/// BS.1770-4 stage-2 Q.
pub const STAGE2_Q: f64 = 0.500_327_037_3;

/// Per-channel K-weighting filter.
#[derive(Debug, Clone, Copy)]
pub struct KWeightingChannel {
    stage1: Biquad,
    stage2: Biquad,
}

impl KWeightingChannel {
    /// Construct K-weighting for the given sample rate.
    pub fn new(sample_rate: f64) -> Self {
        let s1 = BiquadCoeffs::high_shelf(sample_rate, STAGE1_F0_HZ, STAGE1_Q, STAGE1_GAIN_DB);
        let s2 = BiquadCoeffs::high_pass(sample_rate, STAGE2_F0_HZ, STAGE2_Q);
        Self {
            stage1: Biquad::new(s1),
            stage2: Biquad::new(s2),
        }
    }

    /// Process a single sample.
    #[inline]
    pub fn process(&mut self, x: f64) -> f64 {
        let y = self.stage1.process(x);
        self.stage2.process(y)
    }

    /// Process a slice in place (f64).
    pub fn process_block_f64(&mut self, buf: &mut [f64]) {
        for s in buf.iter_mut() {
            *s = self.process(*s);
        }
    }

    /// Reset both stages.
    pub fn reset(&mut self) {
        self.stage1.reset();
        self.stage2.reset();
    }
}

/// K-weighting filter bank (per-channel).
#[derive(Debug, Clone)]
pub struct KWeightingBank {
    sample_rate: f64,
    channels: Vec<KWeightingChannel>,
}

impl KWeightingBank {
    /// Construct one K-weighting filter per channel.
    pub fn new(sample_rate: f64, channels: usize) -> Self {
        Self {
            sample_rate,
            channels: (0..channels).map(|_| KWeightingChannel::new(sample_rate)).collect(),
        }
    }

    /// Sample rate.
    pub fn sample_rate(&self) -> f64 { self.sample_rate }
    /// Channel count.
    pub fn channels(&self) -> usize { self.channels.len() }

    /// Process one frame (sample per channel).  `input.len() == channels`.
    /// Writes the weighted samples into `output` (must be same length).
    #[inline]
    pub fn process_frame(&mut self, input: &[f64], output: &mut [f64]) {
        debug_assert_eq!(input.len(), self.channels.len());
        debug_assert_eq!(output.len(), self.channels.len());
        for c in 0..self.channels.len() {
            output[c] = self.channels[c].process(input[c]);
        }
    }

    /// Reset all stages.
    pub fn reset(&mut self) {
        for ch in self.channels.iter_mut() {
            ch.reset();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// K-weighted 1 kHz sine should pass with ≈ +4 dB shelf boost above 1.7 kHz,
    /// roughly unity at 1 kHz, attenuation below ≈ 80 Hz.  Sanity: at 1 kHz
    /// the cascaded filter shouldn't blow up or zero out.
    #[test]
    fn one_khz_sine_passes_through() {
        let mut k = KWeightingChannel::new(48_000.0);
        let n = 4096;
        let mut buf: Vec<f64> = (0..n)
            .map(|i| (2.0 * std::f64::consts::PI * 1000.0 * i as f64 / 48_000.0).sin())
            .collect();
        k.process_block_f64(&mut buf);
        // After convergence, the RMS should be > 0.3 and < 2.0 (sanity).
        let rms = (buf[1024..].iter().map(|x| x * x).sum::<f64>() / 3072.0).sqrt();
        assert!(rms > 0.3 && rms < 2.0, "K-weighted 1 kHz RMS suspicious: {rms}");
    }

    /// 30 Hz signal should be heavily attenuated by the RLB stage.
    #[test]
    fn low_freq_is_attenuated() {
        let mut k = KWeightingChannel::new(48_000.0);
        let n = 16384;
        let mut buf: Vec<f64> = (0..n)
            .map(|i| (2.0 * std::f64::consts::PI * 30.0 * i as f64 / 48_000.0).sin())
            .collect();
        k.process_block_f64(&mut buf);
        let rms = (buf[8192..].iter().map(|x| x * x).sum::<f64>() / 8192.0).sqrt();
        // At 30 Hz the stage-2 HPF cuts substantially.  Expect ≤ 0.3.
        assert!(rms < 0.4, "30 Hz not attenuated enough: {rms}");
    }
}
