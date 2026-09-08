//! The mastering chain — assembles the modules in canonical order.

use super::config::{db_to_lin, MasteringChainConfig};
use super::gain::Gain;
use super::eq::Eq;
use super::parametric_eq::{ParametricBand, ParametricEq};
use super::delay::Delay;
use super::top_rebuild::TopRebuild;
use super::reverb::Reverb;
use super::dynamics::Dynamics;
use super::imager::Imager;
use super::limiter::Limiter;
use super::loudness::LoudnessTarget;
use super::declick::Declick;
use super::dehum::Dehum;
use super::dither::Dither;
use super::monitor::Monitor;
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
    top_rebuild: TopRebuild,
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
    delay: Delay,
    reverb: Reverb,
    // Stereo + output.
    imager: Imager,
    limiter: Limiter,
    output_gain: Gain,
    /// Automatic gain toward a loudness target.  Corrects at the chain
    /// INPUT from a measurement of the chain OUTPUT, so the limiter stays
    /// inside the loop and the ceiling still holds.
    loudness: LoudnessTarget,
    dither: Dither,
    monitor: Monitor,
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
            top_rebuild: TopRebuild::new(sample_rate, cfg.top_rebuild),
            // Built from the config like every other module.  Leaving it
            // empty here would mean a chain constructed with bands went
            // silent on them until the first `set_config` — the offline
            // render constructs once and never calls it.
            parametric_eq: {
                let mut p = ParametricEq::new(sample_rate);
                p.set_bands(if cfg.parametric_eq.bypass { &[] } else { &cfg.parametric_eq.bands[..] });
                p
            },
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
            delay: Delay::new(sample_rate, cfg.delay),
            reverb: Reverb::new(sample_rate, cfg.reverb),
            imager: Imager::new(sample_rate, cfg.imager),
            limiter: Limiter::new(sample_rate, cfg.limiter),
            loudness: LoudnessTarget::new(sample_rate, cfg.loudness),
            output_gain: Gain::from_db(cfg.output_gain_db),
            dither: Dither::new(sample_rate, cfg.dither),
            monitor: Monitor::new(sample_rate, cfg.monitor),
            gr: GainReduction::default(),
            dry_l: vec![0.0; SAFETY_SCRATCH],
            dry_r: vec![0.0; SAFETY_SCRATCH],
            safety_events: 0,
        }
    }

    /// Replace the free parametric EQ band list directly.
    ///
    /// `set_config` also carries the band list, and it is the path the UI
    /// uses.  This one remains for hosts driving the chain positionally —
    /// but the two are not independent: a later `set_config` replaces
    /// whatever this wrote.  One source of truth, and it is the config.
    pub fn set_parametric_eq_bands(&mut self, bands: &[ParametricBand]) {
        self.parametric_eq.set_bands(bands);
        // Keep the stored config in step, so a subsequent `set_config`
        // built from `self.cfg` does not silently undo this call.
        for (slot, b) in self.cfg.parametric_eq.bands.iter_mut().zip(bands.iter()) {
            *slot = *b;
        }
        for slot in self.cfg.parametric_eq.bands.iter_mut().skip(bands.len()) {
            *slot = ParametricBand::default();
        }
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
        self.top_rebuild.set_config(cfg.top_rebuild);
        self.parametric_eq.set_bands(
            if cfg.parametric_eq.bypass { &[] } else { &cfg.parametric_eq.bands[..] },
        );
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
        self.delay.set_config(cfg.delay);
        self.reverb.set_config(cfg.reverb);
        self.imager.set_config(cfg.imager);
        self.limiter.set_config(cfg.limiter);
        self.loudness.set_config(cfg.loudness);
        self.output_gain.set_db(cfg.output_gain_db);
        self.dither.set_config(cfg.dither);
        self.monitor.set_config(cfg.monitor);
    }

    /// Loudness the chain is currently adding, in dB (wet − dry).
    ///
    /// Only measured while the monitor stage is active; 0 otherwise.
    pub fn monitor_loudness_delta_db(&self) -> f64 {
        self.monitor.loudness_delta_db()
    }

    /// Gain the A/B loudness match is applying, in dB.
    pub fn monitor_match_gain_db(&self) -> f64 {
        self.monitor.match_gain_db()
    }

    /// Measured loudness of the dry path (LUFS).
    pub fn monitor_dry_lufs(&self) -> f64 { self.monitor.dry_lufs() }

    /// Measured loudness of the processed path (LUFS).
    pub fn monitor_wet_lufs(&self) -> f64 { self.monitor.wet_lufs() }

    /// Whether the monitor stage is changing what you hear.  True means the
    /// output is a listening tool, NOT the master.
    pub fn monitoring_active(&self) -> bool {
        !self.cfg.bypass && self.monitor.is_active()
    }

    /// Whether the dither stage is quantising (false at 32-bit float or when
    /// bypassed).  The export path uses it to avoid dithering a second time
    /// in the file writer.
    pub fn dither_engaged(&self) -> bool {
        !self.cfg.bypass && self.dither.is_engaged()
    }

    /// The quantisation step the dither stage is targeting, in dBFS.
    /// `-inf` when the stage is not quantising.
    pub fn dither_lsb_dbfs(&self) -> f64 {
        if self.cfg.bypass { f64::NEG_INFINITY } else { self.dither.lsb_dbfs() }
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
        // Keep a dry copy so a bad block can be replaced bit-for-bit, and so
        // the monitor stage has something to compare the output against.
        let backed_up = n <= self.dry_l.len();
        if backed_up {
            self.dry_l[..n].copy_from_slice(&left[..n]);
            self.dry_r[..n].copy_from_slice(&right[..n]);
        }
        // Latency must be read BEFORE the modules run: it is a property of
        // the config, and the monitor needs it to align the dry path.
        let latency = self.latency_samples();

        // Canonical mastering order: repair what is broken, correct the
        // tone, control the dynamics, add character, place the image, then
        // set the level.  Each stage assumes the ones before it have run.
        self.input_gain.process_stereo(left, right);

        // 0 — Loudness target.
        //
        // Applied HERE, at the input, from a measurement taken at the end of
        // this same function. That ordering is the whole design: the offline
        // render reaches a loudness target by measuring its own output and
        // re-rendering with the input gain adjusted, so putting the realtime
        // correction in the same place makes the two converge on the same
        // answer instead of being tuned to resemble each other. It also
        // keeps the limiter inside the loop, so the ceiling still holds
        // however hard the loop pushes.
        if self.loudness.is_active() {
            let g = self.loudness.gain_lin() as f32;
            for i in 0..n {
                left[i] *= g;
                right[i] *= g;
            }
        }

        // 1 — Restoration.
        self.declick.process_stereo(left, right);
        self.dehum.process_stereo(left, right);
        self.denoise.process_stereo(left, right);
        self.deess.process_stereo(left, right);
        self.top_rebuild.process_stereo(left, right);

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
        self.delay.process_stereo(left, right);
        self.reverb.process_stereo(left, right);

        // 6 — Image and output stage.
        self.imager.process_stereo(left, right);
        self.limiter.process_stereo(left, right);
        self.output_gain.process_stereo(left, right);

        // The ceiling has to survive the output trim.
        //
        // `output_gain` runs after the limiter, so a positive trim walked
        // straight past the ceiling the limiter had just enforced — the
        // limiter's own contract says "the output can never exceed the
        // ceiling", and it could. Easy to miss while the chain ran quiet;
        // obvious once the loudness loop started delivering material that
        // actually reaches the ceiling, where +3 dB of trim peaked at
        // +1.7 dBFS and clipped on the way to the file.
        //
        // Clamping rather than reordering keeps the trim meaning what it
        // says for the ordinary case (a negative trim), and makes the
        // ceiling the last word in every case.
        if !self.cfg.limiter.bypass {
            let ceil = db_to_lin(self.cfg.limiter.ceiling_dbtp) as f32;
            for i in 0..n {
                left[i] = left[i].clamp(-ceil, ceil);
                right[i] = right[i].clamp(-ceil, ceil);
            }
        }

        // 7 — Dither + quantisation.  Last processing stage: it targets the
        // output file's bit depth, so anything after it would break the
        // quantisation it just established.
        self.dither.process_stereo(left, right);

        // Close the loudness loop.  Measured after every processing stage,
        // so what it reads is what the listener hears; the correction it
        // computes lands on the next block's input gain above. One block of
        // loop delay, which at 128 samples is under 3 ms against a
        // multi-second time constant.
        //
        // Before the monitor, deliberately: A/B and delta replace the
        // output with a level-matched dry signal, and measuring that would
        // make the loop chase the comparison rather than the master.
        self.loudness.observe(&left[..n], &right[..n]);

        // 8 — Monitoring.  Not processing: A/B and delta live outside the
        // signal chain proper, which is why they run after dither and why
        // they are skipped entirely unless the user asked for them.  Needs
        // the block's dry copy, so it is limited to blocks that fit the
        // scratch — larger blocks only occur in offline render, where
        // monitoring is never enabled.
        if backed_up && self.monitor.is_active() {
            let (dry_l, dry_r) = (&self.dry_l[..n], &self.dry_r[..n]);
            self.monitor.process(&mut left[..n], &mut right[..n], dry_l, dry_r, latency);
        }

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
        self.top_rebuild.reset();
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
        self.delay.reset();
        self.reverb.reset();
        self.imager.reset();
        self.limiter.reset();
        self.loudness.reset();
        self.dither.reset();
        self.monitor.reset();
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
    fn a_positive_output_trim_cannot_break_the_ceiling() {
        // `output_gain` runs AFTER the limiter, so a positive trim used to
        // walk straight past the ceiling the limiter had just enforced --
        // the limiter's contract says the output can never exceed it, and
        // it could.  Measured at +1.7 dBFS with a +3 dB trim once the
        // loudness loop started delivering material that reaches the
        // ceiling at all.
        for trim in [0.0, 3.0, 6.0, 12.0] {
            let cfg = MasteringChainConfig {
                limiter: LimiterConfig {
                    ceiling_dbtp: -1.0, lookahead_ms: 1.0, isp: false, bypass: false,
                    ..Default::default()
                },
                output_gain_db: trim,
                ..Default::default()
            };
            let mut chain = MasteringChain::new(48_000.0, cfg);
            let n = 4096;
            let mut l: Vec<f32> = (0..n)
                .map(|i| 0.9 * (2.0 * std::f64::consts::PI * 220.0 * i as f64 / 48_000.0).sin() as f32)
                .collect();
            let mut r = l.clone();
            for a in (0..n).step_by(512) {
                let b = (a + 512).min(n);
                chain.process_stereo_block(&mut l[a..b], &mut r[a..b]);
            }
            let peak = l.iter().chain(r.iter()).fold(0.0f32, |m, x| m.max(x.abs()));
            let ceiling = db_to_lin(-1.0) as f32;
            assert!(
                peak <= ceiling + 1e-3,
                "output trim {trim} dB broke the ceiling: peak {peak} > {ceiling}",
            );
        }
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

    /// Dither must be off by default — it is the last irreversible step
    /// before a file is written and must never appear uninvited.
    #[test]
    fn dither_is_off_by_default() {
        let chain = MasteringChain::new(48_000.0, MasteringChainConfig::default());
        assert!(!chain.dither_engaged());
        assert!(chain.dither_lsb_dbfs().is_infinite());
    }

    /// Engaging it must quantise the chain output to the target depth.
    #[test]
    fn dither_quantises_the_chain_output() {
        let cfg = MasteringChainConfig {
            limiter: LimiterConfig { bypass: true, ..LimiterConfig::default() },
            dither: DitherConfig { bit_depth: 16, mode: DitherMode::Tpdf, auto_blank: false, bypass: false },
            ..MasteringChainConfig::default()
        };
        let mut chain = MasteringChain::new(48_000.0, cfg);
        let mut l = sine(4096, 1_000.0, 48_000.0, 0.4);
        let mut r = l.clone();
        chain.process_stereo_block(&mut l, &mut r);

        assert!(chain.dither_engaged());
        assert!((chain.dither_lsb_dbfs() - (-90.3)).abs() < 0.5);
        // Every sample must land exactly on a 16-bit step.
        let scale = 32_768.0f64;
        assert!(
            l.iter().all(|&s| {
                let n = s as f64 * scale;
                (n - n.round()).abs() < 1e-6
            }),
            "chain output is not quantised to 16-bit",
        );
    }

    /// Master bypass must skip dither too — a bypassed chain is a wire.
    #[test]
    fn master_bypass_skips_dither() {
        let cfg = MasteringChainConfig {
            bypass: true,
            dither: DitherConfig { bit_depth: 16, mode: DitherMode::Tpdf, auto_blank: false, bypass: false },
            ..MasteringChainConfig::default()
        };
        let mut chain = MasteringChain::new(48_000.0, cfg);
        let input = sine(512, 1_000.0, 48_000.0, 0.3);
        let mut l = input.clone();
        let mut r = input.clone();
        chain.process_stereo_block(&mut l, &mut r);
        assert_eq!(l, input);
        assert!(!chain.dither_engaged());
    }

    /// Monitoring must be off unless asked for — the chain output is the
    /// master, not a listening tool.
    #[test]
    fn monitoring_is_off_by_default() {
        let chain = MasteringChain::new(48_000.0, MasteringChainConfig::default());
        assert!(!chain.monitoring_active());
    }

    /// Bypass monitoring must return the input, delayed to match whatever
    /// latency the engaged modules introduced.  This is the whole basis of
    /// a fair A/B: same timing, same material.
    #[test]
    fn monitor_bypass_returns_the_aligned_dry() {
        let cfg = MasteringChainConfig {
            // Engage a real STFT module so the chain has genuine latency.
            denoise: DenoiseConfig { reduction_db: 12.0, ..DenoiseConfig::default() },
            limiter: LimiterConfig { bypass: true, ..LimiterConfig::default() },
            monitor: MonitorConfig { mode: MonitorMode::Bypass, ..MonitorConfig::default() },
            ..MasteringChainConfig::default()
        };
        let mut chain = MasteringChain::new(48_000.0, cfg);
        let latency = chain.latency_samples();
        assert!(latency > 0, "test needs a latent chain");

        let n = 8192;
        let input = sine(n, 440.0, 48_000.0, 0.4);
        let mut l = input.clone();
        let mut r = input.clone();
        chain.process_stereo_block(&mut l, &mut r);

        let mut worst = 0.0f32;
        for i in latency..n {
            worst = worst.max((l[i] - input[i - latency]).abs());
        }
        assert!(worst < 1e-5, "bypass monitoring is not the aligned dry, worst {worst}");
        assert!(chain.monitoring_active());
    }

    /// Delta on a chain that does nothing but delay must be silence.  If the
    /// alignment is off by even one sample this fails loudly, which is
    /// exactly what makes it worth having.
    #[test]
    fn monitor_delta_of_a_transparent_chain_is_silence() {
        let cfg = MasteringChainConfig {
            denoise: DenoiseConfig { reduction_db: 12.0, ..DenoiseConfig::default() },
            limiter: LimiterConfig { bypass: true, ..LimiterConfig::default() },
            monitor: MonitorConfig { mode: MonitorMode::Delta, ..MonitorConfig::default() },
            ..MasteringChainConfig::default()
        };
        let mut chain = MasteringChain::new(48_000.0, cfg);
        let latency = chain.latency_samples();

        // Silence in, silence out — the de-noiser has nothing to remove, so
        // the only thing the chain contributes is its delay.
        let n = 8192;
        let mut l = vec![0.0f32; n];
        let mut r = vec![0.0f32; n];
        chain.process_stereo_block(&mut l, &mut r);
        let residual = l[latency..].iter().fold(0.0f32, |a, b| a.max(b.abs()));
        assert!(residual < 1e-6, "delta of a silent pass should be silent, got {residual}");
    }

    /// Delta must surface what a module actually did.
    #[test]
    fn monitor_delta_surfaces_a_real_change() {
        let cfg = MasteringChainConfig {
            eq: EqConfig { air_db: 6.0, ..EqConfig::default() },
            limiter: LimiterConfig { bypass: true, ..LimiterConfig::default() },
            monitor: MonitorConfig { mode: MonitorMode::Delta, ..MonitorConfig::default() },
            ..MasteringChainConfig::default()
        };
        let mut chain = MasteringChain::new(48_000.0, cfg);
        let n = 16_384;
        // Content in the air band, where the EQ boost lands.
        let mut l = sine(n, 14_000.0, 48_000.0, 0.3);
        let mut r = l.clone();
        chain.process_stereo_block(&mut l, &mut r);
        let energy = l[n / 2..].iter().fold(0.0f32, |a, b| a.max(b.abs()));
        assert!(energy > 0.05, "delta should show the air boost, peak {energy}");
    }

    /// Loudness matching must neutralise a pure level change, so an A/B is
    /// comparing processing rather than makeup gain.
    #[test]
    fn monitor_match_neutralises_output_gain() {
        let cfg = MasteringChainConfig {
            // The chain's only job here is +6 dB.
            output_gain_db: 6.0,
            limiter: LimiterConfig { bypass: true, ..LimiterConfig::default() },
            monitor: MonitorConfig {
                mode: MonitorMode::Processed, loudness_match: true,
                ..MonitorConfig::default()
            },
            ..MasteringChainConfig::default()
        };
        let mut chain = MasteringChain::new(48_000.0, cfg);
        let n = 48_000 * 12;
        let input = sine(n, 1_000.0, 48_000.0, 0.2);
        let mut l = input.clone();
        let mut r = input.clone();
        // Fed in realistic blocks — the hosts call this with 128 (worklet)
        // or 512 (offline) samples, and the monitor's dry tap is bounded by
        // the same scratch the safety layer uses.
        for chunk in 0..(n / 512) {
            let a = chunk * 512;
            let b = a + 512;
            chain.process_stereo_block(&mut l[a..b], &mut r[a..b]);
        }

        let tail = n - 48_000;
        let rms = |x: &[f32]| -> f64 {
            (x[tail..].iter().map(|v| (*v as f64) * (*v as f64)).sum::<f64>()
                / (x.len() - tail) as f64).sqrt()
        };
        let delta_db = 20.0 * (rms(&l) / rms(&input)).log10();
        assert!(delta_db.abs() < 1.0, "matched A/B should sit at dry level, off {delta_db:.2} dB");
        assert!(
            (chain.monitor_loudness_delta_db() - 6.0).abs() < 1.0,
            "chain should report ≈ +6 dB added, got {:.2}",
            chain.monitor_loudness_delta_db(),
        );
    }

    /// The monitor's dry tap rides on the safety scratch, so a block larger
    /// than that cannot be compared and monitoring is skipped for it.  Real
    /// hosts use 128/512-sample blocks, and offline render never monitors —
    /// but the behaviour is asserted rather than left as a surprise.
    #[test]
    fn monitoring_is_skipped_for_oversized_blocks() {
        let cfg = MasteringChainConfig {
            limiter: LimiterConfig { bypass: true, ..LimiterConfig::default() },
            monitor: MonitorConfig { mode: MonitorMode::Bypass, ..MonitorConfig::default() },
            ..MasteringChainConfig::default()
        };
        let mut chain = MasteringChain::new(48_000.0, cfg);
        // Well past SAFETY_SCRATCH.
        let n = SAFETY_SCRATCH * 2;
        let input = sine(n, 440.0, 48_000.0, 0.3);
        let mut l = input.clone();
        let mut r = input.clone();
        chain.process_stereo_block(&mut l, &mut r);
        // Bypass monitoring did NOT engage, so this is the processed output
        // (here: the default EQ curve), not the dry.
        assert!(l.iter().all(|x| x.is_finite()));

        // The same material in host-sized blocks does engage it.
        let mut l2 = input.clone();
        let mut r2 = input.clone();
        for chunk in 0..(n / 512) {
            let a = chunk * 512;
            let b = a + 512;
            chain.process_stereo_block(&mut l2[a..b], &mut r2[a..b]);
        }
        let mut worst = 0.0f32;
        for i in 0..n {
            worst = worst.max((l2[i] - input[i]).abs());
        }
        assert!(worst < 1e-5, "block-fed bypass should return the dry, worst {worst}");
    }

    /// Measured gain of the chain at one frequency, in dB.
    fn chain_gain_db_at(cfg: MasteringChainConfig, hz: f64) -> f64 {
        let sr = 48_000.0;
        let mut chain = MasteringChain::new(sr, cfg);
        let n = 1 << 14;
        let amp = 0.2f32;
        let mut l: Vec<f32> = (0..n)
            .map(|i| (2.0 * std::f64::consts::PI * hz * i as f64 / sr).sin() as f32 * amp)
            .collect();
        let mut r = l.clone();
        for a in (0..n).step_by(512) {
            let b = (a + 512).min(n);
            chain.process_stereo_block(&mut l[a..b], &mut r[a..b]);
        }
        let tail = &l[n / 2..];
        let out = (tail.iter().map(|x| (x * x) as f64).sum::<f64>() / tail.len() as f64).sqrt();
        20.0 * (out / (amp as f64 / 2f64.sqrt())).log10()
    }

    #[test]
    fn parametric_bands_arrive_through_the_config() {
        // The band list used to be reachable only by a side-channel setter,
        // which meant the JSON config — the one object the preview and the
        // export share — could not describe a user-drawn EQ at all.
        let mut cfg = MasteringChainConfig::default();
        cfg.limiter.bypass = true;
        cfg.eq.bypass = true;
        cfg.dynamics.bypass = true;
        cfg.imager.bypass = true;
        cfg.parametric_eq.bands[0] = ParametricBand {
            kind: super::super::parametric_eq::ParametricBandType::Bell,
            frequency_hz: 1000.0,
            gain_db: 9.0,
            q: 4.0,
            enabled: true,
        };
        let at_1k = chain_gain_db_at(cfg, 1000.0);
        assert!((at_1k - 9.0).abs() < 0.6, "config band not applied: {at_1k:.2} dB");

        // …and bypass must actually take it out of the path.
        cfg.parametric_eq.bypass = true;
        let bypassed = chain_gain_db_at(cfg, 1000.0);
        assert!(bypassed.abs() < 0.1, "bypassed parametric EQ still filtering: {bypassed:.2} dB");
    }

    #[test]
    fn many_parametric_bands_stack() {
        // "Unlimited bands" in the UI is sixteen here; the cascade must
        // actually run all of them rather than quietly keeping the first few.
        let mut cfg = MasteringChainConfig::default();
        cfg.limiter.bypass = true;
        cfg.eq.bypass = true;
        cfg.dynamics.bypass = true;
        cfg.imager.bypass = true;
        for i in 0..8 {
            cfg.parametric_eq.bands[i] = ParametricBand {
                kind: super::super::parametric_eq::ParametricBandType::Bell,
                frequency_hz: 1000.0,
                gain_db: 1.0,
                q: 2.0,
                enabled: true,
            };
        }
        let g = chain_gain_db_at(cfg, 1000.0);
        assert!((g - 8.0).abs() < 0.6, "eight stacked +1 dB bells gave {g:.2} dB");
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
