//! Shared crossover primitives for multiband DSP (compressor + imager).
//!
//! A 4th-order Linkwitz-Riley lowpass (two cascaded Butterworth biquads) plus
//! helpers for a *subtractive* 4-band split: with lowpass cutoffs lp1 ≤ lp2 ≤
//! lp3 the bands `[lp1, lp2-lp1, lp3-lp2, x-lp3]` telescope back to `x`
//! exactly, so unity per-band processing reconstructs the input bit-for-bit.

use crate::biquad::{Biquad, BiquadCoeffs};

/// Butterworth Q; two cascaded ⇒ Linkwitz-Riley 4th order.
pub(crate) const LR_Q: f64 = std::f64::consts::FRAC_1_SQRT_2;

/// 4th-order Linkwitz-Riley lowpass.
#[derive(Clone, Copy)]
pub(crate) struct Lr4Lowpass {
    a: Biquad,
    b: Biquad,
}

impl Lr4Lowpass {
    pub(crate) fn new(sr: f64, f: f64) -> Self {
        let c = BiquadCoeffs::low_pass(sr, f, LR_Q);
        Self { a: Biquad::new(c), b: Biquad::new(c) }
    }
    pub(crate) fn set(&mut self, sr: f64, f: f64) {
        let c = BiquadCoeffs::low_pass(sr, f, LR_Q);
        self.a.set_coeffs(c);
        self.b.set_coeffs(c);
    }
    #[inline]
    pub(crate) fn process(&mut self, x: f64) -> f64 {
        self.b.process(self.a.process(x))
    }
    pub(crate) fn reset(&mut self) {
        self.a.reset();
        self.b.reset();
    }
}

/// Clamp + order three crossover frequencies so lo < mid < hi and each stays
/// safely below Nyquist.  Returns `[lo, mid, hi]`.
pub(crate) fn ordered_xovers3(lo: f64, mid: f64, hi: f64, sr: f64) -> [f64; 3] {
    let nyq = sr * 0.5;
    let hi_max = (nyq * 0.9).max(40.0);
    let lo = lo.clamp(20.0, hi_max);
    let mut mid = mid.clamp(20.0, hi_max);
    let mut hi = hi.clamp(20.0, hi_max);
    if mid <= lo {
        mid = (lo * 1.5).min(hi_max);
    }
    if hi <= mid {
        hi = (mid * 1.5).min(hi_max);
    }
    [lo, mid, hi]
}

/// Subtractive 4-band split of `x` using three ascending lowpass filters.
/// Sum of the returned bands == `x` (telescoping).
#[inline]
pub(crate) fn subtractive_bands(lp: &mut [Lr4Lowpass; 3], x: f64) -> [f64; 4] {
    let l1 = lp[0].process(x);
    let l2 = lp[1].process(x);
    let l3 = lp[2].process(x);
    [l1, l2 - l1, l3 - l2, x - l3]
}
