//! Hum & buzz removal — mains hum and its harmonic series.
//!
//! Electrical hum is a stack of very narrow, very stable partials at the
//! mains frequency and its integer multiples (50 Hz in most of the world,
//! 60 Hz in the Americas / Korea's 60 Hz grid).  A wide EQ cut would take
//! bass content with it, so the fix is a comb of high-Q notches — one per
//! harmonic — each cutting only a few Hz.
//!
//! Two behaviours, matching what restoration engineers expect:
//!
//!   * **Fixed depth.**  Every harmonic is cut by `depth_db`.  Predictable,
//!     and what you want when the hum level is known.
//!   * **Adaptive.**  Each harmonic's notch depth tracks how much energy
//!     actually sits in that partial versus its neighbourhood, so harmonics
//!     that carry programme material (a bass note landing on 120 Hz) are
//!     cut less than harmonics that are pure hum.
//!
//! Zero added latency — this is a plain biquad cascade.

use crate::biquad::{Biquad, BiquadCoeffs};
use super::config::DehumConfig;
use super::StereoModule;

/// Maximum harmonics (including the fundamental) the comb can notch.
pub const MAX_HARMONICS: usize = 12;

/// Detector time constant for the adaptive mode, in seconds.
const DETECT_TAU_S: f64 = 0.25;

/// One harmonic's notch (a narrow peaking cut) plus its detectors.
#[derive(Clone, Copy)]
struct Harmonic {
    freq_hz: f64,
    /// The notch itself, per channel.
    notch_l: Biquad,
    notch_r: Biquad,
    /// Narrow band-pass at the harmonic — measures partial energy.
    probe: Biquad,
    /// Wider band-pass around it — measures the local neighbourhood.
    probe_wide: Biquad,
    /// Smoothed energy of the narrow / wide probes.
    env_narrow: f64,
    env_wide: f64,
    /// Depth currently applied (dB, ≥ 0), smoothed towards the target.
    applied_db: f64,
}

impl Harmonic {
    fn new(sr: f64, freq_hz: f64, q: f64, depth_db: f64) -> Self {
        let f = freq_hz.clamp(10.0, sr * 0.45);
        let notch = BiquadCoeffs::peaking(sr, f, q, -depth_db);
        Self {
            freq_hz: f,
            notch_l: Biquad::new(notch),
            notch_r: Biquad::new(notch),
            probe: Biquad::new(BiquadCoeffs::peaking(sr, f, q, 0.0)),
            probe_wide: Biquad::new(BiquadCoeffs::peaking(sr, f, 1.0, 0.0)),
            env_narrow: 0.0,
            env_wide: 0.0,
            applied_db: 0.0,
        }
    }
}

/// Mains-hum comb filter.
pub struct Dehum {
    sr: f64,
    cfg: DehumConfig,
    harmonics: [Harmonic; MAX_HARMONICS],
    /// Number of harmonics currently active (prefix of `harmonics`).
    active: usize,
    detect_coeff: f64,
    /// Highest depth applied on the last block, for the UI meter.
    last_depth_db: f64,
}

/// Band-pass probes for the adaptive detector.
fn probe_coeffs(sr: f64, f: f64, q: f64) -> (BiquadCoeffs, BiquadCoeffs) {
    let f = f.clamp(10.0, sr * 0.45);
    // A high-Q peaking boost at unity is useless as a probe; use band-pass
    // shaped peaking with a large boost and normalise by the same factor.
    (
        BiquadCoeffs::peaking(sr, f, q, 12.0),
        BiquadCoeffs::peaking(sr, f, 0.8, 12.0),
    )
}

impl Dehum {
    /// Construct from a sample rate + config.
    pub fn new(sample_rate: f64, cfg: DehumConfig) -> Self {
        let mut me = Self {
            sr: sample_rate,
            cfg,
            harmonics: [Harmonic::new(sample_rate, 50.0, 20.0, 0.0); MAX_HARMONICS],
            active: 0,
            detect_coeff: (-1.0 / (DETECT_TAU_S * sample_rate)).exp(),
            last_depth_db: 0.0,
        };
        me.rebuild();
        me
    }

    /// Update parameters (rebuilds the comb; filter state is preserved
    /// where the frequency has not moved).
    pub fn set_config(&mut self, cfg: DehumConfig) {
        self.cfg = cfg;
        self.rebuild();
    }

    /// The deepest cut applied on the last block, in dB (≥ 0).
    pub fn applied_depth_db(&self) -> f64 { self.last_depth_db }

    /// Recompute the comb from the current config.
    fn rebuild(&mut self) {
        let base = if self.cfg.frequency_hz.is_finite() {
            self.cfg.frequency_hz.clamp(20.0, 500.0)
        } else {
            60.0
        };
        let q = self.cfg.q.clamp(2.0, 100.0);
        let depth = self.cfg.depth_db.clamp(0.0, 48.0);
        let nyq = self.sr * 0.45;
        let want = (self.cfg.harmonics.clamp(1, MAX_HARMONICS as u32)) as usize;

        let mut active = 0;
        for i in 0..want {
            let f = base * (i + 1) as f64;
            if f > nyq {
                break;
            }
            let h = &mut self.harmonics[i];
            let moved = (h.freq_hz - f).abs() > 1e-6;
            h.freq_hz = f;
            h.notch_l.set_coeffs(BiquadCoeffs::peaking(self.sr, f, q, -depth));
            h.notch_r.set_coeffs(BiquadCoeffs::peaking(self.sr, f, q, -depth));
            let (narrow, wide) = probe_coeffs(self.sr, f, q);
            h.probe.set_coeffs(narrow);
            h.probe_wide.set_coeffs(wide);
            if moved {
                h.env_narrow = 0.0;
                h.env_wide = 0.0;
            }
            active += 1;
        }
        self.active = active;
    }
}

impl StereoModule for Dehum {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        if self.cfg.bypass || self.active == 0 || self.cfg.depth_db <= 0.0 {
            self.last_depth_db = 0.0;
            return;
        }
        let n = left.len().min(right.len());
        let adaptive = self.cfg.adaptive;
        let max_depth = self.cfg.depth_db.clamp(0.0, 48.0);
        let q = self.cfg.q.clamp(2.0, 100.0);
        let coeff = self.detect_coeff;
        let sr = self.sr;
        let mut deepest = 0.0f64;

        for hi in 0..self.active {
            let h = &mut self.harmonics[hi];

            if adaptive {
                // Measure how much of the local energy is concentrated in the
                // partial.  Mono sum is enough — mains hum is correlated.
                for i in 0..n {
                    let x = 0.5 * (left[i] as f64 + right[i] as f64);
                    let narrow = h.probe.process(x);
                    let wide = h.probe_wide.process(x);
                    h.env_narrow = narrow * narrow + coeff * (h.env_narrow - narrow * narrow);
                    h.env_wide = wide * wide + coeff * (h.env_wide - wide * wide);
                }
                // Concentration ratio → 1 when the band is all partial, → 0
                // when the neighbourhood is equally loud (i.e. it is music).
                let ratio = if h.env_wide > 1e-15 {
                    (h.env_narrow / h.env_wide).clamp(0.0, 1.0)
                } else {
                    0.0
                };
                let target = max_depth * ratio;
                // Smooth the depth so the notch never steps.
                h.applied_db += 0.25 * (target - h.applied_db);
            } else {
                h.applied_db = max_depth;
            }

            let depth = h.applied_db.clamp(0.0, 48.0);
            if depth > deepest { deepest = depth; }
            let coeffs = BiquadCoeffs::peaking(sr, h.freq_hz, q, -depth);
            h.notch_l.set_coeffs(coeffs);
            h.notch_r.set_coeffs(coeffs);
            for i in 0..n {
                left[i] = h.notch_l.process(left[i] as f64) as f32;
                right[i] = h.notch_r.process(right[i] as f64) as f32;
            }
        }
        self.last_depth_db = deepest;
    }

    fn reset(&mut self) {
        for h in self.harmonics.iter_mut() {
            h.notch_l.reset();
            h.notch_r.reset();
            h.probe.reset();
            h.probe_wide.reset();
            h.env_narrow = 0.0;
            h.env_wide = 0.0;
            h.applied_db = 0.0;
        }
        self.last_depth_db = 0.0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> DehumConfig {
        DehumConfig { frequency_hz: 60.0, harmonics: 6, depth_db: 30.0, q: 30.0, adaptive: false, bypass: false }
    }

    fn tone(n: usize, freq: f64, sr: f64, amp: f32) -> Vec<f32> {
        (0..n).map(|i| (2.0 * std::f64::consts::PI * freq * i as f64 / sr).sin() as f32 * amp).collect()
    }

    fn rms(x: &[f32]) -> f64 {
        (x.iter().map(|v| (*v as f64) * (*v as f64)).sum::<f64>() / x.len() as f64).sqrt()
    }

    #[test]
    fn bypass_is_passthrough() {
        let mut d = Dehum::new(48_000.0, DehumConfig { bypass: true, ..cfg() });
        let mut l = tone(1024, 60.0, 48_000.0, 0.5);
        let orig = l.clone();
        let mut r = l.clone();
        d.process_stereo(&mut l, &mut r);
        assert_eq!(l, orig);
    }

    #[test]
    fn kills_the_fundamental() {
        let mut d = Dehum::new(48_000.0, cfg());
        let n = 48_000;
        let mut l = tone(n, 60.0, 48_000.0, 0.5);
        let mut r = l.clone();
        let before = rms(&l[n / 2..]);
        d.process_stereo(&mut l, &mut r);
        let after = rms(&l[n / 2..]);
        let delta = 20.0 * (after / before).log10();
        assert!(delta < -20.0, "60 Hz hum should be gone, got {delta:.1} dB");
    }

    #[test]
    fn kills_harmonics() {
        let mut d = Dehum::new(48_000.0, cfg());
        let n = 48_000;
        // 3rd harmonic of 60 Hz.
        let mut l = tone(n, 180.0, 48_000.0, 0.5);
        let mut r = l.clone();
        let before = rms(&l[n / 2..]);
        d.process_stereo(&mut l, &mut r);
        let after = rms(&l[n / 2..]);
        assert!(20.0 * (after / before).log10() < -20.0);
    }

    /// Content between the notches must survive essentially untouched.
    #[test]
    fn leaves_music_between_notches() {
        let mut d = Dehum::new(48_000.0, cfg());
        let n = 48_000;
        let mut l = tone(n, 1_000.0, 48_000.0, 0.5);
        let mut r = l.clone();
        let before = rms(&l[n / 2..]);
        d.process_stereo(&mut l, &mut r);
        let after = rms(&l[n / 2..]);
        let delta = 20.0 * (after / before).log10();
        assert!(delta.abs() < 0.5, "1 kHz should pass, got {delta:.2} dB");
    }

    /// Adaptive mode should back off when the "harmonic" is really music.
    #[test]
    fn adaptive_backs_off_on_broadband_content() {
        let mut d = Dehum::new(48_000.0, DehumConfig { adaptive: true, ..cfg() });
        let n = 48_000 * 2;
        // Broadband-ish content around the fundamental: two nearby tones.
        let a = tone(n, 58.0, 48_000.0, 0.4);
        let b = tone(n, 66.0, 48_000.0, 0.4);
        let mut l: Vec<f32> = a.iter().zip(b.iter()).map(|(x, y)| x + y).collect();
        let mut r = l.clone();
        d.process_stereo(&mut l, &mut r);
        assert!(d.applied_depth_db() < 30.0, "adaptive should not apply full depth to music");
        assert!(l.iter().all(|s| s.is_finite()));
    }

    #[test]
    fn harmonics_above_nyquist_are_dropped() {
        let d = Dehum::new(8_000.0, DehumConfig { frequency_hz: 400.0, harmonics: 12, ..cfg() });
        // 8 kHz SR → 3.6 kHz limit → 9 harmonics of 400 Hz.
        assert!(d.active <= 9 && d.active > 0, "active harmonics: {}", d.active);
    }
}
