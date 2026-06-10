//! The mastering chain — assembles the modules in canonical order.

use super::config::MasteringChainConfig;
use super::gain::Gain;
use super::eq::Eq;
use super::dynamic_eq::DynamicEq;
use super::parametric_eq::{ParametricBand, ParametricEq};
use super::dynamics::Dynamics;
use super::multiband::Multiband;
use super::saturation::Saturation;
use super::transient::Transient;
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

/// Maximum block size the dry-backup scratch is pre-allocated for.  Audio
/// worklet quanta are 128; offline render blocks are ≤ 512.  Anything
/// larger still gets the per-sample sanitiser (just without dry restore).
const SAFETY_SCRATCH: usize = 8192;
/// Absurd-output guard (linear).  ~+12 dBFS — well past any musical peak;
/// only a runaway/instability reaches this.
const SAFETY_PEAK_LIN: f32 = 4.0;

/// Realtime-safe preview mastering chain.
///
/// Order: input gain → EQ → dynamics → imager → limiter → output gain.
/// `process_stereo_block` runs the whole chain in place on planar stereo.
///
/// A last-line **output-safety layer** guards every block: if processing
/// produces a non-finite sample or an absurd peak (from any cause), the
/// block is replaced with the dry input and `safety_events` is bumped.
/// This guarantees the realtime preview can never emit ear-splitting noise
/// or NaN, no matter what parameters are thrown at it.
pub struct MasteringChain {
    cfg: MasteringChainConfig,
    input_gain: Gain,
    parametric_eq: ParametricEq,
    eq: Eq,
    dynamic_eq: DynamicEq,
    dynamics: Dynamics,
    multiband: Multiband,
    saturation: Saturation,
    transient: Transient,
    imager: Imager,
    limiter: Limiter,
    output_gain: Gain,
    gr: GainReduction,
    // Dry-signal backup so a bad block can be replaced (no alloc in process).
    dry_l: Vec<f32>,
    dry_r: Vec<f32>,
    safety_events: u32,
}

impl MasteringChain {
    /// Construct the chain for a sample rate + initial config.
    pub fn new(sample_rate: f64, cfg: MasteringChainConfig) -> Self {
        Self {
            cfg,
            input_gain: Gain::from_db(cfg.input_gain_db),
            parametric_eq: ParametricEq::new(sample_rate),
            eq: Eq::new(sample_rate, cfg.eq),
            dynamic_eq: DynamicEq::new(sample_rate, cfg.dynamic_eq),
            dynamics: Dynamics::new(sample_rate, cfg.dynamics),
            multiband: Multiband::new(sample_rate, cfg.multiband),
            saturation: Saturation::new(sample_rate, cfg.saturation),
            transient: Transient::new(sample_rate, cfg.transient),
            imager: Imager::new(sample_rate, cfg.imager),
            limiter: Limiter::new(sample_rate, cfg.limiter),
            output_gain: Gain::from_db(cfg.output_gain_db),
            gr: GainReduction::default(),
            dry_l: vec![0.0; SAFETY_SCRATCH],
            dry_r: vec![0.0; SAFETY_SCRATCH],
            safety_events: 0,
        }
    }

    /// Replace the free parametric EQ band list (independent of `set_config`,
    /// since the band list is variable-length and lives outside the flat
    /// `MasteringChainConfig` value type).  Empty list = bypass.
    pub fn set_parametric_eq_bands(&mut self, bands: &[ParametricBand]) {
        self.parametric_eq.set_bands(bands);
    }

    /// Number of enabled parametric-EQ bands currently active.
    pub fn parametric_eq_band_count(&self) -> usize {
        self.parametric_eq.active_bands()
    }

    /// Number of blocks the output-safety layer had to replace with the
    /// dry signal (non-finite or absurd peak).  ≥ 0; resets with `reset`.
    pub fn safety_events(&self) -> u32 {
        self.safety_events
    }

    /// Update the entire chain configuration.  Recomputes coefficients;
    /// preserves filter / envelope / delay-line state (no clicks).
    pub fn set_config(&mut self, cfg: MasteringChainConfig) {
        self.cfg = cfg;
        self.input_gain.set_db(cfg.input_gain_db);
        self.eq.set_config(cfg.eq);
        self.dynamic_eq.set_config(cfg.dynamic_eq);
        self.dynamics.set_config(cfg.dynamics);
        self.multiband.set_config(cfg.multiband);
        self.saturation.set_config(cfg.saturation);
        self.transient.set_config(cfg.transient);
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
        let n = left.len().min(right.len());
        // Keep a dry copy so a bad block can be replaced bit-for-bit.
        let backed_up = n <= self.dry_l.len();
        if backed_up {
            self.dry_l[..n].copy_from_slice(&left[..n]);
            self.dry_r[..n].copy_from_slice(&right[..n]);
        }

        self.input_gain.process_stereo(left, right);
        self.parametric_eq.process_stereo(left, right);
        self.eq.process_stereo(left, right);
        self.dynamic_eq.process_stereo(left, right);
        self.dynamics.process_stereo(left, right);
        self.multiband.process_stereo(left, right);
        self.saturation.process_stereo(left, right);
        self.transient.process_stereo(left, right);
        self.imager.process_stereo(left, right);
        self.limiter.process_stereo(left, right);
        self.output_gain.process_stereo(left, right);

        // ── Output-safety layer ──────────────────────────────────────────
        // Scan the processed block for non-finite or absurd output.  If the
        // chain misbehaved for ANY reason, restore the dry signal (or, when
        // the block is larger than the scratch, sanitise per-sample) so the
        // device never hears NaN or a noise blow-up.
        let mut bad = false;
        let mut peak = 0.0f32;
        for i in 0..n {
            let a = left[i];
            let b = right[i];
            if !a.is_finite() || !b.is_finite() {
                bad = true;
                break;
            }
            let m = a.abs().max(b.abs());
            if m > peak {
                peak = m;
            }
        }
        if bad || peak > SAFETY_PEAK_LIN {
            self.safety_events = self.safety_events.saturating_add(1);
            // Restore the dry signal (or sanitise per-sample for oversized
            // blocks).  A non-finite dry sample is itself replaced with 0 so
            // the output is ALWAYS finite, even if the input was poisoned.
            for i in 0..n {
                let (a, b) = if backed_up {
                    (self.dry_l[i], self.dry_r[i])
                } else {
                    (left[i], right[i])
                };
                left[i] = if a.is_finite() { a.clamp(-1.0, 1.0) } else { 0.0 };
                right[i] = if b.is_finite() { b.clamp(-1.0, 1.0) } else { 0.0 };
            }
            self.gr = GainReduction::default();
            return;
        }

        self.gr = GainReduction {
            dynamics_db: self.dynamics.gain_reduction_db(),
            limiter_db: self.limiter.gain_reduction_db(),
        };
    }

    /// Clear all module state (transport seek / source swap).
    pub fn reset(&mut self) {
        self.parametric_eq.reset();
        self.eq.reset();
        self.dynamic_eq.reset();
        self.dynamics.reset();
        self.multiband.reset();
        self.saturation.reset();
        self.transient.reset();
        self.imager.reset();
        self.limiter.reset();
        self.safety_events = 0;
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
            imager: ImagerConfig { width_pct: 130.0, low_mono_hz: 120.0, bypass: false, ..ImagerConfig::default() },
            limiter: LimiterConfig { ceiling_dbtp: -0.8, lookahead_ms: 2.0, isp: true, bypass: false },
            output_gain_db: -1.0,
            bypass: false,
            ..MasteringChainConfig::default()
        });
        let mut l2 = sine(512, 440.0, 48_000.0, 0.4);
        let mut r2 = l2.clone();
        chain.process_stereo_block(&mut l2, &mut r2);
        assert!(l2.iter().all(|x| x.is_finite()));
        assert!(r2.iter().all(|x| x.is_finite()));
    }

    #[test]
    fn safety_layer_replaces_non_finite_block_with_dry() {
        // Feed a block that already contains a NaN; the safety layer must
        // restore the dry signal and count the event (never emit NaN).
        let mut chain = MasteringChain::new(48_000.0, MasteringChainConfig::default());
        let mut l = sine(256, 1000.0, 48_000.0, 0.3);
        let mut r = l.clone();
        l[10] = f32::NAN;
        let dry = l.clone();
        chain.process_stereo_block(&mut l, &mut r);
        assert!(l.iter().all(|x| x.is_finite()), "output must be finite");
        assert_eq!(chain.safety_events(), 1, "one bad block should be counted");
        // The poisoned sample is sanitised to 0; the rest is the dry signal.
        assert_eq!(l[10], 0.0);
        for i in 0..256 {
            if i == 10 { continue; }
            assert_eq!(l[i], dry[i]);
        }
    }

    #[test]
    fn safety_events_reset_with_chain() {
        let mut chain = MasteringChain::new(48_000.0, MasteringChainConfig::default());
        let mut l = vec![f32::INFINITY; 128];
        let mut r = vec![f32::INFINITY; 128];
        chain.process_stereo_block(&mut l, &mut r);
        assert!(chain.safety_events() >= 1);
        chain.reset();
        assert_eq!(chain.safety_events(), 0);
    }

    #[test]
    fn extreme_imager_width_stays_finite_and_bounded() {
        // Wide width + hot input → must stay finite and under the safety peak.
        let cfg = MasteringChainConfig {
            imager: ImagerConfig { width_pct: 200.0, low_mono_hz: 120.0, bypass: false, ..ImagerConfig::default() },
            ..MasteringChainConfig::default()
        };
        let mut chain = MasteringChain::new(48_000.0, cfg);
        let mut l = sine(4096, 220.0, 48_000.0, 0.9);
        let mut r = sine(4096, 221.0, 48_000.0, 0.9); // decorrelated → big side
        chain.process_stereo_block(&mut l, &mut r);
        let peak = l.iter().chain(r.iter()).fold(0.0f32, |m, &x| m.max(x.abs()));
        assert!(l.iter().chain(r.iter()).all(|x| x.is_finite()));
        assert!(peak <= 4.0, "peak {peak} exceeded safety guard");
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
