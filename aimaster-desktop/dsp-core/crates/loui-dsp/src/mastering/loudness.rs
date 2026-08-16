//! Loudness target — make "Target LUFS" mean something while listening.
//!
//! # The bug this fixes
//!
//! The limiter panel has always had a **Target LUFS** control, and moving it
//! did nothing you could hear. Two separate reasons, both real:
//!
//!   1. `chain-config.ts` never read `targetLufs`. It went into the
//!      parameter state and stopped there — a knob wired to nothing.
//!   2. The offline render DID honour it, by measuring the rendered output
//!      and re-rendering with the input gain adjusted (a two-pass solve).
//!
//! So the preview was raw chain output while the export was normalised to
//! the target. Those are routinely 6-10 dB apart, and the preview is the
//! quiet one. Every judgement made while listening was made at the wrong
//! level.
//!
//! # What this does
//!
//! The same thing the offline pass does, arranged so one pass can do it:
//! measure the loudness of the chain's **output**, and adjust the gain at
//! its **input** to close the gap. Because the loop measures after the
//! chain and corrects before it, it settles on exactly the fixed point the
//! offline two-pass solves for algebraically — the two agree by
//! construction rather than by being tuned to match.
//!
//! Correcting at the input rather than the output is the part that matters
//! for safety: the limiter is inside the loop, so it still sees and catches
//! everything the gain pushes at it, and the ceiling holds.
//!
//! # Why it does not pump
//!
//! An automatic gain that reacts quickly is a compressor with a very long
//! attack, and it would flatten the record's own dynamics — the loud chorus
//! would be pulled down to match the quiet verse. So:
//!
//!   * loudness is measured K-weighted, over a window of a few hundred
//!     milliseconds, the way LUFS is defined;
//!   * the gain moves on a multi-second time constant, so it tracks the
//!     song rather than the bar;
//!   * it is gated: below `ABS_GATE_LUFS` nothing is measured and the gain
//!     holds, so a fade-out is not answered by winding the gain up into the
//!     noise floor.
//!
//! Realtime-safe: two biquad pairs and three scalars, no allocation, no
//! branches on data beyond the gate.

use crate::k_weighting::KWeightingChannel;
use super::config::LoudnessConfig;

/// Below this, the signal is treated as silence and the gain holds.
///
/// The same absolute gate BS.1770 uses, and for the same reason: without it
/// a quiet passage reads as "needs +30 dB".
const ABS_GATE_LUFS: f64 = -70.0;
/// The offset in the LUFS formula, from BS.1770.
const LUFS_OFFSET: f64 = -0.691;
/// Measurement window, in milliseconds.
///
/// Between BS.1770's momentary (400 ms) and short-term (3 s) windows. Long
/// enough that individual beats do not move it, short enough that the loop
/// has settled within the first few seconds of playback.
const WINDOW_MS: f64 = 600.0;
/// Floor on the measured mean square, so silence cannot divide by zero.
const MS_FLOOR: f64 = 1e-12;
/// How long the loop stays in fast acquisition after signal starts.
///
/// Steady-state has to be slow or the loop becomes a compressor, but slow
/// all the way from the start means the first half-minute of listening
/// happens at the wrong level — measured at 20 seconds to settle, which is
/// far too long to wait after pressing play. So the loop acquires quickly
/// and then hands over to the slow constant, which is how every automatic
/// gain worth using behaves.
const ACQUIRE_MS: f64 = 1_200.0;
/// Time constant during acquisition.
const ACQUIRE_SPEED_MS: f64 = 150.0;

fn one_pole(sr: f64, ms: f64) -> f64 {
    if ms <= 0.0 { return 0.0; }
    (-1.0 / (ms * 0.001 * sr)).exp()
}

/// Automatic gain toward an integrated-loudness target.
pub struct LoudnessTarget {
    sr: f64,
    cfg: LoudnessConfig,
    k_l: KWeightingChannel,
    k_r: KWeightingChannel,
    /// Running mean square of the K-weighted output.
    ms: f64,
    ms_coeff: f64,
    /// The gain being applied, in dB, and its slew coefficient.
    gain_db: f64,
    gain_coeff: f64,
    /// True until the first block has been observed — lets the first block
    /// jump straight to the right gain instead of sliding up to it.
    priming: bool,
    /// Samples of signal seen since the loop last started, for the
    /// acquisition window.  Saturates rather than wrapping.
    acquired: f64,
    /// Fast time constant used while acquiring.
    acquire_coeff: f64,
}

impl LoudnessTarget {
    /// Construct from a sample rate + config.
    pub fn new(sample_rate: f64, cfg: LoudnessConfig) -> Self {
        let mut m = Self {
            sr: sample_rate,
            cfg,
            k_l: KWeightingChannel::new(sample_rate),
            k_r: KWeightingChannel::new(sample_rate),
            ms: 0.0,
            ms_coeff: one_pole(sample_rate, WINDOW_MS),
            gain_db: 0.0,
            gain_coeff: 0.0,
            priming: true,
            acquired: 0.0,
            acquire_coeff: 0.0,
        };
        m.set_config(cfg);
        m
    }

    /// Update parameters.  Never allocates.
    ///
    /// Every field is sanitised on the way in rather than at the point of
    /// use. A non-finite target would survive `clamp` — `f64::NAN.clamp(a,
    /// b)` is NAN — reach `gain_db`, and from there multiply the audio.
    pub fn set_config(&mut self, mut cfg: LoudnessConfig) {
        let d = LoudnessConfig::default();
        if !cfg.target_lufs.is_finite() { cfg.target_lufs = d.target_lufs; }
        cfg.target_lufs = cfg.target_lufs.clamp(-60.0, 0.0);
        if !cfg.max_boost_db.is_finite() { cfg.max_boost_db = d.max_boost_db; }
        cfg.max_boost_db = cfg.max_boost_db.abs().clamp(0.0, 40.0);
        if !cfg.max_cut_db.is_finite() { cfg.max_cut_db = d.max_cut_db; }
        cfg.max_cut_db = cfg.max_cut_db.abs().clamp(0.0, 40.0);
        if !cfg.speed_ms.is_finite() { cfg.speed_ms = d.speed_ms; }
        self.cfg = cfg;
        self.ms_coeff = one_pole(self.sr, WINDOW_MS);
        self.gain_coeff = one_pole(self.sr, cfg.speed_ms.clamp(100.0, 20_000.0));
        self.acquire_coeff = one_pole(self.sr, ACQUIRE_SPEED_MS);
    }

    /// False when the stage cannot change the signal.
    pub fn is_active(&self) -> bool {
        !self.cfg.bypass && self.cfg.enabled
    }

    /// Reset the loop.  Called on transport changes.
    pub fn reset(&mut self) {
        self.k_l.reset();
        self.k_r.reset();
        self.ms = 0.0;
        self.gain_db = 0.0;
        self.priming = true;
        self.acquired = 0.0;
    }

    /// The linear gain to apply at the chain input for this block.
    #[inline]
    pub fn gain_lin(&self) -> f64 {
        if !self.is_active() { return 1.0; }
        crate::mastering::config::db_to_lin(self.gain_db)
    }

    /// The gain currently applied, in dB — for the meter.
    pub fn gain_db(&self) -> f64 {
        if !self.is_active() { 0.0 } else { self.gain_db }
    }

    /// The measured output loudness, in LUFS — for the meter.
    ///
    /// Returns `ABS_GATE_LUFS` for anything at or below the gate rather
    /// than a large negative number, so a display never has to special-case
    /// silence.
    pub fn measured_lufs(&self) -> f64 {
        let l = LUFS_OFFSET + 10.0 * (self.ms.max(MS_FLOOR)).log10();
        if l < ABS_GATE_LUFS { ABS_GATE_LUFS } else { l }
    }

    /// Observe the chain's OUTPUT for one block, and move the gain.
    ///
    /// Called after the chain has run. The correction it computes is applied
    /// at the input of the *next* block — one block of loop delay, which at
    /// 128 samples is under 3 ms and irrelevant next to a multi-second time
    /// constant.
    pub fn observe(&mut self, left: &[f32], right: &[f32]) {
        if !self.is_active() {
            // Keep the gain wound back to unity so re-enabling does not
            // step, but do not measure — the stage is off.
            self.gain_db = 0.0;
            self.priming = true;
            self.acquired = 0.0;
            return;
        }
        let n = left.len().min(right.len());
        if n == 0 { return; }

        // The gate has to look at THIS block, not at the smoothed figure.
        //
        // Gating on the smoothed measurement was the first attempt and it
        // was wrong in a way only a test caught: the running average decays
        // exponentially, so digital silence reads as quiet-but-present
        // music for many seconds. The loop answered a fade-out by winding
        // the gain up — 4.2 dB to 8.5 dB across two seconds of nothing.
        //
        // So the block's own level decides, and when it fails the gate
        // BOTH the average and the gain are left untouched.
        let ms_before = self.ms;
        let mut block_sum = 0.0;
        for i in 0..n {
            // BS.1770 sums the weighted mean squares of the channels, both
            // at unit weight for stereo.
            let a = self.k_l.process(left[i] as f64);
            let b = self.k_r.process(right[i] as f64);
            let power = a * a + b * b;
            block_sum += power;
            self.ms = power + (self.ms - power) * self.ms_coeff;
        }

        let block_lufs = LUFS_OFFSET + 10.0 * ((block_sum / n as f64).max(MS_FLOOR)).log10();
        if block_lufs < ABS_GATE_LUFS {
            // Silence. Hold everything — do not chase the noise floor.
            self.ms = ms_before;
            return;
        }

        let measured = LUFS_OFFSET + 10.0 * (self.ms.max(MS_FLOOR)).log10();

        // The correction is relative to the gain ALREADY applied: the
        // measurement is of output that has been through it, so the error
        // is (target - measured) on top of what is being applied.
        let want = (self.gain_db + (self.cfg.target_lufs - measured))
            .clamp(-self.cfg.max_cut_db.abs(), self.cfg.max_boost_db.abs());

        if self.priming {
            // First measurement: jump. Sliding in from 0 dB would make the
            // opening seconds of every track fade up, which reads as a bug.
            self.gain_db = want;
            self.priming = false;
        } else {
            // Fast while acquiring, slow once settled. Per-block slew, so
            // the rate does not depend on block size.
            let acquiring = self.acquired < ACQUIRE_MS * 0.001 * self.sr;
            let base = if acquiring { self.acquire_coeff } else { self.gain_coeff };
            let c = base.powi(n as i32);
            self.gain_db = want + (self.gain_db - want) * c;
        }
        self.acquired = (self.acquired + n as f64).min(1e12);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mastering::config::db_to_lin;

    const SR: f64 = 48_000.0;

    fn cfg() -> LoudnessConfig {
        LoudnessConfig { enabled: true, ..LoudnessConfig::default() }
    }

    /// Pink-ish broadband at a known amplitude, so loudness is meaningful.
    fn tone(n: usize, amp: f64) -> (Vec<f32>, Vec<f32>) {
        let mut l = Vec::with_capacity(n);
        for i in 0..n {
            let t = i as f64 / SR;
            let v = 0.6 * (2.0 * std::f64::consts::PI * 220.0 * t).sin()
                + 0.3 * (2.0 * std::f64::consts::PI * 1_000.0 * t).sin()
                + 0.1 * (2.0 * std::f64::consts::PI * 3_500.0 * t).sin();
            l.push((v * amp) as f32);
        }
        let r = l.clone();
        (l, r)
    }

    /// Run the loop to convergence and return the settled gain, in dB.
    ///
    /// Models the real arrangement: gain at the input, measurement of the
    /// output. With no chain in between, output = input * gain.
    fn settle(c: LoudnessConfig, amp: f64, seconds: f64) -> (f64, f64) {
        let mut m = LoudnessTarget::new(SR, c);
        let block = 512;
        let blocks = (SR * seconds / block as f64) as usize;
        let (src_l, src_r) = tone(block, amp);
        let mut out_l = vec![0f32; block];
        let mut out_r = vec![0f32; block];
        for _ in 0..blocks {
            let g = m.gain_lin() as f32;
            for i in 0..block {
                out_l[i] = src_l[i] * g;
                out_r[i] = src_r[i] * g;
            }
            m.observe(&out_l, &out_r);
        }
        (m.gain_db(), m.measured_lufs())
    }

    #[test]
    fn disabled_is_exact_unity() {
        let mut m = LoudnessTarget::new(SR, LoudnessConfig::default());
        assert!(!m.is_active());
        let (l, r) = tone(512, 0.5);
        m.observe(&l, &r);
        assert_eq!(m.gain_lin(), 1.0);
        assert_eq!(m.gain_db(), 0.0);
    }

    #[test]
    fn it_converges_on_the_target() {
        // The whole promise: whatever comes in, the output measures at the
        // target.
        let (_, measured) = settle(LoudnessConfig { target_lufs: -14.0, ..cfg() }, 0.1, 12.0);
        assert!(
            (measured - -14.0).abs() < 0.5,
            "did not reach the target: settled at {measured:.2} LUFS",
        );
    }

    #[test]
    fn a_quiet_input_is_raised_and_a_loud_one_lowered() {
        // The direction has to be right, and the amount has to track the
        // input — a 20 dB quieter source needs 20 dB more gain.
        let (quiet, _) = settle(cfg(), 0.05, 12.0);
        let (loud, _) = settle(cfg(), 0.5, 12.0);
        assert!(quiet > loud, "quiet {quiet:.2} dB should need more than loud {loud:.2} dB");
        let expected = 20.0 * (0.5f64 / 0.05).log10();
        assert!(
            ((quiet - loud) - expected).abs() < 0.5,
            "gain difference {:.2} dB should match the {expected:.2} dB level difference",
            quiet - loud,
        );
    }

    #[test]
    fn moving_the_target_moves_the_gain_by_the_same_amount() {
        let (a, _) = settle(LoudnessConfig { target_lufs: -20.0, ..cfg() }, 0.2, 12.0);
        let (b, _) = settle(LoudnessConfig { target_lufs: -10.0, ..cfg() }, 0.2, 12.0);
        assert!(
            ((b - a) - 10.0).abs() < 0.5,
            "a 10 LU target change gave {:.2} dB of gain change",
            b - a,
        );
    }

    #[test]
    fn the_boost_is_clamped() {
        // Digital near-silence must not be answered with 60 dB of gain.
        let c = LoudnessConfig { target_lufs: -6.0, max_boost_db: 12.0, ..cfg() };
        let (g, _) = settle(c, 0.0005, 12.0);
        assert!(g <= 12.0 + 0.01, "boost ran past the clamp: {g:.2} dB");
    }

    #[test]
    fn the_cut_is_clamped() {
        let c = LoudnessConfig { target_lufs: -40.0, max_cut_db: 6.0, ..cfg() };
        let (g, _) = settle(c, 0.8, 12.0);
        assert!(g >= -6.0 - 0.01, "cut ran past the clamp: {g:.2} dB");
    }

    #[test]
    fn silence_holds_the_gain_rather_than_chasing_it() {
        // A fade-out must not wind the gain up into the noise floor.
        let mut m = LoudnessTarget::new(SR, cfg());
        let block = 512;
        let (l, r) = tone(block, 0.2);
        let mut out_l = vec![0f32; block];
        let mut out_r = vec![0f32; block];
        for _ in 0..(48_000 * 10 / block) {
            let g = m.gain_lin() as f32;
            for i in 0..block { out_l[i] = l[i] * g; out_r[i] = r[i] * g; }
            m.observe(&out_l, &out_r);
        }
        let settled = m.gain_db();
        // Now digital silence for two seconds.
        let quiet = vec![0f32; block];
        for _ in 0..(48_000 * 2 / block) {
            m.observe(&quiet, &quiet);
        }
        assert!(
            (m.gain_db() - settled).abs() < 0.1,
            "gain drifted during silence: {settled:.2} → {:.2} dB",
            m.gain_db(),
        );
    }

    #[test]
    fn it_does_not_flatten_the_song_within_a_bar() {
        // The dynamics test.  A loud bar followed by a quiet bar must come
        // out with most of that difference intact — a fast AGC would erase
        // it.  Half a second per bar, which is faster than any real one.
        let mut m = LoudnessTarget::new(SR, cfg());
        let block = 512;
        let (loud_l, loud_r) = tone(block, 0.4);
        let (soft_l, soft_r) = tone(block, 0.1);
        let mut out_l = vec![0f32; block];
        let mut out_r = vec![0f32; block];
        let per_bar = (SR * 0.5 / block as f64) as usize;
        // Settle on the loud bar first.
        for _ in 0..(48_000 * 8 / block) {
            let g = m.gain_lin() as f32;
            for i in 0..block { out_l[i] = loud_l[i] * g; out_r[i] = loud_r[i] * g; }
            m.observe(&out_l, &out_r);
        }
        let g_loud = m.gain_db();
        // Then a quiet bar.
        for _ in 0..per_bar {
            let g = m.gain_lin() as f32;
            for i in 0..block { out_l[i] = soft_l[i] * g; out_r[i] = soft_r[i] * g; }
            m.observe(&out_l, &out_r);
        }
        let moved = m.gain_db() - g_loud;
        // 12 dB quieter material; the loop must not have made up more than
        // a small part of that inside half a second.
        assert!(
            moved < 4.0,
            "the gain chased a 0.5 s level change by {moved:.2} dB — that is a compressor, not a target",
        );
    }

    #[test]
    fn it_does_not_fade_up_at_the_start() {
        // The first measurement jumps to the right gain.  Sliding in from
        // 0 dB would make every track open with a fade, which reads as a
        // bug even though it settles correctly.
        let mut m = LoudnessTarget::new(SR, cfg());
        let block = 512;
        let (l, r) = tone(block, 0.05);
        let mut out_l = vec![0f32; block];
        let mut out_r = vec![0f32; block];
        // One block through, then look at the gain.
        let g0 = m.gain_lin() as f32;
        for i in 0..block { out_l[i] = l[i] * g0; out_r[i] = r[i] * g0; }
        m.observe(&out_l, &out_r);
        let after_one = m.gain_db();
        assert!(after_one > 3.0, "still at {after_one:.2} dB after the first block");
    }

    #[test]
    fn a_hostile_config_stays_finite() {
        for c in [
            LoudnessConfig { enabled: true, target_lufs: f64::NAN, ..cfg() },
            LoudnessConfig { enabled: true, target_lufs: 1e9, max_boost_db: 1e9, ..cfg() },
            LoudnessConfig { enabled: true, speed_ms: -5.0, ..cfg() },
            LoudnessConfig { enabled: true, max_boost_db: f64::NAN, ..cfg() },
        ] {
            let (g, _) = settle(c, 0.2, 3.0);
            // NaN targets are allowed to produce no gain, but never a
            // non-finite one that would poison the audio.
            assert!(g.is_finite() || g == 0.0, "non-finite gain from a hostile config");
            assert!(db_to_lin(if g.is_finite() { g } else { 0.0 }).is_finite());
        }
    }
}
