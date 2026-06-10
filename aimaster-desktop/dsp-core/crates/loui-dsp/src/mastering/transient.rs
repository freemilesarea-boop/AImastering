//! Transient / impact shaper — multiband attack/sustain, realtime-safe.
//!
//! Differential-envelope transient designer.  Two envelope followers track the
//! stereo-linked level: a FAST one (short attack) that catches onsets and a
//! SLOW one (long attack) that lags them.  Their dB difference is positive
//! during an attack transient and negative during the sustain/decay, so:
//!
//!   gain_db = (attack% / 100) · relu(fast − slow)
//!           + (sustain%/ 100) · relu(slow − fast)      (clamped ±12 dB)
//!
//! attack% > 0 emphasises punch, < 0 softens it; sustain% > 0 lengthens the
//! body, < 0 tightens it.  With both at 0 (or `bypass`) the stage is a clean
//! passthrough.  An optional 4-band mode shapes each band independently via
//! the shared subtractive crossover (unity bands reconstruct the input).
//!
//! Realtime-safe: per-sample, all state pre-allocated, no allocation.

use super::config::{TransientBandConfig, TransientConfig};
use super::crossover::{ordered_xovers3, subtractive_bands, Lr4Lowpass};
use super::StereoModule;

const N_BANDS: usize = 4;
const N_XOVER: usize = 3;
const MAX_GAIN_DB: f64 = 12.0;
/// Below this level the detector is idle (avoids noise-floor chatter).
const GATE_DB: f64 = -60.0;

const FAST_ATTACK_MS: f64 = 0.5;
const SLOW_ATTACK_MS: f64 = 20.0;
const RELEASE_MS: f64 = 80.0;

fn time_coeff(ms: f64, sr: f64) -> f64 {
    if ms <= 0.0 {
        return 0.0;
    }
    (-1.0 / (ms * 0.001 * sr)).exp()
}

#[inline]
fn follow(env_db: f64, in_db: f64, atk: f64, rel: f64) -> f64 {
    let coeff = if in_db > env_db { atk } else { rel };
    in_db + coeff * (env_db - in_db)
}

/// Per-band differential envelope state.
#[derive(Clone, Copy)]
struct BandEnv {
    fast_db: f64,
    slow_db: f64,
}
impl BandEnv {
    fn new() -> Self {
        Self { fast_db: -120.0, slow_db: -120.0 }
    }
}

pub struct Transient {
    sr: f64,
    cfg: TransientConfig,
    atk_fast: f64,
    atk_slow: f64,
    rel: f64,
    lp_l: [Lr4Lowpass; N_XOVER],
    lp_r: [Lr4Lowpass; N_XOVER],
    /// Envelopes: index 0 = single-band (broadband), 0..4 used in multiband.
    envs: [BandEnv; N_BANDS],
    /// Broadband envelope (single-band mode).
    wide: BandEnv,
}

impl Transient {
    pub fn new(sample_rate: f64, cfg: TransientConfig) -> Self {
        let xo = ordered_xovers3(cfg.xover_lo_hz, cfg.xover_mid_hz, cfg.xover_hi_hz, sample_rate);
        Self {
            sr: sample_rate,
            cfg,
            atk_fast: time_coeff(FAST_ATTACK_MS, sample_rate),
            atk_slow: time_coeff(SLOW_ATTACK_MS, sample_rate),
            rel: time_coeff(RELEASE_MS, sample_rate),
            lp_l: [Lr4Lowpass::new(sample_rate, xo[0]), Lr4Lowpass::new(sample_rate, xo[1]), Lr4Lowpass::new(sample_rate, xo[2])],
            lp_r: [Lr4Lowpass::new(sample_rate, xo[0]), Lr4Lowpass::new(sample_rate, xo[1]), Lr4Lowpass::new(sample_rate, xo[2])],
            envs: [BandEnv::new(); N_BANDS],
            wide: BandEnv::new(),
        }
    }

    pub fn set_config(&mut self, cfg: TransientConfig) {
        let xo = ordered_xovers3(cfg.xover_lo_hz, cfg.xover_mid_hz, cfg.xover_hi_hz, self.sr);
        for i in 0..N_XOVER {
            self.lp_l[i].set(self.sr, xo[i]);
            self.lp_r[i].set(self.sr, xo[i]);
        }
        self.cfg = cfg;
    }

    fn is_unity(&self) -> bool {
        if self.cfg.bypass {
            return true;
        }
        if self.cfg.multiband_enabled {
            self.cfg.bands.iter().all(|b| b.attack_pct == 0.0 && b.sustain_pct == 0.0)
        } else {
            self.cfg.attack_pct == 0.0 && self.cfg.sustain_pct == 0.0
        }
    }

    /// Differential-envelope gain for a band, given the stereo-linked peak.
    #[inline]
    fn band_gain(env: &mut BandEnv, peak: f64, bc: &TransientBandConfig, atk_fast: f64, atk_slow: f64, rel: f64) -> f64 {
        let in_db = 20.0 * peak.max(1e-9).log10();
        env.fast_db = follow(env.fast_db, in_db, atk_fast, rel);
        env.slow_db = follow(env.slow_db, in_db, atk_slow, rel);
        if env.fast_db < GATE_DB {
            return 1.0;
        }
        let t = env.fast_db - env.slow_db;
        let gain_db = (bc.attack_pct / 100.0) * t.max(0.0) + (bc.sustain_pct / 100.0) * (-t).max(0.0);
        10f64.powf(gain_db.clamp(-MAX_GAIN_DB, MAX_GAIN_DB) / 20.0)
    }
}

impl StereoModule for Transient {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        if self.is_unity() {
            return;
        }
        let n = left.len().min(right.len());
        let (af, as_, rl) = (self.atk_fast, self.atk_slow, self.rel);

        if self.cfg.multiband_enabled {
            for i in 0..n {
                let xl = left[i] as f64;
                let xr = right[i] as f64;
                let bl = subtractive_bands(&mut self.lp_l, xl);
                let br = subtractive_bands(&mut self.lp_r, xr);
                let mut sum_l = 0.0;
                let mut sum_r = 0.0;
                for b in 0..N_BANDS {
                    let bc = &self.cfg.bands[b];
                    if bc.attack_pct == 0.0 && bc.sustain_pct == 0.0 {
                        sum_l += bl[b];
                        sum_r += br[b];
                        continue;
                    }
                    let peak = bl[b].abs().max(br[b].abs());
                    let g = Self::band_gain(&mut self.envs[b], peak, bc, af, as_, rl);
                    sum_l += bl[b] * g;
                    sum_r += br[b] * g;
                }
                left[i] = if sum_l.is_finite() { sum_l as f32 } else { xl as f32 };
                right[i] = if sum_r.is_finite() { sum_r as f32 } else { xr as f32 };
            }
        } else {
            let bc = TransientBandConfig { attack_pct: self.cfg.attack_pct, sustain_pct: self.cfg.sustain_pct };
            for i in 0..n {
                let xl = left[i] as f64;
                let xr = right[i] as f64;
                let peak = xl.abs().max(xr.abs());
                let g = Self::band_gain(&mut self.wide, peak, &bc, af, as_, rl);
                let ol = xl * g;
                let or = xr * g;
                left[i] = if ol.is_finite() { ol as f32 } else { xl as f32 };
                right[i] = if or.is_finite() { or as f32 } else { xr as f32 };
            }
        }
    }

    fn reset(&mut self) {
        for i in 0..N_XOVER {
            self.lp_l[i].reset();
            self.lp_r[i].reset();
        }
        self.envs = [BandEnv::new(); N_BANDS];
        self.wide = BandEnv::new();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Silence then a sustained tone — a hard onset transient at `onset`.
    fn burst(n: usize, onset: usize, freq: f64, sr: f64, amp: f32) -> Vec<f32> {
        (0..n).map(|i| if i < onset { 0.0 } else { (2.0 * std::f64::consts::PI * freq * (i - onset) as f64 / sr).sin() as f32 * amp }).collect()
    }

    fn cfg(attack: f64, sustain: f64) -> TransientConfig {
        TransientConfig { bypass: false, attack_pct: attack, sustain_pct: sustain, ..TransientConfig::default() }
    }

    /// Peak over a window AFTER the detector gate has opened (skip the first
    /// ~1 ms of onset, which passes through ungated while the fast envelope
    /// climbs above the noise gate).
    fn attack_peak(buf: &[f32], onset: usize) -> f32 {
        let start = onset + 48;
        let end = (onset + 460).min(buf.len());
        buf[start..end].iter().cloned().fold(0.0f32, |m, x| m.max(x.abs()))
    }

    #[test]
    fn default_is_passthrough() {
        let mut t = Transient::new(48_000.0, TransientConfig::default());
        let inl = burst(2048, 256, 1000.0, 48_000.0, 0.5);
        let mut l = inl.clone();
        let mut r = inl.clone();
        t.process_stereo(&mut l, &mut r);
        assert!(l.iter().zip(&inl).all(|(a, b)| (a - b).abs() < 1e-7));
    }

    #[test]
    fn zero_amounts_is_passthrough() {
        let mut t = Transient::new(48_000.0, cfg(0.0, 0.0));
        let inl = burst(2048, 256, 1000.0, 48_000.0, 0.5);
        let mut l = inl.clone();
        let mut r = inl.clone();
        t.process_stereo(&mut l, &mut r);
        assert!(l.iter().zip(&inl).all(|(a, b)| (a - b).abs() < 1e-7));
    }

    #[test]
    fn attack_boost_raises_onset_peak() {
        let inl = burst(4096, 512, 1000.0, 48_000.0, 0.5);
        let in_peak = attack_peak(&inl, 512);
        let mut l = inl.clone();
        let mut r = inl.clone();
        let mut t = Transient::new(48_000.0, cfg(100.0, 0.0));
        t.process_stereo(&mut l, &mut r);
        let out_peak = attack_peak(&l, 512);
        assert!(out_peak > in_peak * 1.05, "attack not boosted: in {in_peak} out {out_peak}");
        assert!(l.iter().all(|x| x.is_finite()));
    }

    #[test]
    fn attack_cut_lowers_onset_peak() {
        let inl = burst(4096, 512, 1000.0, 48_000.0, 0.5);
        let in_peak = attack_peak(&inl, 512);
        let mut l = inl.clone();
        let mut r = inl.clone();
        let mut t = Transient::new(48_000.0, cfg(-100.0, 0.0));
        t.process_stereo(&mut l, &mut r);
        let out_peak = attack_peak(&l, 512);
        assert!(out_peak < in_peak, "attack not softened: in {in_peak} out {out_peak}");
    }

    #[test]
    fn multiband_unity_is_passthrough() {
        let c = TransientConfig { bypass: false, multiband_enabled: true, bands: [TransientBandConfig { attack_pct: 0.0, sustain_pct: 0.0 }; 4], ..TransientConfig::default() };
        let mut t = Transient::new(48_000.0, c);
        let inl = burst(2048, 256, 300.0, 48_000.0, 0.5);
        let mut l = inl.clone();
        let mut r = inl.clone();
        t.process_stereo(&mut l, &mut r);
        assert!(l.iter().zip(&inl).all(|(a, b)| (a - b).abs() < 1e-6));
    }

    #[test]
    fn multiband_low_band_attack_stays_finite() {
        let mut bands = [TransientBandConfig { attack_pct: 0.0, sustain_pct: 0.0 }; 4];
        bands[0] = TransientBandConfig { attack_pct: 100.0, sustain_pct: 0.0 };
        let c = TransientConfig { bypass: false, multiband_enabled: true, bands, ..TransientConfig::default() };
        let mut t = Transient::new(48_000.0, c);
        let inl = burst(4096, 512, 60.0, 48_000.0, 0.6);
        let mut l = inl.clone();
        let mut r = inl.clone();
        t.process_stereo(&mut l, &mut r);
        let changed = l.iter().zip(&inl).any(|(a, b)| (a - b).abs() > 1e-3);
        assert!(changed, "low-band transient had no effect");
        assert!(l.iter().all(|x| x.is_finite()));
    }
}
