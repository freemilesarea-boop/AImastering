//! Lookahead peak limiter — true-peak-safe ceiling for preview.
//!
//! A safe, glitch-free brickwall:
//!   * a lookahead delay line (so gain can drop *before* a peak arrives)
//!   * a sliding peak detector over the lookahead window
//!   * instant attack (gain drops within the lookahead), smoothed release
//!   * ceiling in dBTP; `isp` adds a small extra headroom to approximate
//!     inter-sample (true-peak) safety without 4× oversampling in preview
//!
//! NOT an Ozone-grade multi-stage limiter — a stable preview limiter that
//! never lets the output exceed the ceiling and never clicks.

use super::config::{db_to_lin, LimiterConfig};
use super::StereoModule;

/// Extra headroom (dB) applied when ISP (true-peak) guard is on.
const ISP_HEADROOM_DB: f64 = 0.3;
/// Maximum lookahead the delay lines are sized for (ms).
const MAX_LOOKAHEAD_MS: f64 = 20.0;

/// Lookahead peak limiter.
pub struct Limiter {
    sr: f64,
    cfg: LimiterConfig,
    ceiling_lin: f64,
    release_coeff: f64,
    // Delay lines (stereo) sized for MAX_LOOKAHEAD_MS.
    delay_l: Vec<f32>,
    delay_r: Vec<f32>,
    write: usize,
    lookahead: usize,
    // Sliding peak tracker over the lookahead window (simple ring max).
    peak_ring: Vec<f64>,
    peak_write: usize,
    // Smoothed gain (release).
    gain: f64,
    // Last-block gain reduction (dB, ≥ 0) for metering.
    last_gr_db: f64,
}

fn release_coeff(ms: f64, sr: f64) -> f64 {
    if ms <= 0.0 { return 0.0; }
    (-1.0 / (ms * 0.001 * sr)).exp()
}

impl Limiter {
    /// Construct from a sample rate + config.  Pre-allocates the delay
    /// lines for the maximum lookahead — no allocation in `process`.
    pub fn new(sample_rate: f64, cfg: LimiterConfig) -> Self {
        let max_la = ((MAX_LOOKAHEAD_MS * 0.001 * sample_rate).ceil() as usize).max(1);
        let lookahead = Self::lookahead_samples(cfg.lookahead_ms, sample_rate, max_la);
        Self {
            sr: sample_rate,
            cfg,
            ceiling_lin: Self::ceiling_lin(&cfg),
            release_coeff: release_coeff(50.0, sample_rate),
            delay_l: vec![0.0; max_la + 1],
            delay_r: vec![0.0; max_la + 1],
            write: 0,
            lookahead,
            peak_ring: vec![0.0; max_la + 1],
            peak_write: 0,
            gain: 1.0,
            last_gr_db: 0.0,
        }
    }

    fn lookahead_samples(ms: f64, sr: f64, max: usize) -> usize {
        ((ms * 0.001 * sr).round() as usize).clamp(1, max)
    }

    fn ceiling_lin(cfg: &LimiterConfig) -> f64 {
        let extra = if cfg.isp { ISP_HEADROOM_DB } else { 0.0 };
        db_to_lin(cfg.ceiling_dbtp - extra)
    }

    /// Update parameters (keeps delay-line contents).
    pub fn set_config(&mut self, cfg: LimiterConfig) {
        self.cfg = cfg;
        self.ceiling_lin = Self::ceiling_lin(&cfg);
        let max = self.delay_l.len().saturating_sub(1).max(1);
        self.lookahead = Self::lookahead_samples(cfg.lookahead_ms, self.sr, max);
    }

    /// Last-block gain reduction in dB (≥ 0).
    pub fn gain_reduction_db(&self) -> f64 {
        self.last_gr_db
    }

    #[inline]
    fn window_peak(&self) -> f64 {
        // Max over the active lookahead window of the peak ring.
        let mut m = 1e-9;
        for k in 0..self.lookahead {
            let idx = (self.peak_write + self.peak_ring.len() - 1 - k) % self.peak_ring.len();
            if self.peak_ring[idx] > m { m = self.peak_ring[idx]; }
        }
        m
    }
}

impl StereoModule for Limiter {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        if self.cfg.bypass {
            return;
        }
        let cap = self.delay_l.len();
        let n = left.len().min(right.len());
        let mut max_gr = 0.0_f64;
        for i in 0..n {
            let in_l = left[i];
            let in_r = right[i];
            // Push the incoming sample's peak into the ring.
            let peak_in = (in_l.abs().max(in_r.abs())) as f64;
            self.peak_ring[self.peak_write] = peak_in;
            self.peak_write = (self.peak_write + 1) % cap;

            // Target gain to keep the windowed peak under the ceiling.
            let wp = self.window_peak();
            let target = if wp > self.ceiling_lin { self.ceiling_lin / wp } else { 1.0 };

            // Instant attack (take the lower gain immediately), smoothed release.
            if target < self.gain {
                self.gain = target;
            } else {
                self.gain = target + self.release_coeff * (self.gain - target);
            }

            // Read the delayed sample, apply the (lookahead-aligned) gain.
            let read = (self.write + cap - self.lookahead) % cap;
            let out_l = self.delay_l[read] * self.gain as f32;
            let out_r = self.delay_r[read] * self.gain as f32;

            // Write the incoming sample into the delay line.
            self.delay_l[self.write] = in_l;
            self.delay_r[self.write] = in_r;
            self.write = (self.write + 1) % cap;

            // Hard safety clamp (never exceed ceiling, even on rounding).
            let c = self.ceiling_lin as f32;
            left[i] = out_l.clamp(-c, c);
            right[i] = out_r.clamp(-c, c);

            let gr = -20.0 * self.gain.log10();
            if gr > max_gr { max_gr = gr; }
        }
        self.last_gr_db = max_gr;
    }

    fn reset(&mut self) {
        self.delay_l.iter_mut().for_each(|x| *x = 0.0);
        self.delay_r.iter_mut().for_each(|x| *x = 0.0);
        self.peak_ring.iter_mut().for_each(|x| *x = 0.0);
        self.write = 0;
        self.peak_write = 0;
        self.gain = 1.0;
        self.last_gr_db = 0.0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(ceiling: f64) -> LimiterConfig {
        LimiterConfig { ceiling_dbtp: ceiling, lookahead_ms: 1.0, isp: false, bypass: false }
    }

    #[test]
    fn output_never_exceeds_ceiling() {
        let mut lim = Limiter::new(48_000.0, cfg(-1.0));
        let ceiling = db_to_lin(-1.0) as f32;
        // A hot signal well above the ceiling.
        let mut l: Vec<f32> = (0..4096).map(|i| if i % 2 == 0 { 0.99 } else { -0.99 }).collect();
        let mut r = l.clone();
        lim.process_stereo(&mut l, &mut r);
        let peak = l.iter().chain(r.iter()).fold(0.0f32, |m, &x| m.max(x.abs()));
        assert!(peak <= ceiling + 1e-4, "peak {} exceeds ceiling {}", peak, ceiling);
    }

    #[test]
    fn quiet_signal_passes_through_delayed() {
        let mut lim = Limiter::new(48_000.0, cfg(-1.0));
        // A signal below the ceiling — gain should stay ~1.0 (just delayed).
        let mut l = [0.1f32; 2048];
        let mut r = [0.1f32; 2048];
        lim.process_stereo(&mut l, &mut r);
        // After the lookahead delay, samples reach full level.
        assert!((l[2047] - 0.1).abs() < 1e-3, "quiet sample altered: {}", l[2047]);
        assert!(lim.gain_reduction_db() < 0.1);
    }

    #[test]
    fn bypass_is_passthrough() {
        let mut lim = Limiter::new(48_000.0, LimiterConfig { bypass: true, ..cfg(-6.0) });
        let mut l = [0.99f32, -0.99];
        let mut r = [0.99f32, -0.99];
        let (lc, rc) = (l, r);
        lim.process_stereo(&mut l, &mut r);
        assert_eq!(l, lc);
        assert_eq!(r, rc);
    }

    #[test]
    fn reports_gain_reduction_when_limiting() {
        let mut lim = Limiter::new(48_000.0, cfg(-6.0));
        let mut l = [0.99f32; 1024];
        let mut r = [0.99f32; 1024];
        lim.process_stereo(&mut l, &mut r);
        assert!(lim.gain_reduction_db() > 0.5, "expected GR, got {}", lim.gain_reduction_db());
    }

    #[test]
    fn no_nan_on_silence() {
        let mut lim = Limiter::new(48_000.0, cfg(-1.0));
        let mut l = [0.0f32; 512];
        let mut r = [0.0f32; 512];
        lim.process_stereo(&mut l, &mut r);
        assert!(l.iter().all(|x| x.is_finite()));
        assert!(lim.gain_reduction_db().is_finite());
    }
}
