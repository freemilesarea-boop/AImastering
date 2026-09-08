//! Stereo imager — M/S width + low-frequency mono, with a phase guard.
//!
//!   M = (L+R)/2, S = (L-R)/2
//!   * width: S *= width_pct/100
//!   * low-mono: high-pass the Side below `low_mono_hz` (so lows fold to mono)
//!   * phase guard: clamp width so the reconstructed correlation can't
//!     invert hard (prevents mono-fold-down cancellation)
//!
//! Reconstruct L = M+S, R = M-S.
//!
//! A per-band width is also available: when any entry of `band_width_pct`
//! differs from 100 the signal is first split by a Linkwitz-Riley 4-band
//! crossover and each band's Side is scaled independently, which is how you
//! narrow a boomy low end while widening the air.  When every band is at
//! 100 the splitter is skipped entirely, so the common case costs nothing
//! and stays bit-transparent at width 100.

use crate::biquad::{Biquad, BiquadCoeffs};
use crate::crossover::{Crossover4, BANDS};
use super::config::ImagerConfig;
use super::StereoModule;

/// Stereo imager module.
pub struct Imager {
    sr: f64,
    cfg: ImagerConfig,
    // High-pass applied to the Side signal for low-mono.
    side_hp: Biquad,
    // Band splitters, only used when per-band widths are in play.
    xo_l: Crossover4,
    xo_r: Crossover4,
}

impl Imager {
    /// Construct from a sample rate + config.
    pub fn new(sample_rate: f64, cfg: ImagerConfig) -> Self {
        Self {
            sr: sample_rate,
            cfg,
            side_hp: Biquad::new(BiquadCoeffs::high_pass(sample_rate, Self::safe_low_mono(cfg.low_mono_hz, sample_rate), 0.707)),
            xo_l: Crossover4::new(sample_rate, cfg.crossover_hz),
            xo_r: Crossover4::new(sample_rate, cfg.crossover_hz),
        }
    }

    /// Update parameters.
    pub fn set_config(&mut self, cfg: ImagerConfig) {
        self.cfg = cfg;
        self.side_hp.set_coeffs(BiquadCoeffs::high_pass(self.sr, Self::safe_low_mono(cfg.low_mono_hz, self.sr), 0.707));
        self.xo_l.set_freqs(cfg.crossover_hz);
        self.xo_r.set_freqs(cfg.crossover_hz);
    }

    /// True when at least one band asks for a width other than 100 %.
    fn per_band_active(&self) -> bool {
        self.cfg.band_width_pct.iter().any(|w| !w.is_finite() || (w - 100.0).abs() > 1e-9)
    }

    /// Per-band width factors, guarded to [0, 2].
    fn band_factors(&self) -> [f64; BANDS] {
        let mut out = [1.0; BANDS];
        for (i, o) in out.iter_mut().enumerate() {
            let w = self.cfg.band_width_pct[i] / 100.0;
            *o = if w.is_finite() { w.clamp(0.0, 2.0) } else { 1.0 };
        }
        out
    }

    /// Clamp the low-mono crossover to a numerically safe range so a bad
    /// (or out-of-range) value can never make the high-pass unstable.
    fn safe_low_mono(hz: f64, sr: f64) -> f64 {
        if hz.is_finite() {
            hz.clamp(20.0, sr * 0.45)
        } else {
            20.0
        }
    }

    /// Effective width factor, phase-guarded to [0, 2.0] (non-finite → 1.0).
    fn width_factor(&self) -> f64 {
        let w = self.cfg.width_pct / 100.0;
        if w.is_finite() {
            w.clamp(0.0, 2.0)
        } else {
            1.0
        }
    }
}

impl StereoModule for Imager {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        if self.cfg.bypass {
            return;
        }
        let width = self.width_factor();
        let do_low_mono = self.cfg.low_mono_hz > 20.0;
        let per_band = self.per_band_active();
        let band_w = self.band_factors();
        let n = left.len().min(right.len());
        for i in 0..n {
            let l = left[i] as f64;
            let r = right[i] as f64;
            let (mid, mut side) = if per_band {
                // Split, scale each band's Side, and recombine.  Mid is the
                // plain band sum, which is flat by the crossover's design.
                let bl = self.xo_l.split(l);
                let br = self.xo_r.split(r);
                let mut m = 0.0;
                let mut s = 0.0;
                for k in 0..BANDS {
                    m += 0.5 * (bl[k] + br[k]);
                    s += 0.5 * (bl[k] - br[k]) * band_w[k];
                }
                (m, s)
            } else {
                (0.5 * (l + r), 0.5 * (l - r))
            };
            // Low-mono: keep only the high-passed Side, so lows fold to mono.
            if do_low_mono {
                side = self.side_hp.process(side);
            } else {
                // Keep the filter state coherent even when bypassed this block.
                let _ = self.side_hp.process(side);
            }
            side *= width;
            let out_l = mid + side;
            let out_r = mid - side;
            // Per-sample finite guard — a non-finite (e.g. a poisoned filter
            // state) must fall back to the dry sample, never emit garbage.
            left[i] = if out_l.is_finite() { out_l as f32 } else { l as f32 };
            right[i] = if out_r.is_finite() { out_r as f32 } else { r as f32 };
        }
    }

    fn reset(&mut self) {
        self.side_hp.reset();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(width_pct: f64, low_mono_hz: f64) -> ImagerConfig {
        ImagerConfig { width_pct, low_mono_hz, bypass: false, ..Default::default() }
    }

    #[test]
    fn width_100_is_passthrough() {
        let mut im = Imager::new(48_000.0, cfg(100.0, 20.0));
        let mut l = [0.5f32, -0.3, 0.8];
        let mut r = [0.1f32, 0.4, -0.2];
        let (lc, rc) = (l, r);
        im.process_stereo(&mut l, &mut r);
        for i in 0..3 {
            assert!((l[i] - lc[i]).abs() < 1e-5, "L[{i}] {} vs {}", l[i], lc[i]);
            assert!((r[i] - rc[i]).abs() < 1e-5);
        }
    }

    #[test]
    fn width_0_collapses_to_mono() {
        let mut im = Imager::new(48_000.0, cfg(0.0, 20.0));
        let mut l = [0.8f32, -0.4];
        let mut r = [0.2f32, 0.6];
        im.process_stereo(&mut l, &mut r);
        // Width 0 → L == R == mid.
        for i in 0..2 {
            assert!((l[i] - r[i]).abs() < 1e-6, "not mono at {i}: {} vs {}", l[i], r[i]);
        }
    }

    #[test]
    fn width_200_doubles_side() {
        let mut im = Imager::new(48_000.0, cfg(200.0, 20.0));
        // Pure side signal (L = -R).
        let mut l = [0.5f32];
        let mut r = [-0.5f32];
        im.process_stereo(&mut l, &mut r);
        // mid = 0, side = 0.5 → ×2 = 1.0 → L = 1.0, R = -1.0
        assert!((l[0] - 1.0).abs() < 1e-5, "L = {}", l[0]);
        assert!((r[0] + 1.0).abs() < 1e-5, "R = {}", r[0]);
    }

    #[test]
    fn bypass_is_passthrough() {
        let mut im = Imager::new(48_000.0, ImagerConfig { bypass: true, ..cfg(0.0, 200.0) });
        let mut l = [0.5f32, -0.3];
        let mut r = [0.1f32, 0.4];
        let (lc, rc) = (l, r);
        im.process_stereo(&mut l, &mut r);
        assert_eq!(l, lc);
        assert_eq!(r, rc);
    }

    #[test]
    fn mono_input_stays_finite_and_centred() {
        // Mono = L == R → side 0 → width has no effect, output stays == input.
        let mut im = Imager::new(48_000.0, cfg(150.0, 120.0));
        let mut l = [0.5f32, -0.4, 0.3, -0.2];
        let mut r = l;
        im.process_stereo(&mut l, &mut r);
        for i in 0..4 {
            assert!(l[i].is_finite() && r[i].is_finite());
            assert!((l[i] - r[i]).abs() < 1e-5, "mono should stay centred at {i}");
        }
    }

    #[test]
    fn non_finite_width_falls_back_to_unity() {
        // A NaN width must not poison the output.
        let mut im = Imager::new(48_000.0, cfg(f64::NAN, 20.0));
        let mut l = [0.5f32, -0.3];
        let mut r = [0.1f32, 0.4];
        im.process_stereo(&mut l, &mut r);
        assert!(l.iter().chain(r.iter()).all(|x| x.is_finite()));
    }

    #[test]
    fn extreme_low_mono_is_clamped_stable() {
        // An absurd / non-finite crossover must clamp, not blow up.
        let mut im = Imager::new(48_000.0, cfg(130.0, 1.0e9));
        let mut l: Vec<f32> = (0..2048).map(|i| (i as f32 * 0.01).sin() * 0.5).collect();
        let mut r: Vec<f32> = (0..2048).map(|i| (i as f32 * 0.013).sin() * 0.5).collect();
        im.process_stereo(&mut l, &mut r);
        assert!(l.iter().chain(r.iter()).all(|x| x.is_finite()));
    }
}
