//! Click / crackle removal — vinyl ticks, digital dropouts, edit clicks.
//!
//! Impulsive defects are short (a handful of samples), broadband, and — the
//! property that makes them detectable — *unpredictable* from the samples
//! around them.  The classic restoration approach, and the one used here:
//!
//!   1. **Detect.**  Run a high-pass "click emphasis" filter, then compare
//!      each sample's emphasised magnitude against a running median-style
//!      estimate of its neighbourhood.  A sample that spikes far above the
//!      local statistic is a click candidate.
//!   2. **Repair.**  Replace the damaged run by cubic Hermite interpolation
//!      across it, using clean samples either side.  Interpolation is
//!      inaudible for runs of a few samples and far less destructive than
//!      gating or zeroing.
//!
//! A short delay line (`MAX_RUN + GUARD`) gives the detector its lookahead,
//! so the repair can see the far side of a click before emitting it.
//!
//! Sensitivity is a threshold in "× above local level": 4.0 means a sample
//! must exceed four times the neighbourhood estimate to count as a click.

use crate::biquad::{Biquad, BiquadCoeffs};
use super::config::DeclickConfig;
use super::StereoModule;

/// Longest defect the repairer will interpolate across, in samples.
pub const MAX_RUN: usize = 24;
/// Clean samples kept either side of a repair for the interpolator.
const GUARD: usize = 4;
/// Delay-line length — lookahead the detector needs.
const DELAY: usize = MAX_RUN + 2 * GUARD;
/// Time constant of the local-level estimate, in samples (≈ 85 ms @ 48 kHz).
/// Long enough that the *shape* of programme material never drags the
/// estimate around — only a genuine impulse stands out against it.
const LEVEL_TAU: f64 = 4096.0;
/// Time constant used while warming up, so the estimate converges in a few
/// milliseconds instead of taking the full `LEVEL_TAU` to become usable.
const WARM_TAU: f64 = 256.0;
/// Samples the detector observes before it is allowed to repair anything,
/// so a cold level estimate can't fire on the first transient it sees.
/// ≈ 43 ms at 48 kHz.
const WARMUP: usize = 2048;

/// One channel's detector + repair state.
struct ChannelState {
    /// Lookahead delay line.
    ring: Vec<f32>,
    /// Emphasised (high-passed) magnitude, aligned with `ring`.
    emph: Vec<f32>,
    write: usize,
    /// Click-emphasis high-pass.
    hp: Biquad,
    /// Smoothed local level of the emphasised signal.
    level: f64,
    /// Samples repaired since the last reset (for the UI counter).
    repairs: u32,
    /// True until the delay line has filled.
    priming: usize,
    /// Samples still to observe before repairs are enabled.
    warmup: usize,
}

impl ChannelState {
    fn new(sr: f64) -> Self {
        Self {
            ring: vec![0.0; DELAY],
            emph: vec![0.0; DELAY],
            write: 0,
            hp: Biquad::new(BiquadCoeffs::high_pass(sr, (sr * 0.12).min(6_000.0), 0.707)),
            level: 0.0,
            repairs: 0,
            priming: DELAY,
            warmup: WARMUP,
        }
    }

    fn set_sample_rate(&mut self, sr: f64) {
        self.hp.set_coeffs(BiquadCoeffs::high_pass(sr, (sr * 0.12).min(6_000.0), 0.707));
    }

    fn reset(&mut self) {
        self.ring.fill(0.0);
        self.emph.fill(0.0);
        self.write = 0;
        self.hp.reset();
        self.level = 0.0;
        self.priming = DELAY;
        self.warmup = WARMUP;
    }

    #[inline]
    fn at(&self, offset: usize) -> f32 {
        self.ring[(self.write + offset) % DELAY]
    }

    #[inline]
    fn set_at(&mut self, offset: usize, v: f32) {
        let idx = (self.write + offset) % DELAY;
        self.ring[idx] = v;
    }

    #[inline]
    fn emph_at(&self, offset: usize) -> f32 {
        self.emph[(self.write + offset) % DELAY]
    }
}

/// Impulsive-defect remover.
pub struct Declick {
    cfg: DeclickConfig,
    left: ChannelState,
    right: ChannelState,
    level_coeff: f64,
    warm_coeff: f64,
}

/// Cubic Hermite interpolation between `y1` (t=0) and `y2` (t=1), with
/// `y0` / `y3` supplying the tangents.  Catmull-Rom tangents.
#[inline]
fn hermite(y0: f32, y1: f32, y2: f32, y3: f32, t: f32) -> f32 {
    let m1 = 0.5 * (y2 - y0);
    let m2 = 0.5 * (y3 - y1);
    let t2 = t * t;
    let t3 = t2 * t;
    (2.0 * t3 - 3.0 * t2 + 1.0) * y1
        + (t3 - 2.0 * t2 + t) * m1
        + (-2.0 * t3 + 3.0 * t2) * y2
        + (t3 - t2) * m2
}

impl Declick {
    /// Construct from a sample rate + config.
    pub fn new(sample_rate: f64, cfg: DeclickConfig) -> Self {
        let mut left = ChannelState::new(sample_rate);
        let mut right = ChannelState::new(sample_rate);
        left.set_sample_rate(sample_rate);
        right.set_sample_rate(sample_rate);
        Self {
            cfg,
            left,
            right,
            level_coeff: (-1.0 / LEVEL_TAU).exp(),
            warm_coeff: (-1.0 / WARM_TAU).exp(),
        }
    }

    /// Update parameters.
    pub fn set_config(&mut self, cfg: DeclickConfig) {
        self.cfg = cfg;
    }

    /// Processing latency in samples.
    pub fn latency_samples(&self) -> usize {
        if self.cfg.bypass { 0 } else { DELAY }
    }

    /// Number of samples repaired since the last reset (both channels).
    pub fn repair_count(&self) -> u32 {
        self.left.repairs.saturating_add(self.right.repairs)
    }

    fn process_channel(&mut self, buf: &mut [f32], is_left: bool) {
        let sensitivity = self.cfg.sensitivity.clamp(1.5, 20.0);
        let max_run = (self.cfg.max_run_samples.clamp(1, MAX_RUN as u32)) as usize;
        let coeff = self.level_coeff;
        let warm_coeff = self.warm_coeff;
        let ch = if is_left { &mut self.left } else { &mut self.right };

        for sample in buf.iter_mut() {
            let x = *sample;
            // Emphasise: a click is broadband, so it dominates the high-passed
            // signal even when the programme material is bass-heavy.
            let e = ch.hp.process(x as f64).abs();

            // While warming up, converge the level estimate quickly so the
            // detector is usable within a few ms of the start of a track.
            let c = if ch.warmup > 0 { warm_coeff } else { coeff };
            ch.level = e + c * (ch.level - e);

            // Read the oldest sample out of the slot we are about to reuse,
            // THEN write the newest one into it — so the delay is exactly
            // DELAY samples and no input is lost.
            let slot = ch.write;
            let oldest = ch.ring[slot];
            ch.ring[slot] = x;
            ch.emph[slot] = e as f32;
            ch.write = (ch.write + 1) % DELAY;

            *sample = if ch.priming > 0 {
                ch.priming -= 1;
                0.0
            } else {
                oldest
            };

            if ch.warmup > 0 {
                ch.warmup -= 1;
                continue;
            }

            // ── Detect at the repair position ────────────────────────────
            // Look at the sample just past the guard region, so a detected
            // run still has clean samples on both sides inside the ring.
            let probe = GUARD;
            let threshold = (ch.level * sensitivity).max(1e-6);
            if (ch.emph_at(probe) as f64) <= threshold {
                continue;
            }

            // Measure how long the defect runs.
            let mut run = 1;
            while run < max_run && (ch.emph_at(probe + run) as f64) > threshold * 0.5 {
                run += 1;
            }
            if probe + run + GUARD >= DELAY {
                continue; // not enough clean context — leave it alone
            }

            // ── Repair by cubic interpolation across the run ─────────────
            let y0 = ch.at(probe - 2);
            let y1 = ch.at(probe - 1);
            let y2 = ch.at(probe + run);
            let y3 = ch.at(probe + run + 1);
            for k in 0..run {
                let t = (k + 1) as f32 / (run + 1) as f32;
                ch.set_at(probe + k, hermite(y0, y1, y2, y3, t));
            }
            ch.repairs = ch.repairs.saturating_add(run as u32);
        }
    }
}

impl StereoModule for Declick {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        if self.cfg.bypass {
            return;
        }
        self.process_channel(left, true);
        self.process_channel(right, false);
    }

    fn reset(&mut self) {
        self.left.reset();
        self.right.reset();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> DeclickConfig {
        DeclickConfig { sensitivity: 4.0, max_run_samples: 16, bypass: false }
    }

    fn tone(n: usize, freq: f64, sr: f64, amp: f32) -> Vec<f32> {
        (0..n).map(|i| (2.0 * std::f64::consts::PI * freq * i as f64 / sr).sin() as f32 * amp).collect()
    }

    #[test]
    fn bypass_is_passthrough() {
        let mut d = Declick::new(48_000.0, DeclickConfig { bypass: true, ..cfg() });
        let mut l = tone(512, 440.0, 48_000.0, 0.5);
        let orig = l.clone();
        let mut r = l.clone();
        d.process_stereo(&mut l, &mut r);
        assert_eq!(l, orig);
    }

    /// A clean tone must come through as a pure delay, not a mangled one.
    #[test]
    fn clean_signal_is_only_delayed() {
        let mut d = Declick::new(48_000.0, cfg());
        let n = 8192;
        let input = tone(n, 440.0, 48_000.0, 0.5);
        let mut l = input.clone();
        let mut r = input.clone();
        d.process_stereo(&mut l, &mut r);
        let mut worst = 0.0f32;
        for i in DELAY..n {
            worst = worst.max((l[i] - input[i - DELAY]).abs());
        }
        assert!(worst < 1e-5, "clean signal altered by {worst}");
        assert_eq!(d.repair_count(), 0, "no clicks should have been detected");
    }

    /// An injected impulse must be interpolated away.
    #[test]
    fn removes_injected_click() {
        let mut d = Declick::new(48_000.0, cfg());
        let n = 8192;
        let input = tone(n, 440.0, 48_000.0, 0.3);
        let mut l = input.clone();
        // Inject a hard click well past the priming region.
        for k in 0..3 {
            l[4000 + k] = if k % 2 == 0 { 0.95 } else { -0.95 };
        }
        let mut r = l.clone();
        d.process_stereo(&mut l, &mut r);
        assert!(d.repair_count() > 0, "click was not detected");
        // Output around the click should track the underlying tone again.
        let out = &l[4000 + DELAY - 1..4000 + DELAY + 6];
        let want = &input[3999..4006];
        for (o, w) in out.iter().zip(want.iter()) {
            assert!((o - w).abs() < 0.25, "repair left {o} vs expected ≈ {w}");
        }
    }

    #[test]
    fn output_stays_finite_on_extremes() {
        let mut d = Declick::new(48_000.0, cfg());
        let mut l = vec![0.0f32; 4096];
        for (i, s) in l.iter_mut().enumerate() {
            *s = if i % 7 == 0 { 3.0 } else { -3.0 };
        }
        let mut r = l.clone();
        d.process_stereo(&mut l, &mut r);
        assert!(l.iter().all(|s| s.is_finite()));
    }
}
