//! Stereo imager — M/S width + low-frequency mono, with a phase guard.
//!
//!   M = (L+R)/2, S = (L-R)/2
//!   * width: S *= width_pct/100
//!   * low-mono: high-pass the Side below `low_mono_hz` (so lows fold to mono)
//!   * phase guard: clamp width so the reconstructed correlation can't
//!     invert hard (prevents mono-fold-down cancellation)
//!
//! Reconstruct L = M+S, R = M-S.

use crate::biquad::{Biquad, BiquadCoeffs};
use super::config::ImagerConfig;
use super::StereoModule;

/// Stereo imager module.
pub struct Imager {
    sr: f64,
    cfg: ImagerConfig,
    // High-pass applied to the Side signal for low-mono.
    side_hp: Biquad,
}

impl Imager {
    /// Construct from a sample rate + config.
    pub fn new(sample_rate: f64, cfg: ImagerConfig) -> Self {
        Self {
            sr: sample_rate,
            cfg,
            side_hp: Biquad::new(BiquadCoeffs::high_pass(sample_rate, cfg.low_mono_hz.max(20.0), 0.707)),
        }
    }

    /// Update parameters.
    pub fn set_config(&mut self, cfg: ImagerConfig) {
        self.cfg = cfg;
        self.side_hp.set_coeffs(BiquadCoeffs::high_pass(self.sr, cfg.low_mono_hz.max(20.0), 0.707));
    }

    /// Effective width factor, phase-guarded to [0, 2.0].
    fn width_factor(&self) -> f64 {
        (self.cfg.width_pct / 100.0).clamp(0.0, 2.0)
    }
}

impl StereoModule for Imager {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        if self.cfg.bypass {
            return;
        }
        let width = self.width_factor();
        let do_low_mono = self.cfg.low_mono_hz > 20.0;
        let n = left.len().min(right.len());
        for i in 0..n {
            let l = left[i] as f64;
            let r = right[i] as f64;
            let mid = 0.5 * (l + r);
            let mut side = 0.5 * (l - r);
            // Low-mono: keep only the high-passed Side, so lows fold to mono.
            if do_low_mono {
                side = self.side_hp.process(side);
            } else {
                // Keep the filter state coherent even when bypassed this block.
                let _ = self.side_hp.process(side);
            }
            side *= width;
            left[i] = (mid + side) as f32;
            right[i] = (mid - side) as f32;
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
        ImagerConfig { width_pct, low_mono_hz, bypass: false }
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
}
