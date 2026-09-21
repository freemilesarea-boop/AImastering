//! Direct-form-II transposed biquad + RBJ cookbook factories.
//!
//! Used by K-weighting and the half-band oversampler.  State is two f64
//! per channel.  `process` is realtime-safe.

/// Biquad coefficients (normalised so a0 = 1).
///
/// Transfer function:
///   H(z) = (b0 + b1 z⁻¹ + b2 z⁻²) / (1 + a1 z⁻¹ + a2 z⁻²)
#[derive(Debug, Clone, Copy)]
pub struct BiquadCoeffs {
    /// Numerator z⁰.
    pub b0: f64,
    /// Numerator z⁻¹.
    pub b1: f64,
    /// Numerator z⁻².
    pub b2: f64,
    /// Denominator z⁻¹.
    pub a1: f64,
    /// Denominator z⁻².
    pub a2: f64,
}

impl BiquadCoeffs {
    /// RBJ peaking EQ (cookbook).
    pub fn peaking(sample_rate: f64, freq_hz: f64, q: f64, gain_db: f64) -> Self {
        let a = 10f64.powf(gain_db / 40.0);
        let omega = 2.0 * std::f64::consts::PI * freq_hz / sample_rate;
        let cos_w = omega.cos();
        let sin_w = omega.sin();
        let alpha = sin_w / (2.0 * q);
        let b0 = 1.0 + alpha * a;
        let b1 = -2.0 * cos_w;
        let b2 = 1.0 - alpha * a;
        let a0 = 1.0 + alpha / a;
        let a1 = -2.0 * cos_w;
        let a2 = 1.0 - alpha / a;
        Self { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 }
    }

    /// RBJ high-shelf (cookbook).
    pub fn high_shelf(sample_rate: f64, freq_hz: f64, q: f64, gain_db: f64) -> Self {
        let a = 10f64.powf(gain_db / 40.0);
        let omega = 2.0 * std::f64::consts::PI * freq_hz / sample_rate;
        let cos_w = omega.cos();
        let sin_w = omega.sin();
        let alpha = sin_w / (2.0 * q);
        let sqrt_a = a.sqrt();
        let b0 =       a * ((a + 1.0) + (a - 1.0) * cos_w + 2.0 * sqrt_a * alpha);
        let b1 = -2.0 * a * ((a - 1.0) + (a + 1.0) * cos_w);
        let b2 =       a * ((a + 1.0) + (a - 1.0) * cos_w - 2.0 * sqrt_a * alpha);
        let a0 =             (a + 1.0) - (a - 1.0) * cos_w + 2.0 * sqrt_a * alpha;
        let a1 =       2.0 * ((a - 1.0) - (a + 1.0) * cos_w);
        let a2 =             (a + 1.0) - (a - 1.0) * cos_w - 2.0 * sqrt_a * alpha;
        Self { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 }
    }

    /// RBJ high-pass (cookbook).
    pub fn high_pass(sample_rate: f64, freq_hz: f64, q: f64) -> Self {
        let omega = 2.0 * std::f64::consts::PI * freq_hz / sample_rate;
        let cos_w = omega.cos();
        let sin_w = omega.sin();
        let alpha = sin_w / (2.0 * q);
        let b0 = (1.0 + cos_w) / 2.0;
        let b1 = -(1.0 + cos_w);
        let b2 = (1.0 + cos_w) / 2.0;
        let a0 = 1.0 + alpha;
        let a1 = -2.0 * cos_w;
        let a2 = 1.0 - alpha;
        Self { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 }
    }

    /// RBJ low-pass (cookbook).
    pub fn low_pass(sample_rate: f64, freq_hz: f64, q: f64) -> Self {
        let omega = 2.0 * std::f64::consts::PI * freq_hz / sample_rate;
        let cos_w = omega.cos();
        let sin_w = omega.sin();
        let alpha = sin_w / (2.0 * q);
        let b0 = (1.0 - cos_w) / 2.0;
        let b1 = 1.0 - cos_w;
        let b2 = (1.0 - cos_w) / 2.0;
        let a0 = 1.0 + alpha;
        let a1 = -2.0 * cos_w;
        let a2 = 1.0 - alpha;
        Self { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 }
    }

    /// RBJ low-shelf (cookbook).
    pub fn low_shelf(sample_rate: f64, freq_hz: f64, q: f64, gain_db: f64) -> Self {
        let a = 10f64.powf(gain_db / 40.0);
        let omega = 2.0 * std::f64::consts::PI * freq_hz / sample_rate;
        let cos_w = omega.cos();
        let sin_w = omega.sin();
        let alpha = sin_w / (2.0 * q);
        let sqrt_a = a.sqrt();
        let b0 =       a * ((a + 1.0) - (a - 1.0) * cos_w + 2.0 * sqrt_a * alpha);
        let b1 = 2.0 * a * ((a - 1.0) - (a + 1.0) * cos_w);
        let b2 =       a * ((a + 1.0) - (a - 1.0) * cos_w - 2.0 * sqrt_a * alpha);
        let a0 =             (a + 1.0) + (a - 1.0) * cos_w + 2.0 * sqrt_a * alpha;
        let a1 = -2.0 *     ((a - 1.0) + (a + 1.0) * cos_w);
        let a2 =             (a + 1.0) + (a - 1.0) * cos_w - 2.0 * sqrt_a * alpha;
        Self { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 }
    }

    /// Magnitude of the response at one frequency, as a linear factor.
    ///
    /// The exact digital response, evaluated on the unit circle — not the
    /// analogue prototype's, which drifts from it as the frequency
    /// approaches Nyquist.  A detector that needs to read levels in dBFS
    /// divides by this at the frequency it is listening to, so the filter
    /// in front of it stops counting as part of the signal.
    pub fn magnitude_at(&self, sample_rate: f64, freq_hz: f64) -> f64 {
        let w = 2.0 * std::f64::consts::PI * freq_hz / sample_rate;
        let (c1, s1) = ((-w).cos(), (-w).sin());
        let (c2, s2) = ((-2.0 * w).cos(), (-2.0 * w).sin());
        let num_re = self.b0 + self.b1 * c1 + self.b2 * c2;
        let num_im = self.b1 * s1 + self.b2 * s2;
        let den_re = 1.0 + self.a1 * c1 + self.a2 * c2;
        let den_im = self.a1 * s1 + self.a2 * s2;
        let den = (den_re * den_re + den_im * den_im).sqrt();
        if den < 1e-30 { return 0.0; }
        (num_re * num_re + num_im * num_im).sqrt() / den
    }
}

/// Single-channel biquad with persistent state.
///
/// Direct-form II transposed.  Allocates only at construction.
#[derive(Debug, Clone, Copy)]
pub struct Biquad {
    coeffs: BiquadCoeffs,
    z1: f64,
    z2: f64,
}

impl Biquad {
    /// Construct with given coefficients and zero state.
    pub fn new(coeffs: BiquadCoeffs) -> Self {
        Self { coeffs, z1: 0.0, z2: 0.0 }
    }

    /// Re-set the coefficients without resetting state.  Useful for live
    /// parameter changes — the implementation is intentionally direct (a
    /// click may occur on large parameter jumps; for click-free smoothing
    /// the caller should run two parallel biquads + crossfade).
    pub fn set_coeffs(&mut self, coeffs: BiquadCoeffs) {
        self.coeffs = coeffs;
    }

    /// Zero the state (clears any DC tail).
    pub fn reset(&mut self) {
        self.z1 = 0.0;
        self.z2 = 0.0;
    }

    /// Process a single sample.
    #[inline]
    pub fn process(&mut self, x: f64) -> f64 {
        let c = &self.coeffs;
        let y = c.b0 * x + self.z1;
        self.z1 = c.b1 * x - c.a1 * y + self.z2;
        self.z2 = c.b2 * x - c.a2 * y;
        y
    }

    /// Process a whole f32 slice in place.
    pub fn process_block_f32(&mut self, buf: &mut [f32]) {
        for s in buf.iter_mut() {
            let y = self.process(*s as f64);
            *s = y as f32;
        }
    }

    /// Process a whole f64 slice in place.
    pub fn process_block_f64(&mut self, buf: &mut [f64]) {
        for s in buf.iter_mut() {
            *s = self.process(*s);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A peaking EQ at unity gain should be near-identity.
    #[test]
    fn unity_peaking_is_identity() {
        let coeffs = BiquadCoeffs::peaking(48_000.0, 1000.0, 1.0, 0.0);
        let mut b = Biquad::new(coeffs);
        let input: Vec<f64> = (0..256).map(|i| ((i as f64) * 0.1).sin()).collect();
        let mut out = input.clone();
        b.process_block_f64(&mut out);
        for i in 0..256 {
            assert!((input[i] - out[i]).abs() < 1e-9, "peaking 0 dB should be identity");
        }
    }

    /// High-pass should kill DC.
    #[test]
    fn high_pass_kills_dc() {
        let coeffs = BiquadCoeffs::high_pass(48_000.0, 1000.0, 0.707);
        let mut b = Biquad::new(coeffs);
        let mut out = vec![1.0; 2048];
        b.process_block_f64(&mut out);
        // After convergence, DC should be ~0.
        let tail: f64 = out[1024..].iter().sum::<f64>() / 1024.0;
        assert!(tail.abs() < 1e-3, "DC tail too large: {tail}");
    }

    /// `magnitude_at` is used to cancel a detector's own filter, so it has
    /// to agree with what the filter does to a signal, not with a formula.
    /// Every case here is measured: a settled sine through the real biquad,
    /// its amplitude ratio compared with the predicted magnitude.
    #[test]
    fn magnitude_at_matches_a_measured_sine() {
        let sr = 48_000.0;
        let cases: [(&str, BiquadCoeffs); 6] = [
            ("high-pass 500 Hz", BiquadCoeffs::high_pass(sr, 500.0, 0.707)),
            ("low-pass 2 kHz", BiquadCoeffs::low_pass(sr, 2_000.0, 0.707)),
            ("high-shelf +6 dB @ 6.5k", BiquadCoeffs::high_shelf(sr, 6_500.0, 0.707, 6.0)),
            ("low-shelf -6 dB @ 6.5k", BiquadCoeffs::low_shelf(sr, 6_500.0, 0.707, -6.0)),
            ("peaking +9 dB Q4 @ 1k", BiquadCoeffs::peaking(sr, 1_000.0, 4.0, 9.0)),
            ("high-pass 12 kHz Q2", BiquadCoeffs::high_pass(sr, 12_000.0, 2.0)),
        ];
        let mut worst = 0.0f64;
        for (name, c) in cases {
            for &f in &[100.0f64, 500.0, 1_000.0, 2_000.0, 6_500.0, 12_000.0, 18_000.0] {
                let mut b = Biquad::new(c);
                let n = 96_000;
                let from = n / 2; // the transient is long gone by here
                let (mut num, mut den) = (0.0f64, 0.0f64);
                for i in 0..n {
                    let x = (2.0 * std::f64::consts::PI * f * i as f64 / sr).sin();
                    let y = b.process(x);
                    if i >= from { num += y * y; den += x * x; }
                }
                // RMS over the same window for both, so the partial cycle at
                // the end biases numerator and denominator identically and
                // cancels.  Peak-picking would instead measure how near a
                // sample lands to the crest — 2e-3 at 1 kHz.
                let measured = (num / den).sqrt();
                let want = c.magnitude_at(sr, f);
                let err = (measured - want).abs();
                worst = worst.max(err);
                assert!(err < 1e-6, "{name} at {f} Hz: measured {measured:.8}, predicted {want:.8}");
            }
        }
        assert!(worst > 0.0, "nothing was measured");
    }

    /// DC is the one point where the answer is arithmetic rather than a
    /// measurement, so it pins the sign conventions.
    #[test]
    fn magnitude_at_dc_is_the_coefficient_sum() {
        let c = BiquadCoeffs::low_pass(48_000.0, 1_000.0, 0.707);
        let want = (c.b0 + c.b1 + c.b2) / (1.0 + c.a1 + c.a2);
        assert!((c.magnitude_at(48_000.0, 0.0) - want.abs()).abs() < 1e-12);
        let hp = BiquadCoeffs::high_pass(48_000.0, 1_000.0, 0.707);
        assert!(hp.magnitude_at(48_000.0, 0.0) < 1e-12, "a high-pass must be zero at DC");
    }
}
