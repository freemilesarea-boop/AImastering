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
    last_gr_db: f64,    // peak gain reduction over the last block (≥ 0), for metering
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
            last_gr_db: 0.0,
        }
    }

    /// Peak gain reduction (dB, ≥ 0) applied over the last processed block.
    /// 0 when bypassed / below threshold.  Drives the Dynamics GR meter.
    ///
    /// This is the reduction the OUTPUT shows, parallel mix included, not
    /// the wet path's.  The two are the same only at 100% wet: below that
    /// the dry half is summed back in as a *signal*, and the wet and dry
    /// copies are the same signal scaled, so they add in the linear domain.
    /// Reporting the wet figure scaled by the mix reads several dB high.
    /// Makeup gain is not in it — a GR meter shows what the gain computer
    /// took away, not what was handed back afterwards.
    pub fn gain_reduction_db(&self) -> f64 {
        self.last_gr_db
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
            self.last_gr_db = 0.0;
            return;
        }
        let mix = (self.cfg.mix_pct / 100.0).clamp(0.0, 1.0);
        let dry = 1.0 - mix;
        let n = left.len().min(right.len());
        // The block's deepest OUTPUT factor, converted to dB once at the
        // end: cheaper than a log per sample, and it is the quantity the
        // meter is supposed to show.
        let mut min_factor = 1.0f64;
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
            let factor = dry + mix * g;
            if factor < min_factor { min_factor = factor; }
            left[i] = (factor * l) as f32;
            right[i] = (factor * r) as f32;
        }
        self.last_gr_db = (-20.0 * min_factor.max(1e-12).log10()).max(0.0);
    }

    fn reset(&mut self) {
        self.env_db = -120.0;
        self.last_gr_db = 0.0;
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

    /// -1 dBFS of steady level, held long enough for the envelope to settle.
    /// A constant input makes the block's deepest factor the settled one, so
    /// the last sample and the meter describe the same instant.
    fn settled(cfg: DynamicsConfig) -> (f64, f64) {
        let mut d = Dynamics::new(48_000.0, cfg);
        let n = 48_000;
        let amp = 0.891_25f32;
        let mut l = vec![amp; n];
        let mut r = vec![amp; n];
        d.process_stereo(&mut l, &mut r);
        let applied = -20.0 * (l[n - 1] as f64 / amp as f64).log10();
        (d.gain_reduction_db(), applied)
    }

    /// The ratio is the compressor's whole promise, and "the output moved"
    /// is not a test of it: that passes at 1.0001:1.  Above the knee the
    /// output must land at `threshold + over / ratio`, to the decimal.
    #[test]
    fn ratio_places_the_output_where_the_curve_says() {
        let in_db = 20.0 * 0.891_25f64.log10();
        for &ratio in &[2.0f64, 4.0, 8.0] {
            let thr = -20.0;
            let cfg = DynamicsConfig { threshold_db: thr, ratio, ..comp_cfg() };
            let (_, applied) = settled(cfg);
            let want = in_db - (thr + (in_db - thr) / ratio);
            assert!(
                (applied - want).abs() < 0.05,
                "{ratio}:1 should reduce by {want:.2} dB, moved {applied:.2}",
            );
        }
    }

    /// The GR meter must report the reduction the OUTPUT shows, parallel mix
    /// included.  At 100% wet that is the gain computer's figure; below it
    /// the dry copy is summed back as a *signal* and the reduction shrinks
    /// fast.  Scaling the wet figure by the mix — blending dB where the
    /// audio blends amplitudes — reads over 6 dB high at 40%.
    #[test]
    fn gr_meter_reports_the_reduction_the_output_shows() {
        let mut deepest = f64::INFINITY;
        for &mix_pct in &[100.0f64, 88.0, 50.0, 40.0] {
            let cfg = DynamicsConfig {
                threshold_db: -30.0, ratio: 10.0, mix_pct, ..comp_cfg()
            };
            let (meter, applied) = settled(cfg);
            assert!(
                (meter - applied).abs() < 0.02,
                "mix {mix_pct}%: meter says {meter:.2} dB, output moved {applied:.2}",
            );
            assert!(applied > 1.0, "mix {mix_pct}%: nothing to measure ({applied:.2} dB)");
            assert!(
                applied < deepest,
                "mix {mix_pct}%: less wet must mean less reduction, got {applied:.2}",
            );
            deepest = applied;
        }
        // Pin the size of the error the old wet-scaled formula made, so a
        // return to it cannot pass as a rounding difference.
        let (meter, _) = settled(DynamicsConfig {
            threshold_db: -30.0, ratio: 10.0, mix_pct: 40.0, ..comp_cfg()
        });
        assert!(meter < 6.0, "40% wet cannot be 6 dB of reduction, meter says {meter:.2}");
    }
}
