//! Algorithmic reverb — comb + all-pass, in the Schroeder arrangement.
//!
//! Eight parallel damped comb filters per channel build the tail's density;
//! four series all-passes smear what is left of the echo pattern into
//! something that reads as space rather than as repeats. It is an old
//! design and it is the right one here: fixed buffers, no allocation while
//! running, and a decay that is set rather than measured.
//!
//! What matters on a mastering bus, and what the parameters therefore are:
//!
//!   * **Mix is tiny.** Two to eight percent. The controls are scaled for
//!     that range instead of for a send effect.
//!   * **The wet path is filtered.** A reverb tail in the bass is mud and
//!     in the top is hiss, so the wet signal gets a low cut and the combs
//!     get damping. Without those, any amount audible enough to help is
//!     also enough to smear the low end.
//!   * **Pre-delay keeps the transient dry.** The tail arrives after the
//!     hit, so the mix keeps its attack and gains its space.
//!
//! Realtime-safe: every buffer is sized at construction from the sample
//! rate; `set_config` only changes gains and coefficients.
//!
//! Bit-transparent at `mix_pct = 0` — the module returns before touching
//! the samples.

use super::config::ReverbConfig;
use super::StereoModule;

/// Longest pre-delay, in seconds.
pub const MAX_PREDELAY_S: f64 = 0.25;

/// Comb lengths in samples at 44.1 kHz, from the classic tuning.  Scaled to
/// the running sample rate at construction.
const COMB_TUNING: [usize; 8] = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
/// All-pass lengths at 44.1 kHz, likewise.
const ALLPASS_TUNING: [usize; 4] = [556, 441, 341, 225];
/// Offset applied to the right channel's buffers so the two sides are not
/// the same room heard twice.
const STEREO_SPREAD: usize = 23;
/// Fixed all-pass coefficient — the value that makes the classic topology
/// diffuse rather than ring.
const ALLPASS_FEEDBACK: f64 = 0.5;
/// Reference rate the tunings above were chosen at.
const TUNING_SR: f64 = 44_100.0;

/// A damped comb: a delay line whose feedback runs through a one-pole.
struct Comb {
    buf: Vec<f64>,
    idx: usize,
    filter_store: f64,
    feedback: f64,
    damp1: f64,
    damp2: f64,
}

impl Comb {
    fn new(len: usize) -> Self {
        Self {
            buf: vec![0.0; len.max(1)],
            idx: 0,
            filter_store: 0.0,
            feedback: 0.5,
            damp1: 0.5,
            damp2: 0.5,
        }
    }

    fn set(&mut self, feedback: f64, damping: f64) {
        self.feedback = feedback;
        self.damp1 = damping;
        self.damp2 = 1.0 - damping;
    }

    #[inline]
    fn process(&mut self, input: f64) -> f64 {
        let out = self.buf[self.idx];
        self.filter_store = out * self.damp2 + self.filter_store * self.damp1;
        self.buf[self.idx] = input + self.filter_store * self.feedback;
        self.idx += 1;
        if self.idx >= self.buf.len() {
            self.idx = 0;
        }
        out
    }

    fn reset(&mut self) {
        for v in self.buf.iter_mut() {
            *v = 0.0;
        }
        self.filter_store = 0.0;
        self.idx = 0;
    }
}

/// A Schroeder all-pass.
struct Allpass {
    buf: Vec<f64>,
    idx: usize,
}

impl Allpass {
    fn new(len: usize) -> Self {
        Self { buf: vec![0.0; len.max(1)], idx: 0 }
    }

    #[inline]
    fn process(&mut self, input: f64) -> f64 {
        let buf_out = self.buf[self.idx];
        let output = -input + buf_out;
        self.buf[self.idx] = input + buf_out * ALLPASS_FEEDBACK;
        self.idx += 1;
        if self.idx >= self.buf.len() {
            self.idx = 0;
        }
        output
    }

    fn reset(&mut self) {
        for v in self.buf.iter_mut() {
            *v = 0.0;
        }
        self.idx = 0;
    }
}

/// One-pole, for the wet path's tone controls.
#[derive(Clone, Copy, Default)]
struct OnePole {
    z: f64,
    a: f64,
}

impl OnePole {
    fn set_cutoff(&mut self, sr: f64, hz: f64) {
        let f = hz.clamp(1.0, sr * 0.49);
        self.a = (-2.0 * std::f64::consts::PI * f / sr).exp();
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

/// A pre-delay line.
struct PreDelay {
    buf: Vec<f64>,
    write: usize,
    delay: usize,
}

impl PreDelay {
    fn new(capacity: usize) -> Self {
        Self { buf: vec![0.0; capacity.max(2)], write: 0, delay: 0 }
    }
    fn set(&mut self, samples: usize) {
        self.delay = samples.min(self.buf.len() - 1);
    }
    #[inline]
    fn process(&mut self, x: f64) -> f64 {
        if self.delay == 0 {
            return x;
        }
        let n = self.buf.len();
        let out = self.buf[(self.write + n - self.delay) % n];
        self.buf[self.write] = x;
        self.write = (self.write + 1) % n;
        out
    }
    fn reset(&mut self) {
        for v in self.buf.iter_mut() {
            *v = 0.0;
        }
        self.write = 0;
    }
}

struct Channel {
    combs: Vec<Comb>,
    allpasses: Vec<Allpass>,
    predelay: PreDelay,
    low_cut: OnePole,
}

impl Channel {
    fn new(sr: f64, offset: usize) -> Self {
        let scale = sr / TUNING_SR;
        let combs = COMB_TUNING
            .iter()
            .map(|&len| Comb::new(((len + offset) as f64 * scale) as usize))
            .collect();
        let allpasses = ALLPASS_TUNING
            .iter()
            .map(|&len| Allpass::new(((len + offset) as f64 * scale) as usize))
            .collect();
        Self {
            combs,
            allpasses,
            predelay: PreDelay::new((sr * MAX_PREDELAY_S) as usize + 2),
            low_cut: OnePole::default(),
        }
    }

    #[inline]
    fn process(&mut self, input: f64) -> f64 {
        let x = self.predelay.process(input);
        // Combs in parallel: their sum is the tail's density.
        let mut out = 0.0;
        for c in self.combs.iter_mut() {
            out += c.process(x);
        }
        // All-passes in series: they smear what is left of the pattern.
        for a in self.allpasses.iter_mut() {
            out = a.process(out);
        }
        self.low_cut.high_pass(out)
    }

    fn reset(&mut self) {
        for c in self.combs.iter_mut() {
            c.reset();
        }
        for a in self.allpasses.iter_mut() {
            a.reset();
        }
        self.predelay.reset();
        self.low_cut.reset();
    }
}

/// Stereo algorithmic reverb.
pub struct Reverb {
    sr: f64,
    cfg: ReverbConfig,
    l: Channel,
    r: Channel,
    /// Gain applied to the comb bank's input, keeping the tail's level
    /// roughly independent of how many combs are summed.
    input_gain: f64,
}

impl Reverb {
    /// Construct from a sample rate + config.
    pub fn new(sample_rate: f64, cfg: ReverbConfig) -> Self {
        let mut rv = Self {
            sr: sample_rate,
            cfg,
            l: Channel::new(sample_rate, 0),
            r: Channel::new(sample_rate, STEREO_SPREAD),
            input_gain: 0.015,
        };
        rv.set_config(cfg);
        rv
    }

    /// Update parameters.  Recomputes gains; never allocates.
    pub fn set_config(&mut self, cfg: ReverbConfig) {
        self.cfg = cfg;

        // Size sets the comb feedback, and so the decay.  Capped below 1.0
        // unconditionally: this is a user number driving eight feedback
        // loops, and at 1.0 the tail is infinite.
        let size = (cfg.size_pct / 100.0).clamp(0.0, 1.0);
        let feedback = (0.70 + size * 0.28).min(0.98);
        let damping = (cfg.damping_pct / 100.0).clamp(0.0, 1.0) * 0.4;

        for c in self.l.combs.iter_mut().chain(self.r.combs.iter_mut()) {
            c.set(feedback, damping);
        }

        let pre = ((cfg.pre_delay_ms.clamp(0.0, MAX_PREDELAY_S * 1000.0)) * 0.001 * self.sr) as usize;
        self.l.predelay.set(pre);
        self.r.predelay.set(pre);

        let hp = cfg.low_cut_hz.clamp(20.0, 2_000.0);
        self.l.low_cut.set_cutoff(self.sr, hp);
        self.r.low_cut.set_cutoff(self.sr, hp);
    }

    /// False when the module cannot change the signal.
    pub fn is_active(&self) -> bool {
        !self.cfg.bypass && self.cfg.mix_pct > 0.001
    }
}

impl StereoModule for Reverb {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        if !self.is_active() {
            return;
        }
        let mix = (self.cfg.mix_pct / 100.0).clamp(0.0, 1.0);
        // Width blends each channel's tail towards the pair's mean.  A
        // reverb narrower than the source is a legitimate mastering move;
        // one wider than the room is not, so this only narrows.
        let width = (self.cfg.width_pct / 100.0).clamp(0.0, 1.0);

        for i in 0..left.len().min(right.len()) {
            let dry_l = left[i] as f64;
            let dry_r = right[i] as f64;
            // Feed the summed input to both sides — a mastering reverb
            // should place the mix in one room, not two.
            let input = (dry_l + dry_r) * 0.5 * self.input_gain;

            let wl = self.l.process(input);
            let wr = self.r.process(input);
            let mid = (wl + wr) * 0.5;
            let wet_l = mid + (wl - mid) * width;
            let wet_r = mid + (wr - mid) * width;

            left[i] = (dry_l * (1.0 - mix) + wet_l * mix) as f32;
            right[i] = (dry_r * (1.0 - mix) + wet_r * mix) as f32;
        }
    }

    fn reset(&mut self) {
        self.l.reset();
        self.r.reset();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> ReverbConfig {
        ReverbConfig { mix_pct: 30.0, size_pct: 60.0, ..ReverbConfig::default() }
    }

    fn tail_energy(mut rv: Reverb, from: usize, to: usize) -> f64 {
        let n = 48_000 * 3;
        let mut l = vec![0.0f32; n];
        let mut r = vec![0.0f32; n];
        l[0] = 1.0;
        r[0] = 1.0;
        for a in (0..n).step_by(512) {
            let b = (a + 512).min(n);
            rv.process_stereo(&mut l[a..b], &mut r[a..b]);
        }
        l[from.min(n)..to.min(n)].iter().map(|x| (x * x) as f64).sum()
    }

    #[test]
    fn zero_mix_is_exact_passthrough() {
        let mut rv = Reverb::new(48_000.0, ReverbConfig { mix_pct: 0.0, ..cfg() });
        let mut l = [0.3f32, -0.7, 0.1, 0.55];
        let mut r = [0.2f32, 0.4, -0.5, 0.05];
        let (lc, rc) = (l, r);
        rv.process_stereo(&mut l, &mut r);
        assert_eq!(l, lc);
        assert_eq!(r, rc);
    }

    #[test]
    fn an_impulse_produces_a_tail() {
        let e = tail_energy(Reverb::new(48_000.0, cfg()), 4_800, 48_000);
        assert!(e > 1e-9, "no tail after an impulse: {e:.3e}");
    }

    #[test]
    fn a_bigger_room_rings_longer() {
        // The size control's whole job.  Measured late in the tail, where
        // the difference between a small room and a large one lives.
        let small = tail_energy(Reverb::new(48_000.0, ReverbConfig { size_pct: 10.0, ..cfg() }), 48_000, 96_000);
        let large = tail_energy(Reverb::new(48_000.0, ReverbConfig { size_pct: 95.0, ..cfg() }), 48_000, 96_000);
        assert!(large > small * 4.0, "size barely changed the decay: {small:.3e} → {large:.3e}");
    }

    #[test]
    fn damping_takes_the_top_off_the_tail() {
        let bright = tail_energy(Reverb::new(48_000.0, ReverbConfig { damping_pct: 0.0, ..cfg() }), 24_000, 96_000);
        let dark = tail_energy(Reverb::new(48_000.0, ReverbConfig { damping_pct: 100.0, ..cfg() }), 24_000, 96_000);
        assert!(dark < bright, "damping did not shorten the tail: {bright:.3e} → {dark:.3e}");
    }

    #[test]
    fn pre_delay_keeps_the_first_moment_dry() {
        let sr = 48_000.0;
        let mut rv = Reverb::new(sr, ReverbConfig { mix_pct: 100.0, pre_delay_ms: 40.0, ..cfg() });
        let n = 8192;
        let mut l = vec![0.0f32; n];
        let mut r = vec![0.0f32; n];
        l[0] = 1.0;
        r[0] = 1.0;
        rv.process_stereo(&mut l, &mut r);
        let before = l[100..1800].iter().fold(0.0f32, |m, x| m.max(x.abs()));
        let after = l[2100..6000].iter().fold(0.0f32, |m, x| m.max(x.abs()));
        assert!(before < after * 0.1, "tail arrived before the pre-delay: {before} vs {after}");
    }

    #[test]
    fn the_tail_never_runs_away() {
        // Eight feedback loops driven by a user number.  If the size clamp
        // ever goes, this is what notices.
        let sr = 48_000.0;
        let mut rv = Reverb::new(sr, ReverbConfig {
            mix_pct: 100.0, size_pct: 1e9, damping_pct: 0.0, ..cfg()
        });
        let n = (sr as usize) * 6;
        let mut l = vec![0.0f32; n];
        let mut r = vec![0.0f32; n];
        l[0] = 1.0;
        r[0] = 1.0;
        for a in (0..n).step_by(512) {
            let b = (a + 512).min(n);
            rv.process_stereo(&mut l[a..b], &mut r[a..b]);
        }
        assert!(l.iter().all(|x| x.is_finite()), "reverb produced non-finite output");
        let early = l[..n / 6].iter().fold(0.0f32, |m, x| m.max(x.abs()));
        let late = l[n * 5 / 6..].iter().fold(0.0f32, |m, x| m.max(x.abs()));
        assert!(late <= early, "tail grew: {early} → {late}");
    }

    #[test]
    fn a_hostile_config_does_not_panic() {
        for (size, pre, hp) in [(0.0, 0.0, 0.0), (-50.0, -10.0, -1.0), (1e9, 1e9, 1e9)] {
            let mut rv = Reverb::new(48_000.0, ReverbConfig {
                mix_pct: 100.0, size_pct: size, pre_delay_ms: pre, low_cut_hz: hp, ..cfg()
            });
            let mut l = [0.4f32; 512];
            let mut r = [0.4f32; 512];
            rv.process_stereo(&mut l, &mut r);
            assert!(l.iter().all(|x| x.is_finite()), "size={size} produced non-finite");
        }
    }
}
