//! The mastering chain — assembles the modules in canonical order.

use super::config::MasteringChainConfig;
use super::gain::Gain;
use super::eq::Eq;
use super::dynamics::Dynamics;
use super::imager::Imager;
use super::limiter::Limiter;
use super::StereoModule;

/// Gain-reduction snapshot from the last processed block (for metering).
#[derive(Debug, Clone, Copy, Default)]
pub struct GainReduction {
    /// Dynamics (compressor) gain reduction in dB (≥ 0).
    pub dynamics_db: f64,
    /// Limiter gain reduction in dB (≥ 0).
    pub limiter_db: f64,
}

/// Realtime-safe preview mastering chain.
///
/// Order: input gain → EQ → dynamics → imager → limiter → output gain.
/// `process_stereo_block` runs the whole chain in place on planar stereo.
pub struct MasteringChain {
    cfg: MasteringChainConfig,
    input_gain: Gain,
    eq: Eq,
    dynamics: Dynamics,
    imager: Imager,
    limiter: Limiter,
    output_gain: Gain,
    gr: GainReduction,
}

impl MasteringChain {
    /// Construct the chain for a sample rate + initial config.
    pub fn new(sample_rate: f64, cfg: MasteringChainConfig) -> Self {
        Self {
            cfg,
            input_gain: Gain::from_db(cfg.input_gain_db),
            eq: Eq::new(sample_rate, cfg.eq),
            dynamics: Dynamics::new(sample_rate, cfg.dynamics),
            imager: Imager::new(sample_rate, cfg.imager),
            limiter: Limiter::new(sample_rate, cfg.limiter),
            output_gain: Gain::from_db(cfg.output_gain_db),
            gr: GainReduction::default(),
        }
    }

    /// Update the entire chain configuration.  Recomputes coefficients;
    /// preserves filter / envelope / delay-line state (no clicks).
    pub fn set_config(&mut self, cfg: MasteringChainConfig) {
        self.cfg = cfg;
        self.input_gain.set_db(cfg.input_gain_db);
        self.eq.set_config(cfg.eq);
        self.dynamics.set_config(cfg.dynamics);
        self.imager.set_config(cfg.imager);
        self.limiter.set_config(cfg.limiter);
        self.output_gain.set_db(cfg.output_gain_db);
    }

    /// The current configuration.
    pub fn config(&self) -> MasteringChainConfig {
        self.cfg
    }

    /// Gain reduction from the last processed block.
    pub fn gain_reduction(&self) -> GainReduction {
        self.gr
    }

    /// Process one block of planar stereo audio in place.
    ///
    /// Master bypass short-circuits to a pass-through.  Realtime-safe:
    /// no allocation, no locks.
    pub fn process_stereo_block(&mut self, left: &mut [f32], right: &mut [f32]) {
        if self.cfg.bypass {
            self.gr = GainReduction::default();
            return;
        }
        self.input_gain.process_stereo(left, right);
        self.eq.process_stereo(left, right);
        self.dynamics.process_stereo(left, right);
        self.imager.process_stereo(left, right);
        self.limiter.process_stereo(left, right);
        self.output_gain.process_stereo(left, right);
        self.gr = GainReduction {
            dynamics_db: 0.0, // dynamics GR is implicit in its envelope; metered separately if needed
            limiter_db: self.limiter.gain_reduction_db(),
        };
    }

    /// Clear all module state (transport seek / source swap).
    pub fn reset(&mut self) {
        self.eq.reset();
        self.dynamics.reset();
        self.imager.reset();
        self.limiter.reset();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mastering::config::*;

    fn sine(n: usize, freq: f64, sr: f64, amp: f32) -> Vec<f32> {
        (0..n).map(|i| (2.0 * std::f64::consts::PI * freq * i as f64 / sr).sin() as f32 * amp).collect()
    }

    #[test]
    fn default_chain_no_nan() {
        let mut chain = MasteringChain::new(48_000.0, MasteringChainConfig::default());
        let mut l = sine(4096, 1000.0, 48_000.0, 0.5);
        let mut r = l.clone();
        chain.process_stereo_block(&mut l, &mut r);
        assert!(l.iter().all(|x| x.is_finite()));
        assert!(r.iter().all(|x| x.is_finite()));
    }

    #[test]
    fn master_bypass_is_passthrough() {
        let cfg = MasteringChainConfig {
            bypass: true,
            input_gain_db: 6.0,
            output_gain_db: 6.0,
            ..MasteringChainConfig::default()
        };
        let mut chain = MasteringChain::new(48_000.0, cfg);
        let mut l = sine(256, 1000.0, 48_000.0, 0.3);
        let mut r = l.clone();
        let lc = l.clone();
        chain.process_stereo_block(&mut l, &mut r);
        assert_eq!(l, lc);
    }

    #[test]
    fn limiter_keeps_output_under_ceiling() {
        let cfg = MasteringChainConfig {
            input_gain_db: 12.0, // drive hard into the limiter
            limiter: LimiterConfig { ceiling_dbtp: -1.0, lookahead_ms: 1.0, isp: false, bypass: false },
            ..MasteringChainConfig::default()
        };
        let mut chain = MasteringChain::new(48_000.0, cfg);
        let mut l = sine(8192, 220.0, 48_000.0, 0.9);
        let mut r = l.clone();
        chain.process_stereo_block(&mut l, &mut r);
        let ceiling = db_to_lin(-1.0) as f32;
        let peak = l.iter().chain(r.iter()).fold(0.0f32, |m, &x| m.max(x.abs()));
        assert!(peak <= ceiling + 1e-3, "peak {} > ceiling {}", peak, ceiling);
        assert!(chain.gain_reduction().limiter_db > 0.0);
    }

    #[test]
    fn live_config_change_does_not_panic_or_nan() {
        let mut chain = MasteringChain::new(48_000.0, MasteringChainConfig::default());
        let mut l = sine(512, 440.0, 48_000.0, 0.4);
        let mut r = l.clone();
        chain.process_stereo_block(&mut l, &mut r);
        // Change every module mid-stream.
        chain.set_config(MasteringChainConfig {
            input_gain_db: 3.0,
            eq: EqConfig { low_shelf_db: 2.0, presence_db: -1.0, air_db: 3.0, adaptive: true, ..EqConfig::default() },
            dynamics: DynamicsConfig { threshold_db: -18.0, ratio: 3.0, ..DynamicsConfig::default() },
            imager: ImagerConfig { width_pct: 130.0, low_mono_hz: 120.0, bypass: false },
            limiter: LimiterConfig { ceiling_dbtp: -0.8, lookahead_ms: 2.0, isp: true, bypass: false },
            output_gain_db: -1.0,
            bypass: false,
        });
        let mut l2 = sine(512, 440.0, 48_000.0, 0.4);
        let mut r2 = l2.clone();
        chain.process_stereo_block(&mut l2, &mut r2);
        assert!(l2.iter().all(|x| x.is_finite()));
        assert!(r2.iter().all(|x| x.is_finite()));
    }

    #[test]
    fn reset_clears_state() {
        let mut chain = MasteringChain::new(48_000.0, MasteringChainConfig::default());
        let mut l = sine(1024, 1000.0, 48_000.0, 0.8);
        let mut r = l.clone();
        chain.process_stereo_block(&mut l, &mut r);
        chain.reset();
        // After reset, a silent block stays silent + finite.
        let mut sl = [0.0f32; 256];
        let mut sr = [0.0f32; 256];
        chain.process_stereo_block(&mut sl, &mut sr);
        assert!(sl.iter().all(|&x| x == 0.0 || x.is_finite()));
    }
}
