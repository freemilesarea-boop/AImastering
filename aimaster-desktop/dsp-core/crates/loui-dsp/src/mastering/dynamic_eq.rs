//! Dynamic EQ — fully parametric, threshold-driven per-band gain.
//!
//! Each band is a parametric filter (bell / low-shelf / high-shelf) whose gain
//! is modulated by the band's own level relative to a threshold:
//!
//!   * a band-pass sidechain detector measures the energy around `freq_hz`
//!   * an envelope follower tracks it (attack / release)
//!   * mode `DownCut`  → cut  when the band is LOUDER than threshold
//!     mode `UpBoost`  → boost when the band is QUIETER than threshold
//!   * the dynamic gain (clamped to ±`range_db`) drives the filter, recomputed
//!     only when it moves by > 0.05 dB (cheap — fixed-frequency precompute)
//!
//! With every band disabled (or `range_db == 0`) the stage is a clean
//! passthrough.  Realtime-safe: per-sample, all state pre-allocated.

use super::config::{DynEqBandConfig, DynEqFilterType, DynEqMode, DynamicEqConfig, MAX_DYNEQ_BANDS};
use super::StereoModule;
use crate::biquad::{Biquad, BiquadCoeffs};

const RECOMPUTE_EPS_DB: f64 = 0.05;

fn time_coeff(ms: f64, sr: f64) -> f64 {
    if ms <= 0.0 {
        return 0.0;
    }
    (-1.0 / (ms * 0.001 * sr)).exp()
}

fn make_coeffs(ftype: DynEqFilterType, sr: f64, freq: f64, q: f64, gain_db: f64) -> BiquadCoeffs {
    match ftype {
        DynEqFilterType::Bell => BiquadCoeffs::peaking(sr, freq, q, gain_db),
        DynEqFilterType::LowShelf => BiquadCoeffs::low_shelf(sr, freq, q, gain_db),
        DynEqFilterType::HighShelf => BiquadCoeffs::high_shelf(sr, freq, q, gain_db),
    }
}

/// One dynamic-EQ band: detector + per-channel filter + envelope state.
struct Band {
    cfg: DynEqBandConfig,
    det_l: Biquad,
    det_r: Biquad,
    filt_l: Biquad,
    filt_r: Biquad,
    atk: f64,
    rel: f64,
    env_db: f64,
    last_gain_db: f64,
}

impl Band {
    fn new(sr: f64, cfg: DynEqBandConfig) -> Self {
        let det = BiquadCoeffs::band_pass(sr, cfg.freq_hz.clamp(20.0, sr * 0.45), cfg.q.max(0.3));
        let flat = make_coeffs(cfg.filter_type, sr, cfg.freq_hz.clamp(20.0, sr * 0.45), cfg.q.max(0.1), 0.0);
        Self {
            cfg,
            det_l: Biquad::new(det),
            det_r: Biquad::new(det),
            filt_l: Biquad::new(flat),
            filt_r: Biquad::new(flat),
            atk: time_coeff(cfg.attack_ms, sr),
            rel: time_coeff(cfg.release_ms, sr),
            env_db: -120.0,
            last_gain_db: 0.0,
        }
    }

    fn retune(&mut self, sr: f64, cfg: DynEqBandConfig) {
        let f = cfg.freq_hz.clamp(20.0, sr * 0.45);
        self.det_l.set_coeffs(BiquadCoeffs::band_pass(sr, f, cfg.q.max(0.3)));
        self.det_r.set_coeffs(BiquadCoeffs::band_pass(sr, f, cfg.q.max(0.3)));
        // Force a filter recompute on the next active sample.
        self.last_gain_db = f64::NAN;
        self.atk = time_coeff(cfg.attack_ms, sr);
        self.rel = time_coeff(cfg.release_ms, sr);
        self.cfg = cfg;
    }

    /// Target dynamic gain (dB) for the current envelope.
    #[inline]
    fn target_gain_db(&self) -> f64 {
        let over = self.env_db - self.cfg.threshold_db;
        let r = self.cfg.ratio.max(1.0);
        let factor = 1.0 - 1.0 / r;
        match self.cfg.mode {
            DynEqMode::DownCut => {
                if over > 0.0 { (-(over * factor)).max(-self.cfg.range_db) } else { 0.0 }
            }
            DynEqMode::UpBoost => {
                if over < 0.0 { ((-over) * factor).min(self.cfg.range_db) } else { 0.0 }
            }
        }
    }

    #[inline]
    fn process(&mut self, sr: f64, xl: f64, xr: f64) -> (f64, f64) {
        // Detector (stereo-linked).
        let dl = self.det_l.process(xl);
        let dr = self.det_r.process(xr);
        let det = dl.abs().max(dr.abs()).max(1e-9);
        let in_db = 20.0 * det.log10();
        let coeff = if in_db > self.env_db { self.atk } else { self.rel };
        self.env_db = in_db + coeff * (self.env_db - in_db);

        let gain_db = self.target_gain_db();
        if !(self.last_gain_db.is_finite()) || (gain_db - self.last_gain_db).abs() > RECOMPUTE_EPS_DB {
            let f = self.cfg.freq_hz.clamp(20.0, sr * 0.45);
            let c = make_coeffs(self.cfg.filter_type, sr, f, self.cfg.q.max(0.1), gain_db);
            self.filt_l.set_coeffs(c);
            self.filt_r.set_coeffs(c);
            self.last_gain_db = gain_db;
        }
        (self.filt_l.process(xl), self.filt_r.process(xr))
    }

    fn reset(&mut self) {
        self.det_l.reset();
        self.det_r.reset();
        self.filt_l.reset();
        self.filt_r.reset();
        self.env_db = -120.0;
    }
}

/// Fully-parametric dynamic EQ.
pub struct DynamicEq {
    sr: f64,
    cfg: DynamicEqConfig,
    bands: Vec<Band>,
}

impl DynamicEq {
    pub fn new(sample_rate: f64, cfg: DynamicEqConfig) -> Self {
        // Pre-allocate all band slots once (realtime-safe; no alloc in process).
        let bands = (0..MAX_DYNEQ_BANDS).map(|i| Band::new(sample_rate, cfg.bands[i])).collect();
        Self { sr: sample_rate, cfg, bands }
    }

    pub fn set_config(&mut self, cfg: DynamicEqConfig) {
        for i in 0..MAX_DYNEQ_BANDS {
            self.bands[i].retune(self.sr, cfg.bands[i]);
        }
        self.cfg = cfg;
    }

    fn is_unity(&self) -> bool {
        if self.cfg.bypass {
            return true;
        }
        self.cfg.bands.iter().all(|b| !b.enabled || b.range_db <= 0.0)
    }
}

impl StereoModule for DynamicEq {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        if self.is_unity() {
            return;
        }
        let sr = self.sr;
        let n = left.len().min(right.len());
        for i in 0..n {
            let mut xl = left[i] as f64;
            let mut xr = right[i] as f64;
            for b in self.bands.iter_mut() {
                if !b.cfg.enabled || b.cfg.range_db <= 0.0 {
                    continue;
                }
                let (ol, or) = b.process(sr, xl, xr);
                xl = ol;
                xr = or;
            }
            left[i] = if xl.is_finite() { xl as f32 } else { left[i] };
            right[i] = if xr.is_finite() { xr as f32 } else { right[i] };
        }
    }

    fn reset(&mut self) {
        for b in self.bands.iter_mut() {
            b.reset();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(n: usize, freq: f64, sr: f64, amp: f32) -> Vec<f32> {
        (0..n).map(|i| (2.0 * std::f64::consts::PI * freq * i as f64 / sr).sin() as f32 * amp).collect()
    }

    fn band(freq: f64, thr: f64, range: f64, mode: DynEqMode) -> DynEqBandConfig {
        DynEqBandConfig {
            enabled: true, filter_type: DynEqFilterType::Bell, freq_hz: freq, q: 2.0,
            threshold_db: thr, ratio: 4.0, attack_ms: 5.0, release_ms: 80.0, range_db: range, mode,
        }
    }

    fn one_band(b: DynEqBandConfig) -> DynamicEqConfig {
        let mut bands = [DynEqBandConfig::default(); MAX_DYNEQ_BANDS];
        bands[0] = b;
        DynamicEqConfig { bypass: false, bands }
    }

    fn rms(buf: &[f32]) -> f64 {
        (buf.iter().map(|&x| (x as f64) * (x as f64)).sum::<f64>() / buf.len() as f64).sqrt()
    }

    #[test]
    fn default_is_passthrough() {
        let mut d = DynamicEq::new(48_000.0, DynamicEqConfig::default());
        let inl = sine(1024, 1000.0, 48_000.0, 0.5);
        let mut l = inl.clone();
        let mut r = inl.clone();
        d.process_stereo(&mut l, &mut r);
        assert!(l.iter().zip(&inl).all(|(a, b)| (a - b).abs() < 1e-7));
    }

    #[test]
    fn disabled_band_is_passthrough() {
        let mut d = DynamicEq::new(48_000.0, one_band(DynEqBandConfig { enabled: false, ..band(1000.0, -30.0, 6.0, DynEqMode::DownCut) }));
        let inl = sine(1024, 1000.0, 48_000.0, 0.5);
        let mut l = inl.clone();
        let mut r = inl.clone();
        d.process_stereo(&mut l, &mut r);
        assert!(l.iter().zip(&inl).all(|(a, b)| (a - b).abs() < 1e-7));
    }

    #[test]
    fn downcut_attenuates_a_loud_in_band_tone() {
        // A loud 1 kHz tone well above threshold → the 1 kHz band cuts it.
        let mut d = DynamicEq::new(48_000.0, one_band(band(1000.0, -30.0, 12.0, DynEqMode::DownCut)));
        let inl = sine(8192, 1000.0, 48_000.0, 0.7);
        let mut l = inl.clone();
        let mut r = inl.clone();
        d.process_stereo(&mut l, &mut r);
        // Compare RMS of the settled tail.
        let in_rms = rms(&inl[4096..]);
        let out_rms = rms(&l[4096..]);
        assert!(out_rms < in_rms * 0.85, "no dynamic cut: in {in_rms} out {out_rms}");
        assert!(l.iter().all(|x| x.is_finite()));
    }

    #[test]
    fn downcut_spares_an_out_of_band_tone() {
        // The same 1 kHz band barely touches a 6 kHz tone.
        let mut d = DynamicEq::new(48_000.0, one_band(band(1000.0, -30.0, 12.0, DynEqMode::DownCut)));
        let inl = sine(8192, 6000.0, 48_000.0, 0.7);
        let mut l = inl.clone();
        let mut r = inl.clone();
        d.process_stereo(&mut l, &mut r);
        let in_rms = rms(&inl[4096..]);
        let out_rms = rms(&l[4096..]);
        assert!(out_rms > in_rms * 0.95, "out-of-band tone over-affected: in {in_rms} out {out_rms}");
    }

    #[test]
    fn upboost_lifts_a_quiet_in_band_tone() {
        // A quiet 1 kHz tone below threshold → UpBoost raises it.
        let mut d = DynamicEq::new(48_000.0, one_band(DynEqBandConfig { threshold_db: -10.0, ..band(1000.0, -10.0, 12.0, DynEqMode::UpBoost) }));
        let inl = sine(8192, 1000.0, 48_000.0, 0.05); // ~ -26 dBFS, below -10 thr
        let mut l = inl.clone();
        let mut r = inl.clone();
        d.process_stereo(&mut l, &mut r);
        let in_rms = rms(&inl[4096..]);
        let out_rms = rms(&l[4096..]);
        assert!(out_rms > in_rms * 1.1, "no dynamic boost: in {in_rms} out {out_rms}");
        assert!(l.iter().all(|x| x.is_finite()));
    }

    #[test]
    fn range_zero_is_passthrough() {
        let mut d = DynamicEq::new(48_000.0, one_band(band(1000.0, -40.0, 0.0, DynEqMode::DownCut)));
        let inl = sine(2048, 1000.0, 48_000.0, 0.6);
        let mut l = inl.clone();
        let mut r = inl.clone();
        d.process_stereo(&mut l, &mut r);
        assert!(l.iter().zip(&inl).all(|(a, b)| (a - b).abs() < 1e-7));
    }
}
