//! Dynamic EQ — level-dependent bells and shelves.
//!
//! Each band has a static filter shape (bell / low shelf / high shelf) whose
//! gain is driven by a detector listening to that band.  This is the tool
//! that fixes problems a static EQ cannot: a boxy 250 Hz that only appears
//! on loud choruses, a harsh 3 kHz that only bites on vocal peaks.
//!
//! Per band:
//!
//! ```text
//!   side-chain band-pass ──► envelope ──► gain computer ──► filter gain
//!            ▲                                                   │
//!            └───────────────── input ────────────────────► filter ──► out
//! ```
//!
//! Two directions, both of which engineers use:
//!
//!   * **Down** (compressive) — cut when the band exceeds the threshold.
//!     Taming resonances, de-boxing, de-harshing.
//!   * **Up** (expansive) — boost when the band falls *below* the threshold.
//!     Adding weight to quiet passages without pumping the loud ones.
//!
//! The applied gain is clamped to `range_db` so a runaway detector can never
//! produce more than the band's declared maximum move.
//!
//! `threshold_db` is in dBFS and means it.  The side-chain band-pass is two
//! Butterworth sections whose corners straddle the band, so at the band's
//! own centre both are already off their flat part — 0.2 dB of loss at
//! Q 0.5 and 4 dB at Q 8.  The detector divides that loss back out, or the
//! threshold would drift by nearly 4 dB as the user turned Q, which is the
//! knob they turn to aim at a resonance.

use crate::biquad::{Biquad, BiquadCoeffs};
use super::config::{DynEqBandConfig, DynEqBandShape, DynEqMode, DynamicEqConfig};
use super::StereoModule;

/// Bands the module runs.  Ozone-style suites expose six; that is enough to
/// cover low / low-mid / mid / presence / sibilance / air.
pub const DYN_EQ_BANDS: usize = 6;

/// Detector knee, in dB.
const KNEE_DB: f64 = 6.0;
/// Coefficient refresh interval, in samples.  The envelope is already
/// smoothed, so recomputing the biquad every sample buys nothing audible.
const COEFF_UPDATE: usize = 16;

fn time_coeff(ms: f64, sr: f64) -> f64 {
    if ms <= 0.0 { return 0.0; }
    (-1.0 / (ms * 0.001 * sr)).exp()
}

/// One band's filters, detector and smoothed gain.
struct Band {
    /// The audio-path filter, per channel.
    filt_l: Biquad,
    filt_r: Biquad,
    /// Side-chain band-pass that isolates what the detector listens to.
    sc_a: Biquad,
    sc_b: Biquad,
    /// Reciprocal of the side-chain's gain at the band centre, so what the
    /// detector reads is the band's level in dBFS and not the band-pass's
    /// opinion of it.  1.0 when the band-pass is already flat there.
    sc_cal: f64,
    env_db: f64,
    atk: f64,
    rel: f64,
    /// Gain currently applied (dB, signed).
    applied_db: f64,
}

impl Band {
    fn new(sr: f64) -> Self {
        let flat = BiquadCoeffs::peaking(sr, 1_000.0, 1.0, 0.0);
        Self {
            filt_l: Biquad::new(flat),
            filt_r: Biquad::new(flat),
            sc_a: Biquad::new(BiquadCoeffs::high_pass(sr, 500.0, 0.707)),
            sc_b: Biquad::new(BiquadCoeffs::low_pass(sr, 2_000.0, 0.707)),
            sc_cal: 1.0,
            env_db: -120.0,
            atk: time_coeff(10.0, sr),
            rel: time_coeff(120.0, sr),
            applied_db: 0.0,
        }
    }

    fn reset(&mut self) {
        self.filt_l.reset();
        self.filt_r.reset();
        self.sc_a.reset();
        self.sc_b.reset();
        self.env_db = -120.0;
        self.applied_db = 0.0;
    }
}

/// Multi-band dynamic equaliser.
pub struct DynamicEq {
    sr: f64,
    cfg: DynamicEqConfig,
    bands: Vec<Band>,
    /// Signed gain applied per band on the last block, for the UI.
    applied: [f64; DYN_EQ_BANDS],
}

/// Shape the audio-path filter for a band at a given gain.
fn band_coeffs(sr: f64, b: &DynEqBandConfig, gain_db: f64) -> BiquadCoeffs {
    let f = b.frequency_hz.clamp(20.0, sr * 0.45);
    let q = b.q.clamp(0.2, 12.0);
    match b.shape {
        DynEqBandShape::Bell => BiquadCoeffs::peaking(sr, f, q, gain_db),
        DynEqBandShape::LowShelf => BiquadCoeffs::low_shelf(sr, f, q.min(1.4), gain_db),
        DynEqBandShape::HighShelf => BiquadCoeffs::high_shelf(sr, f, q.min(1.4), gain_db),
    }
}

impl DynamicEq {
    /// Construct from a sample rate + config.
    pub fn new(sample_rate: f64, cfg: DynamicEqConfig) -> Self {
        let mut me = Self {
            sr: sample_rate,
            cfg,
            bands: (0..DYN_EQ_BANDS).map(|_| Band::new(sample_rate)).collect(),
            applied: [0.0; DYN_EQ_BANDS],
        };
        me.rebuild();
        me
    }

    /// Update parameters (filter state preserved — no clicks).
    pub fn set_config(&mut self, cfg: DynamicEqConfig) {
        self.cfg = cfg;
        self.rebuild();
    }

    /// Signed gain (dB) each band applied on the last block.
    pub fn applied_gains_db(&self) -> [f64; DYN_EQ_BANDS] { self.applied }

    fn rebuild(&mut self) {
        let sr = self.sr;
        for (i, band) in self.bands.iter_mut().enumerate() {
            let c = self.cfg.bands[i];
            let f = c.frequency_hz.clamp(20.0, sr * 0.45);
            let q = c.q.clamp(0.2, 12.0);
            // Side chain: a band-pass roughly matching the band's reach, so
            // the detector hears what the filter will act on.
            let width = (1.0 / q).clamp(0.15, 2.0);
            let lo = (f / (1.0 + width)).clamp(20.0, sr * 0.44);
            let hi = (f * (1.0 + width)).clamp(lo * 1.05, sr * 0.45);
            let sc_hp = BiquadCoeffs::high_pass(sr, lo, 0.707);
            let sc_lp = BiquadCoeffs::low_pass(sr, hi, 0.707);
            // What the pair does to the band's own centre, divided back out
            // so `threshold_db` is a level and not a level minus a filter.
            // Clamped because a band pushed against Nyquist has its low-pass
            // corner clamped with it, and there the pair is no longer a
            // band-pass to calibrate; 16x is 24 dB, far past the 4 dB the
            // widest legal Q costs.
            let centre_gain = sc_hp.magnitude_at(sr, f) * sc_lp.magnitude_at(sr, f);
            band.sc_cal = if centre_gain > 1e-6 { (1.0 / centre_gain).clamp(1.0, 16.0) } else { 1.0 };
            band.sc_a.set_coeffs(sc_hp);
            band.sc_b.set_coeffs(sc_lp);
            band.atk = time_coeff(c.attack_ms, sr);
            band.rel = time_coeff(c.release_ms, sr);
        }
    }
}

impl StereoModule for DynamicEq {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        if self.cfg.bypass {
            self.applied = [0.0; DYN_EQ_BANDS];
            return;
        }
        let n = left.len().min(right.len());
        let sr = self.sr;

        for bi in 0..DYN_EQ_BANDS {
            let c = self.cfg.bands[bi];
            if !c.enabled || c.range_db <= 0.0 {
                self.applied[bi] = 0.0;
                continue;
            }
            let threshold = c.threshold_db.clamp(-80.0, 0.0);
            let ratio = c.ratio.clamp(1.0, 20.0);
            let range = c.range_db.clamp(0.0, 24.0);
            let up = c.mode == DynEqMode::Up;
            let band = &mut self.bands[bi];
            let mut peak_move = 0.0f64;

            for i in 0..n {
                // Side chain listens to the mono sum — a band problem that
                // only exists on one side is still a band problem.
                let mono = 0.5 * (left[i] as f64 + right[i] as f64);
                let sc = band.sc_b.process(band.sc_a.process(mono)) * band.sc_cal;
                let lvl = sc.abs().max(1e-9);
                let in_db = 20.0 * lvl.log10();
                let coeff = if in_db > band.env_db { band.atk } else { band.rel };
                band.env_db = in_db + coeff * (band.env_db - in_db);

                // Gain computer.  Down mode acts on the excess above the
                // threshold; up mode acts on the shortfall below it.
                let delta = if up { threshold - band.env_db } else { band.env_db - threshold };
                let magnitude = if delta <= -KNEE_DB / 2.0 {
                    0.0
                } else if delta >= KNEE_DB / 2.0 {
                    delta * (1.0 - 1.0 / ratio)
                } else {
                    let x = delta + KNEE_DB / 2.0;
                    (1.0 - 1.0 / ratio) * x * x / (2.0 * KNEE_DB)
                }
                .clamp(0.0, range);

                let target = if up { magnitude } else { -magnitude };
                band.applied_db = target;
                if magnitude > peak_move { peak_move = magnitude; }

                if i % COEFF_UPDATE == 0 {
                    let coeffs = band_coeffs(sr, &c, band.applied_db);
                    band.filt_l.set_coeffs(coeffs);
                    band.filt_r.set_coeffs(coeffs);
                }
                left[i] = band.filt_l.process(left[i] as f64) as f32;
                right[i] = band.filt_r.process(right[i] as f64) as f32;
            }
            self.applied[bi] = if up { peak_move } else { -peak_move };
        }
    }

    fn reset(&mut self) {
        for b in self.bands.iter_mut() { b.reset(); }
        self.applied = [0.0; DYN_EQ_BANDS];
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn one_band(b: DynEqBandConfig) -> DynamicEqConfig {
        let mut cfg = DynamicEqConfig::default();
        cfg.bands[0] = b;
        cfg.bypass = false;
        cfg
    }

    fn down_band() -> DynEqBandConfig {
        DynEqBandConfig {
            enabled: true, shape: DynEqBandShape::Bell, mode: DynEqMode::Down,
            frequency_hz: 250.0, q: 1.5, threshold_db: -30.0, ratio: 4.0,
            range_db: 9.0, attack_ms: 5.0, release_ms: 80.0,
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
        let mut d = DynamicEq::new(48_000.0, DynamicEqConfig { bypass: true, ..one_band(down_band()) });
        let mut l = tone(512, 250.0, 48_000.0, 0.5);
        let orig = l.clone();
        let mut r = l.clone();
        d.process_stereo(&mut l, &mut r);
        assert_eq!(l, orig);
    }

    #[test]
    fn disabled_band_is_passthrough() {
        let mut b = down_band();
        b.enabled = false;
        let mut d = DynamicEq::new(48_000.0, one_band(b));
        let mut l = tone(512, 250.0, 48_000.0, 0.5);
        let orig = l.clone();
        let mut r = l.clone();
        d.process_stereo(&mut l, &mut r);
        assert_eq!(l, orig);
    }

    #[test]
    fn down_mode_cuts_loud_band() {
        let mut d = DynamicEq::new(48_000.0, one_band(down_band()));
        let n = 24_000;
        let mut l = tone(n, 250.0, 48_000.0, 0.6);
        let mut r = l.clone();
        let before = rms(&l[n / 2..]);
        d.process_stereo(&mut l, &mut r);
        let after = rms(&l[n / 2..]);
        let delta = 20.0 * (after / before).log10();
        assert!(delta < -3.0, "loud 250 Hz should be cut, got {delta:.1} dB");
        assert!(d.applied_gains_db()[0] < -3.0);
    }

    /// Content well outside the band must not move.
    #[test]
    fn other_frequencies_are_left_alone() {
        let mut d = DynamicEq::new(48_000.0, one_band(down_band()));
        let n = 24_000;
        let mut l = tone(n, 6_000.0, 48_000.0, 0.6);
        let mut r = l.clone();
        let before = rms(&l[n / 2..]);
        d.process_stereo(&mut l, &mut r);
        let after = rms(&l[n / 2..]);
        assert!((20.0 * (after / before).log10()).abs() < 1.0);
    }

    #[test]
    fn quiet_band_is_not_cut() {
        let mut d = DynamicEq::new(48_000.0, one_band(down_band()));
        let n = 12_000;
        let mut l = tone(n, 250.0, 48_000.0, 0.002); // ≈ -54 dB
        let mut r = l.clone();
        let before = rms(&l[n / 2..]);
        d.process_stereo(&mut l, &mut r);
        let after = rms(&l[n / 2..]);
        assert!((20.0 * (after / before).log10()).abs() < 0.5);
    }

    #[test]
    fn up_mode_boosts_quiet_band() {
        let mut b = down_band();
        b.mode = DynEqMode::Up;
        b.threshold_db = -20.0;
        let mut d = DynamicEq::new(48_000.0, one_band(b));
        let n = 24_000;
        let mut l = tone(n, 250.0, 48_000.0, 0.02); // well below threshold
        let mut r = l.clone();
        let before = rms(&l[n / 2..]);
        d.process_stereo(&mut l, &mut r);
        let after = rms(&l[n / 2..]);
        let delta = 20.0 * (after / before).log10();
        assert!(delta > 2.0, "up mode should lift quiet band, got {delta:.1} dB");
        assert!(d.applied_gains_db()[0] > 0.0);
    }

    /// The move must never exceed the declared range.
    #[test]
    fn respects_range_clamp() {
        let mut b = down_band();
        b.range_db = 3.0;
        b.ratio = 20.0;
        let mut d = DynamicEq::new(48_000.0, one_band(b));
        let mut l = tone(24_000, 250.0, 48_000.0, 0.9);
        let mut r = l.clone();
        d.process_stereo(&mut l, &mut r);
        assert!(d.applied_gains_db()[0] >= -3.001, "clamp breached: {}", d.applied_gains_db()[0]);
    }

    #[test]
    fn output_stays_finite() {
        let mut d = DynamicEq::new(48_000.0, one_band(down_band()));
        let mut l = vec![0.0f32; 4096];
        for (i, s) in l.iter_mut().enumerate() { *s = if i % 3 == 0 { 2.0 } else { -2.0 }; }
        let mut r = l.clone();
        d.process_stereo(&mut l, &mut r);
        assert!(l.iter().all(|s| s.is_finite()));
    }

    /// What the band's detector settled on, in dBFS, recovered by inverting
    /// the gain computer.  A high ratio makes the inversion well
    /// conditioned, a long release keeps the follower near the crest, and a
    /// range wider than the move keeps the clamp out of it.
    fn detector_reads(sr: f64, freq_hz: f64, q: f64, level_db: f64) -> f64 {
        let (n, thr, ratio) = ((sr * 2.0) as usize, -30.0, 20.0);
        let mut e = DynamicEq::new(sr, one_band(DynEqBandConfig {
            enabled: true, shape: DynEqBandShape::Bell, mode: DynEqMode::Down,
            frequency_hz: freq_hz, q, threshold_db: thr, ratio,
            range_db: 24.0, attack_ms: 1.0, release_ms: 2_000.0,
        }));
        let mut l = tone(n, freq_hz, sr, 10f64.powf(level_db / 20.0) as f32);
        let mut r = l.clone();
        e.process_stereo(&mut l, &mut r);
        thr + (-e.applied_gains_db()[0]) / (1.0 - 1.0 / ratio)
    }

    /// The same peak follower on the raw tone, so the droop it has between
    /// peaks is never counted as a calibration error.
    fn follower_droop_db(sr: f64, freq_hz: f64, level_db: f64) -> f64 {
        let n = (sr * 2.0) as usize;
        let amp = 10f64.powf(level_db / 20.0);
        let (atk, rel) = ((-1.0f64 / (0.001 * sr)).exp(), (-1.0f64 / (2.0 * sr)).exp());
        let mut env = -120.0f64;
        for i in 0..n {
            let x = (2.0 * std::f64::consts::PI * freq_hz * i as f64 / sr).sin().abs() * amp;
            let in_db = 20.0 * x.max(1e-9).log10();
            let c = if in_db > env { atk } else { rel };
            env = in_db + c * (env - in_db);
        }
        env - level_db
    }

    /// `threshold_db` is in dBFS and has to mean dBFS at every Q.
    ///
    /// The side-chain is two Butterworth sections whose corners straddle the
    /// band, so at the band's own centre neither is on its flat part.  The
    /// loss grows as Q narrows the pair: 0.2 dB at Q 0.5, 4.0 dB at Q 8.
    /// Uncancelled, the threshold slid by nearly 4 dB as the user turned the
    /// one knob they turn to aim at a resonance.
    #[test]
    fn a_threshold_in_dbfs_means_dbfs_at_every_q() {
        let (sr, level) = (48_000.0, -12.0);
        for &q in &[0.2f64, 0.5, 1.0, 1.4, 2.0, 4.0, 8.0, 12.0] {
            for &f in &[120.0f64, 1_000.0, 3_200.0] {
                assert!(sr / f >= 12.0, "case is unmeasurable");
                let off = detector_reads(sr, f, q, level) - level
                    - follower_droop_db(sr, f, level);
                // 0.08 dB, not 0.01: a peak follower only sees the samples
                // it is given, and at 3.2 kHz there are 15 per cycle, so
                // where the grid lands on the crest is worth about 0.05.
                // The error being cancelled here was 0.6 to 4.0 dB.
                assert!(
                    off.abs() < 0.08,
                    "Q {q} at {f} Hz, tone at {level} dBFS: detector is {off:+.3} dB out",
                );
            }
        }
    }

    /// Turning Q must not move the threshold.  The absolute test above
    /// would catch that too, but this is the symptom the user would report:
    /// the same band, the same material, a different amount of work done
    /// because a width control was touched.
    #[test]
    fn turning_q_does_not_move_the_threshold() {
        let (sr, level) = (48_000.0, -12.0);
        let readings: Vec<f64> = [0.2f64, 1.0, 4.0, 12.0]
            .iter()
            .map(|&q| detector_reads(sr, 1_000.0, q, level))
            .collect();
        let hi = readings.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
        let lo = readings.iter().cloned().fold(f64::INFINITY, f64::min);
        assert!(
            hi - lo < 0.05,
            "the threshold moved {:.3} dB across Q 0.2..12: {readings:?}",
            hi - lo,
        );
        assert!(lo > -60.0, "nothing was detected at all: {readings:?}");
    }
}
