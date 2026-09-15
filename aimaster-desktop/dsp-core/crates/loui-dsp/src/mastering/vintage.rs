//! Vintage modules — Pultec-style EQ, vari-mu compressor, tape.
//!
//! These are *behaviour* models, not circuit models.  The point is not to
//! claim a particular unit, it is to give the engineer the controls and the
//! interactions they already know how to use:
//!
//!   * [`VintageEq`] — a passive program EQ.  Its famous property is that
//!     boost and cut at the *same* low frequency do not cancel.  The boost
//!     is a shelf at the selected frequency; the attenuation is a *bell*
//!     roughly an octave and a half above it.  Running both therefore gives
//!     the measured curve of the original units — a lift at the very bottom
//!     with a scooped upper bass — rather than the silence two opposing
//!     shelves would produce.
//!
//!   * [`VintageCompressor`] — a vari-mu / opto behaviour: soft knee that
//!     *softens further* as it works harder, program-dependent release
//!     (fast for short peaks, slow for sustained level), and a gentle
//!     saturation that rides with the gain reduction.
//!
//!   * [`VintageTape`] — record/replay chain: input drive into hysteresis-ish
//!     saturation, head-bump in the low end, HF loss from gap width, and
//!     wow/flutter as a slow pitch wobble via a modulated delay.
//!
//! All three are realtime-safe: fixed state, no allocation in `process`.

use crate::biquad::{Biquad, BiquadCoeffs};
use super::config::{VintageCompressorConfig, VintageEqConfig, VintageTapeConfig, TapeSpeed};
use super::StereoModule;

// ─────────────────────────────────────────────────────────────────────────
// Vintage EQ (passive program equaliser)
// ─────────────────────────────────────────────────────────────────────────

/// Offset (in octaves) between the low boost shelf and the low cut bell.
/// This separation is what makes simultaneous boost + cut a usable move.
const LOW_CUT_OFFSET_OCT: f64 = 1.6;
/// Q of the low boost shelf — wide and gentle.
const LOW_BOOST_Q: f64 = 0.7;
/// Q of the low cut bell — broad enough to scoop, narrow enough to leave
/// the bottom octave alone.
const LOW_CUT_Q: f64 = 0.8;

/// Passive program EQ with the classic boost/cut interaction.
pub struct VintageEq {
    sr: f64,
    cfg: VintageEqConfig,
    low_boost_l: Biquad,
    low_boost_r: Biquad,
    low_cut_l: Biquad,
    low_cut_r: Biquad,
    high_boost_l: Biquad,
    high_boost_r: Biquad,
    high_cut_l: Biquad,
    high_cut_r: Biquad,
}

impl VintageEq {
    /// Construct from a sample rate + config.
    pub fn new(sample_rate: f64, cfg: VintageEqConfig) -> Self {
        let flat = BiquadCoeffs::peaking(sample_rate, 1_000.0, 1.0, 0.0);
        let mut me = Self {
            sr: sample_rate,
            cfg,
            low_boost_l: Biquad::new(flat), low_boost_r: Biquad::new(flat),
            low_cut_l: Biquad::new(flat), low_cut_r: Biquad::new(flat),
            high_boost_l: Biquad::new(flat), high_boost_r: Biquad::new(flat),
            high_cut_l: Biquad::new(flat), high_cut_r: Biquad::new(flat),
        };
        me.rebuild();
        me
    }

    /// Update parameters (filter state preserved).
    pub fn set_config(&mut self, cfg: VintageEqConfig) {
        self.cfg = cfg;
        self.rebuild();
    }

    fn rebuild(&mut self) {
        let sr = self.sr;
        let nyq = sr * 0.45;
        let lf = self.cfg.low_frequency_hz.clamp(20.0, 400.0).min(nyq);
        let hf = self.cfg.high_frequency_hz.clamp(2_000.0, 24_000.0).min(nyq);

        // Low boost: wide shelf at the selected frequency.
        let boost = self.cfg.low_boost_db.clamp(0.0, 12.0);
        let c = BiquadCoeffs::low_shelf(sr, lf, LOW_BOOST_Q, boost);
        self.low_boost_l.set_coeffs(c);
        self.low_boost_r.set_coeffs(c);

        // Low cut: a bell sitting above the boost, not an opposing shelf.
        // Two opposing shelves cancel below their corners; a bell leaves the
        // bottom octave lifted and scoops the upper bass, which is the curve
        // the hardware actually produces.
        let cut = self.cfg.low_cut_db.clamp(0.0, 12.0);
        let cut_hz = (lf * 2f64.powf(LOW_CUT_OFFSET_OCT)).min(nyq);
        let c = BiquadCoeffs::peaking(sr, cut_hz, LOW_CUT_Q, -cut);
        self.low_cut_l.set_coeffs(c);
        self.low_cut_r.set_coeffs(c);

        // High boost: a bell whose bandwidth is the front-panel control.
        let hboost = self.cfg.high_boost_db.clamp(0.0, 12.0);
        let q = (1.6 - self.cfg.high_bandwidth.clamp(0.0, 1.0) * 1.2).max(0.4);
        let c = BiquadCoeffs::peaking(sr, hf, q, hboost);
        self.high_boost_l.set_coeffs(c);
        self.high_boost_r.set_coeffs(c);

        // High cut: a broad shelf well above the boost bell.
        let hcut = self.cfg.high_cut_db.clamp(0.0, 12.0);
        let c = BiquadCoeffs::high_shelf(sr, (hf * 1.5).min(nyq), 0.6, -hcut);
        self.high_cut_l.set_coeffs(c);
        self.high_cut_r.set_coeffs(c);
    }
}

impl StereoModule for VintageEq {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        if self.cfg.bypass {
            return;
        }
        let n = left.len().min(right.len());
        for i in 0..n {
            let mut l = left[i] as f64;
            let mut r = right[i] as f64;
            l = self.low_boost_l.process(l);
            r = self.low_boost_r.process(r);
            l = self.low_cut_l.process(l);
            r = self.low_cut_r.process(r);
            l = self.high_boost_l.process(l);
            r = self.high_boost_r.process(r);
            l = self.high_cut_l.process(l);
            r = self.high_cut_r.process(r);
            left[i] = l as f32;
            right[i] = r as f32;
        }
    }

    fn reset(&mut self) {
        self.low_boost_l.reset(); self.low_boost_r.reset();
        self.low_cut_l.reset(); self.low_cut_r.reset();
        self.high_boost_l.reset(); self.high_boost_r.reset();
        self.high_cut_l.reset(); self.high_cut_r.reset();
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Vintage compressor (vari-mu behaviour)
// ─────────────────────────────────────────────────────────────────────────

/// Base knee width, in dB.  Widens as gain reduction increases.
const VARIMU_KNEE_DB: f64 = 8.0;
/// Fast release path time constant, seconds.
const VARIMU_FAST_REL_S: f64 = 0.08;
/// Slow release path time constant, seconds.
const VARIMU_SLOW_REL_S: f64 = 1.2;

fn coeff(seconds: f64, sr: f64) -> f64 {
    if seconds <= 0.0 { return 0.0; }
    (-1.0 / (seconds * sr)).exp()
}

/// Vari-mu style compressor with a program-dependent release.
pub struct VintageCompressor {
    sr: f64,
    cfg: VintageCompressorConfig,
    env_db: f64,
    /// Slow-release companion envelope; the two combine into the program-
    /// dependent behaviour.
    slow_db: f64,
    atk: f64,
    fast_rel: f64,
    slow_rel: f64,
    last_gr_db: f64,
}

impl VintageCompressor {
    /// Construct from a sample rate + config.
    pub fn new(sample_rate: f64, cfg: VintageCompressorConfig) -> Self {
        Self {
            sr: sample_rate,
            cfg,
            env_db: -120.0,
            slow_db: -120.0,
            atk: coeff(cfg.attack_ms * 0.001, sample_rate),
            fast_rel: coeff(VARIMU_FAST_REL_S, sample_rate),
            slow_rel: coeff(VARIMU_SLOW_REL_S, sample_rate),
            last_gr_db: 0.0,
        }
    }

    /// Update parameters.
    pub fn set_config(&mut self, cfg: VintageCompressorConfig) {
        self.cfg = cfg;
        self.atk = coeff(cfg.attack_ms * 0.001, self.sr);
    }

    /// Gain reduction (dB, ≥ 0) on the last block.
    pub fn gain_reduction_db(&self) -> f64 { self.last_gr_db }
}

impl StereoModule for VintageCompressor {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        if self.cfg.bypass || self.cfg.ratio <= 1.0 {
            self.last_gr_db = 0.0;
            return;
        }
        let n = left.len().min(right.len());
        let threshold = self.cfg.threshold_db.clamp(-60.0, 0.0);
        let ratio = self.cfg.ratio.clamp(1.0, 20.0);
        let slope = 1.0 - 1.0 / ratio;
        let makeup = 10f64.powf(self.cfg.makeup_db.clamp(-12.0, 24.0) / 20.0);
        let drive = (self.cfg.character_pct / 100.0).clamp(0.0, 1.0);
        let mix = (self.cfg.mix_pct / 100.0).clamp(0.0, 1.0);
        let mut block_gr = 0.0f64;

        for i in 0..n {
            let l = left[i] as f64;
            let r = right[i] as f64;
            let peak = l.abs().max(r.abs()).max(1e-9);
            let in_db = 20.0 * peak.log10();

            // Two release paths.  Short peaks recover on the fast path; a
            // sustained level drags the slow path down with it, and the
            // compressor then holds — the "breathing" a vari-mu is used for.
            if in_db > self.env_db {
                self.env_db = in_db + self.atk * (self.env_db - in_db);
            } else {
                self.env_db = in_db + self.fast_rel * (self.env_db - in_db);
            }
            self.slow_db = if in_db > self.slow_db {
                in_db + self.atk * (self.slow_db - in_db)
            } else {
                in_db + self.slow_rel * (self.slow_db - in_db)
            };
            let det_db = self.env_db.max(self.slow_db);

            // Soft knee that widens with gain reduction — the vari-mu's
            // ratio rising as the tube is pushed.
            let over = det_db - threshold;
            let knee = VARIMU_KNEE_DB * (1.0 + 0.5 * (over.max(0.0) / 12.0).min(2.0));
            let reduction = if over <= -knee / 2.0 {
                0.0
            } else if over >= knee / 2.0 {
                over * slope
            } else {
                let x = over + knee / 2.0;
                slope * x * x / (2.0 * knee)
            }
            .clamp(0.0, 30.0);

            if reduction > block_gr { block_gr = reduction; }
            let g = 10f64.powf(-reduction / 20.0);

            // Saturation rides with the gain reduction: the harder it works,
            // the more colour it adds.
            let sat = drive * (reduction / 12.0).min(1.0);
            let mut wl = l * g;
            let mut wr = r * g;
            if sat > 0.0 {
                wl = wl * (1.0 - sat) + (wl * 1.5).tanh() / 1.5 * sat;
                wr = wr * (1.0 - sat) + (wr * 1.5).tanh() / 1.5 * sat;
            }

            left[i] = ((l * (1.0 - mix) + wl * mix) * makeup) as f32;
            right[i] = ((r * (1.0 - mix) + wr * mix) * makeup) as f32;
        }
        self.last_gr_db = block_gr;
    }

    fn reset(&mut self) {
        self.env_db = -120.0;
        self.slow_db = -120.0;
        self.last_gr_db = 0.0;
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Vintage tape
// ─────────────────────────────────────────────────────────────────────────

/// Longest wow/flutter delay modulation, in milliseconds.
const TAPE_MAX_MOD_MS: f64 = 3.0;
/// Delay-line headroom, in milliseconds.
const TAPE_DELAY_MS: f64 = 8.0;

/// Head-bump frequency and HF corner for each tape speed.
fn tape_curve(speed: TapeSpeed) -> (f64, f64) {
    match speed {
        // Slower tape: lower, stronger head bump and earlier HF roll-off.
        TapeSpeed::Ips7_5 => (55.0, 12_000.0),
        TapeSpeed::Ips15 => (75.0, 16_000.0),
        TapeSpeed::Ips30 => (110.0, 20_000.0),
    }
}

/// Tape machine emulation — saturation, head bump, HF loss, wow/flutter.
pub struct VintageTape {
    sr: f64,
    cfg: VintageTapeConfig,
    head_bump_l: Biquad,
    head_bump_r: Biquad,
    hf_loss_l: Biquad,
    hf_loss_r: Biquad,
    /// Modulated delay line for wow (slow) and flutter (fast).
    delay_l: Vec<f32>,
    delay_r: Vec<f32>,
    write: usize,
    /// Wow / flutter LFO phases, in radians.
    wow_phase: f64,
    flutter_phase: f64,
}

impl VintageTape {
    /// Construct from a sample rate + config.
    pub fn new(sample_rate: f64, cfg: VintageTapeConfig) -> Self {
        let len = ((TAPE_DELAY_MS + TAPE_MAX_MOD_MS) * 0.001 * sample_rate).ceil() as usize + 4;
        let flat = BiquadCoeffs::peaking(sample_rate, 1_000.0, 1.0, 0.0);
        let mut me = Self {
            sr: sample_rate,
            cfg,
            head_bump_l: Biquad::new(flat), head_bump_r: Biquad::new(flat),
            hf_loss_l: Biquad::new(flat), hf_loss_r: Biquad::new(flat),
            delay_l: vec![0.0; len],
            delay_r: vec![0.0; len],
            write: 0,
            wow_phase: 0.0,
            flutter_phase: 0.0,
        };
        me.rebuild();
        me
    }

    /// Update parameters.
    pub fn set_config(&mut self, cfg: VintageTapeConfig) {
        self.cfg = cfg;
        self.rebuild();
    }

    fn rebuild(&mut self) {
        let sr = self.sr;
        let (bump_hz, hf_hz) = tape_curve(self.cfg.speed);
        // Head bump: a low bell whose depth follows the bias control.
        let bump_db = (self.cfg.bias.clamp(-1.0, 1.0) * 2.5 + 1.5).clamp(-2.0, 4.0);
        let c = BiquadCoeffs::peaking(sr, bump_hz.min(sr * 0.45), 1.1, bump_db);
        self.head_bump_l.set_coeffs(c);
        self.head_bump_r.set_coeffs(c);
        // HF loss: a shelf, deeper the more the drive pushes the tape.
        let loss_db = -(self.cfg.drive_db.clamp(0.0, 24.0) / 24.0) * 4.0 - 1.0;
        let c = BiquadCoeffs::high_shelf(sr, hf_hz.min(sr * 0.45), 0.7, loss_db);
        self.hf_loss_l.set_coeffs(c);
        self.hf_loss_r.set_coeffs(c);
    }

    /// Read the delay line at a fractional offset (linear interpolation).
    #[inline]
    fn read_delay(line: &[f32], write: usize, delay_samples: f64) -> f64 {
        let len = line.len();
        let d = delay_samples.clamp(1.0, (len - 2) as f64);
        let base = d.floor();
        let frac = d - base;
        let i0 = (write + len - base as usize) % len;
        let i1 = (i0 + len - 1) % len;
        line[i0] as f64 * (1.0 - frac) + line[i1] as f64 * frac
    }
}

impl VintageTape {
    /// True when any of the tape is actually blended in.  At mix 0 the
    /// delay line and filters are skipped, so the module is bit-transparent.
    fn is_active(&self) -> bool {
        !self.cfg.bypass && self.cfg.mix_pct > 0.0
    }
}

impl StereoModule for VintageTape {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        if !self.is_active() {
            return;
        }
        let n = left.len().min(right.len());
        let drive = 10f64.powf(self.cfg.drive_db.clamp(0.0, 24.0) / 20.0);
        // Level-match the drive so pushing the tape is a character control,
        // not a volume control.
        let comp = 1.0 / drive.max(1e-9).powf(0.7);
        let mix = (self.cfg.mix_pct / 100.0).clamp(0.0, 1.0);
        let wow_depth = (self.cfg.wow_flutter_pct / 100.0).clamp(0.0, 1.0) * TAPE_MAX_MOD_MS;
        let base_delay = TAPE_DELAY_MS * 0.001 * self.sr;
        let two_pi = 2.0 * std::f64::consts::PI;
        // Wow ≈ 0.7 Hz (capstan rotation), flutter ≈ 7 Hz (guide chatter).
        let wow_inc = two_pi * 0.7 / self.sr;
        let flutter_inc = two_pi * 7.0 / self.sr;

        for i in 0..n {
            let dry_l = left[i] as f64;
            let dry_r = right[i] as f64;

            // Record: drive into hysteresis-ish saturation.
            let mut l = ((dry_l * drive).tanh() * comp).clamp(-4.0, 4.0);
            let mut r = ((dry_r * drive).tanh() * comp).clamp(-4.0, 4.0);

            // Tape response: head bump then gap loss.
            l = self.hf_loss_l.process(self.head_bump_l.process(l));
            r = self.hf_loss_r.process(self.head_bump_r.process(r));

            // Transport: wow/flutter as a modulated delay.
            self.delay_l[self.write] = l as f32;
            self.delay_r[self.write] = r as f32;
            let (out_l, out_r) = if wow_depth > 0.0 {
                self.wow_phase += wow_inc;
                self.flutter_phase += flutter_inc;
                if self.wow_phase > two_pi { self.wow_phase -= two_pi; }
                if self.flutter_phase > two_pi { self.flutter_phase -= two_pi; }
                let mod_ms = wow_depth
                    * (0.75 * self.wow_phase.sin() + 0.25 * self.flutter_phase.sin());
                let d = base_delay + mod_ms * 0.001 * self.sr;
                (
                    Self::read_delay(&self.delay_l, self.write, d),
                    Self::read_delay(&self.delay_r, self.write, d),
                )
            } else {
                (
                    Self::read_delay(&self.delay_l, self.write, base_delay),
                    Self::read_delay(&self.delay_r, self.write, base_delay),
                )
            };
            self.write = (self.write + 1) % self.delay_l.len();

            left[i] = (dry_l * (1.0 - mix) + out_l * mix) as f32;
            right[i] = (dry_r * (1.0 - mix) + out_r * mix) as f32;
        }
    }

    fn reset(&mut self) {
        self.head_bump_l.reset(); self.head_bump_r.reset();
        self.hf_loss_l.reset(); self.hf_loss_r.reset();
        self.delay_l.fill(0.0);
        self.delay_r.fill(0.0);
        self.write = 0;
        self.wow_phase = 0.0;
        self.flutter_phase = 0.0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(n: usize, freq: f64, sr: f64, amp: f32) -> Vec<f32> {
        (0..n).map(|i| (2.0 * std::f64::consts::PI * freq * i as f64 / sr).sin() as f32 * amp).collect()
    }

    fn rms(x: &[f32]) -> f64 {
        (x.iter().map(|v| (*v as f64) * (*v as f64)).sum::<f64>() / x.len() as f64).sqrt()
    }

    fn level_at(freq: f64, m: &mut dyn StereoModule) -> f64 {
        let n = 16_384;
        let input = tone(n, freq, 48_000.0, 0.2);
        let mut l = input.clone();
        let mut r = input.clone();
        m.reset();
        m.process_stereo(&mut l, &mut r);
        20.0 * (rms(&l[n / 2..]) / rms(&input[n / 2..])).log10()
    }

    // ── Vintage EQ ───────────────────────────────────────────────────────

    #[test]
    fn vintage_eq_bypass_is_passthrough() {
        let mut e = VintageEq::new(48_000.0, VintageEqConfig { bypass: true, ..Default::default() });
        let mut l = tone(512, 100.0, 48_000.0, 0.5);
        let orig = l.clone();
        let mut r = l.clone();
        e.process_stereo(&mut l, &mut r);
        assert_eq!(l, orig);
    }

    #[test]
    fn vintage_eq_neutral_is_flat() {
        let mut e = VintageEq::new(48_000.0, VintageEqConfig::default());
        for &f in &[50.0, 500.0, 5_000.0] {
            let d = level_at(f, &mut e);
            assert!(d.abs() < 0.3, "{f} Hz moved {d:.2} dB at neutral");
        }
    }

    #[test]
    fn vintage_eq_low_boost_lifts_lows() {
        let mut e = VintageEq::new(48_000.0, VintageEqConfig {
            low_frequency_hz: 60.0, low_boost_db: 6.0, ..Default::default()
        });
        let d = level_at(40.0, &mut e);
        assert!(d > 3.0, "low boost only gave {d:.2} dB");
    }

    /// The signature move: simultaneous boost and cut must NOT cancel.
    #[test]
    fn vintage_eq_boost_and_cut_do_not_cancel() {
        let mut e = VintageEq::new(48_000.0, VintageEqConfig {
            low_frequency_hz: 60.0, low_boost_db: 8.0, low_cut_db: 8.0, ..Default::default()
        });
        let deep = level_at(35.0, &mut e);   // below both — should still lift
        let upper = level_at(220.0, &mut e); // in the cut's region — dipped
        assert!(deep > 1.5, "deep lows should still lift, got {deep:.2} dB");
        assert!(upper < -1.0, "upper bass should dip, got {upper:.2} dB");
    }

    // ── Vintage compressor ───────────────────────────────────────────────

    #[test]
    fn varimu_bypass_is_passthrough() {
        let mut c = VintageCompressor::new(48_000.0, VintageCompressorConfig {
            bypass: true, ratio: 4.0, ..Default::default()
        });
        let mut l = tone(512, 440.0, 48_000.0, 0.5);
        let orig = l.clone();
        let mut r = l.clone();
        c.process_stereo(&mut l, &mut r);
        assert_eq!(l, orig);
    }

    #[test]
    fn varimu_compresses_loud_material() {
        let mut c = VintageCompressor::new(48_000.0, VintageCompressorConfig {
            threshold_db: -24.0, ratio: 4.0, attack_ms: 10.0,
            makeup_db: 0.0, character_pct: 50.0, mix_pct: 100.0, bypass: false,
        });
        let n = 48_000;
        let input = tone(n, 440.0, 48_000.0, 0.7);
        let mut l = input.clone();
        let mut r = input.clone();
        c.process_stereo(&mut l, &mut r);
        let delta = 20.0 * (rms(&l[n / 2..]) / rms(&input[n / 2..])).log10();
        assert!(delta < -5.0, "expected compression, got {delta:.1} dB");
        assert!(c.gain_reduction_db() > 5.0);
    }

    #[test]
    fn varimu_leaves_quiet_material_alone() {
        let mut c = VintageCompressor::new(48_000.0, VintageCompressorConfig {
            threshold_db: -12.0, ratio: 4.0, ..Default::default()
        });
        let n = 24_000;
        let input = tone(n, 440.0, 48_000.0, 0.02); // ≈ -34 dB
        let mut l = input.clone();
        let mut r = input.clone();
        c.process_stereo(&mut l, &mut r);
        let delta = 20.0 * (rms(&l[n / 2..]) / rms(&input[n / 2..])).log10();
        assert!(delta.abs() < 0.5, "quiet material moved {delta:.2} dB");
    }

    // ── Vintage tape ─────────────────────────────────────────────────────

    #[test]
    fn tape_bypass_is_passthrough() {
        let mut t = VintageTape::new(48_000.0, VintageTapeConfig { bypass: true, ..Default::default() });
        let mut l = tone(512, 440.0, 48_000.0, 0.5);
        let orig = l.clone();
        let mut r = l.clone();
        t.process_stereo(&mut l, &mut r);
        assert_eq!(l, orig);
    }

    #[test]
    fn tape_zero_mix_is_passthrough() {
        let mut t = VintageTape::new(48_000.0, VintageTapeConfig {
            mix_pct: 0.0, drive_db: 12.0, ..Default::default()
        });
        let input = tone(4096, 440.0, 48_000.0, 0.5);
        let mut l = input.clone();
        let mut r = input.clone();
        t.process_stereo(&mut l, &mut r);
        for (a, b) in l.iter().zip(input.iter()) {
            assert!((a - b).abs() < 1e-6, "mix 0 should be dry");
        }
    }

    /// Driving the tape must not simply make it louder.
    #[test]
    fn tape_drive_is_level_matched() {
        let n = 32_768;
        let input = tone(n, 1_000.0, 48_000.0, 0.3);
        for drive in [0.0, 6.0, 12.0, 24.0] {
            let mut t = VintageTape::new(48_000.0, VintageTapeConfig {
                drive_db: drive, mix_pct: 100.0, wow_flutter_pct: 0.0, ..Default::default()
            });
            let mut l = input.clone();
            let mut r = input.clone();
            t.process_stereo(&mut l, &mut r);
            let delta = 20.0 * (rms(&l[n / 2..]) / rms(&input[n / 2..])).log10();
            assert!(delta.abs() < 6.0, "drive {drive} dB shifted level {delta:.1} dB");
        }
    }

    #[test]
    fn tape_speeds_differ_in_the_top_end() {
        let n = 32_768;
        let input = tone(n, 15_000.0, 48_000.0, 0.3);
        let mut levels = vec![];
        for speed in [TapeSpeed::Ips7_5, TapeSpeed::Ips15, TapeSpeed::Ips30] {
            let mut t = VintageTape::new(48_000.0, VintageTapeConfig {
                speed, drive_db: 6.0, mix_pct: 100.0, wow_flutter_pct: 0.0, ..Default::default()
            });
            let mut l = input.clone();
            let mut r = input.clone();
            t.process_stereo(&mut l, &mut r);
            levels.push(20.0 * (rms(&l[n / 2..]) / rms(&input[n / 2..])).log10());
        }
        assert!(levels[0] < levels[2] - 1.0,
                "7.5 ips should lose more top than 30 ips: {levels:?}");
    }

    #[test]
    fn tape_output_stays_finite() {
        let mut t = VintageTape::new(48_000.0, VintageTapeConfig {
            drive_db: 24.0, mix_pct: 100.0, wow_flutter_pct: 100.0, bias: 1.0,
            speed: TapeSpeed::Ips7_5, bypass: false,
        });
        let mut l = vec![0.0f32; 8192];
        for (i, s) in l.iter_mut().enumerate() { *s = if i % 3 == 0 { 2.0 } else { -2.0 }; }
        let mut r = l.clone();
        t.process_stereo(&mut l, &mut r);
        assert!(l.iter().all(|s| s.is_finite()));
    }
}
