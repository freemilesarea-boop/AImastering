//! Tone-shaping EQ — a small fixed band layout driven by the UI params.
//!
//! Bands (per channel):
//!   * high-pass  @ low_cut_hz   (Q 0.707)
//!   * low shelf  @ 120 Hz       (Q 0.707, low_shelf_db)
//!   * presence   @ 3 kHz peak   (Q 1.1, presence_db)
//!   * air shelf  @ 12 kHz       (Q 0.707, air_db)
//!   * harshness  @ 4 kHz peak   (Q 1.4, −1.5 dB when `adaptive` on)
//!
//! NOT a full adaptive/AI EQ — `adaptive` is a gentle harshness control,
//! documented so the curve preview and the audible result stay close.

use crate::biquad::{Biquad, BiquadCoeffs};
use super::config::EqConfig;
use super::StereoModule;

const LOW_SHELF_HZ: f64 = 120.0;
const PRESENCE_HZ: f64 = 3000.0;
const AIR_HZ: f64 = 12_000.0;
const HARSH_HZ: f64 = 4000.0;
const HARSH_DIP_DB: f64 = -1.5;

struct ChannelBands {
    hp: Biquad,
    low_shelf: Biquad,
    presence: Biquad,
    air: Biquad,
    harsh: Biquad,
}

impl ChannelBands {
    fn new(sr: f64, cfg: &EqConfig) -> Self {
        Self {
            hp: Biquad::new(BiquadCoeffs::high_pass(sr, cfg.low_cut_hz.max(20.0), 0.707)),
            low_shelf: Biquad::new(BiquadCoeffs::low_shelf(sr, LOW_SHELF_HZ, 0.707, cfg.low_shelf_db)),
            presence: Biquad::new(BiquadCoeffs::peaking(sr, PRESENCE_HZ, 1.1, cfg.presence_db)),
            air: Biquad::new(BiquadCoeffs::high_shelf(sr, AIR_HZ, 0.707, cfg.air_db)),
            harsh: Biquad::new(BiquadCoeffs::peaking(sr, HARSH_HZ, 1.4, if cfg.adaptive { HARSH_DIP_DB } else { 0.0 })),
        }
    }

    fn set(&mut self, sr: f64, cfg: &EqConfig) {
        self.hp.set_coeffs(BiquadCoeffs::high_pass(sr, cfg.low_cut_hz.max(20.0), 0.707));
        self.low_shelf.set_coeffs(BiquadCoeffs::low_shelf(sr, LOW_SHELF_HZ, 0.707, cfg.low_shelf_db));
        self.presence.set_coeffs(BiquadCoeffs::peaking(sr, PRESENCE_HZ, 1.1, cfg.presence_db));
        self.air.set_coeffs(BiquadCoeffs::high_shelf(sr, AIR_HZ, 0.707, cfg.air_db));
        self.harsh.set_coeffs(BiquadCoeffs::peaking(sr, HARSH_HZ, 1.4, if cfg.adaptive { HARSH_DIP_DB } else { 0.0 }));
    }

    fn reset(&mut self) {
        self.hp.reset();
        self.low_shelf.reset();
        self.presence.reset();
        self.air.reset();
        self.harsh.reset();
    }

    #[inline]
    fn process(&mut self, x: f64) -> f64 {
        let y = self.hp.process(x);
        let y = self.low_shelf.process(y);
        let y = self.presence.process(y);
        let y = self.air.process(y);
        self.harsh.process(y)
    }
}

/// Tone-shaping EQ module.
pub struct Eq {
    sr: f64,
    cfg: EqConfig,
    l: ChannelBands,
    r: ChannelBands,
}

impl Eq {
    /// Construct from a sample rate + config.
    pub fn new(sample_rate: f64, cfg: EqConfig) -> Self {
        Self {
            sr: sample_rate,
            cfg,
            l: ChannelBands::new(sample_rate, &cfg),
            r: ChannelBands::new(sample_rate, &cfg),
        }
    }

    /// Update parameters (recomputes coefficients; keeps filter state).
    pub fn set_config(&mut self, cfg: EqConfig) {
        self.cfg = cfg;
        self.l.set(self.sr, &cfg);
        self.r.set(self.sr, &cfg);
    }
}

impl StereoModule for Eq {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        if self.cfg.bypass {
            return;
        }
        for x in left.iter_mut() {
            *x = self.l.process(*x as f64) as f32;
        }
        for x in right.iter_mut() {
            *x = self.r.process(*x as f64) as f32;
        }
    }

    fn reset(&mut self) {
        self.l.reset();
        self.r.reset();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flat_cfg() -> EqConfig {
        EqConfig { low_cut_hz: 20.0, low_shelf_db: 0.0, presence_db: 0.0, air_db: 0.0, adaptive: false, bypass: false }
    }

    #[test]
    fn flat_eq_is_near_passthrough_for_midband() {
        // A 1 kHz sine should pass through a flat EQ (HPF @20Hz) nearly unchanged.
        let sr = 48_000.0;
        let mut eq = Eq::new(sr, flat_cfg());
        let n = 4096;
        let mut l: Vec<f32> = (0..n).map(|i| (2.0 * std::f64::consts::PI * 1000.0 * i as f64 / sr).sin() as f32 * 0.5).collect();
        let mut r = l.clone();
        let input_rms = (l.iter().map(|x| (x * x) as f64).sum::<f64>() / n as f64).sqrt();
        eq.process_stereo(&mut l, &mut r);
        // skip the filter warm-up
        let tail = &l[2048..];
        let out_rms = (tail.iter().map(|x| (x * x) as f64).sum::<f64>() / tail.len() as f64).sqrt();
        assert!((out_rms / input_rms - 1.0).abs() < 0.05, "flat EQ changed RMS: {} vs {}", out_rms, input_rms);
        assert!(l.iter().all(|x| x.is_finite()));
    }

    #[test]
    fn bypass_is_exact_passthrough() {
        let mut eq = Eq::new(48_000.0, EqConfig { bypass: true, low_shelf_db: 6.0, ..flat_cfg() });
        let mut l = [0.3f32, -0.7, 0.1];
        let mut r = [0.2f32, 0.4, -0.5];
        let (lc, rc) = (l, r);
        eq.process_stereo(&mut l, &mut r);
        assert_eq!(l, lc);
        assert_eq!(r, rc);
    }

    #[test]
    fn high_pass_attenuates_dc() {
        let mut eq = Eq::new(48_000.0, EqConfig { low_cut_hz: 100.0, ..flat_cfg() });
        let mut l = [1.0f32; 2048];
        let mut r = [1.0f32; 2048];
        eq.process_stereo(&mut l, &mut r);
        // DC should be strongly attenuated by the high-pass after settling.
        assert!(l[2047].abs() < 0.1, "DC not attenuated: {}", l[2047]);
    }
}
