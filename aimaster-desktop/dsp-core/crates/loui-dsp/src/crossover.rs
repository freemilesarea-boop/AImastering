//! Linkwitz-Riley 4th-order crossover — the band-splitter behind every
//! multiband module (Dynamics, Exciter, Impact, Imager bands, Low End Focus).
//!
//! An LR4 section is two cascaded Butterworth (Q = 0.707) biquads.  Its
//! low + high outputs sum to an all-pass response — flat magnitude, so a
//! split-then-sum with no per-band processing is transparent apart from
//! phase.  The high branch is polarity-inverted at odd split counts to keep
//! the sum in phase; with the 3-split (4-band) tree used here the standard
//! cascade already sums flat, which `four_band_sum_is_flat` verifies.
//!
//! Splitting is done as a binary tree so band edges stay independent:
//!
//! ```text
//!            ┌── LP(f1) ─────────────────────────► band 0 (low)
//!   in ──────┤
//!            └── HP(f1) ──┬── LP(f2) ─────────────► band 1 (low-mid)
//!                         └── HP(f2) ──┬── LP(f3) ► band 2 (high-mid)
//!                                      └── HP(f3) ► band 3 (high)
//! ```
//!
//! Realtime-safe: all state is fixed-size, `split` allocates nothing.

use crate::biquad::{Biquad, BiquadCoeffs};

/// Number of bands the multiband splitter produces.
pub const BANDS: usize = 4;
/// Number of crossover frequencies (`BANDS - 1`).
pub const SPLITS: usize = BANDS - 1;

/// Butterworth Q for one half of an LR4 cascade.
const BUTTERWORTH_Q: f64 = std::f64::consts::FRAC_1_SQRT_2;

/// A Linkwitz-Riley 4th-order low/high pair for one split point.
#[derive(Debug, Clone, Copy)]
struct Lr4 {
    lp_a: Biquad,
    lp_b: Biquad,
    hp_a: Biquad,
    hp_b: Biquad,
}

impl Lr4 {
    fn new(sample_rate: f64, freq_hz: f64) -> Self {
        let lp = BiquadCoeffs::low_pass(sample_rate, freq_hz, BUTTERWORTH_Q);
        let hp = BiquadCoeffs::high_pass(sample_rate, freq_hz, BUTTERWORTH_Q);
        Self {
            lp_a: Biquad::new(lp),
            lp_b: Biquad::new(lp),
            hp_a: Biquad::new(hp),
            hp_b: Biquad::new(hp),
        }
    }

    fn set_freq(&mut self, sample_rate: f64, freq_hz: f64) {
        let lp = BiquadCoeffs::low_pass(sample_rate, freq_hz, BUTTERWORTH_Q);
        let hp = BiquadCoeffs::high_pass(sample_rate, freq_hz, BUTTERWORTH_Q);
        self.lp_a.set_coeffs(lp);
        self.lp_b.set_coeffs(lp);
        self.hp_a.set_coeffs(hp);
        self.hp_b.set_coeffs(hp);
    }

    #[inline]
    fn split(&mut self, x: f64) -> (f64, f64) {
        let low = self.lp_b.process(self.lp_a.process(x));
        let high = self.hp_b.process(self.hp_a.process(x));
        (low, high)
    }

    fn reset(&mut self) {
        self.lp_a.reset();
        self.lp_b.reset();
        self.hp_a.reset();
        self.hp_b.reset();
    }
}

/// Two-band Linkwitz-Riley splitter for one channel.
///
/// The simple case of the tree above: one split point, low and high outputs
/// that sum back to the input with flat magnitude.  Used where a module only
/// needs to separate one region (Low End Focus, the imager's low-mono).
#[derive(Debug, Clone, Copy)]
pub struct Crossover2 {
    sr: f64,
    freq: f64,
    stage: Lr4,
}

impl Crossover2 {
    /// Construct with one crossover frequency.
    pub fn new(sample_rate: f64, freq_hz: f64) -> Self {
        let f = Self::sanitise(freq_hz, sample_rate);
        Self { sr: sample_rate, freq: f, stage: Lr4::new(sample_rate, f) }
    }

    /// Update the crossover frequency (state preserved — no click).
    pub fn set_freq(&mut self, freq_hz: f64) {
        let f = Self::sanitise(freq_hz, self.sr);
        if (f - self.freq).abs() < 1e-9 {
            return;
        }
        self.freq = f;
        self.stage.set_freq(self.sr, f);
    }

    /// The active crossover frequency.
    pub fn freq(&self) -> f64 { self.freq }

    fn sanitise(freq_hz: f64, sr: f64) -> f64 {
        if freq_hz.is_finite() { freq_hz.clamp(20.0, sr * 0.45) } else { 200.0 }
    }

    /// Split one sample into `(low, high)`.
    #[inline]
    pub fn split(&mut self, x: f64) -> (f64, f64) {
        self.stage.split(x)
    }

    /// Clear filter state.
    pub fn reset(&mut self) { self.stage.reset(); }
}

/// 4-band Linkwitz-Riley splitter for one channel.
#[derive(Debug, Clone, Copy)]
pub struct Crossover4 {
    sr: f64,
    freqs: [f64; SPLITS],
    stage: [Lr4; SPLITS],
    /// All-pass compensation so the low bands stay phase-aligned with the
    /// high bands they were split before.
    lo_ap_1: Lr4,
    lo_ap_2: Lr4,
    mid_ap: Lr4,
}

impl Crossover4 {
    /// Construct with three crossover frequencies (ascending).
    pub fn new(sample_rate: f64, freqs: [f64; SPLITS]) -> Self {
        let f = Self::sanitise(freqs, sample_rate);
        Self {
            sr: sample_rate,
            freqs: f,
            stage: [
                Lr4::new(sample_rate, f[0]),
                Lr4::new(sample_rate, f[1]),
                Lr4::new(sample_rate, f[2]),
            ],
            lo_ap_1: Lr4::new(sample_rate, f[1]),
            lo_ap_2: Lr4::new(sample_rate, f[2]),
            mid_ap: Lr4::new(sample_rate, f[2]),
        }
    }

    /// Update the crossover frequencies (state preserved — no click).
    pub fn set_freqs(&mut self, freqs: [f64; SPLITS]) {
        let f = Self::sanitise(freqs, self.sr);
        if f == self.freqs {
            return;
        }
        self.freqs = f;
        self.stage[0].set_freq(self.sr, f[0]);
        self.stage[1].set_freq(self.sr, f[1]);
        self.stage[2].set_freq(self.sr, f[2]);
        self.lo_ap_1.set_freq(self.sr, f[1]);
        self.lo_ap_2.set_freq(self.sr, f[2]);
        self.mid_ap.set_freq(self.sr, f[2]);
    }

    /// The active crossover frequencies.
    pub fn freqs(&self) -> [f64; SPLITS] { self.freqs }

    /// Force ascending, in-range, finite crossover points.  A bad value can
    /// otherwise make a biquad unstable, so this is a hard safety gate.
    fn sanitise(freqs: [f64; SPLITS], sr: f64) -> [f64; SPLITS] {
        let nyq = sr * 0.45;
        let mut out = [0.0; SPLITS];
        let mut prev = 20.0;
        for i in 0..SPLITS {
            let raw = if freqs[i].is_finite() { freqs[i] } else { prev * 4.0 };
            // Each split must sit at least a semitone above the previous one.
            let v = raw.clamp(prev * 1.06, nyq);
            out[i] = v;
            prev = v;
        }
        out
    }

    /// Split one sample into 4 bands (low → high).  The bands sum back to
    /// the input (to within LR4 phase behaviour).
    #[inline]
    pub fn split(&mut self, x: f64) -> [f64; BANDS] {
        let (low, rest) = self.stage[0].split(x);
        let (low_mid, rest2) = self.stage[1].split(rest);
        let (high_mid, high) = self.stage[2].split(rest2);

        // Phase-align the earlier bands through the all-pass sum of the
        // splits they never passed through.
        let low = {
            let (a, b) = self.lo_ap_1.split(low);
            let s = a + b;
            let (c, d) = self.lo_ap_2.split(s);
            c + d
        };
        let low_mid = {
            let (a, b) = self.mid_ap.split(low_mid);
            a + b
        };

        [low, low_mid, high_mid, high]
    }

    /// Clear all filter state.
    pub fn reset(&mut self) {
        for s in self.stage.iter_mut() { s.reset(); }
        self.lo_ap_1.reset();
        self.lo_ap_2.reset();
        self.mid_ap.reset();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(n: usize, freq: f64, sr: f64) -> Vec<f64> {
        (0..n).map(|i| (2.0 * std::f64::consts::PI * freq * i as f64 / sr).sin()).collect()
    }

    /// Summing the four bands must reconstruct the input (magnitude-flat).
    #[test]
    fn four_band_sum_is_flat() {
        let sr = 48_000.0;
        for &f in &[60.0, 300.0, 1_000.0, 4_000.0, 9_000.0] {
            let mut xo = Crossover4::new(sr, [120.0, 800.0, 5_000.0]);
            let input = sine(8192, f, sr);
            let mut out = vec![0.0; input.len()];
            for (i, &x) in input.iter().enumerate() {
                out[i] = xo.split(x).iter().sum();
            }
            // Compare RMS over the settled tail — LR4 sums flat in magnitude.
            let tail = 4096;
            let rms_in: f64 = (input[tail..].iter().map(|v| v * v).sum::<f64>() / (input.len() - tail) as f64).sqrt();
            let rms_out: f64 = (out[tail..].iter().map(|v| v * v).sum::<f64>() / (out.len() - tail) as f64).sqrt();
            let err_db = 20.0 * (rms_out / rms_in).log10();
            assert!(err_db.abs() < 0.5, "{f} Hz: sum deviates {err_db:.2} dB from flat");
        }
    }

    /// Energy must land in the band the tone belongs to.
    #[test]
    fn tone_lands_in_expected_band() {
        let sr = 48_000.0;
        let cases = [(50.0, 0usize), (400.0, 1), (2_000.0, 2), (10_000.0, 3)];
        for (freq, expect) in cases {
            let mut xo = Crossover4::new(sr, [120.0, 800.0, 5_000.0]);
            let input = sine(8192, freq, sr);
            let mut energy = [0.0f64; BANDS];
            for (i, &x) in input.iter().enumerate() {
                let b = xo.split(x);
                if i >= 4096 {
                    for k in 0..BANDS { energy[k] += b[k] * b[k]; }
                }
            }
            let loudest = energy
                .iter()
                .enumerate()
                .max_by(|a, b| a.1.partial_cmp(b.1).unwrap())
                .map(|(i, _)| i)
                .unwrap();
            assert_eq!(loudest, expect, "{freq} Hz landed in band {loudest}, energy {energy:?}");
        }
    }

    /// Out-of-order / non-finite frequencies must not destabilise the filters.
    #[test]
    fn bad_frequencies_are_sanitised() {
        let mut xo = Crossover4::new(48_000.0, [9_000.0, 100.0, f64::NAN]);
        let f = xo.freqs();
        assert!(f[0] < f[1] && f[1] < f[2], "frequencies not ascending: {f:?}");
        let mut peak = 0.0f64;
        for i in 0..4096 {
            let b = xo.split(if i % 2 == 0 { 1.0 } else { -1.0 });
            for v in b { peak = peak.max(v.abs()); }
        }
        assert!(peak.is_finite() && peak < 10.0, "crossover blew up: peak {peak}");
    }
}
