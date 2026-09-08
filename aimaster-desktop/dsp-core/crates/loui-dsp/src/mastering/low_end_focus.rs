//! Low End Focus — contrast control for the bottom octaves.
//!
//! Low end goes wrong in two directions and they need opposite fixes:
//!
//!   * **Punchy** — the kick and bass are there but mushy.  Push the
//!     transient part of the low band up and pull the sustain down, so
//!     attacks separate and the low end stops smearing into itself.
//!   * **Smooth** — the low end is spiky and inconsistent, one note
//!     jumping out.  Pull transients down and lift the sustain, so the
//!     bottom sits level and dense.
//!
//! Both are the same mechanism with the sign flipped: a fast-vs-slow
//! envelope difference on the low band drives a gain, and only the low band
//! is affected.  The split is a Linkwitz-Riley pair so the recombined
//! output is magnitude-flat when contrast is zero.
//!
//! `gain_db` is a plain trim on the low band after the contrast stage — the
//! "how much low end" control, separate from "what shape".

use crate::crossover::Crossover2;
use super::config::{LowEndFocusConfig, LowEndFocusMode};
use super::StereoModule;

/// Fast envelope time constant, seconds.
const FAST_TAU_S: f64 = 0.008;
/// Slow envelope time constant, seconds.
const SLOW_TAU_S: f64 = 0.200;
/// Hard limit on the contrast move, in dB.
const MAX_MOVE_DB: f64 = 9.0;

/// Low-band contrast processor.
pub struct LowEndFocus {
    cfg: LowEndFocusConfig,
    xo_l: Crossover2,
    xo_r: Crossover2,
    fast: f64,
    slow: f64,
    fast_coeff: f64,
    slow_coeff: f64,
    last_move_db: f64,
}

impl LowEndFocus {
    /// Construct from a sample rate + config.
    pub fn new(sample_rate: f64, cfg: LowEndFocusConfig) -> Self {
        Self {
            cfg,
            xo_l: Crossover2::new(sample_rate, cfg.frequency_hz),
            xo_r: Crossover2::new(sample_rate, cfg.frequency_hz),
            fast: 0.0,
            slow: 0.0,
            fast_coeff: (-1.0 / (FAST_TAU_S * sample_rate)).exp(),
            slow_coeff: (-1.0 / (SLOW_TAU_S * sample_rate)).exp(),
            last_move_db: 0.0,
        }
    }

    /// Update parameters.
    pub fn set_config(&mut self, cfg: LowEndFocusConfig) {
        self.cfg = cfg;
        self.xo_l.set_freq(cfg.frequency_hz);
        self.xo_r.set_freq(cfg.frequency_hz);
    }

    /// Signed gain (dB) the contrast stage applied on the last block.
    pub fn contrast_move_db(&self) -> f64 { self.last_move_db }

    /// The crossover frequency actually in use.
    pub fn frequency_hz(&self) -> f64 { self.xo_l.freq() }

    /// True when the module would change the signal.  Otherwise the band
    /// split is skipped so a neutral setting is bit-transparent.
    fn is_active(&self) -> bool {
        !self.cfg.bypass && (self.cfg.contrast_pct > 0.0 || self.cfg.gain_db != 0.0)
    }
}

impl StereoModule for LowEndFocus {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        if !self.is_active() {
            self.last_move_db = 0.0;
            return;
        }
        let n = left.len().min(right.len());
        let contrast = (self.cfg.contrast_pct / 100.0).clamp(0.0, 1.0);
        // Punchy accentuates transients; Smooth does the reverse.
        let sign = match self.cfg.mode {
            LowEndFocusMode::Punchy => 1.0,
            LowEndFocusMode::Smooth => -1.0,
        };
        let trim = 10f64.powf(self.cfg.gain_db.clamp(-12.0, 12.0) / 20.0);
        let fast_c = self.fast_coeff;
        let slow_c = self.slow_coeff;
        let mut peak_move = 0.0f64;

        for i in 0..n {
            let (low_l, high_l) = self.xo_l.split(left[i] as f64);
            let (low_r, high_r) = self.xo_r.split(right[i] as f64);

            let mut g = trim;
            if contrast > 0.0 {
                // Stereo-linked detector on the low band.
                let mag = low_l.abs().max(low_r.abs());
                self.fast = mag + fast_c * (self.fast - mag);
                self.slow = mag + slow_c * (self.slow - mag);

                // How transient the low band is right now, in dB.  Positive
                // on an attack, negative while it decays.
                let transient_db = if self.slow > 1e-9 {
                    20.0 * (self.fast / self.slow).max(1e-6).log10()
                } else {
                    0.0
                };
                let move_db = (transient_db * contrast * sign).clamp(-MAX_MOVE_DB, MAX_MOVE_DB);
                if move_db.abs() > peak_move.abs() { peak_move = move_db; }
                g *= 10f64.powf(move_db / 20.0);
            }

            left[i] = (low_l * g + high_l) as f32;
            right[i] = (low_r * g + high_r) as f32;
        }
        self.last_move_db = peak_move;
    }

    fn reset(&mut self) {
        self.xo_l.reset();
        self.xo_r.reset();
        self.fast = 0.0;
        self.slow = 0.0;
        self.last_move_db = 0.0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> LowEndFocusConfig {
        LowEndFocusConfig {
            mode: LowEndFocusMode::Punchy, frequency_hz: 150.0,
            contrast_pct: 0.0, gain_db: 0.0, bypass: false,
        }
    }

    fn tone(n: usize, freq: f64, sr: f64, amp: f32) -> Vec<f32> {
        (0..n).map(|i| (2.0 * std::f64::consts::PI * freq * i as f64 / sr).sin() as f32 * amp).collect()
    }

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

    fn rms(x: &[f32]) -> f64 {
        (x.iter().map(|v| (*v as f64) * (*v as f64)).sum::<f64>() / x.len() as f64).sqrt()
    }

    fn peak(x: &[f32]) -> f32 { x.iter().fold(0.0f32, |a, b| a.max(b.abs())) }

    #[test]
    fn bypass_is_passthrough() {
        let mut m = LowEndFocus::new(48_000.0, LowEndFocusConfig { bypass: true, ..cfg() });
        let mut l = tone(512, 60.0, 48_000.0, 0.5);
        let orig = l.clone();
        let mut r = l.clone();
        m.process_stereo(&mut l, &mut r);
        assert_eq!(l, orig);
    }

    #[test]
    fn neutral_settings_are_transparent() {
        let mut m = LowEndFocus::new(48_000.0, cfg());
        let n = 16_384;
        for &f in &[50.0, 400.0, 4_000.0] {
            m.reset();
            let input = tone(n, f, 48_000.0, 0.4);
            let mut l = input.clone();
            let mut r = input.clone();
            m.process_stereo(&mut l, &mut r);
            let delta = 20.0 * (rms(&l[n / 2..]) / rms(&input[n / 2..])).log10();
            assert!(delta.abs() < 0.6, "{f} Hz drifted {delta:.2} dB");
        }
    }

    #[test]
    fn gain_trims_only_the_low_band() {
        let mut m = LowEndFocus::new(48_000.0, LowEndFocusConfig { gain_db: 6.0, ..cfg() });
        let n = 16_384;

        let low = tone(n, 50.0, 48_000.0, 0.3);
        let mut l = low.clone();
        let mut r = low.clone();
        m.process_stereo(&mut l, &mut r);
        let low_delta = 20.0 * (rms(&l[n / 2..]) / rms(&low[n / 2..])).log10();
        assert!((low_delta - 6.0).abs() < 1.0, "low band moved {low_delta:.2} dB, wanted +6");

        m.reset();
        let high = tone(n, 4_000.0, 48_000.0, 0.3);
        let mut l = high.clone();
        let mut r = high.clone();
        m.process_stereo(&mut l, &mut r);
        let high_delta = 20.0 * (rms(&l[n / 2..]) / rms(&high[n / 2..])).log10();
        assert!(high_delta.abs() < 0.6, "high band moved {high_delta:.2} dB");
    }

    #[test]
    fn punchy_lifts_low_transients() {
        let n = 48_000;
        let input = bursts(n, 48_000.0, 60.0, 4_800, 720);
        let mut m = LowEndFocus::new(48_000.0, LowEndFocusConfig { contrast_pct: 100.0, ..cfg() });
        let mut l = input.clone();
        let mut r = input.clone();
        m.process_stereo(&mut l, &mut r);
        assert!(peak(&l[n / 2..]) > peak(&input[n / 2..]) * 1.05,
                "punchy should raise attacks");
        assert!(m.contrast_move_db() > 0.0);
    }

    #[test]
    fn smooth_softens_low_transients() {
        let n = 48_000;
        let input = bursts(n, 48_000.0, 60.0, 4_800, 720);
        let mut m = LowEndFocus::new(48_000.0, LowEndFocusConfig {
            mode: LowEndFocusMode::Smooth, contrast_pct: 100.0, ..cfg()
        });
        let mut l = input.clone();
        let mut r = input.clone();
        m.process_stereo(&mut l, &mut r);
        assert!(peak(&l[n / 2..]) < peak(&input[n / 2..]) * 0.98,
                "smooth should soften attacks");
    }

    #[test]
    fn output_stays_finite() {
        let mut m = LowEndFocus::new(48_000.0, LowEndFocusConfig {
            contrast_pct: 100.0, gain_db: 12.0, ..cfg()
        });
        let mut l = vec![0.0f32; 8192];
        for (i, s) in l.iter_mut().enumerate() { *s = if i % 9 == 0 { 2.0 } else { 0.0 }; }
        let mut r = l.clone();
        m.process_stereo(&mut l, &mut r);
        assert!(l.iter().all(|s| s.is_finite()));
    }
}
