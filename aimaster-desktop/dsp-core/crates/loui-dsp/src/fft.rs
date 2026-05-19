//! Cooley-Tukey radix-2 in-place FFT (no external deps).
//!
//! Pre-allocated state — twiddle factors and the bit-reversal permutation
//! are computed at construction.  `process` does zero allocations.

/// Pre-allocated FFT engine.  Size must be a power of two.
#[derive(Debug, Clone)]
pub struct Fft {
    n: usize,
    /// Twiddle factors: `twiddles[k] = exp(-2πi · k / n)` for `k ∈ 0..n/2`.
    twiddles: Vec<(f64, f64)>,
    /// Bit-reversal permutation lookup.
    bit_reverse: Vec<u32>,
}

impl Fft {
    /// Construct a radix-2 FFT of size `n`.  Panics if `n` is not a power of two.
    pub fn new(n: usize) -> Self {
        assert!(n >= 2 && n.is_power_of_two(), "FFT size must be power of two ≥ 2");
        let half = n / 2;
        let mut twiddles = Vec::with_capacity(half);
        let theta_step = -2.0 * std::f64::consts::PI / n as f64;
        for k in 0..half {
            let theta = theta_step * k as f64;
            twiddles.push((theta.cos(), theta.sin()));
        }
        let log_n = n.trailing_zeros();
        let mut bit_reverse = Vec::with_capacity(n);
        for i in 0..n {
            bit_reverse.push((i as u32).reverse_bits() >> (32 - log_n));
        }
        Self { n, twiddles, bit_reverse }
    }

    /// FFT size.
    pub fn size(&self) -> usize { self.n }

    /// In-place complex FFT.  `re` and `im` must each have length `self.size()`.
    ///
    /// Forward transform: `X[k] = Σ_n x[n] · exp(-2πi · k · n / N)`.
    pub fn process(&self, re: &mut [f64], im: &mut [f64]) {
        assert_eq!(re.len(), self.n);
        assert_eq!(im.len(), self.n);

        // Bit-reverse permutation.
        for i in 0..self.n {
            let j = self.bit_reverse[i] as usize;
            if i < j {
                re.swap(i, j);
                im.swap(i, j);
            }
        }

        // Butterflies, stage by stage.
        let mut len = 2;
        while len <= self.n {
            let half = len / 2;
            let stride = self.n / len;
            let mut i = 0;
            while i < self.n {
                for k in 0..half {
                    let (w_re, w_im) = self.twiddles[k * stride];
                    let a_re = re[i + k];
                    let a_im = im[i + k];
                    let br_re = re[i + k + half];
                    let br_im = im[i + k + half];
                    let b_re = w_re * br_re - w_im * br_im;
                    let b_im = w_re * br_im + w_im * br_re;
                    re[i + k]        = a_re + b_re;
                    im[i + k]        = a_im + b_im;
                    re[i + k + half] = a_re - b_re;
                    im[i + k + half] = a_im - b_im;
                }
                i += len;
            }
            len <<= 1;
        }
    }

    /// Real-input FFT: takes real `input` of length `n`, writes the first
    /// `n/2 + 1` bins of magnitude (linear, NOT in dB) into `mag_out`.
    ///
    /// Magnitudes are NOT normalised — caller divides by window-coefficient
    /// sum if needed.
    pub fn magnitude(&self, input: &[f32], mag_out: &mut [f64], scratch_re: &mut [f64], scratch_im: &mut [f64]) {
        assert_eq!(input.len(), self.n);
        assert_eq!(scratch_re.len(), self.n);
        assert_eq!(scratch_im.len(), self.n);
        assert_eq!(mag_out.len(), self.n / 2 + 1);

        for (i, &x) in input.iter().enumerate() {
            scratch_re[i] = x as f64;
            scratch_im[i] = 0.0;
        }
        self.process(scratch_re, scratch_im);
        for k in 0..=self.n / 2 {
            let r = scratch_re[k];
            let im = scratch_im[k];
            mag_out[k] = (r * r + im * im).sqrt();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// FFT of a pure cosine at bin k should put all energy at bin k.
    #[test]
    fn cosine_spike_at_correct_bin() {
        let n = 256;
        let fft = Fft::new(n);
        let k_signal: usize = 16;
        let mut input = vec![0.0f32; n];
        for i in 0..n {
            input[i] = (2.0 * std::f32::consts::PI * (k_signal as f32) * (i as f32)
                / (n as f32))
                .cos();
        }
        let mut re = vec![0.0; n];
        let mut im = vec![0.0; n];
        let mut mag = vec![0.0; n / 2 + 1];
        fft.magnitude(&input, &mut mag, &mut re, &mut im);

        // Most of the energy must be in bin k_signal.
        let total: f64 = mag.iter().sum();
        let in_bin = mag[k_signal];
        assert!(in_bin / total > 0.45, "spike not at expected bin: {:?}", mag.iter().enumerate().filter(|(_, m)| **m > 1.0).collect::<Vec<_>>());
    }

    /// DC input: all energy in bin 0.
    #[test]
    fn dc_signal_only_dc_bin() {
        let n = 128;
        let fft = Fft::new(n);
        let input = vec![1.0f32; n];
        let mut re = vec![0.0; n];
        let mut im = vec![0.0; n];
        let mut mag = vec![0.0; n / 2 + 1];
        fft.magnitude(&input, &mut mag, &mut re, &mut im);
        assert!(mag[0] > 100.0);  // ≈ n
        for k in 1..mag.len() {
            assert!(mag[k] < 1e-6, "bin {} should be ~0, got {}", k, mag[k]);
        }
    }

    #[test]
    fn linearity() {
        let n = 64;
        let fft = Fft::new(n);
        let mut a_re = vec![0.0; n];
        let mut a_im = vec![0.0; n];
        for i in 0..n { a_re[i] = (i as f64).sin(); }
        let mut b_re = a_re.clone();
        let mut b_im = a_im.clone();
        let scale = 3.0;
        for v in b_re.iter_mut() { *v *= scale; }
        fft.process(&mut a_re, &mut a_im);
        fft.process(&mut b_re, &mut b_im);
        for i in 0..n {
            let predicted = a_re[i] * scale;
            assert!((b_re[i] - predicted).abs() < 1e-9);
        }
    }
}
