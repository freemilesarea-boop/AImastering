//! Free parametric EQ — a small variable-length band list authored by the
//! user, processed in series.  Each band is a single biquad (bell / shelf /
//! cut/pass) with type, frequency, gain, Q, and an enable flag.
//!
//! Sits BEFORE the fixed-band [`super::eq::Eq`] in the mastering chain so
//! user-drawn corrective EQ runs before the gentle tone-shaping curve.
//!
//! Realtime-safe: capacity is fixed at construction; updates never allocate.
//! When the new band count exceeds the chain's capacity, surplus bands are
//! silently dropped — the chain logs nothing (callers cap at the UI's
//! MAX_BANDS, currently 7, well under the chain's larger safety bound).

use crate::biquad::{Biquad, BiquadCoeffs};
use super::StereoModule;

/// Hard cap on the number of bands a single [`ParametricEq`] instance can
/// run.  The UI exposes 7; we leave headroom for future presets.
pub const MAX_PARAMETRIC_BANDS: usize = 16;

/// Filter type for one band.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParametricBandType {
    HighPass,
    LowPass,
    Bell,
    LowShelf,
    HighShelf,
}

/// One band's parameters.
#[derive(Debug, Clone, Copy)]
pub struct ParametricBand {
    pub kind: ParametricBandType,
    pub frequency_hz: f64,
    pub gain_db: f64,
    pub q: f64,
    pub enabled: bool,
}

impl Default for ParametricBand {
    fn default() -> Self {
        Self {
            kind: ParametricBandType::Bell,
            frequency_hz: 1000.0,
            gain_db: 0.0,
            q: 1.0,
            enabled: false,
        }
    }
}

fn coeffs_for(sample_rate: f64, b: &ParametricBand) -> BiquadCoeffs {
    let f = b.frequency_hz.clamp(10.0, sample_rate / 2.0 - 1.0);
    let q = b.q.clamp(0.1, 18.0);
    match b.kind {
        ParametricBandType::HighPass  => BiquadCoeffs::high_pass(sample_rate, f, q),
        ParametricBandType::LowPass   => BiquadCoeffs::low_pass(sample_rate, f, q),
        ParametricBandType::Bell      => BiquadCoeffs::peaking(sample_rate, f, q, b.gain_db),
        ParametricBandType::LowShelf  => BiquadCoeffs::low_shelf(sample_rate, f, q, b.gain_db),
        ParametricBandType::HighShelf => BiquadCoeffs::high_shelf(sample_rate, f, q, b.gain_db),
    }
}

struct ChannelBank {
    /// Pre-allocated biquads (capacity = MAX_PARAMETRIC_BANDS).
    biquads: Vec<Biquad>,
    /// Number of biquads currently active (the prefix of `biquads`).
    active_len: usize,
}

impl ChannelBank {
    fn new() -> Self {
        let mut biquads = Vec::with_capacity(MAX_PARAMETRIC_BANDS);
        for _ in 0..MAX_PARAMETRIC_BANDS {
            // Identity peaking filter @ 1 kHz, 0 dB.
            biquads.push(Biquad::new(BiquadCoeffs::peaking(48_000.0, 1000.0, 1.0, 0.0)));
        }
        Self { biquads, active_len: 0 }
    }

    fn apply(&mut self, sample_rate: f64, bands: &[ParametricBand]) {
        let n = bands.iter().filter(|b| b.enabled).count().min(MAX_PARAMETRIC_BANDS);
        let mut idx = 0;
        for b in bands.iter().filter(|b| b.enabled).take(MAX_PARAMETRIC_BANDS) {
            self.biquads[idx].set_coeffs(coeffs_for(sample_rate, b));
            idx += 1;
        }
        self.active_len = n;
    }

    fn reset(&mut self) {
        for b in self.biquads.iter_mut() {
            b.reset();
        }
    }

    #[inline]
    fn process(&mut self, x: f64) -> f64 {
        let mut y = x;
        for b in self.biquads[..self.active_len].iter_mut() {
            y = b.process(y);
        }
        y
    }
}

/// Free parametric EQ — bank of biquads per channel.
pub struct ParametricEq {
    sample_rate: f64,
    bands_count: usize,
    l: ChannelBank,
    r: ChannelBank,
    bypass: bool,
}

impl ParametricEq {
    /// Construct a transparent (no bands) parametric EQ for the given SR.
    pub fn new(sample_rate: f64) -> Self {
        Self {
            sample_rate,
            bands_count: 0,
            l: ChannelBank::new(),
            r: ChannelBank::new(),
            bypass: false,
        }
    }

    /// Replace the active band list.  Bands with `enabled = false` are
    /// skipped.  Surplus over [`MAX_PARAMETRIC_BANDS`] is dropped.
    pub fn set_bands(&mut self, bands: &[ParametricBand]) {
        self.l.apply(self.sample_rate, bands);
        self.r.apply(self.sample_rate, bands);
        self.bands_count = self.l.active_len;
    }

    /// Number of enabled bands currently in the signal path.
    pub fn active_bands(&self) -> usize { self.bands_count }

    /// Force the entire module to bypass (overrides `set_bands`).
    pub fn set_bypass(&mut self, bypass: bool) {
        self.bypass = bypass;
    }
}

impl StereoModule for ParametricEq {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        if self.bypass || self.bands_count == 0 { return; }
        for x in left.iter_mut() { *x = self.l.process(*x as f64) as f32; }
        for x in right.iter_mut() { *x = self.r.process(*x as f64) as f32; }
    }

    fn reset(&mut self) {
        self.l.reset();
        self.r.reset();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_band_list_is_passthrough() {
        let mut eq = ParametricEq::new(48_000.0);
        eq.set_bands(&[]);
        let mut l = [0.3f32, -0.7, 0.1, 0.9, -0.5];
        let mut r = [0.2f32, 0.4, -0.5, 0.0, 0.8];
        let (lc, rc) = (l, r);
        eq.process_stereo(&mut l, &mut r);
        assert_eq!(l, lc);
        assert_eq!(r, rc);
        assert_eq!(eq.active_bands(), 0);
    }

    #[test]
    fn disabled_bands_are_skipped() {
        let mut eq = ParametricEq::new(48_000.0);
        eq.set_bands(&[
            ParametricBand { enabled: false, gain_db: 24.0, ..ParametricBand::default() },
            ParametricBand { enabled: false, kind: ParametricBandType::HighPass, frequency_hz: 8000.0, q: 0.707, ..ParametricBand::default() },
        ]);
        assert_eq!(eq.active_bands(), 0);
        // Still a passthrough.
        let mut l = [0.3f32, -0.7, 0.1];
        let mut r = [0.2f32, 0.4, -0.5];
        let (lc, rc) = (l, r);
        eq.process_stereo(&mut l, &mut r);
        assert_eq!(l, lc);
        assert_eq!(r, rc);
    }

    #[test]
    fn high_pass_attenuates_dc() {
        let mut eq = ParametricEq::new(48_000.0);
        eq.set_bands(&[
            ParametricBand { kind: ParametricBandType::HighPass, frequency_hz: 200.0, q: 0.707, enabled: true, ..ParametricBand::default() },
        ]);
        let mut l = [1.0f32; 4096];
        let mut r = [1.0f32; 4096];
        eq.process_stereo(&mut l, &mut r);
        assert!(l[4095].abs() < 0.05, "DC not attenuated: {}", l[4095]);
    }

    #[test]
    fn bell_boost_increases_amplitude_at_center() {
        let sr = 48_000.0;
        let mut eq = ParametricEq::new(sr);
        eq.set_bands(&[
            ParametricBand { kind: ParametricBandType::Bell, frequency_hz: 1000.0, gain_db: 12.0, q: 0.8, enabled: true, ..ParametricBand::default() },
        ]);
        let n = 8192;
        let mut l: Vec<f32> = (0..n).map(|i| (2.0 * std::f64::consts::PI * 1000.0 * i as f64 / sr).sin() as f32 * 0.3).collect();
        let mut r = l.clone();
        let input_rms = (l.iter().map(|x| (x * x) as f64).sum::<f64>() / n as f64).sqrt();
        eq.process_stereo(&mut l, &mut r);
        let tail = &l[4096..];
        let out_rms = (tail.iter().map(|x| (x * x) as f64).sum::<f64>() / tail.len() as f64).sqrt();
        // +12 dB ≈ 4× amplitude (with some skirt loss).  Expect ≥ 2.5× for honest gain.
        let ratio_db = 20.0 * (out_rms / input_rms).log10();
        assert!(ratio_db > 8.0, "expected ≥ +8 dB boost at 1 kHz, got {ratio_db:.1}");
    }

    #[test]
    fn surplus_bands_dropped_silently() {
        let mut eq = ParametricEq::new(48_000.0);
        let bands: Vec<ParametricBand> = (0..MAX_PARAMETRIC_BANDS + 5)
            .map(|i| ParametricBand {
                kind: ParametricBandType::Bell,
                frequency_hz: 1000.0 + (i as f64 * 50.0),
                gain_db: 1.0,
                q: 1.0,
                enabled: true,
            })
            .collect();
        eq.set_bands(&bands);
        assert_eq!(eq.active_bands(), MAX_PARAMETRIC_BANDS);
        // Still finite output.
        let mut l = vec![0.4f32; 1024];
        let mut r = vec![0.4f32; 1024];
        eq.process_stereo(&mut l, &mut r);
        assert!(l.iter().all(|x| x.is_finite()));
        assert!(r.iter().all(|x| x.is_finite()));
    }

    #[test]
    fn bypass_overrides_band_list() {
        let mut eq = ParametricEq::new(48_000.0);
        eq.set_bands(&[
            ParametricBand { kind: ParametricBandType::Bell, frequency_hz: 1000.0, gain_db: 12.0, q: 1.0, enabled: true, ..ParametricBand::default() },
        ]);
        eq.set_bypass(true);
        let mut l = [0.3f32, -0.7, 0.1];
        let mut r = [0.2f32, 0.4, -0.5];
        let (lc, rc) = (l, r);
        eq.process_stereo(&mut l, &mut r);
        assert_eq!(l, lc);
        assert_eq!(r, rc);
    }
}
