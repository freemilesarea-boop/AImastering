//! Single-band glue compressor — lightweight, realtime-safe.
//!
//! Feed-forward peak compressor:
//!   envelope (peak follower, attack/release) → gain computer
//!   (threshold/ratio, soft knee) → wet gain → parallel mix.
//!
//! NOT multiband, NOT lookahead — a stable "glue" comp for preview.

use super::config::DynamicsConfig;
use super::StereoModule;

const KNEE_DB: f64 = 6.0;

/// Single-band stereo glue compressor.
pub struct Dynamics {
    sr: f64,
    cfg: DynamicsConfig,
    env_db: f64,        // current envelope in dB
    atk_coeff: f64,
    rel_coeff: f64,
}

fn time_coeff(ms: f64, sr: f64) -> f64 {
    if ms <= 0.0 { return 0.0; }
    (-1.0 / (ms * 0.001 * sr)).exp()
}

impl Dynamics {
    /// Construct from a sample rate + config.
    pub fn new(sample_rate: f64, cfg: DynamicsConfig) -> Self {
        Self {
            sr: sample_rate,
            cfg,
            env_db: -120.0,
            atk_coeff: time_coeff(cfg.attack_ms, sample_rate),
            rel_coeff: time_coeff(cfg.release_ms, sample_rate),
        }
    }

    /// Update parameters.
    pub fn set_config(&mut self, cfg: DynamicsConfig) {
        self.cfg = cfg;
        self.atk_coeff = time_coeff(cfg.attack_ms, self.sr);
        self.rel_coeff = time_coeff(cfg.release_ms, self.sr);
    }

    /// Gain-computer: target output level (dB) for an input level (dB),
    /// with a soft knee around the threshold.
    fn computed_gain_db(&self, in_db: f64) -> f64 {
        let t = self.cfg.threshold_db;
        let r = self.cfg.ratio.max(1.0);
        let over = in_db - t;
        if over <= -KNEE_DB / 2.0 {
            0.0
        } else if over >= KNEE_DB / 2.0 {
            // Above the knee: full compression.
            (t + over / r) - in_db
        } else {
            // Soft-knee region (quadratic interpolation).
            let x = over + KNEE_DB / 2.0;
            let comp = (1.0 / r - 1.0) * x * x / (2.0 * KNEE_DB);
            comp
        }
    }
}

impl StereoModule for Dynamics {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        if self.cfg.bypass || self.cfg.ratio <= 1.0 {
            return;
        }
        let mix = (self.cfg.mix_pct / 100.0).clamp(0.0, 1.0);
        let dry = 1.0 - mix;
        let n = left.len().min(right.len());
        for i in 0..n {
            let l = left[i] as f64;
            let r = right[i] as f64;
            // Stereo-linked detector — use the louder channel.
            let peak = l.abs().max(r.abs()).max(1e-9);
            let in_db = 20.0 * peak.log10();
            // Envelope follower (attack when rising, release when falling).
            let coeff = if in_db > self.env_db { self.atk_coeff } else { self.rel_coeff };
            self.env_db = in_db + coeff * (self.env_db - in_db);
            let gain_db = self.computed_gain_db(self.env_db);
            let g = 10f64.powf(gain_db / 20.0);
            // Parallel mix: dry + wet*g.
            left[i] = ((dry + mix * g) * l) as f32;
            right[i] = ((dry + mix * g) * r) as f32;
        }
    }

    fn reset(&mut self) {
        self.env_db = -120.0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn comp_cfg() -> DynamicsConfig {
        DynamicsConfig { threshold_db: -20.0, ratio: 4.0, attack_ms: 1.0, release_ms: 50.0, mix_pct: 100.0, bypass: false }
    }

    #[test]
    fn ratio_one_is_passthrough() {
        let mut d = Dynamics::new(48_000.0, DynamicsConfig { ratio: 1.0, ..comp_cfg() });
        let mut l = [0.9f32; 64];
        let mut r = [0.9f32; 64];
        d.process_stereo(&mut l, &mut r);
        assert!(l.iter().all(|&x| (x - 0.9).abs() < 1e-6));
    }

    #[test]
    fn bypass_is_passthrough() {
        let mut d = Dynamics::new(48_000.0, DynamicsConfig { bypass: true, ..comp_cfg() });
        let mut l = [0.9f32; 16];
        let mut r = [0.9f32; 16];
        d.process_stereo(&mut l, &mut r);
        assert!(l.iter().all(|&x| (x - 0.9).abs() < 1e-6));
    }

    #[test]
    fn loud_signal_is_attenuated() {
        let mut d = Dynamics::new(48_000.0, comp_cfg());
        // Sustained loud signal well above threshold.
        let mut l = [0.9f32; 4096];
        let mut r = [0.9f32; 4096];
        d.process_stereo(&mut l, &mut r);
        // After the envelope settles, output should be below input.
        assert!(l[4095] < 0.9, "expected gain reduction, got {}", l[4095]);
        assert!(l.iter().all(|x| x.is_finite()));
    }

    #[test]
    fn quiet_signal_below_threshold_untouched() {
        let mut d = Dynamics::new(48_000.0, comp_cfg());
        // -40 dB ≈ 0.01, well below -20 threshold.
        let mut l = [0.01f32; 2048];
        let mut r = [0.01f32; 2048];
        d.process_stereo(&mut l, &mut r);
        assert!((l[2047] - 0.01).abs() < 1e-3, "quiet signal changed: {}", l[2047]);
    }
}
