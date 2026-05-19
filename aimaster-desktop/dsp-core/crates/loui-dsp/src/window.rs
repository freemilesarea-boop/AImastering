//! Pre-computed window functions for spectral analysis.
//!
//! Realtime constraint: windows are computed once at construction and held
//! in heap memory.  `apply` is a vector multiply — no allocation.

/// Pre-computed window coefficients.
#[derive(Debug, Clone)]
pub struct Window {
    coeffs: Vec<f32>,
    /// Sum of coefficients — used to normalise FFT magnitudes.
    sum: f32,
}

impl Window {
    /// Hann window of `n` samples.
    pub fn hann(n: usize) -> Self {
        assert!(n >= 2, "window length must be at least 2");
        let mut coeffs = vec![0.0f32; n];
        let denom = (n - 1) as f32;
        for (i, c) in coeffs.iter_mut().enumerate() {
            *c = 0.5 - 0.5 * ((2.0 * std::f32::consts::PI * i as f32) / denom).cos();
        }
        let sum = coeffs.iter().sum::<f32>();
        Self { coeffs, sum }
    }

    /// Rectangular (no-op) window.
    pub fn rectangular(n: usize) -> Self {
        let coeffs = vec![1.0f32; n];
        let sum = n as f32;
        Self { coeffs, sum }
    }

    /// Window length.
    pub fn len(&self) -> usize { self.coeffs.len() }

    /// Returns `true` if the window has length 0 (never possible via constructors).
    pub fn is_empty(&self) -> bool { self.coeffs.is_empty() }

    /// Sum of window coefficients.  Used as `magnitude / (sum/2)` normalisation.
    pub fn coefficient_sum(&self) -> f32 { self.sum }

    /// Apply window to `out` (overwrites).  `src.len() == self.len() == out.len()`.
    pub fn apply(&self, src: &[f32], out: &mut [f32]) {
        assert_eq!(src.len(), self.coeffs.len());
        assert_eq!(out.len(), self.coeffs.len());
        for ((c, s), d) in self.coeffs.iter().zip(src.iter()).zip(out.iter_mut()) {
            *d = c * s;
        }
    }

    /// Apply window in-place.
    pub fn apply_in_place(&self, buf: &mut [f32]) {
        assert_eq!(buf.len(), self.coeffs.len());
        for (c, b) in self.coeffs.iter().zip(buf.iter_mut()) {
            *b *= c;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hann_endpoints_are_zero() {
        let w = Window::hann(1024);
        assert!(w.len() == 1024);
        assert!(w.coeffs[0].abs() < 1e-6);
        assert!(w.coeffs[1023].abs() < 1e-6);
    }

    #[test]
    fn hann_peak_at_centre() {
        let w = Window::hann(1024);
        let mid = w.coeffs[512];
        assert!((mid - 1.0).abs() < 0.01);
    }
}
