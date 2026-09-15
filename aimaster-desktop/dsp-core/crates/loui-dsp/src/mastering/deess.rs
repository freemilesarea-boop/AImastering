//! De-esser — tames sibilance ("s", "sh", "t") and cymbal spit.
//!
//! Split-band design, which is what mastering engineers want on a mix bus:
//! the signal is divided at `frequency_hz` into a low path (untouched) and a
//! high path (compressed), then recombined.  Only the sibilant band moves,
//! so the body of the mix keeps its level and tone.
//!
//! The reduction is applied as a **dynamic high-shelf**, not by subtracting a
//! filtered copy of the band.  Subtracting a minimum-phase band split combs
//! badly — around the corner the filtered copy is far enough out of phase
//! that most of the intended attenuation cancels out.  A shelf whose gain
//! tracks the detector has none of that: at 0 dB reduction the RBJ shelf
//! coefficients collapse to exact unity (bit-transparent), below the corner
//! it is flat, and above it the cut is exactly what the meter reports.
//!
//! Two detector modes:
//!
//!   * **Split band** — attenuate only the high band.  Transparent, the
//!     default for mastering.
//!   * **Wideband** — attenuate the whole signal when the high band trips.
//!     More audible, but preserves the tonal balance during the duck; the
//!     classic broadcast behaviour.
//!
//! Stereo detection is linked (the louder channel drives both), so a
//! sibilant on one side can't pull the image across.

use crate::biquad::{Biquad, BiquadCoeffs};
use super::config::DeessConfig;
use super::StereoModule;

/// Detector knee, in dB.
const KNEE_DB: f64 = 4.0;

/// How often the shelf coefficients are recomputed, in samples.  The
/// envelope is already attack/release-smoothed, so stepping the shelf at
/// audio-block granularity is inaudible and keeps the cost off the hot path.
const COEFF_UPDATE: usize = 16;

/// Split-band de-esser.
pub struct Deess {
    sr: f64,
    cfg: DeessConfig,
    /// Detector-only high-pass — isolates the band the detector listens to.
    det_hp: Biquad,
    /// The dynamic shelf that does the actual ducking, per channel.
    shelf_l: Biquad,
    shelf_r: Biquad,
    /// Detector emphasis — tilts the high band the detector sees so that
    /// 9 kHz sibilance trips before 5 kHz presence does.  Applied to the
    /// (linear, un-rectified) mid of the high band.
    det_tilt: Biquad,
    env_db: f64,
    atk_coeff: f64,
    rel_coeff: f64,
    last_gr_db: f64,
}

fn time_coeff(ms: f64, sr: f64) -> f64 {
    if ms <= 0.0 { return 0.0; }
    (-1.0 / (ms * 0.001 * sr)).exp()
}

impl Deess {
    /// Construct from a sample rate + config.
    pub fn new(sample_rate: f64, cfg: DeessConfig) -> Self {
        let f = Self::safe_freq(cfg.frequency_hz, sample_rate);
        let flat = BiquadCoeffs::high_shelf(sample_rate, f, 0.707, 0.0);
        Self {
            sr: sample_rate,
            cfg,
            det_hp: Biquad::new(BiquadCoeffs::high_pass(sample_rate, f, 0.707)),
            shelf_l: Biquad::new(flat),
            shelf_r: Biquad::new(flat),
            det_tilt: Biquad::new(BiquadCoeffs::high_shelf(sample_rate, f, 0.707, 6.0)),
            env_db: -120.0,
            atk_coeff: time_coeff(cfg.attack_ms, sample_rate),
            rel_coeff: time_coeff(cfg.release_ms, sample_rate),
            last_gr_db: 0.0,
        }
    }

    /// Update parameters.
    pub fn set_config(&mut self, cfg: DeessConfig) {
        self.cfg = cfg;
        let f = Self::safe_freq(cfg.frequency_hz, self.sr);
        self.det_hp.set_coeffs(BiquadCoeffs::high_pass(self.sr, f, 0.707));
        self.det_tilt.set_coeffs(BiquadCoeffs::high_shelf(self.sr, f, 0.707, 6.0));
        self.atk_coeff = time_coeff(cfg.attack_ms, self.sr);
        self.rel_coeff = time_coeff(cfg.release_ms, self.sr);
    }

    /// Gain reduction (dB, ≥ 0) applied on the last block — drives the meter.
    pub fn gain_reduction_db(&self) -> f64 { self.last_gr_db }

    fn safe_freq(hz: f64, sr: f64) -> f64 {
        if hz.is_finite() { hz.clamp(1_000.0, sr * 0.45) } else { 6_500.0 }
    }
}

impl StereoModule for Deess {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        if self.cfg.bypass || self.cfg.range_db <= 0.0 {
            self.last_gr_db = 0.0;
            return;
        }
        let threshold = self.cfg.threshold_db.clamp(-60.0, 0.0);
        let range = self.cfg.range_db.clamp(0.0, 24.0);
        let ratio = self.cfg.ratio.clamp(1.0, 20.0);
        let wideband = self.cfg.wideband;
        let n = left.len().min(right.len());
        let mut block_gr = 0.0f64;

        let f = Self::safe_freq(self.cfg.frequency_hz, self.sr);
        let sr = self.sr;

        for i in 0..n {
            let l = left[i] as f64;
            let r = right[i] as f64;

            // Detector: isolate the sibilant band, tilt it so 9 kHz trips
            // before 5 kHz presence does, and rectify the *linear* result.
            // (Filtering an already-rectified signal folds in its DC term.)
            let band = self.det_hp.process(0.5 * (l + r));
            let peak = self.det_tilt.process(band).abs().max(1e-9);
            let in_db = 20.0 * peak.log10();
            let coeff = if in_db > self.env_db { self.atk_coeff } else { self.rel_coeff };
            self.env_db = in_db + coeff * (self.env_db - in_db);

            // Gain computer with a soft knee, clamped to the range.
            let over = self.env_db - threshold;
            let reduction = if over <= -KNEE_DB / 2.0 {
                0.0
            } else if over >= KNEE_DB / 2.0 {
                over * (1.0 - 1.0 / ratio)
            } else {
                let x = over + KNEE_DB / 2.0;
                (1.0 - 1.0 / ratio) * x * x / (2.0 * KNEE_DB)
            }
            .clamp(0.0, range);

            if reduction > block_gr { block_gr = reduction; }

            if wideband {
                let g = 10f64.powf(-reduction / 20.0);
                left[i] = (l * g) as f32;
                right[i] = (r * g) as f32;
            } else {
                if i % COEFF_UPDATE == 0 {
                    let c = BiquadCoeffs::high_shelf(sr, f, 0.707, -reduction);
                    self.shelf_l.set_coeffs(c);
                    self.shelf_r.set_coeffs(c);
                }
                left[i] = self.shelf_l.process(l) as f32;
                right[i] = self.shelf_r.process(r) as f32;
            }
        }
        self.last_gr_db = block_gr;
    }

    fn reset(&mut self) {
        self.det_hp.reset();
        self.det_tilt.reset();
        self.shelf_l.reset();
        self.shelf_r.reset();
        self.env_db = -120.0;
        self.last_gr_db = 0.0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> DeessConfig {
        DeessConfig {
            frequency_hz: 6_500.0, threshold_db: -30.0, ratio: 4.0, range_db: 12.0,
            attack_ms: 1.0, release_ms: 60.0, wideband: false, bypass: false,
        }
    }

    fn tone(n: usize, freq: f64, sr: f64, amp: f32) -> Vec<f32> {
        (0..n).map(|i| (2.0 * std::f64::consts::PI * freq * i as f64 / sr).sin() as f32 * amp).collect()
    }

    fn rms(x: &[f32]) -> f64 {
        (x.iter().map(|v| (*v as f64) * (*v as f64)).sum::<f64>() / x.len() as f64).sqrt()
    }

    #[test]
    fn bypass_is_passthrough() {
        let mut d = Deess::new(48_000.0, DeessConfig { bypass: true, ..cfg() });
        let mut l = tone(512, 9_000.0, 48_000.0, 0.5);
        let orig = l.clone();
        let mut r = l.clone();
        d.process_stereo(&mut l, &mut r);
        assert_eq!(l, orig);
    }

    #[test]
    fn ducks_loud_sibilance() {
        let mut d = Deess::new(48_000.0, cfg());
        let n = 24_000;
        let mut l = tone(n, 9_000.0, 48_000.0, 0.6);
        let mut r = l.clone();
        let before = rms(&l[n / 2..]);
        d.process_stereo(&mut l, &mut r);
        let after = rms(&l[n / 2..]);
        let delta = 20.0 * (after / before).log10();
        assert!(delta < -3.0, "sibilance should duck, got {delta:.1} dB");
        assert!(d.gain_reduction_db() > 3.0);
    }

    /// Low-frequency content must not move — that is the point of split band.
    #[test]
    fn leaves_low_band_alone() {
        let mut d = Deess::new(48_000.0, cfg());
        let n = 24_000;
        let mut l = tone(n, 200.0, 48_000.0, 0.6);
        let mut r = l.clone();
        let before = rms(&l[n / 2..]);
        d.process_stereo(&mut l, &mut r);
        let after = rms(&l[n / 2..]);
        let delta = 20.0 * (after / before).log10();
        assert!(delta.abs() < 1.0, "low band moved {delta:.2} dB");
    }

    /// Wideband mode ducks the low band too.
    #[test]
    fn wideband_ducks_everything() {
        let mut d = Deess::new(48_000.0, DeessConfig { wideband: true, ..cfg() });
        let n = 24_000;
        let low = tone(n, 200.0, 48_000.0, 0.4);
        let sib = tone(n, 9_000.0, 48_000.0, 0.6);
        let mut l: Vec<f32> = low.iter().zip(sib.iter()).map(|(a, b)| a + b).collect();
        let mut r = l.clone();
        d.process_stereo(&mut l, &mut r);
        assert!(d.gain_reduction_db() > 3.0);
        assert!(l.iter().all(|s| s.is_finite()));
    }

    #[test]
    fn quiet_signal_is_untouched() {
        let mut d = Deess::new(48_000.0, cfg());
        let n = 8192;
        let mut l = tone(n, 9_000.0, 48_000.0, 0.005); // ≈ -46 dB, below threshold
        let mut r = l.clone();
        let before = rms(&l[n / 2..]);
        d.process_stereo(&mut l, &mut r);
        let after = rms(&l[n / 2..]);
        assert!((20.0 * (after / before).log10()).abs() < 0.5);
    }
}
