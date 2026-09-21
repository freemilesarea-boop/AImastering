//! De-esser — tames sibilance ("s", "sh", "t") and cymbal spit.
//!
//! Split-band design, which is what mastering engineers want on a mix bus:
//! the signal is divided at `frequency_hz` into a low path (untouched) and a
//! high path (compressed), then recombined.  Only the sibilant band moves,
//! so the body of the mix keeps its level and tone.
//!
//! `threshold_db` is in dBFS and means it: the detector's emphasis shelf is
//! normalised so that the sibilant band — above `frequency_hz` — passes it
//! at unity, and only the band *below* the corner is pushed down.  Written
//! the other way round, as a +6 dB lift on the band it listens to, the
//! threshold would read 3 to 6 dB high and the amount would depend on where
//! the sibilance sat relative to the corner.
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

/// How far the detector favours the sibilant band over what sits below the
/// corner, in dB.  Applied as a *cut* below the corner rather than a lift
/// above it, so the band the threshold is about passes at unity.
const DET_TILT_DB: f64 = 6.0;

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
    /// (linear, un-rectified) mid of the high band.  Unity in the sibilant
    /// band, `-DET_TILT_DB` below the corner: same tilt, no offset.
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
            det_tilt: Biquad::new(BiquadCoeffs::low_shelf(sample_rate, f, 0.707, -DET_TILT_DB)),
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
        self.det_tilt.set_coeffs(BiquadCoeffs::low_shelf(self.sr, f, 0.707, -DET_TILT_DB));
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
            // The tilt is unity in the band, so `in_db` is the band's own
            // level in dBFS and comparing it with `threshold` is honest.
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

    /// Wideband mode ducks the low band too — that is the whole difference
    /// between the two modes, so the low band is what the test has to look
    /// at.  Split band is run on the same signal for the contrast: its low
    /// content has to come through untouched while wideband's does not.
    #[test]
    fn wideband_ducks_everything() {
        let n = 24_000;
        let low = tone(n, 200.0, 48_000.0, 0.4);
        let sib = tone(n, 9_000.0, 48_000.0, 0.6);
        let mixed: Vec<f32> = low.iter().zip(sib.iter()).map(|(a, b)| a + b).collect();

        // Isolate the low content in the output with a low-pass, so the
        // sibilant band's own ducking cannot be mistaken for it.
        let low_of = |x: &[f32]| -> f64 {
            let mut f = Biquad::new(BiquadCoeffs::low_pass(48_000.0, 500.0, 0.707));
            let y: Vec<f32> = x.iter().map(|v| f.process(*v as f64) as f32).collect();
            rms(&y[n / 2..])
        };
        let before = low_of(&mixed);

        let mut moved = [0.0f64; 2];
        for (slot, wideband) in moved.iter_mut().zip([true, false]) {
            let mut d = Deess::new(48_000.0, DeessConfig { wideband, ..cfg() });
            let mut l = mixed.clone();
            let mut r = l.clone();
            d.process_stereo(&mut l, &mut r);
            assert!(l.iter().all(|s| s.is_finite()));
            assert!(d.gain_reduction_db() > 3.0, "wideband={wideband}: detector never tripped");
            *slot = 20.0 * (low_of(&l) / before).log10();
        }
        assert!(moved[0] < -3.0, "wideband left the low band at {:.2} dB", moved[0]);
        assert!(moved[1].abs() < 1.0, "split band moved the low band {:.2} dB", moved[1]);
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

    /// What the detector settled on, in dBFS, recovered by inverting the
    /// gain computer.  A high ratio makes the inversion well conditioned
    /// and a long release keeps the follower near the crest; what droop is
    /// left is measured separately by `follower_droop_db` below, so it is
    /// never counted as a calibration error.
    fn detector_reads(sr: f64, corner_hz: f64, tone_hz: f64, level_db: f64) -> f64 {
        let (n, thr, ratio) = ((sr * 2.0) as usize, -30.0, 20.0);
        let mut d = Deess::new(sr, DeessConfig {
            frequency_hz: corner_hz, threshold_db: thr, ratio, range_db: 24.0,
            attack_ms: 1.0, release_ms: 2_000.0, wideband: false, bypass: false,
        });
        let mut l = tone(n, tone_hz, sr, 10f64.powf(level_db / 20.0) as f32);
        let mut r = l.clone();
        d.process_stereo(&mut l, &mut r);
        thr + d.gain_reduction_db() / (1.0 - 1.0 / ratio)
    }

    /// The same peak follower on the raw tone, with nothing in front of it.
    fn follower_droop_db(sr: f64, tone_hz: f64, level_db: f64) -> f64 {
        let n = (sr * 2.0) as usize;
        let amp = 10f64.powf(level_db / 20.0);
        let (atk, rel) = ((-1.0f64 / (0.001 * sr)).exp(), (-1.0f64 / (2.0 * sr)).exp());
        let mut env = -120.0f64;
        for i in 0..n {
            let x = (2.0 * std::f64::consts::PI * tone_hz * i as f64 / sr).sin().abs() * amp;
            let in_db = 20.0 * x.max(1e-9).log10();
            let c = if in_db > env { atk } else { rel };
            env = in_db + c * (env - in_db);
        }
        env - level_db
    }

    /// `threshold_db` is in dBFS, and in the band the module is about it
    /// means dBFS.  The emphasis shelf used to be written as a +6 dB lift on
    /// the sibilant band rather than a cut below the corner, so the detector
    /// read up to 5.94 dB high and the amount moved with where the sibilance
    /// sat -- a threshold that changed meaning as the corner was turned.
    ///
    /// Every case keeps at least 12 samples per cycle and sits at least 4x
    /// above the corner.  Below 12 the measurement stops being about the
    /// detector: a peak follower can only see the samples it is given, and
    /// the filters shift the phase, so the grid lands somewhere else on the
    /// crest than it does for the bare tone the droop control measures --
    /// at 6 samples per cycle that alone is worth 1.2 dB.  Below 4x the
    /// corner the high-pass's own skirt is still falling, which is the band
    /// split working, not a calibration error.
    #[test]
    fn a_threshold_in_dbfs_means_dbfs_in_the_band() {
        let level = -12.0;
        for &(sr, corner, tone_hz) in &[
            (48_000.0, 1_000.0, 4_000.0), (96_000.0, 1_000.0, 4_000.0),
            (96_000.0, 1_500.0, 6_000.0), (192_000.0, 1_500.0, 6_000.0),
            (192_000.0, 1_500.0, 7_500.0), (192_000.0, 1_000.0, 5_000.0),
            (192_000.0, 3_000.0, 12_000.0),
        ] {
            assert!(sr / tone_hz >= 12.0 && tone_hz >= 4.0 * corner, "case is unmeasurable");
            let off = detector_reads(sr, corner, tone_hz, level) - level
                - follower_droop_db(sr, tone_hz, level);
            assert!(
                off.abs() < 0.05,
                "{sr:.0} Hz, corner {corner} Hz, {tone_hz} Hz tone at {level} dBFS: \
                 detector is {off:+.3} dB out",
            );
        }
    }

    /// And nowhere -- at any corner, at any frequency the sweep reaches --
    /// may it read HIGH.  That is the direction that matters: reading high
    /// makes the module clamp down on material quieter than the number the
    /// user set.  Below the corner it reads low on purpose; that is the band
    /// split doing its job, so only the ceiling is asserted.
    #[test]
    fn the_detector_never_reads_above_the_true_level() {
        let (sr, level) = (192_000.0, -12.0);
        let mut worst: (f64, f64, f64) = (f64::NEG_INFINITY, 0.0, 0.0);
        let mut counted = 0;
        for &corner in &[1_000.0f64, 1_500.0, 2_000.0, 3_000.0] {
            for k in 0..14 {
                let tone_hz = corner * (1.0 + 0.15 * k as f64 * (1.0 + k as f64 * 0.25));
                // Same 16-samples-per-cycle floor as above, for the same
                // reason; it is what bounds the sweep rather than Nyquist.
                if sr / tone_hz < 16.0 { continue; }
                counted += 1;
                let off = detector_reads(sr, corner, tone_hz, level) - level
                    - follower_droop_db(sr, tone_hz, level);
                if off > worst.0 { worst = (off, corner, tone_hz); }
            }
        }
        assert!(counted >= 20, "the sweep only measured {counted} points");
        assert!(
            worst.0 < 0.05,
            "detector reads {:+.3} dB high at corner {:.0} Hz, tone {:.0} Hz",
            worst.0, worst.1, worst.2,
        );
        // It also has to have reached the band's flat part, or the ceiling
        // passes on content the detector barely hears.
        assert!(worst.0 > -0.05, "the sweep never found the flat part ({:+.3} dB)", worst.0);
    }

    /// The chain builds a de-esser once and then calls `set_config` on every
    /// parameter change, so the two have to agree.  They are separate copies
    /// of the same three filter expressions; a fix applied to one of them and
    /// not the other looks right in a unit test and ships wrong.
    #[test]
    fn set_config_builds_the_same_detector_as_new() {
        let (sr, level) = (192_000.0, -12.0);
        for &(corner, tone_hz) in &[(1_500.0, 6_000.0), (3_000.0, 12_000.0)] {
            let cfg = DeessConfig {
                frequency_hz: corner, threshold_db: -30.0, ratio: 20.0, range_db: 24.0,
                attack_ms: 1.0, release_ms: 2_000.0, wideband: false, bypass: false,
            };
            // One built for this config; one built for another and moved here.
            let mut fresh = Deess::new(sr, cfg);
            let mut moved = Deess::new(sr, DeessConfig { frequency_hz: 11_000.0, ..cfg });
            moved.set_config(cfg);
            let mut out = [Vec::new(), Vec::new()];
            for (slot, d) in out.iter_mut().zip([&mut fresh, &mut moved]) {
                let mut l = tone((sr * 2.0) as usize, tone_hz, sr, 10f64.powf(level / 20.0) as f32);
                let mut r = l.clone();
                d.process_stereo(&mut l, &mut r);
                *slot = l;
            }
            assert_eq!(out[0], out[1], "corner {corner} Hz: set_config disagrees with new");
            assert!(out[0].iter().any(|v| *v != 0.0), "nothing was rendered");
        }
    }
}
