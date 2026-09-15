//! Monitoring — loudness-matched A/B and delta listening.
//!
//! This is not a processor.  It is the stage that lets you *judge* the
//! processors, and it exists because two things make an untrained A/B
//! useless:
//!
//! **Louder wins.** A mastering chain almost always raises level, and at
//! matched programme material the louder version is preferred essentially
//! every time — regardless of whether it is better. An A/B button that does
//! not level-match is not comparing your processing, it is comparing your
//! makeup gain. So the monitor measures both paths with K-weighting
//! (BS.1770) and brings one to the other's loudness before you hear them.
//!
//! **Latency ruins the comparison.** The chain's spectral modules delay the
//! signal by thousands of samples. Comparing an undelayed dry against a
//! delayed wet gives you a phasey, smeared A/B and a delta made mostly of
//! timing error. The dry path is therefore held in a delay line and read
//! back at exactly the chain's reported latency, so the two are
//! sample-aligned no matter which modules are engaged.
//!
//! # Modes
//!
//! | Mode | You hear |
//! |---|---|
//! | `Processed` | The chain output (the normal case) |
//! | `Bypass` | The dry input, delay- and loudness-aligned to the wet |
//! | `Delta` | Wet − dry: *only* what the chain changed |
//!
//! Delta is the honest test of a module. Level-matched first, so a stage
//! that only changed gain shows up as near-silence rather than a loud copy
//! of the programme — which is exactly the information you want.
//!
//! # This must never run on an export
//!
//! Loudness matching deliberately alters the output level, and Bypass and
//! Delta are not the master. `Processed` with matching off is an exact
//! pass-through; anything else is a listening tool only. The export path
//! never configures this stage.
//!
//! Realtime-safe: all buffers are allocated in the constructor.

use crate::k_weighting::KWeightingChannel;
use super::config::{MatchTarget, MonitorConfig, MonitorMode};

/// Longest chain latency the dry delay line can align to.
///
/// The chain's worst case today is de-click (32) + de-noise (2048) +
/// spectral (2048) = 4128.  Sized well past that so a future STFT module
/// does not silently break alignment.
pub const MAX_ALIGN_SAMPLES: usize = 16_384;

/// Loudness follower time constant, in seconds.  Matches the 3 s window of
/// short-term LUFS — long enough that the match gain does not breathe with
/// the music, short enough to settle within a phrase.
const FOLLOW_TAU_S: f64 = 3.0;

/// Hard limit on the match gain.  A mastering chain that moved level by
/// more than this has something wrong with it, and an auto-gain that large
/// pointed at someone's monitors is a hazard, not a feature.
const MAX_MATCH_DB: f64 = 18.0;

/// Mean-square floor below which the followers are not trusted yet.
/// Roughly -80 dBFS; under this the match gain stays at unity.
const MS_FLOOR: f64 = 1e-8;

/// A K-weighted loudness follower for one stereo path.
struct Follower {
    k_l: KWeightingChannel,
    k_r: KWeightingChannel,
    /// Smoothed sum of channel mean-squares (BS.1770 weights L=R=1).
    ms: f64,
    coeff: f64,
}

impl Follower {
    fn new(sample_rate: f64) -> Self {
        Self {
            k_l: KWeightingChannel::new(sample_rate),
            k_r: KWeightingChannel::new(sample_rate),
            ms: 0.0,
            coeff: (-1.0 / (FOLLOW_TAU_S * sample_rate)).exp(),
        }
    }

    #[inline]
    fn push(&mut self, l: f64, r: f64) {
        let kl = self.k_l.process(l);
        let kr = self.k_r.process(r);
        let inst = kl * kl + kr * kr;
        self.ms = inst + self.coeff * (self.ms - inst);
    }

    /// Loudness in LUFS, using the BS.1770 offset.  `-inf` below the floor.
    fn lufs(&self) -> f64 {
        if self.ms <= MS_FLOOR {
            f64::NEG_INFINITY
        } else {
            -0.691 + 10.0 * self.ms.log10()
        }
    }

    fn reset(&mut self) {
        self.k_l.reset();
        self.k_r.reset();
        self.ms = 0.0;
    }
}

/// Monitoring stage — A/B alignment, loudness match, delta.
pub struct Monitor {
    cfg: MonitorConfig,
    /// Dry delay line, one per channel.
    dry_l: Vec<f32>,
    dry_r: Vec<f32>,
    write: usize,
    dry: Follower,
    wet: Follower,
    /// Smoothed linear match gain actually applied.
    match_gain: f64,
    /// Latency the dry path is currently aligned to.
    align: usize,
}

impl Monitor {
    /// Construct for a sample rate.
    pub fn new(sample_rate: f64, cfg: MonitorConfig) -> Self {
        // The ring only has to hold the alignment history: each sample
        // reads the slot written `align` samples ago, which is still intact
        // however long the block is.  Block size is irrelevant.
        let cap = MAX_ALIGN_SAMPLES + 1;
        Self {
            cfg,
            dry_l: vec![0.0; cap],
            dry_r: vec![0.0; cap],
            write: 0,
            dry: Follower::new(sample_rate),
            wet: Follower::new(sample_rate),
            match_gain: 1.0,
            align: 0,
        }
    }

    /// Update parameters.
    pub fn set_config(&mut self, cfg: MonitorConfig) {
        self.cfg = cfg;
    }

    /// True when the stage would change what you hear.
    ///
    /// `Processed` with matching off is an exact pass-through, and is
    /// skipped outright — the dry delay line is not even written, so
    /// monitoring costs nothing when it is not in use.
    pub fn is_active(&self) -> bool {
        self.cfg.mode != MonitorMode::Processed || self.cfg.loudness_match
    }

    /// The match gain currently applied, in dB.  0 when matching is off.
    ///
    /// The UI shows this: an A/B that silently moved the level by 4 dB is
    /// exactly as misleading as one that did not match at all, so the figure
    /// has to be on screen.
    pub fn match_gain_db(&self) -> f64 {
        if !self.cfg.loudness_match {
            return 0.0;
        }
        20.0 * self.match_gain.max(1e-9).log10()
    }

    /// Measured loudness of the dry path (LUFS, short-term style).
    pub fn dry_lufs(&self) -> f64 { self.dry.lufs() }

    /// Measured loudness of the wet path (LUFS, short-term style).
    pub fn wet_lufs(&self) -> f64 { self.wet.lufs() }

    /// Loudness the chain added, in dB.  This is the number an engineer
    /// wants when asking "am I only hearing it because it got louder?".
    pub fn loudness_delta_db(&self) -> f64 {
        let d = self.dry.lufs();
        let w = self.wet.lufs();
        if d.is_finite() && w.is_finite() { w - d } else { 0.0 }
    }

    /// Samples of chain latency the dry path is aligned to.
    pub fn alignment_samples(&self) -> usize { self.align }

    /// Process a block.
    ///
    /// `wet` is the chain output, modified in place.  `dry_*` is the block
    /// as it entered the chain.  `latency` is the chain's current reported
    /// latency, used to delay the dry path into alignment.
    pub fn process(
        &mut self,
        wet_l: &mut [f32],
        wet_r: &mut [f32],
        dry_l: &[f32],
        dry_r: &[f32],
        latency: usize,
    ) {
        if !self.is_active() {
            return;
        }
        let cap = self.dry_l.len();
        let n = wet_l.len().min(wet_r.len()).min(dry_l.len()).min(dry_r.len());
        let align = latency.min(MAX_ALIGN_SAMPLES);
        self.align = align;

        let mode = self.cfg.mode;
        let matching = self.cfg.loudness_match;
        let target = self.cfg.match_target;
        let delta_gain = 10f64.powf(self.cfg.delta_gain_db.clamp(0.0, 40.0) / 20.0);
        let max_gain = 10f64.powf(MAX_MATCH_DB / 20.0);
        // Smoothing on the applied gain, on top of the followers' own — the
        // gain must never step, or the A/B click becomes the loudest thing
        // in the comparison.
        let gain_smooth = 0.9995;

        for i in 0..n {
            // Dry delay line: write, then read `align` samples back.  At
            // align = 0 the read lands on the slot just written.
            self.dry_l[self.write] = dry_l[i];
            self.dry_r[self.write] = dry_r[i];
            let read = (self.write + cap - align) % cap;
            let dl = self.dry_l[read] as f64;
            let dr = self.dry_r[read] as f64;
            self.write = (self.write + 1) % cap;

            let wl = wet_l[i] as f64;
            let wr = wet_r[i] as f64;

            // Both followers see time-aligned material, so the ratio is a
            // like-for-like comparison rather than a race between paths.
            self.dry.push(dl, dr);
            self.wet.push(wl, wr);

            if matching {
                let (src, dst) = match target {
                    // Bring the wet down to the dry: hear what the chain did
                    // without the loudness advantage.
                    MatchTarget::Dry => (self.wet.ms, self.dry.ms),
                    // Bring the dry up to the wet: compare tone at the level
                    // the master will actually sit at.
                    MatchTarget::Wet => (self.dry.ms, self.wet.ms),
                };
                let want = if src > MS_FLOOR && dst > MS_FLOOR {
                    (dst / src).sqrt().clamp(1.0 / max_gain, max_gain)
                } else {
                    1.0
                };
                self.match_gain = want + gain_smooth * (self.match_gain - want);
            } else {
                self.match_gain = 1.0;
            }

            // Apply the gain to whichever path is NOT the target.
            let (dry_out_l, dry_out_r, wet_out_l, wet_out_r) = if matching {
                match target {
                    MatchTarget::Dry => (dl, dr, wl * self.match_gain, wr * self.match_gain),
                    MatchTarget::Wet => (dl * self.match_gain, dr * self.match_gain, wl, wr),
                }
            } else {
                (dl, dr, wl, wr)
            };

            let (out_l, out_r) = match mode {
                MonitorMode::Processed => (wet_out_l, wet_out_r),
                MonitorMode::Bypass => (dry_out_l, dry_out_r),
                MonitorMode::Delta => (
                    (wet_out_l - dry_out_l) * delta_gain,
                    (wet_out_r - dry_out_r) * delta_gain,
                ),
            };

            wet_l[i] = out_l as f32;
            wet_r[i] = out_r as f32;
        }
    }

    /// Clear delay line and followers.
    pub fn reset(&mut self) {
        self.dry_l.fill(0.0);
        self.dry_r.fill(0.0);
        self.write = 0;
        self.dry.reset();
        self.wet.reset();
        self.match_gain = 1.0;
        self.align = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: f64 = 48_000.0;

    fn cfg(mode: MonitorMode) -> MonitorConfig {
        MonitorConfig {
            mode,
            loudness_match: false,
            match_target: MatchTarget::Dry,
            delta_gain_db: 0.0,
        }
    }

    fn sine(n: usize, freq: f64, amp: f32) -> Vec<f32> {
        (0..n).map(|i| (2.0 * std::f64::consts::PI * freq * i as f64 / SR).sin() as f32 * amp).collect()
    }

    fn rms(x: &[f32], from: usize) -> f64 {
        (x[from..].iter().map(|v| (*v as f64) * (*v as f64)).sum::<f64>() / (x.len() - from) as f64).sqrt()
    }

    #[test]
    fn processed_without_matching_is_a_pass_through() {
        let mut m = Monitor::new(SR, cfg(MonitorMode::Processed));
        assert!(!m.is_active());
        let dry = sine(4096, 1_000.0, 0.4);
        let wet: Vec<f32> = dry.iter().map(|v| v * 0.5).collect();
        let mut l = wet.clone();
        let mut r = wet.clone();
        m.process(&mut l, &mut r, &dry, &dry, 0);
        assert_eq!(l, wet, "an inactive monitor must not touch the chain output");
    }

    /// Bypass must return the dry signal, delayed into alignment with the
    /// wet — that is what makes an A/B comparable at all.
    #[test]
    fn bypass_returns_the_latency_aligned_dry() {
        let latency = 2_048;
        let mut m = Monitor::new(SR, cfg(MonitorMode::Bypass));
        let n = 16_384;
        let dry = sine(n, 440.0, 0.4);
        // A "wet" that is nothing like the dry, so any leakage is obvious.
        let wet = sine(n, 3_000.0, 0.9);
        let mut l = wet.clone();
        let mut r = wet.clone();
        m.process(&mut l, &mut r, &dry, &dry, latency);

        let mut worst = 0.0f32;
        for i in latency..n {
            worst = worst.max((l[i] - dry[i - latency]).abs());
        }
        assert!(worst < 1e-6, "bypass is not the delayed dry, worst {worst}");
        assert_eq!(m.alignment_samples(), latency);
    }

    /// With zero latency the alignment is a plain copy.
    #[test]
    fn bypass_at_zero_latency_is_the_dry_itself() {
        let mut m = Monitor::new(SR, cfg(MonitorMode::Bypass));
        let dry = sine(1024, 440.0, 0.4);
        let mut l = vec![0.0f32; 1024];
        let mut r = vec![0.0f32; 1024];
        m.process(&mut l, &mut r, &dry, &dry, 0);
        assert_eq!(l, dry);
    }

    /// Delta of an unchanged chain is silence — the strongest statement the
    /// mode can make, and the one that proves the alignment is right.
    #[test]
    fn delta_of_an_unchanged_chain_is_silence() {
        let latency = 512;
        let mut m = Monitor::new(SR, cfg(MonitorMode::Delta));
        let n = 8192;
        let dry = sine(n, 440.0, 0.4);
        // Wet = dry delayed by the chain latency, i.e. a chain that did
        // nothing but delay.
        let mut wet = vec![0.0f32; n];
        wet[latency..].copy_from_slice(&dry[..n - latency]);
        let mut l = wet.clone();
        let mut r = wet.clone();
        m.process(&mut l, &mut r, &dry, &dry, latency);

        let residual = l[latency + 64..].iter().fold(0.0f32, |a, b| a.max(b.abs()));
        assert!(residual < 1e-6, "delta should be silent, residual {residual}");
    }

    /// Delta must show what the chain actually changed.
    #[test]
    fn delta_shows_the_change() {
        let mut m = Monitor::new(SR, cfg(MonitorMode::Delta));
        let n = 8192;
        let dry = sine(n, 440.0, 0.4);
        let added = sine(n, 5_000.0, 0.1);
        let wet: Vec<f32> = dry.iter().zip(added.iter()).map(|(a, b)| a + b).collect();
        let mut l = wet.clone();
        let mut r = wet.clone();
        m.process(&mut l, &mut r, &dry, &dry, 0);

        let mut worst = 0.0f32;
        for i in 0..n {
            worst = worst.max((l[i] - added[i]).abs());
        }
        assert!(worst < 1e-5, "delta should be the added signal, worst {worst}");
    }

    /// The point of the feature: a chain that only made things louder must
    /// A/B as (near) identical once matched.
    #[test]
    fn loudness_match_removes_a_pure_gain_difference() {
        let mut m = Monitor::new(SR, MonitorConfig {
            loudness_match: true, ..cfg(MonitorMode::Processed)
        });
        let n = (SR * 12.0) as usize;   // long enough for a 3 s follower
        let dry = sine(n, 1_000.0, 0.2);
        // "Processing" that is nothing but +6 dB.
        let wet: Vec<f32> = dry.iter().map(|v| v * 2.0).collect();
        let mut l = wet.clone();
        let mut r = wet.clone();
        m.process(&mut l, &mut r, &dry, &dry, 0);

        // The tail should be back at the dry level.
        let tail = n - (SR as usize);
        let delta_db = 20.0 * (rms(&l, tail) / rms(&dry, tail)).log10();
        assert!(delta_db.abs() < 1.0, "matched output should sit at dry level, off by {delta_db:.2} dB");
        assert!(
            (m.match_gain_db() - (-6.0)).abs() < 1.0,
            "expected ≈ -6 dB of match gain, got {:.2}",
            m.match_gain_db(),
        );
        assert!(
            (m.loudness_delta_db() - 6.0).abs() < 1.0,
            "chain loudness delta should read ≈ +6 dB, got {:.2}",
            m.loudness_delta_db(),
        );
    }

    /// Matching towards the wet raises the dry instead of lowering the wet.
    #[test]
    fn match_target_wet_lifts_the_dry() {
        let mut m = Monitor::new(SR, MonitorConfig {
            mode: MonitorMode::Bypass,
            loudness_match: true,
            match_target: MatchTarget::Wet,
            delta_gain_db: 0.0,
        });
        let n = (SR * 12.0) as usize;
        let dry = sine(n, 1_000.0, 0.2);
        let wet: Vec<f32> = dry.iter().map(|v| v * 2.0).collect();
        let mut l = wet.clone();
        let mut r = wet.clone();
        m.process(&mut l, &mut r, &dry, &dry, 0);

        let tail = n - (SR as usize);
        // Bypass output should now sit at the WET level, not the dry one.
        let delta_db = 20.0 * (rms(&l, tail) / rms(&wet, tail)).log10();
        assert!(delta_db.abs() < 1.0, "bypass should be lifted to wet level, off by {delta_db:.2} dB");
        assert!(m.match_gain_db() > 4.0, "expected a positive lift, got {:.2}", m.match_gain_db());
    }

    /// A runaway match gain pointed at someone's monitors is a hazard.
    #[test]
    fn match_gain_is_clamped() {
        let mut m = Monitor::new(SR, MonitorConfig {
            loudness_match: true, ..cfg(MonitorMode::Processed)
        });
        let n = (SR * 20.0) as usize;
        let dry = sine(n, 1_000.0, 0.5);
        // A wet path 60 dB quieter — matching would want +60 dB.
        let wet: Vec<f32> = dry.iter().map(|v| v * 0.001).collect();
        let mut l = wet.clone();
        let mut r = wet.clone();
        m.process(&mut l, &mut r, &dry, &dry, 0);
        assert!(
            m.match_gain_db() <= MAX_MATCH_DB + 0.01,
            "match gain broke its clamp: {:.2} dB",
            m.match_gain_db(),
        );
    }

    /// Delta gain makes a quiet difference audible without touching the
    /// difference itself.
    #[test]
    fn delta_gain_scales_the_difference() {
        let n = 8192;
        let dry = sine(n, 440.0, 0.4);
        let added = sine(n, 5_000.0, 0.01);
        let wet: Vec<f32> = dry.iter().zip(added.iter()).map(|(a, b)| a + b).collect();

        let run = |gain_db: f64| -> f64 {
            let mut m = Monitor::new(SR, MonitorConfig {
                delta_gain_db: gain_db, ..cfg(MonitorMode::Delta)
            });
            let mut l = wet.clone();
            let mut r = wet.clone();
            m.process(&mut l, &mut r, &dry, &dry, 0);
            rms(&l, 0)
        };
        let plain = run(0.0);
        let lifted = run(20.0);
        let ratio_db = 20.0 * (lifted / plain).log10();
        assert!((ratio_db - 20.0).abs() < 0.5, "delta gain off: {ratio_db:.2} dB");
    }

    #[test]
    fn reset_clears_alignment_and_followers() {
        let mut m = Monitor::new(SR, cfg(MonitorMode::Bypass));
        let dry = sine(4096, 440.0, 0.5);
        let mut l = dry.clone();
        let mut r = dry.clone();
        m.process(&mut l, &mut r, &dry, &dry, 256);
        m.reset();
        assert_eq!(m.alignment_samples(), 0);
        assert!(m.dry_lufs().is_infinite());

        // A silent block after reset must come out silent (no stale tail).
        let silence = vec![0.0f32; 1024];
        let mut sl = silence.clone();
        let mut sr = silence.clone();
        m.process(&mut sl, &mut sr, &silence, &silence, 256);
        assert!(sl.iter().all(|&s| s == 0.0));
    }

    #[test]
    fn output_stays_finite_on_extremes() {
        let mut m = Monitor::new(SR, MonitorConfig {
            loudness_match: true, delta_gain_db: 40.0, ..cfg(MonitorMode::Delta)
        });
        let n = 8192;
        let dry: Vec<f32> = (0..n).map(|i| if i % 2 == 0 { 3.0 } else { -3.0 }).collect();
        let wet: Vec<f32> = (0..n).map(|i| if i % 3 == 0 { -4.0 } else { 4.0 }).collect();
        let mut l = wet.clone();
        let mut r = wet.clone();
        m.process(&mut l, &mut r, &dry, &dry, 128);
        assert!(l.iter().all(|s| s.is_finite()));
    }
}
