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
}
