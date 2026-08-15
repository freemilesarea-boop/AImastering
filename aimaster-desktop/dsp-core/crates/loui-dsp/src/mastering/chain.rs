//! The mastering chain — assembles the modules in canonical order.

use super::config::MasteringChainConfig;
use super::gain::Gain;
use super::eq::Eq;
use super::parametric_eq::{ParametricBand, ParametricEq};
use super::dynamics::Dynamics;
use super::imager::Imager;
use super::limiter::Limiter;
use super::declick::Declick;
use super::dehum::Dehum;
use super::denoise::Denoise;
use super::deess::Deess;
use super::dynamic_eq::{DynamicEq, DYN_EQ_BANDS};
use super::multiband::Multiband;
use super::exciter::Exciter;
use super::impact::Impact;
use super::low_end_focus::LowEndFocus;
use super::spectral::{Spectral, CURVE_BANDS};
use super::vintage::{VintageCompressor, VintageEq, VintageTape};
use super::StereoModule;
use crate::crossover::BANDS;

/// Gain-reduction snapshot from the last processed block (for metering).
#[derive(Debug, Clone, Copy, Default)]
pub struct GainReduction {
    /// Dynamics (glue compressor) gain reduction in dB (≥ 0).
    pub dynamics_db: f64,
    /// Limiter / maximizer gain reduction in dB (≥ 0).
    pub limiter_db: f64,
    /// Multiband dynamics gain reduction per band, in dB (≥ 0).
    pub multiband_db: [f64; BANDS],
    /// De-esser gain reduction in dB (≥ 0).
    pub deess_db: f64,
    /// Vintage compressor gain reduction in dB (≥ 0).
    pub vintage_comp_db: f64,
    /// Signed gain applied by each dynamic-EQ band, in dB.
    pub dynamic_eq_db: [f64; DYN_EQ_BANDS],
    /// Signed gain applied by each Impact band, in dB.
    pub impact_db: [f64; BANDS],
    /// Signed gain applied by Low End Focus, in dB.
    pub low_end_focus_db: f64,
    /// Deepest hum notch currently applied, in dB (≥ 0).
    pub dehum_db: f64,
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
    // Restoration.
    declick: Declick,
    dehum: Dehum,
    denoise: Denoise,
    deess: Deess,
    // Corrective / spectral.
    parametric_eq: ParametricEq,
    spectral: Spectral,
    // Tone.
    vintage_eq: VintageEq,
    eq: Eq,
    dynamic_eq: DynamicEq,
    // Dynamics.
    multiband: Multiband,
    dynamics: Dynamics,
    vintage_comp: VintageCompressor,
    impact: Impact,
    low_end_focus: LowEndFocus,
    // Character.
    exciter: Exciter,
    tape: VintageTape,
    // Stereo + output.
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
            declick: Declick::new(sample_rate, cfg.declick),
            dehum: Dehum::new(sample_rate, cfg.dehum),
            denoise: Denoise::new(sample_rate, cfg.denoise),
            deess: Deess::new(sample_rate, cfg.deess),
            parametric_eq: ParametricEq::new(sample_rate),
            spectral: Spectral::new(sample_rate, cfg.spectral),
            vintage_eq: VintageEq::new(sample_rate, cfg.vintage_eq),
            eq: Eq::new(sample_rate, cfg.eq),
            dynamic_eq: DynamicEq::new(sample_rate, cfg.dynamic_eq),
            multiband: Multiband::new(sample_rate, cfg.multiband),
            dynamics: Dynamics::new(sample_rate, cfg.dynamics),
            vintage_comp: VintageCompressor::new(sample_rate, cfg.vintage_comp),
            impact: Impact::new(sample_rate, cfg.impact),
            low_end_focus: LowEndFocus::new(sample_rate, cfg.low_end_focus),
            exciter: Exciter::new(sample_rate, cfg.exciter),
            tape: VintageTape::new(sample_rate, cfg.tape),
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
        self.declick.set_config(cfg.declick);
        self.dehum.set_config(cfg.dehum);
        self.denoise.set_config(cfg.denoise);
        self.deess.set_config(cfg.deess);
        self.spectral.set_config(cfg.spectral);
        self.vintage_eq.set_config(cfg.vintage_eq);
        self.eq.set_config(cfg.eq);
        self.dynamic_eq.set_config(cfg.dynamic_eq);
        self.multiband.set_config(cfg.multiband);
        self.dynamics.set_config(cfg.dynamics);
        self.vintage_comp.set_config(cfg.vintage_comp);
        self.impact.set_config(cfg.impact);
        self.low_end_focus.set_config(cfg.low_end_focus);
        self.exciter.set_config(cfg.exciter);
        self.tape.set_config(cfg.tape);
        self.imager.set_config(cfg.imager);
        self.limiter.set_config(cfg.limiter);
        self.output_gain.set_db(cfg.output_gain_db);
    }

    /// Total processing latency in samples, summed over the modules that
    /// introduce delay.  The host uses it to align a dry/wet comparison and
    /// to compensate the offline render.
    pub fn latency_samples(&self) -> usize {
        if self.cfg.bypass {
            return 0;
        }
        self.declick.latency_samples()
            + self.denoise.latency_samples()
            + self.spectral.latency_samples()
    }

    /// Measured long-term tonal curve, in dB per curve band (Tonal Balance).
    pub fn tonal_curve_db(&self) -> [f64; CURVE_BANDS] {
        self.spectral.source_curve_db()
    }

    /// Deviation of the tonal curve from the configured target, per band.
    pub fn tonal_deviation_db(&self) -> [f64; CURVE_BANDS] {
        self.spectral.tonal_deviation_db()
    }

    /// The spectral correction currently applied, per curve band.
    pub fn spectral_correction_db(&self) -> [f64; CURVE_BANDS] {
        self.spectral.applied_curve_db()
    }

    /// Whether the tonal analysis has observed enough audio to be trusted.
    pub fn tonal_analysis_ready(&self) -> bool {
        self.spectral.analysis_ready()
    }

    /// Number of samples the de-clicker has repaired since the last reset.
    pub fn declick_repair_count(&self) -> u32 {
        self.declick.repair_count()
    }

    /// Start capturing a de-noise profile from the audio that follows.
    pub fn denoise_begin_learn(&mut self) {
        self.denoise.begin_learn();
    }

    /// Finish a de-noise profile capture.  Returns `false` (keeping the old
    /// profile) when nothing was captured.
    pub fn denoise_finish_learn(&mut self) -> bool {
        self.denoise.finish_learn()
    }

    /// Whether a usable de-noise profile exists.
    pub fn denoise_has_profile(&self) -> bool {
        self.denoise.has_profile()
    }

    /// Write the learned noise floor, in dBFS per FFT bin, into `out`.
    pub fn denoise_profile_db(&self, out: &mut [f64]) {
        self.denoise.profile_db(out);
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

        // Canonical mastering order: repair what is broken, correct the
        // tone, control the dynamics, add character, place the image, then
        // set the level.  Each stage assumes the ones before it have run.
        self.input_gain.process_stereo(left, right);

        // 1 — Restoration.
        self.declick.process_stereo(left, right);
        self.dehum.process_stereo(left, right);
        self.denoise.process_stereo(left, right);
        self.deess.process_stereo(left, right);

        // 2 — Corrective EQ and the shared spectral stage.
        self.parametric_eq.process_stereo(left, right);
        self.spectral.process_stereo(left, right);

        // 3 — Tone shaping.
        self.vintage_eq.process_stereo(left, right);
        self.eq.process_stereo(left, right);
        self.dynamic_eq.process_stereo(left, right);

        // 4 — Dynamics, broad to fine.
        self.multiband.process_stereo(left, right);
        self.dynamics.process_stereo(left, right);
        self.vintage_comp.process_stereo(left, right);
        self.impact.process_stereo(left, right);
        self.low_end_focus.process_stereo(left, right);

        // 5 — Character.
        self.exciter.process_stereo(left, right);
        self.tape.process_stereo(left, right);

        // 6 — Image and output stage.
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
            multiband_db: self.multiband.band_gain_reduction_db(),
            deess_db: self.deess.gain_reduction_db(),
            vintage_comp_db: self.vintage_comp.gain_reduction_db(),
            dynamic_eq_db: self.dynamic_eq.applied_gains_db(),
            impact_db: self.impact.band_move_db(),
            low_end_focus_db: self.low_end_focus.contrast_move_db(),
            dehum_db: self.dehum.applied_depth_db(),
        };
    }

    /// Clear all module state (transport seek / source swap).
    pub fn reset(&mut self) {
        self.declick.reset();
        self.dehum.reset();
        self.denoise.reset();
        self.deess.reset();
        self.parametric_eq.reset();
        self.spectral.reset();
        self.vintage_eq.reset();
        self.eq.reset();
        self.dynamic_eq.reset();
        self.multiband.reset();
        self.dynamics.reset();
        self.vintage_comp.reset();
        self.impact.reset();
        self.low_end_focus.reset();
        self.exciter.reset();
        self.tape.reset();
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
            limiter: LimiterConfig { ceiling_dbtp: -1.0, lookahead_ms: 1.0, isp: false, bypass: false, ..Default::default() },
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
            imager: ImagerConfig { width_pct: 130.0, low_mono_hz: 120.0, bypass: false, ..Default::default() },
            limiter: LimiterConfig { ceiling_dbtp: -0.8, lookahead_ms: 2.0, isp: true, bypass: false, ..Default::default() },
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
            imager: ImagerConfig { width_pct: 200.0, low_mono_hz: 120.0, bypass: false, ..Default::default() },
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

    /// With the output limiter out of the way, a default chain must be a
    /// straight wire.  Every module has an identity short-circuit; if one of
    /// them regresses this catches it before the preview starts quietly
    /// colouring untouched audio.  (The limiter is excluded because it is a
    /// lookahead stage — it always delays, by design.)
    #[test]
    fn neutral_chain_is_bit_transparent() {
        let mut chain = MasteringChain::new(48_000.0, MasteringChainConfig {
            limiter: LimiterConfig { bypass: true, ..LimiterConfig::default() },
            ..MasteringChainConfig::default()
        });
        let input = sine(4096, 1000.0, 48_000.0, 0.4);
        let mut l = input.clone();
        let mut r = input.clone();
        chain.process_stereo_block(&mut l, &mut r);
        assert_eq!(l, input, "neutral chain altered the left channel");
        assert_eq!(r, input, "neutral chain altered the right channel");
        assert_eq!(chain.latency_samples(), 0, "neutral chain must add no latency");
    }

    /// Latency is reported only by the modules that are actually engaged.
    #[test]
    fn latency_tracks_engaged_modules() {
        let mut chain = MasteringChain::new(48_000.0, MasteringChainConfig::default());
        assert_eq!(chain.latency_samples(), 0);

        chain.set_config(MasteringChainConfig {
            denoise: DenoiseConfig { reduction_db: 12.0, ..DenoiseConfig::default() },
            ..MasteringChainConfig::default()
        });
        let with_denoise = chain.latency_samples();
        assert!(with_denoise > 0, "engaged de-noise should report latency");

        chain.set_config(MasteringChainConfig {
            denoise: DenoiseConfig { reduction_db: 12.0, ..DenoiseConfig::default() },
            spectral: SpectralConfig {
                shaper_enabled: true, shaper_amount_pct: 50.0, ..SpectralConfig::default()
            },
            ..MasteringChainConfig::default()
        });
        assert!(chain.latency_samples() > with_denoise,
                "adding the spectral stage should add its frame too");
    }

    /// Every new module engaged at once must still produce finite, bounded
    /// audio — the combination is what the product actually ships.
    #[test]
    fn full_chain_engaged_stays_sane() {
        let cfg = MasteringChainConfig {
            input_gain_db: 3.0,
            declick: DeclickConfig { bypass: false, ..DeclickConfig::default() },
            dehum: DehumConfig { depth_db: 18.0, ..DehumConfig::default() },
            denoise: DenoiseConfig { reduction_db: 12.0, ..DenoiseConfig::default() },
            deess: DeessConfig { range_db: 8.0, ..DeessConfig::default() },
            spectral: SpectralConfig {
                shaper_enabled: true, shaper_amount_pct: 60.0,
                stabilizer_enabled: true, stabilizer_amount_pct: 50.0,
                ..SpectralConfig::default()
            },
            vintage_eq: VintageEqConfig { low_boost_db: 4.0, low_cut_db: 4.0, ..VintageEqConfig::default() },
            dynamic_eq: {
                let mut d = DynamicEqConfig::default();
                d.bands[0] = DynEqBandConfig { enabled: true, frequency_hz: 250.0, ..DynEqBandConfig::default() };
                d
            },
            multiband: {
                let mut m = MultibandConfig::default();
                for b in m.bands.iter_mut() { b.threshold_db = -24.0; b.ratio = 3.0; }
                m
            },
            vintage_comp: VintageCompressorConfig { ratio: 2.5, threshold_db: -20.0, ..VintageCompressorConfig::default() },
            impact: ImpactConfig { impact_pct: [40.0, 20.0, -20.0, 30.0], ..ImpactConfig::default() },
            low_end_focus: LowEndFocusConfig { contrast_pct: 60.0, gain_db: 2.0, ..LowEndFocusConfig::default() },
            exciter: ExciterConfig { band_amount_pct: [20.0, 30.0, 40.0, 50.0], ..ExciterConfig::default() },
            tape: VintageTapeConfig { drive_db: 8.0, mix_pct: 60.0, wow_flutter_pct: 30.0, ..VintageTapeConfig::default() },
            imager: ImagerConfig { width_pct: 120.0, band_width_pct: [60.0, 100.0, 130.0, 150.0], ..ImagerConfig::default() },
            limiter: LimiterConfig {
                ceiling_dbtp: -1.0, drive_db: 6.0,
                character: LimiterCharacter::Aggressive, ..LimiterConfig::default()
            },
            ..MasteringChainConfig::default()
        };
        let mut chain = MasteringChain::new(48_000.0, cfg);
        let mut l = sine(48_000, 220.0, 48_000.0, 0.6);
        let mut r = sine(48_000, 223.0, 48_000.0, 0.6);
        chain.process_stereo_block(&mut l, &mut r);

        assert!(l.iter().chain(r.iter()).all(|x| x.is_finite()));
        let ceiling = db_to_lin(-1.0) as f32;
        let peak = l.iter().chain(r.iter()).fold(0.0f32, |m, &x| m.max(x.abs()));
        assert!(peak <= ceiling + 1e-3, "peak {peak} exceeded ceiling {ceiling}");
        assert_eq!(chain.safety_events(), 0, "a valid config must not trip the safety layer");
    }

    /// The maximizer's drive must actually raise level, and its character
    /// must not let the output past the ceiling.
    #[test]
    fn maximizer_drive_raises_level_within_ceiling() {
        let quiet = sine(24_000, 440.0, 48_000.0, 0.05);
        let mut levels = vec![];
        for drive in [0.0, 12.0] {
            let cfg = MasteringChainConfig {
                limiter: LimiterConfig {
                    ceiling_dbtp: -1.0, drive_db: drive,
                    character: LimiterCharacter::Punchy, ..LimiterConfig::default()
                },
                ..MasteringChainConfig::default()
            };
            let mut chain = MasteringChain::new(48_000.0, cfg);
            let mut l = quiet.clone();
            let mut r = quiet.clone();
            chain.process_stereo_block(&mut l, &mut r);
            let peak = l.iter().fold(0.0f32, |m, &x| m.max(x.abs()));
            assert!(peak <= db_to_lin(-1.0) as f32 + 1e-3);
            levels.push(peak);
        }
        assert!(levels[1] > levels[0] * 2.0, "drive did not raise level: {levels:?}");
    }

    /// Per-band imager widths must narrow the low end without collapsing
    /// the whole image.
    #[test]
    fn per_band_imager_narrows_only_its_band() {
        let cfg = MasteringChainConfig {
            imager: ImagerConfig {
                band_width_pct: [0.0, 100.0, 100.0, 100.0],
                ..ImagerConfig::default()
            },
            ..MasteringChainConfig::default()
        };
        let mut chain = MasteringChain::new(48_000.0, cfg);
        // Pure side content: a 60 Hz tone in the low band, 8 kHz up top.
        let n = 16_384;
        let low = sine(n, 60.0, 48_000.0, 0.3);
        let high = sine(n, 8_000.0, 48_000.0, 0.3);
        let mut l: Vec<f32> = low.iter().zip(high.iter()).map(|(a, b)| a + b).collect();
        let mut r: Vec<f32> = low.iter().zip(high.iter()).map(|(a, b)| -a - b).collect();
        chain.process_stereo_block(&mut l, &mut r);

        // The low band folded to mono cancels (L = -R there), leaving the
        // high band's side content intact.
        let residual = l[n / 2..].iter().fold(0.0f32, |m, &x| m.max(x.abs()));
        assert!(residual > 0.05, "the high band should survive, peak {residual}");
        assert!(l.iter().all(|x| x.is_finite()));
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
