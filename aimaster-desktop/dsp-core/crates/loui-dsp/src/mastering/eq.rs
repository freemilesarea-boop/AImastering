//! Tone-shaping EQ — four bands the UI can drag anywhere.
//!
//! Bands (per channel):
//!   * high-pass  @ low_cut_hz    (low_cut_q)
//!   * low shelf  @ low_shelf_hz  (low_shelf_q, low_shelf_db)
//!   * presence   @ presence_hz   (peak, presence_q, presence_db)
//!   * air shelf  @ air_hz        (air_q, air_db)
//!   * harshness  @ 4 kHz peak    (Q 1.4, −1.5 dB when `adaptive` on)
//!
//! Frequency and Q are parameters rather than constants because the graph
//! editor drags a node in two axes and sets its bandwidth on the wheel; a
//! fixed-frequency band would ignore two thirds of that gesture.  The
//! defaults reproduce the old fixed layout, so a config that sets only the
//! gains behaves exactly as it did before.
//!
//! NOT a full adaptive/AI EQ — `adaptive` is a gentle harshness control,
//! documented so the curve preview and the audible result stay close.
//!
//! `low_cut_hz` at its minimum (20 Hz) means *off*, and is honoured as off:
//! the high-pass is skipped rather than run at 20 Hz.  Running it would add
//! a phase shift across the bottom octave that the user never asked for, and
//! would stop a neutral EQ from being bit-transparent.

use crate::biquad::{Biquad, BiquadCoeffs};
use super::config::EqConfig;
use super::StereoModule;

const HARSH_HZ: f64 = 4000.0;
const HARSH_DIP_DB: f64 = -1.5;

/// At or below this cutoff the high-pass is treated as switched off.
const LOW_CUT_OFF_HZ: f64 = 20.0;

/// Q floor.  A biquad with Q at or below zero produces NaN coefficients, and
/// the wire config is user data — clamp rather than trust it.
const MIN_Q: f64 = 0.1;
const MAX_Q: f64 = 24.0;

/// Keep a band's centre inside the representable band.  Above Nyquist the
/// cookbook formulas fold over and the curve stops matching what is heard.
fn clamp_hz(hz: f64, sr: f64) -> f64 {
    let nyq = sr * 0.5;
    if !hz.is_finite() { return 1000.0; }
    hz.clamp(10.0, nyq * 0.98)
}

fn clamp_q(q: f64) -> f64 {
    if !q.is_finite() { return 0.707; }
    q.clamp(MIN_Q, MAX_Q)
}

struct ChannelBands {
    hp: Biquad,
    /// False when `low_cut_hz` is at its minimum — the high-pass is skipped.
    hp_active: bool,
    low_shelf: Biquad,
    presence: Biquad,
    air: Biquad,
    harsh: Biquad,
}

impl ChannelBands {
    fn new(sr: f64, cfg: &EqConfig) -> Self {
        let mut b = Self {
            hp: Biquad::new(BiquadCoeffs::peaking(sr, 1000.0, 1.0, 0.0)),
            hp_active: false,
            low_shelf: Biquad::new(BiquadCoeffs::peaking(sr, 1000.0, 1.0, 0.0)),
            presence: Biquad::new(BiquadCoeffs::peaking(sr, 1000.0, 1.0, 0.0)),
            air: Biquad::new(BiquadCoeffs::peaking(sr, 1000.0, 1.0, 0.0)),
            harsh: Biquad::new(BiquadCoeffs::peaking(sr, 1000.0, 1.0, 0.0)),
        };
        b.set(sr, cfg);
        b
    }

    fn set(&mut self, sr: f64, cfg: &EqConfig) {
        self.hp.set_coeffs(BiquadCoeffs::high_pass(
            sr, clamp_hz(cfg.low_cut_hz.max(LOW_CUT_OFF_HZ), sr), clamp_q(cfg.low_cut_q),
        ));
        self.hp_active = cfg.low_cut_hz > LOW_CUT_OFF_HZ;
        self.low_shelf.set_coeffs(BiquadCoeffs::low_shelf(
            sr, clamp_hz(cfg.low_shelf_hz, sr), clamp_q(cfg.low_shelf_q), cfg.low_shelf_db,
        ));
        self.presence.set_coeffs(BiquadCoeffs::peaking(
            sr, clamp_hz(cfg.presence_hz, sr), clamp_q(cfg.presence_q), cfg.presence_db,
        ));
        self.air.set_coeffs(BiquadCoeffs::high_shelf(
            sr, clamp_hz(cfg.air_hz, sr), clamp_q(cfg.air_q), cfg.air_db,
        ));
        self.harsh.set_coeffs(BiquadCoeffs::peaking(
            sr, HARSH_HZ, 1.4, if cfg.adaptive { HARSH_DIP_DB } else { 0.0 },
        ));
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
        let y = if self.hp_active { self.hp.process(x) } else { x };
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
        EqConfig { low_cut_hz: 20.0, low_shelf_db: 0.0, presence_db: 0.0, air_db: 0.0, adaptive: false, bypass: false, ..EqConfig::default() }
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

    /// Gain of the EQ at one frequency, measured rather than derived, so a
    /// coefficient mistake cannot pass.
    fn gain_db_at(cfg: EqConfig, hz: f64) -> f64 {
        let sr = 48_000.0;
        let mut eq = Eq::new(sr, cfg);
        let n = 16_384;
        let mut l: Vec<f32> = (0..n)
            .map(|i| (2.0 * std::f64::consts::PI * hz * i as f64 / sr).sin() as f32 * 0.25)
            .collect();
        let mut r = l.clone();
        eq.process_stereo(&mut l, &mut r);
        // Second half only: the first half is filter warm-up.
        let tail = &l[n / 2..];
        let out = (tail.iter().map(|x| (x * x) as f64).sum::<f64>() / tail.len() as f64).sqrt();
        20.0 * (out / (0.25 / 2f64.sqrt())).log10()
    }

    #[test]
    fn a_band_moves_to_the_frequency_it_is_given() {
        // The graph editor drags a band along the frequency axis.  If the DSP
        // ignored the frequency, the curve on screen would be fiction — so
        // assert the boost lands where it was put and not where it used to be.
        let cfg = EqConfig { presence_hz: 800.0, presence_db: 9.0, presence_q: 3.0, ..flat_cfg() };
        let at_800 = gain_db_at(cfg, 800.0);
        let at_3k = gain_db_at(cfg, 3000.0);
        assert!((at_800 - 9.0).abs() < 0.7, "boost not at 800 Hz: {at_800:.2} dB");
        assert!(at_3k.abs() < 1.0, "old fixed 3 kHz centre still boosting: {at_3k:.2} dB");
    }

    #[test]
    fn q_sets_how_wide_the_band_is() {
        // The wheel gesture sets Q.  A high-Q band must be narrow: same gain
        // at centre, far less a half-octave away.
        let narrow = EqConfig { presence_hz: 1000.0, presence_db: 12.0, presence_q: 8.0, ..flat_cfg() };
        let wide = EqConfig { presence_q: 0.5, ..narrow };
        assert!((gain_db_at(narrow, 1000.0) - 12.0).abs() < 0.7, "narrow centre gain wrong");
        assert!((gain_db_at(wide, 1000.0) - 12.0).abs() < 0.7, "wide centre gain wrong");
        let narrow_off = gain_db_at(narrow, 1414.0);
        let wide_off = gain_db_at(wide, 1414.0);
        assert!(
            wide_off > narrow_off + 3.0,
            "Q had little effect on width: narrow {narrow_off:.2} dB vs wide {wide_off:.2} dB",
        );
    }

    #[test]
    fn omitting_frequency_and_q_keeps_the_classic_layout() {
        // An older config that sets only gains must behave as it always did:
        // the low shelf at 120 Hz, the bell at 3 kHz, the air shelf at 12 kHz.
        let d = EqConfig::default();
        assert_eq!((d.low_shelf_hz, d.presence_hz, d.air_hz), (120.0, 3000.0, 12_000.0));
        let cfg = EqConfig { presence_db: 6.0, ..flat_cfg() };
        assert!((gain_db_at(cfg, 3000.0) - 6.0).abs() < 0.7, "default bell moved off 3 kHz");
    }

    #[test]
    fn a_hostile_q_does_not_produce_nan() {
        // The wire config is user data; zero or negative Q would divide by
        // zero in the cookbook formulas.
        for q in [0.0, -1.0, f64::NAN, 1e9] {
            let cfg = EqConfig { presence_q: q, presence_db: 6.0, low_cut_hz: 100.0, low_cut_q: q, ..flat_cfg() };
            let mut eq = Eq::new(48_000.0, cfg);
            let mut l = [0.4f32; 512];
            let mut r = [0.4f32; 512];
            eq.process_stereo(&mut l, &mut r);
            assert!(l.iter().all(|x| x.is_finite()), "Q={q} produced non-finite output");
        }
    }

    #[test]
    fn a_frequency_above_nyquist_does_not_produce_nan() {
        for hz in [0.0, -100.0, 96_000.0, f64::INFINITY] {
            let cfg = EqConfig { air_hz: hz, air_db: 6.0, ..flat_cfg() };
            let mut eq = Eq::new(48_000.0, cfg);
            let mut l = [0.4f32; 512];
            let mut r = [0.4f32; 512];
            eq.process_stereo(&mut l, &mut r);
            assert!(l.iter().all(|x| x.is_finite()), "f={hz} produced non-finite output");
        }
    }
}
