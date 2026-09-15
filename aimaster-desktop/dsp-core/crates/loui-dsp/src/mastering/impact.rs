//! Impact — multiband transient / macro-dynamics shaper.
//!
//! Not a compressor.  A compressor decides what to do from the *absolute*
//! level; Impact decides from the *difference* between a fast and a slow
//! envelope of each band.  That difference is large during a transient and
//! near zero during sustain, so one control can push punch up (accentuate
//! attacks) or down (soften them) without touching steady-state level.
//!
//! Per band:
//!
//! ```text
//!   fast env (≈5 ms)  ─┐
//!                      ├─► ratio ─► punch gain ─► band gain
//!   slow env (≈150 ms) ┘
//! ```
//!
//! `impact_pct[k] > 0` boosts the transient portion (more punch, more
//! separation), `< 0` softens it (denser, more glued).  0 is a bypass for
//! that band, and the module sums the bands back through the same
//! Linkwitz-Riley crossover the other multiband modules use.

use crate::crossover::{Crossover4, BANDS};
use super::config::ImpactConfig;
use super::StereoModule;

/// Fast envelope time constant, seconds.
const FAST_TAU_S: f64 = 0.005;
/// Slow envelope time constant, seconds.
const SLOW_TAU_S: f64 = 0.150;
/// Hard limit on how much a band can be moved, in dB.
const MAX_MOVE_DB: f64 = 12.0;

/// Per-band, per-channel envelope pair.
#[derive(Clone, Copy, Default)]
struct Env {
    fast: f64,
    slow: f64,
}

/// Multiband transient shaper.
pub struct Impact {
    cfg: ImpactConfig,
    xo_l: Crossover4,
    xo_r: Crossover4,
    env: [Env; BANDS],
    fast_coeff: f64,
    slow_coeff: f64,
    /// Signed gain applied per band on the last block (dB), for the UI.
    last_move_db: [f64; BANDS],
}

impl Impact {
    /// Construct from a sample rate + config.
    pub fn new(sample_rate: f64, cfg: ImpactConfig) -> Self {
        Self {
            cfg,
            xo_l: Crossover4::new(sample_rate, cfg.crossover_hz),
            xo_r: Crossover4::new(sample_rate, cfg.crossover_hz),
            env: [Env::default(); BANDS],
            fast_coeff: (-1.0 / (FAST_TAU_S * sample_rate)).exp(),
            slow_coeff: (-1.0 / (SLOW_TAU_S * sample_rate)).exp(),
            last_move_db: [0.0; BANDS],
        }
    }

    /// Update parameters.
    pub fn set_config(&mut self, cfg: ImpactConfig) {
        self.cfg = cfg;
        self.xo_l.set_freqs(cfg.crossover_hz);
        self.xo_r.set_freqs(cfg.crossover_hz);
    }

    /// Signed gain (dB) applied per band on the last block.
    pub fn band_move_db(&self) -> [f64; BANDS] { self.last_move_db }

    /// The crossover frequencies actually in use.
    pub fn crossover_hz(&self) -> [f64; BANDS - 1] { self.xo_l.freqs() }

    /// True when at least one band asks for a move.  Otherwise the band
    /// splitter is skipped so a neutral Impact is bit-transparent.
    fn is_active(&self) -> bool {
        !self.cfg.bypass && self.cfg.impact_pct.iter().any(|v| *v != 0.0)
    }
}

impl StereoModule for Impact {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        if !self.is_active() {
            self.last_move_db = [0.0; BANDS];
            return;
        }
        let n = left.len().min(right.len());
        let fast_c = self.fast_coeff;
        let slow_c = self.slow_coeff;

        let mut amount = [0.0f64; BANDS];
        for k in 0..BANDS {
            amount[k] = (self.cfg.impact_pct[k] / 100.0).clamp(-1.0, 1.0);
        }
        let mut peak_move = [0.0f64; BANDS];

        for i in 0..n {
            let bl = self.xo_l.split(left[i] as f64);
            let br = self.xo_r.split(right[i] as f64);
            let mut sum_l = 0.0;
            let mut sum_r = 0.0;

            for k in 0..BANDS {
                if amount[k] == 0.0 {
                    sum_l += bl[k];
                    sum_r += br[k];
                    continue;
                }
                // Stereo-linked detector so the image does not shift.
                let mag = bl[k].abs().max(br[k].abs());
                let e = &mut self.env[k];
                e.fast = mag + fast_c * (e.fast - mag);
                e.slow = mag + slow_c * (e.slow - mag);

                // Transient-ness in dB: how far the fast envelope is above
                // the slow one.  Positive on attacks, ~0 on sustain.
                let transient_db = if e.slow > 1e-9 {
                    20.0 * (e.fast / e.slow).max(1e-6).log10()
                } else {
                    0.0
                };
                let move_db = (transient_db.max(0.0) * amount[k]).clamp(-MAX_MOVE_DB, MAX_MOVE_DB);
                if move_db.abs() > peak_move[k].abs() { peak_move[k] = move_db; }

                let g = 10f64.powf(move_db / 20.0);
                sum_l += bl[k] * g;
                sum_r += br[k] * g;
            }

            left[i] = sum_l as f32;
            right[i] = sum_r as f32;
        }
        self.last_move_db = peak_move;
    }

    fn reset(&mut self) {
        self.xo_l.reset();
        self.xo_r.reset();
        self.env = [Env::default(); BANDS];
        self.last_move_db = [0.0; BANDS];
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> ImpactConfig {
        ImpactConfig {
            crossover_hz: [120.0, 800.0, 5_000.0],
            impact_pct: [0.0; BANDS],
            bypass: false,
        }
    }

    /// Repeated short bursts — transients with silence between them.
    fn bursts(n: usize, sr: f64, freq: f64, period: usize, len: usize) -> Vec<f32> {
        (0..n)
            .map(|i| {
                if i % period < len {
                    (2.0 * std::f64::consts::PI * freq * i as f64 / sr).sin() as f32 * 0.6
                } else {
                    0.0
                }
            })
            .collect()
    }

    fn tone(n: usize, freq: f64, sr: f64, amp: f32) -> Vec<f32> {
        (0..n).map(|i| (2.0 * std::f64::consts::PI * freq * i as f64 / sr).sin() as f32 * amp).collect()
    }

    fn peak(x: &[f32]) -> f32 { x.iter().fold(0.0f32, |a, b| a.max(b.abs())) }

    fn rms(x: &[f32]) -> f64 {
        (x.iter().map(|v| (*v as f64) * (*v as f64)).sum::<f64>() / x.len() as f64).sqrt()
    }

    #[test]
    fn bypass_is_passthrough() {
        let mut m = Impact::new(48_000.0, ImpactConfig { bypass: true, ..cfg() });
        let mut l = tone(512, 440.0, 48_000.0, 0.5);
        let orig = l.clone();
        let mut r = l.clone();
        m.process_stereo(&mut l, &mut r);
        assert_eq!(l, orig);
    }

    #[test]
    fn zero_amount_is_transparent() {
        let mut m = Impact::new(48_000.0, cfg());
        let n = 16_384;
        let input = tone(n, 1_000.0, 48_000.0, 0.4);
        let mut l = input.clone();
        let mut r = input.clone();
        m.process_stereo(&mut l, &mut r);
        let delta = 20.0 * (rms(&l[n / 2..]) / rms(&input[n / 2..])).log10();
        assert!(delta.abs() < 0.6, "drifted {delta:.2} dB at amount 0");
    }

    /// Sustained tone has no transient content, so it must not move even at
    /// full impact — that is the whole point of a transient shaper.
    #[test]
    fn sustained_tone_is_barely_touched() {
        let mut c = cfg();
        c.impact_pct = [100.0; BANDS];
        let mut m = Impact::new(48_000.0, c);
        let n = 48_000;
        let input = tone(n, 1_000.0, 48_000.0, 0.4);
        let mut l = input.clone();
        let mut r = input.clone();
        m.process_stereo(&mut l, &mut r);
        // Compare the settled tail only — the very first attack is real.
        let delta = 20.0 * (rms(&l[n / 2..]) / rms(&input[n / 2..])).log10();
        assert!(delta.abs() < 1.0, "sustain moved {delta:.2} dB");
    }

    #[test]
    fn positive_impact_accentuates_attacks() {
        let n = 48_000;
        let input = bursts(n, 48_000.0, 1_000.0, 4_800, 480);

        let mut c = cfg();
        c.impact_pct = [100.0; BANDS];
        let mut m = Impact::new(48_000.0, c);
        let mut l = input.clone();
        let mut r = input.clone();
        m.process_stereo(&mut l, &mut r);

        assert!(peak(&l[n / 2..]) > peak(&input[n / 2..]) * 1.1,
                "attacks should be louder: {} vs {}", peak(&l[n / 2..]), peak(&input[n / 2..]));
        assert!(m.band_move_db()[2] > 0.0);
    }

    #[test]
    fn negative_impact_softens_attacks() {
        let n = 48_000;
        let input = bursts(n, 48_000.0, 1_000.0, 4_800, 480);

        let mut c = cfg();
        c.impact_pct = [-100.0; BANDS];
        let mut m = Impact::new(48_000.0, c);
        let mut l = input.clone();
        let mut r = input.clone();
        m.process_stereo(&mut l, &mut r);

        assert!(peak(&l[n / 2..]) < peak(&input[n / 2..]) * 0.95,
                "attacks should be softened");
        assert!(m.band_move_db()[2] < 0.0);
    }

    #[test]
    fn output_stays_finite() {
        let mut c = cfg();
        c.impact_pct = [100.0, -100.0, 100.0, -100.0];
        let mut m = Impact::new(48_000.0, c);
        let mut l = vec![0.0f32; 8192];
        for (i, s) in l.iter_mut().enumerate() { *s = if i % 6 == 0 { 2.0 } else { 0.0 }; }
        let mut r = l.clone();
        m.process_stereo(&mut l, &mut r);
        assert!(l.iter().all(|s| s.is_finite()));
    }
}
