//! Multiband dynamics — the four-band compressor/expander on the mix bus.
//!
//! The signal is split by a Linkwitz-Riley 4-band crossover, each band gets
//! its own detector and gain computer, and the bands are summed back.  This
//! is the module that lets you glue the low end without squashing the
//! cymbals, or control a boxy low-mid without touching the vocal.
//!
//! Per band: threshold, ratio, attack, release, makeup gain, a wet/dry mix
//! for parallel compression, plus a solo/bypass for setting it up by ear.
//!
//! Each band can run in one of two directions:
//!
//!   * **Compress** — reduce level above the threshold (the usual case).
//!   * **Expand** — reduce level *below* the threshold.  Downward expansion
//!     is how you tighten a boomy low end or push down bleed between hits.
//!
//! Detection is stereo-linked per band so the image stays put.

use crate::crossover::{Crossover4, BANDS};
use super::config::{MultibandBandConfig, MultibandConfig, MultibandMode};
use super::StereoModule;

/// Detector knee, in dB.
const KNEE_DB: f64 = 6.0;

fn time_coeff(ms: f64, sr: f64) -> f64 {
    if ms <= 0.0 { return 0.0; }
    (-1.0 / (ms * 0.001 * sr)).exp()
}

/// Per-band detector state.
#[derive(Clone, Copy)]
struct BandState {
    env_db: f64,
    atk: f64,
    rel: f64,
    /// Peak gain reduction over the last block (dB, ≥ 0 when compressing).
    last_gr_db: f64,
}

/// Four-band dynamics processor.
pub struct Multiband {
    sr: f64,
    cfg: MultibandConfig,
    xo_l: Crossover4,
    xo_r: Crossover4,
    state: [BandState; BANDS],
}

impl Multiband {
    /// Construct from a sample rate + config.
    pub fn new(sample_rate: f64, cfg: MultibandConfig) -> Self {
        let freqs = cfg.crossover_hz;
        let mut me = Self {
            sr: sample_rate,
            cfg,
            xo_l: Crossover4::new(sample_rate, freqs),
            xo_r: Crossover4::new(sample_rate, freqs),
            state: [BandState { env_db: -120.0, atk: 0.0, rel: 0.0, last_gr_db: 0.0 }; BANDS],
        };
        me.rebuild();
        me
    }

    /// Update parameters (crossover state preserved — no clicks).
    pub fn set_config(&mut self, cfg: MultibandConfig) {
        self.cfg = cfg;
        self.xo_l.set_freqs(cfg.crossover_hz);
        self.xo_r.set_freqs(cfg.crossover_hz);
        self.rebuild();
    }

    /// Gain reduction per band on the last block (dB, ≥ 0).
    pub fn band_gain_reduction_db(&self) -> [f64; BANDS] {
        [self.state[0].last_gr_db, self.state[1].last_gr_db,
         self.state[2].last_gr_db, self.state[3].last_gr_db]
    }

    /// The crossover frequencies actually in use (after sanitising).
    pub fn crossover_hz(&self) -> [f64; BANDS - 1] { self.xo_l.freqs() }

    /// True when at least one band would change the signal.  When nothing
    /// would, the crossover is skipped outright: splitting and re-summing is
    /// magnitude-flat but not bit-exact, and a module set to neutral must
    /// not colour the signal (or cost the CPU) at all.
    fn is_active(&self) -> bool {
        if self.cfg.bypass {
            return false;
        }
        self.cfg.bands.iter().any(|b| {
            b.solo
                || b.mute
                || b.makeup_db != 0.0
                || (!b.bypass && b.ratio > 1.0 && b.range_db > 0.0 && b.mix_pct > 0.0)
        })
    }

    fn rebuild(&mut self) {
        for i in 0..BANDS {
            self.state[i].atk = time_coeff(self.cfg.bands[i].attack_ms, self.sr);
            self.state[i].rel = time_coeff(self.cfg.bands[i].release_ms, self.sr);
        }
    }

    /// Gain (dB, signed) the band's computer asks for at this level.
    fn computed_gain_db(b: &MultibandBandConfig, in_db: f64) -> f64 {
        let ratio = b.ratio.max(1.0);
        let slope = 1.0 - 1.0 / ratio;
        match b.mode {
            MultibandMode::Compress => {
                let over = in_db - b.threshold_db;
                if over <= -KNEE_DB / 2.0 {
                    0.0
                } else if over >= KNEE_DB / 2.0 {
                    -over * slope
                } else {
                    let x = over + KNEE_DB / 2.0;
                    -slope * x * x / (2.0 * KNEE_DB)
                }
            }
            MultibandMode::Expand => {
                let under = b.threshold_db - in_db;
                if under <= -KNEE_DB / 2.0 {
                    0.0
                } else if under >= KNEE_DB / 2.0 {
                    -under * slope
                } else {
                    let x = under + KNEE_DB / 2.0;
                    -slope * x * x / (2.0 * KNEE_DB)
                }
            }
        }
        // Never let a band move by more than its declared range.
        .clamp(-b.range_db.clamp(0.0, 40.0), 0.0)
    }
}

impl StereoModule for Multiband {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        if !self.is_active() {
            for s in self.state.iter_mut() { s.last_gr_db = 0.0; }
            return;
        }
        let n = left.len().min(right.len());
        let any_solo = self.cfg.bands.iter().any(|b| b.solo);
        let mut peak_gr = [0.0f64; BANDS];

        for i in 0..n {
            let bl = self.xo_l.split(left[i] as f64);
            let br = self.xo_r.split(right[i] as f64);
            let mut sum_l = 0.0;
            let mut sum_r = 0.0;

            for k in 0..BANDS {
                let cfg = self.cfg.bands[k];
                let mut l = bl[k];
                let mut r = br[k];

                if (any_solo && !cfg.solo) || cfg.mute {
                    continue;
                }

                if !cfg.bypass {
                    // Stereo-linked detector — the louder channel drives both.
                    let peak = l.abs().max(r.abs()).max(1e-9);
                    let in_db = 20.0 * peak.log10();
                    let st = &mut self.state[k];
                    let coeff = if in_db > st.env_db { st.atk } else { st.rel };
                    st.env_db = in_db + coeff * (st.env_db - in_db);

                    let gain_db = Self::computed_gain_db(&cfg, st.env_db);
                    let gr = -gain_db;
                    if gr > peak_gr[k] { peak_gr[k] = gr; }

                    let mix = (cfg.mix_pct / 100.0).clamp(0.0, 1.0);
                    let g = 10f64.powf(gain_db / 20.0);
                    let wet = 1.0 - mix + mix * g;
                    l *= wet;
                    r *= wet;
                }

                let makeup = 10f64.powf(cfg.makeup_db.clamp(-24.0, 24.0) / 20.0);
                sum_l += l * makeup;
                sum_r += r * makeup;
            }

            left[i] = sum_l as f32;
            right[i] = sum_r as f32;
        }

        for k in 0..BANDS {
            self.state[k].last_gr_db = peak_gr[k];
        }
    }

    fn reset(&mut self) {
        self.xo_l.reset();
        self.xo_r.reset();
        for s in self.state.iter_mut() {
            s.env_db = -120.0;
            s.last_gr_db = 0.0;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flat_band() -> MultibandBandConfig {
        MultibandBandConfig {
            mode: MultibandMode::Compress, threshold_db: 0.0, ratio: 1.0,
            attack_ms: 10.0, release_ms: 120.0, makeup_db: 0.0, range_db: 24.0,
            mix_pct: 100.0, solo: false, mute: false, bypass: false,
        }
    }

    fn cfg() -> MultibandConfig {
        MultibandConfig {
            crossover_hz: [120.0, 800.0, 5_000.0],
            bands: [flat_band(); BANDS],
            bypass: false,
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
        let mut m = Multiband::new(48_000.0, MultibandConfig { bypass: true, ..cfg() });
        let mut l = tone(512, 440.0, 48_000.0, 0.5);
        let orig = l.clone();
        let mut r = l.clone();
        m.process_stereo(&mut l, &mut r);
        assert_eq!(l, orig);
    }

    /// Ratio 1 in every band = crossover split and sum only, which is flat.
    #[test]
    fn unity_settings_are_transparent() {
        let mut m = Multiband::new(48_000.0, cfg());
        let n = 16_384;
        for &f in &[80.0, 500.0, 2_000.0, 9_000.0] {
            m.reset();
            let input = tone(n, f, 48_000.0, 0.5);
            let mut l = input.clone();
            let mut r = input.clone();
            m.process_stereo(&mut l, &mut r);
            let delta = 20.0 * (rms(&l[n / 2..]) / rms(&input[n / 2..])).log10();
            assert!(delta.abs() < 0.6, "{f} Hz drifted {delta:.2} dB");
        }
    }

    #[test]
    fn compresses_only_the_loud_band() {
        let mut c = cfg();
        // Squash the low band hard, leave the rest alone.
        c.bands[0] = MultibandBandConfig { threshold_db: -30.0, ratio: 8.0, ..flat_band() };
        let mut m = Multiband::new(48_000.0, c);
        let n = 24_000;

        let mut l = tone(n, 60.0, 48_000.0, 0.7);
        let mut r = l.clone();
        let before = rms(&l[n / 2..]);
        m.process_stereo(&mut l, &mut r);
        let low_delta = 20.0 * (rms(&l[n / 2..]) / before).log10();
        assert!(low_delta < -6.0, "low band should compress, got {low_delta:.1} dB");
        assert!(m.band_gain_reduction_db()[0] > 6.0);

        m.reset();
        let mut l = tone(n, 9_000.0, 48_000.0, 0.7);
        let mut r = l.clone();
        let before = rms(&l[n / 2..]);
        m.process_stereo(&mut l, &mut r);
        let high_delta = 20.0 * (rms(&l[n / 2..]) / before).log10();
        assert!(high_delta.abs() < 1.0, "high band should be untouched, got {high_delta:.1} dB");
    }

    #[test]
    fn expander_pushes_quiet_band_down() {
        let mut c = cfg();
        c.bands[0] = MultibandBandConfig {
            mode: MultibandMode::Expand, threshold_db: -20.0, ratio: 4.0,
            attack_ms: 5.0, release_ms: 60.0, ..flat_band()
        };
        let mut m = Multiband::new(48_000.0, c);
        let n = 24_000;
        let mut l = tone(n, 60.0, 48_000.0, 0.01); // ≈ -40 dB, below threshold
        let mut r = l.clone();
        let before = rms(&l[n / 2..]);
        m.process_stereo(&mut l, &mut r);
        let delta = 20.0 * (rms(&l[n / 2..]) / before).log10();
        assert!(delta < -6.0, "quiet band should expand down, got {delta:.1} dB");
    }

    #[test]
    fn solo_isolates_one_band() {
        let mut c = cfg();
        c.bands[3].solo = true;
        let mut m = Multiband::new(48_000.0, c);
        let n = 16_384;
        let mut l = tone(n, 60.0, 48_000.0, 0.6); // low band content
        let mut r = l.clone();
        m.process_stereo(&mut l, &mut r);
        assert!(rms(&l[n / 2..]) < 0.02, "soloing the high band should mute a 60 Hz tone");
    }

    #[test]
    fn makeup_gain_applies() {
        let mut c = cfg();
        for b in c.bands.iter_mut() { b.makeup_db = 6.0; }
        let mut m = Multiband::new(48_000.0, c);
        let n = 16_384;
        let input = tone(n, 500.0, 48_000.0, 0.2);
        let mut l = input.clone();
        let mut r = input.clone();
        m.process_stereo(&mut l, &mut r);
        let delta = 20.0 * (rms(&l[n / 2..]) / rms(&input[n / 2..])).log10();
        assert!((delta - 6.0).abs() < 0.7, "expected ≈ +6 dB, got {delta:.2}");
    }

    #[test]
    fn output_stays_finite() {
        let mut c = cfg();
        c.bands[1] = MultibandBandConfig { threshold_db: -60.0, ratio: 20.0, ..flat_band() };
        let mut m = Multiband::new(48_000.0, c);
        let mut l = vec![0.0f32; 8192];
        for (i, s) in l.iter_mut().enumerate() { *s = if i % 5 == 0 { 2.5 } else { -2.5 }; }
        let mut r = l.clone();
        m.process_stereo(&mut l, &mut r);
        assert!(l.iter().all(|s| s.is_finite()));
    }
}
