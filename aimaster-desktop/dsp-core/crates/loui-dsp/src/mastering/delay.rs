//! Stereo delay — echo with feedback, filtered in the loop.
//!
//! On a mastering bus a delay is a spatial tool, not an effect: a few
//! percent of a short, filtered echo widens and deepens a mix without
//! anyone hearing "a delay". So the defaults are conservative and the wet
//! path is filtered, which is what stops repeats from piling up as mud in
//! the bass and hiss in the top.
//!
//! Design:
//!   * Per-channel delay line, so the two sides can be offset.
//!   * Feedback filtered by a one-pole low-cut and low-pass. Filtering
//!     INSIDE the loop is the whole difference between a tail that decays
//!     into nothing and one that turns into a resonant drone.
//!   * Ping-pong routes each channel's output into the other's input, so
//!     repeats alternate across the image.
//!
//! Realtime-safe: the lines are allocated once at construction for
//! `MAX_DELAY_S`, and `set_config` only moves read pointers.
//!
//! Bit-transparent at `mix_pct = 0`: the module returns before touching the
//! samples, so a chain with the delay present but silent is still exact.

use super::config::DelayConfig;
use super::StereoModule;

/// Longest delay the lines can hold, in seconds.
pub const MAX_DELAY_S: f64 = 2.0;

/// One-pole filter, used on the feedback path.
#[derive(Clone, Copy, Default)]
struct OnePole {
    z: f64,
    a: f64,
}

impl OnePole {
    fn set_cutoff(&mut self, sr: f64, hz: f64) {
        let f = hz.clamp(1.0, sr * 0.49);
        // Standard one-pole coefficient; exact enough for a tone control
        // inside a feedback loop and cheap enough to run per sample.
        self.a = (-2.0 * std::f64::consts::PI * f / sr).exp();
    }
    #[inline]
    fn low_pass(&mut self, x: f64) -> f64 {
        self.z = x * (1.0 - self.a) + self.z * self.a;
        self.z
    }
    #[inline]
    fn high_pass(&mut self, x: f64) -> f64 {
        self.z = x * (1.0 - self.a) + self.z * self.a;
        x - self.z
    }
    fn reset(&mut self) {
        self.z = 0.0;
    }
}

/// A single delay line with a fractional-free (integer) read tap.
struct Line {
    buf: Vec<f64>,
    write: usize,
    delay_samples: usize,
}

impl Line {
    fn new(capacity: usize) -> Self {
        Self { buf: vec![0.0; capacity.max(2)], write: 0, delay_samples: 1 }
    }

    fn set_delay(&mut self, samples: usize) {
        // One sample minimum: a zero-length line would read what it just
        // wrote, which is not a delay, it is a feedback loop with no delay.
        self.delay_samples = samples.clamp(1, self.buf.len() - 1);
    }

    #[inline]
    fn read(&self) -> f64 {
        let n = self.buf.len();
        self.buf[(self.write + n - self.delay_samples) % n]
    }

    #[inline]
    fn write(&mut self, x: f64) {
        let n = self.buf.len();
        self.buf[self.write] = x;
        self.write = (self.write + 1) % n;
    }

    fn reset(&mut self) {
        for v in self.buf.iter_mut() {
            *v = 0.0;
        }
        self.write = 0;
    }
}

/// Stereo delay.
pub struct Delay {
    sr: f64,
    cfg: DelayConfig,
    left: Line,
    right: Line,
    lp_l: OnePole,
    lp_r: OnePole,
    hp_l: OnePole,
    hp_r: OnePole,
}

impl Delay {
    /// Construct from a sample rate + config.
    pub fn new(sample_rate: f64, cfg: DelayConfig) -> Self {
        let cap = (sample_rate * MAX_DELAY_S) as usize + 2;
        let mut d = Self {
            sr: sample_rate,
            cfg,
            left: Line::new(cap),
            right: Line::new(cap),
            lp_l: OnePole::default(),
            lp_r: OnePole::default(),
            hp_l: OnePole::default(),
            hp_r: OnePole::default(),
        };
        d.set_config(cfg);
        d
    }

    /// Update parameters.  Moves read taps; never allocates.
    pub fn set_config(&mut self, cfg: DelayConfig) {
        self.cfg = cfg;
        let ms_l = cfg.time_ms.clamp(1.0, MAX_DELAY_S * 1000.0);
        // The offset spreads the two sides.  A delay with both taps at the
        // same time is a mono echo, which is not what this is for.
        let ms_r = (ms_l * (1.0 + cfg.stereo_offset_pct.clamp(-50.0, 50.0) / 100.0))
            .clamp(1.0, MAX_DELAY_S * 1000.0);
        self.left.set_delay((ms_l * 0.001 * self.sr) as usize);
        self.right.set_delay((ms_r * 0.001 * self.sr) as usize);

        let lp = cfg.damping_hz.clamp(200.0, 20_000.0);
        let hp = cfg.low_cut_hz.clamp(20.0, 2_000.0);
        self.lp_l.set_cutoff(self.sr, lp);
        self.lp_r.set_cutoff(self.sr, lp);
        self.hp_l.set_cutoff(self.sr, hp);
        self.hp_r.set_cutoff(self.sr, hp);
    }

    /// False when the module cannot change the signal.
    pub fn is_active(&self) -> bool {
        !self.cfg.bypass && self.cfg.mix_pct > 0.001
    }
}

impl StereoModule for Delay {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        if !self.is_active() {
            return;
        }
        let mix = (self.cfg.mix_pct / 100.0).clamp(0.0, 1.0);
        // Feedback is capped below 1.0 unconditionally.  This is a user
        // parameter feeding a loop; at 1.0 the tail never decays and the
        // level runs away, which no amount of downstream limiting fixes.
        let fb = (self.cfg.feedback_pct / 100.0).clamp(0.0, 0.95);
        let ping_pong = self.cfg.ping_pong;

        for i in 0..left.len().min(right.len()) {
            let dry_l = left[i] as f64;
            let dry_r = right[i] as f64;

            let wet_l = self.left.read();
            let wet_r = self.right.read();

            // Filter the tail, then feed it back.  Order matters: filtering
            // after the read means each repeat is filtered once more than
            // the last, which is how a real room loses its top end.
            let fb_l = self.hp_l.high_pass(self.lp_l.low_pass(wet_l)) * fb;
            let fb_r = self.hp_r.high_pass(self.lp_r.low_pass(wet_r)) * fb;

            if ping_pong {
                self.left.write(dry_l + fb_r);
                self.right.write(dry_r + fb_l);
            } else {
                self.left.write(dry_l + fb_l);
                self.right.write(dry_r + fb_r);
            }

            left[i] = (dry_l * (1.0 - mix) + wet_l * mix) as f32;
            right[i] = (dry_r * (1.0 - mix) + wet_r * mix) as f32;
        }
    }

    fn reset(&mut self) {
        self.left.reset();
        self.right.reset();
        self.lp_l.reset();
        self.lp_r.reset();
        self.hp_l.reset();
        self.hp_r.reset();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> DelayConfig {
        DelayConfig { mix_pct: 50.0, time_ms: 100.0, feedback_pct: 0.0, ..DelayConfig::default() }
    }

    #[test]
    fn zero_mix_is_exact_passthrough() {
        let mut d = Delay::new(48_000.0, DelayConfig { mix_pct: 0.0, ..cfg() });
        let mut l = [0.3f32, -0.7, 0.1, 0.55];
        let mut r = [0.2f32, 0.4, -0.5, 0.05];
        let (lc, rc) = (l, r);
        d.process_stereo(&mut l, &mut r);
        assert_eq!(l, lc);
        assert_eq!(r, rc);
    }

    #[test]
    fn an_impulse_comes_back_at_the_delay_time() {
        let sr = 48_000.0;
        let mut d = Delay::new(sr, DelayConfig { mix_pct: 100.0, time_ms: 10.0, ..cfg() });
        let n = 2048;
        let mut l = vec![0.0f32; n];
        let mut r = vec![0.0f32; n];
        l[0] = 1.0;
        r[0] = 1.0;
        d.process_stereo(&mut l, &mut r);
        let expected = (10.0 * 0.001 * sr) as usize;
        assert!(l[expected].abs() > 0.9, "no echo at {expected}: {}", l[expected]);
        assert!(l[expected - 20].abs() < 1e-6, "echo arrived early");
    }

    #[test]
    fn the_two_sides_are_offset() {
        let sr = 48_000.0;
        let mut d = Delay::new(sr, DelayConfig {
            mix_pct: 100.0, time_ms: 10.0, stereo_offset_pct: 30.0, ..cfg()
        });
        let n = 4096;
        let mut l = vec![0.0f32; n];
        let mut r = vec![0.0f32; n];
        l[0] = 1.0;
        r[0] = 1.0;
        d.process_stereo(&mut l, &mut r);
        let la = (10.0 * 0.001 * sr) as usize;
        let ra = (13.0 * 0.001 * sr) as usize;
        assert!(l[la].abs() > 0.9, "left echo missing");
        assert!(r[ra].abs() > 0.9, "right echo not offset");
    }

    #[test]
    fn feedback_decays_and_never_runs_away() {
        // The failure this guards is a tail that grows.  Feedback is a user
        // number feeding a loop; if the clamp ever goes, this catches it.
        let sr = 48_000.0;
        let mut d = Delay::new(sr, DelayConfig {
            mix_pct: 100.0, time_ms: 5.0, feedback_pct: 200.0, ..cfg()
        });
        let n = (sr as usize) * 2;
        let mut l = vec![0.0f32; n];
        let mut r = vec![0.0f32; n];
        l[0] = 1.0;
        r[0] = 1.0;
        for a in (0..n).step_by(512) {
            let b = (a + 512).min(n);
            d.process_stereo(&mut l[a..b], &mut r[a..b]);
        }
        let early = l[..n / 4].iter().fold(0.0f32, |m, x| m.max(x.abs()));
        let late = l[n * 3 / 4..].iter().fold(0.0f32, |m, x| m.max(x.abs()));
        assert!(l.iter().all(|x| x.is_finite()), "delay produced non-finite output");
        assert!(late < early, "tail grew instead of decaying: {early} → {late}");
    }

    #[test]
    fn a_hostile_config_does_not_panic() {
        for (t, fb, off) in [(0.0, 0.0, 0.0), (1e9, 1e9, 1e9), (-5.0, -5.0, -500.0)] {
            let mut d = Delay::new(48_000.0, DelayConfig {
                mix_pct: 100.0, time_ms: t, feedback_pct: fb, stereo_offset_pct: off, ..cfg()
            });
            let mut l = [0.4f32; 512];
            let mut r = [0.4f32; 512];
            d.process_stereo(&mut l, &mut r);
            assert!(l.iter().all(|x| x.is_finite()), "t={t} fb={fb} produced non-finite");
        }
    }
}
