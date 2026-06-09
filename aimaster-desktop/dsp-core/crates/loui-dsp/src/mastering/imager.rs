//! Stereo imager — M/S width + low-frequency mono, with a phase guard.
//!
//!   M = (L+R)/2, S = (L-R)/2
//!   * width: S *= width_pct/100
//!   * low-mono: high-pass the Side below `low_mono_hz` (so lows fold to mono)
//!   * 4-band M/S (optional): split the Side into 4 bands (subtractive LR4)
//!     and apply a per-band width, so e.g. lows stay mono while highs widen.
//!     Unity band widths reconstruct the Side exactly.
//!   * phase guard: clamp width so the reconstructed correlation can't
//!     invert hard (prevents mono-fold-down cancellation)
//!
//! Reconstruct L = M+S, R = M-S.

use crate::biquad::{Biquad, BiquadCoeffs};
use super::config::ImagerConfig;
use super::crossover::{ordered_xovers3, subtractive_bands, Lr4Lowpass};
use super::StereoModule;

/// Stereo imager module.
pub struct Imager {
    sr: f64,
    cfg: ImagerConfig,
    // High-pass applied to the Side signal for low-mono.
    side_hp: Biquad,
    // Lowpass ladder for the 4-band M/S split of the Side signal.
    side_lp: [Lr4Lowpass; 3],
}

impl Imager {
    /// Construct from a sample rate + config.
    pub fn new(sample_rate: f64, cfg: ImagerConfig) -> Self {
        let xo = ordered_xovers3(cfg.xover_lo_hz, cfg.xover_mid_hz, cfg.xover_hi_hz, sample_rate);
        Self {
            sr: sample_rate,
            cfg,
            side_hp: Biquad::new(BiquadCoeffs::high_pass(sample_rate, Self::safe_low_mono(cfg.low_mono_hz, sample_rate), 0.707)),
            side_lp: [
                Lr4Lowpass::new(sample_rate, xo[0]),
                Lr4Lowpass::new(sample_rate, xo[1]),
                Lr4Lowpass::new(sample_rate, xo[2]),
            ],
        }
    }

    /// Update parameters.
    pub fn set_config(&mut self, cfg: ImagerConfig) {
        self.cfg = cfg;
        self.side_hp.set_coeffs(BiquadCoeffs::high_pass(self.sr, Self::safe_low_mono(cfg.low_mono_hz, self.sr), 0.707));
        let xo = ordered_xovers3(cfg.xover_lo_hz, cfg.xover_mid_hz, cfg.xover_hi_hz, self.sr);
        for i in 0..3 {
            self.side_lp[i].set(self.sr, xo[i]);
        }
    }

    /// Per-band width factor (phase-guarded to [0, 2.0]; non-finite → 1.0).
    fn band_width(&self, i: usize) -> f64 {
        let w = self.cfg.band_widths_pct[i] / 100.0;
        if w.is_finite() { w.clamp(0.0, 2.0) } else { 1.0 }
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
        let multiband = self.cfg.multiband_enabled;
        let bw = [self.band_width(0), self.band_width(1), self.band_width(2), self.band_width(3)];
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
            if multiband {
                // Split the Side into 4 bands and apply per-band width.  Unity
                // band widths reconstruct `side` exactly (subtractive sum).
                let bands = subtractive_bands(&mut self.side_lp, side);
                side = bands[0] * bw[0] + bands[1] * bw[1] + bands[2] * bw[2] + bands[3] * bw[3];
            } else {
                // Keep the split filters' state coherent for click-free toggling.
                let _ = subtractive_bands(&mut self.side_lp, side);
                side *= width;
            }
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
        for lp in self.side_lp.iter_mut() {
            lp.reset();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(width_pct: f64, low_mono_hz: f64) -> ImagerConfig {
        ImagerConfig { width_pct, low_mono_hz, bypass: false, ..ImagerConfig::default() }
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

    fn mb_cfg(widths: [f64; 4]) -> ImagerConfig {
        ImagerConfig { multiband_enabled: true, band_widths_pct: widths, ..ImagerConfig::default() }
    }

    #[test]
    fn multiband_unity_widths_reconstruct_input() {
        // 4-band M/S with all widths 100% → Side summed back exactly → passthrough.
        let mut im = Imager::new(48_000.0, mb_cfg([100.0, 100.0, 100.0, 100.0]));
        let inl: Vec<f32> = (0..1024).map(|i| (i as f32 * 0.05).sin() * 0.4).collect();
        let inr: Vec<f32> = (0..1024).map(|i| (i as f32 * 0.037 + 1.0).sin() * 0.4).collect();
        let mut l = inl.clone();
        let mut r = inr.clone();
        im.process_stereo(&mut l, &mut r);
        let max_err = l.iter().zip(&inl).chain(r.iter().zip(&inr))
            .map(|(a, b)| (a - b).abs()).fold(0.0f32, f32::max);
        assert!(max_err < 1e-4, "multiband unity not transparent: err {max_err}");
    }

    #[test]
    fn multiband_low_band_zero_keeps_high_side() {
        // Low band width 0 (mono lows), high band 200% (wide highs).  A pure
        // high-frequency Side tone (L = -R at high freq) must survive.
        let mut im = Imager::new(48_000.0, mb_cfg([0.0, 100.0, 100.0, 200.0]));
        let n = 8192;
        let hi: Vec<f32> = (0..n).map(|i| (2.0 * std::f64::consts::PI * 10000.0 * i as f64 / 48_000.0).sin() as f32 * 0.4).collect();
        // Pure side: L = hi, R = -hi.
        let mut l = hi.clone();
        let mut r: Vec<f32> = hi.iter().map(|x| -x).collect();
        im.process_stereo(&mut l, &mut r);
        // Side should remain non-trivial (high band widened), output finite.
        let side_energy: f64 = l.iter().skip(4096).zip(r.iter().skip(4096))
            .map(|(a, b)| { let s = 0.5 * (*a as f64 - *b as f64); s * s }).sum();
        assert!(side_energy > 1.0, "high side collapsed: {side_energy}");
        assert!(l.iter().chain(r.iter()).all(|x| x.is_finite()));
    }

    #[test]
    fn multiband_low_band_zero_monos_low_side() {
        // Low band width 0 → a low-frequency Side tone folds to mono (L≈R).
        let mut im = Imager::new(48_000.0, mb_cfg([0.0, 0.0, 100.0, 100.0]));
        let n = 8192;
        let lo: Vec<f32> = (0..n).map(|i| (2.0 * std::f64::consts::PI * 50.0 * i as f64 / 48_000.0).sin() as f32 * 0.4).collect();
        let mut l = lo.clone();
        let mut r: Vec<f32> = lo.iter().map(|x| -x).collect();
        im.process_stereo(&mut l, &mut r);
        // After settle the low Side is strongly reduced (subtractive crossovers
        // leave a small phase residual, so it's near-mono, not perfectly mono).
        // Full side would give mean |L-R| ≈ 0.5; assert a large reduction.
        let diff: f64 = l.iter().skip(4096).zip(r.iter().skip(4096))
            .map(|(a, b)| (*a as f64 - *b as f64).abs()).sum::<f64>() / 4096.0;
        assert!(diff < 0.15, "low side not sufficiently monoed: mean |L-R| {diff}");
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
