//! 4-band multiband compressor — realtime-safe.
//!
//! Splits the signal into four bands with a *subtractive* crossover tree
//! built from three cascaded Linkwitz-Riley-4 lowpass filters (per channel),
//! compresses each band independently (stereo-linked detector, soft knee,
//! per-band makeup), then sums the bands back.
//!
//! Why subtractive?  With lowpass outputs lp1 ≤ lp2 ≤ lp3 the bands are
//!
//!   low      = lp1
//!   low-mid  = lp2 - lp1
//!   high-mid = lp3 - lp2
//!   high     = x   - lp3
//!
//! whose sum telescopes back to `x` EXACTLY.  So with every band at ratio
//! 1.0 / 0 dB makeup the output equals the input bit-for-bit — the default
//! (and `bypass`) is a perfect no-op, which keeps preview ≙ export parity.
//!
//! Realtime-safe: per-sample processing, all state pre-allocated in the
//! constructor, no allocation / locks / I/O in `process_stereo`.

use super::config::{db_to_lin, MultibandBandConfig, MultibandConfig};
use super::crossover::{ordered_xovers3, Lr4Lowpass};
use super::StereoModule;

const KNEE_DB: f64 = 6.0;
const N_BANDS: usize = 4;
const N_XOVER: usize = 3;

fn time_coeff(ms: f64, sr: f64) -> f64 {
    if ms <= 0.0 {
        return 0.0;
    }
    (-1.0 / (ms * 0.001 * sr)).exp()
}

/// Clamp + order the three crossover frequencies (delegates to the shared
/// crossover helper).  Returns `[lo, mid, hi]`.
fn ordered_xovers(cfg: &MultibandConfig, sr: f64) -> [f64; N_XOVER] {
    ordered_xovers3(cfg.xover_lo_hz, cfg.xover_mid_hz, cfg.xover_hi_hz, sr)
}

/// Per-band envelope follower + cached time coefficients.
#[derive(Clone, Copy)]
struct BandEnv {
    env_db: f64,
    atk: f64,
    rel: f64,
}

impl BandEnv {
    fn new(sr: f64, cfg: &MultibandBandConfig) -> Self {
        Self {
            env_db: -120.0,
            atk: time_coeff(cfg.attack_ms, sr),
            rel: time_coeff(cfg.release_ms, sr),
        }
    }
}

/// Soft-knee gain computer: returns the gain (dB, ≤ 0) to apply for an input
/// level `in_db` against a band's threshold/ratio.  Makeup is NOT included.
fn computed_gain_db(in_db: f64, cfg: &MultibandBandConfig) -> f64 {
    let t = cfg.threshold_db;
    let r = cfg.ratio.max(1.0);
    let over = in_db - t;
    if over <= -KNEE_DB / 2.0 {
        0.0
    } else if over >= KNEE_DB / 2.0 {
        (t + over / r) - in_db
    } else {
        let x = over + KNEE_DB / 2.0;
        (1.0 / r - 1.0) * x * x / (2.0 * KNEE_DB)
    }
}

/// 4-band multiband compressor.
pub struct Multiband {
    sr: f64,
    cfg: MultibandConfig,
    lp_l: [Lr4Lowpass; N_XOVER],
    lp_r: [Lr4Lowpass; N_XOVER],
    bands: [BandEnv; N_BANDS],
    last_gr_db: f64,
}

impl Multiband {
    pub fn new(sample_rate: f64, cfg: MultibandConfig) -> Self {
        let xo = ordered_xovers(&cfg, sample_rate);
        Self {
            sr: sample_rate,
            cfg,
            lp_l: [
                Lr4Lowpass::new(sample_rate, xo[0]),
                Lr4Lowpass::new(sample_rate, xo[1]),
                Lr4Lowpass::new(sample_rate, xo[2]),
            ],
            lp_r: [
                Lr4Lowpass::new(sample_rate, xo[0]),
                Lr4Lowpass::new(sample_rate, xo[1]),
                Lr4Lowpass::new(sample_rate, xo[2]),
            ],
            bands: [
                BandEnv::new(sample_rate, &cfg.bands[0]),
                BandEnv::new(sample_rate, &cfg.bands[1]),
                BandEnv::new(sample_rate, &cfg.bands[2]),
                BandEnv::new(sample_rate, &cfg.bands[3]),
            ],
            last_gr_db: 0.0,
        }
    }

    /// Largest per-band gain reduction (dB, ≥ 0) over the last block.
    /// Reserved for the GR meter — not yet surfaced through the chain's
    /// `GainReduction` (which would change the metering contract); wired in a
    /// follow-up when the multiband UI lands.
    #[allow(dead_code)]
    pub fn gain_reduction_db(&self) -> f64 {
        self.last_gr_db
    }

    pub fn set_config(&mut self, cfg: MultibandConfig) {
        let xo = ordered_xovers(&cfg, self.sr);
        for i in 0..N_XOVER {
            self.lp_l[i].set(self.sr, xo[i]);
            self.lp_r[i].set(self.sr, xo[i]);
        }
        for b in 0..N_BANDS {
            self.bands[b].atk = time_coeff(cfg.bands[b].attack_ms, self.sr);
            self.bands[b].rel = time_coeff(cfg.bands[b].release_ms, self.sr);
        }
        self.cfg = cfg;
    }

    /// True when no band would alter the signal (every band unity + 0 makeup).
    fn is_unity(&self) -> bool {
        self.cfg.bands.iter().all(|b| b.ratio <= 1.0 && b.makeup_db == 0.0)
    }
}

impl StereoModule for Multiband {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        if self.cfg.bypass || self.is_unity() {
            self.last_gr_db = 0.0;
            return;
        }
        let n = left.len().min(right.len());
        let mut block_gr = 0.0f64;

        for i in 0..n {
            let xl = left[i] as f64;
            let xr = right[i] as f64;

            // Per-channel lowpass ladder (lp1 ≤ lp2 ≤ lp3 in cutoff).
            let l1 = self.lp_l[0].process(xl);
            let l2 = self.lp_l[1].process(xl);
            let l3 = self.lp_l[2].process(xl);
            let r1 = self.lp_r[0].process(xr);
            let r2 = self.lp_r[1].process(xr);
            let r3 = self.lp_r[2].process(xr);

            // Subtractive bands — sum telescopes back to x exactly.
            let bl = [l1, l2 - l1, l3 - l2, xl - l3];
            let br = [r1, r2 - r1, r3 - r2, xr - r3];

            let mut sum_l = 0.0f64;
            let mut sum_r = 0.0f64;

            for b in 0..N_BANDS {
                let bc = &self.cfg.bands[b];
                if bc.ratio <= 1.0 && bc.makeup_db == 0.0 {
                    // Unity band — pass through untouched (keeps reconstruction exact).
                    sum_l += bl[b];
                    sum_r += br[b];
                    continue;
                }
                // Stereo-linked detector on the band signal.
                let peak = bl[b].abs().max(br[b].abs()).max(1e-9);
                let in_db = 20.0 * peak.log10();
                let env = &mut self.bands[b];
                let coeff = if in_db > env.env_db { env.atk } else { env.rel };
                env.env_db = in_db + coeff * (env.env_db - in_db);
                let reduction = computed_gain_db(env.env_db, bc); // ≤ 0
                if -reduction > block_gr {
                    block_gr = -reduction;
                }
                let g = db_to_lin(reduction + bc.makeup_db);
                sum_l += bl[b] * g;
                sum_r += br[b] * g;
            }

            // Finite guard — fall back to dry sample if anything went non-finite.
            left[i] = if sum_l.is_finite() { sum_l as f32 } else { xl as f32 };
            right[i] = if sum_r.is_finite() { sum_r as f32 } else { xr as f32 };
        }

        self.last_gr_db = block_gr.max(0.0);
    }

    fn reset(&mut self) {
        for i in 0..N_XOVER {
            self.lp_l[i].reset();
            self.lp_r[i].reset();
        }
        for b in 0..N_BANDS {
            self.bands[b].env_db = -120.0;
        }
        self.last_gr_db = 0.0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(n: usize, freq: f64, sr: f64, amp: f32) -> Vec<f32> {
        (0..n)
            .map(|i| (2.0 * std::f64::consts::PI * freq * i as f64 / sr).sin() as f32 * amp)
            .collect()
    }

    fn active_band() -> MultibandBandConfig {
        MultibandBandConfig { threshold_db: -30.0, ratio: 4.0, attack_ms: 2.0, release_ms: 80.0, makeup_db: 0.0 }
    }

    #[test]
    fn unity_bands_are_bit_exact_passthrough() {
        // bypass=false but every band unity → subtractive sum reconstructs x.
        let cfg = MultibandConfig { bypass: false, ..MultibandConfig::default() };
        let mut mb = Multiband::new(48_000.0, cfg);
        let inl = sine(2048, 220.0, 48_000.0, 0.4);
        let mut l = inl.clone();
        let mut r = inl.clone();
        mb.process_stereo(&mut l, &mut r);
        // is_unity() short-circuits → identical.
        assert!(l.iter().zip(&inl).all(|(a, b)| (a - b).abs() < 1e-7));
    }

    #[test]
    fn forced_reconstruction_is_near_exact() {
        // Force the per-sample band path (one band non-unity but ratio 1.0
        // via makeup 0 won't trigger; instead set a band to ratio 1.0 with a
        // tiny makeup of 0 is unity).  Use a band with ratio>1 but threshold
        // so high it never compresses → reduction ≈ 0 ⇒ sum ≈ x.
        let mut bands = [MultibandBandConfig::default(); 4];
        bands[2] = MultibandBandConfig { threshold_db: 24.0, ratio: 4.0, makeup_db: 0.0, ..MultibandBandConfig::default() };
        let cfg = MultibandConfig { bypass: false, bands, ..MultibandConfig::default() };
        let mut mb = Multiband::new(48_000.0, cfg);
        let inl = sine(4096, 500.0, 48_000.0, 0.3);
        let mut l = inl.clone();
        let mut r = inl.clone();
        mb.process_stereo(&mut l, &mut r);
        // No band compresses (level ≪ +24 dB threshold) → reconstruction holds.
        let max_err = l.iter().zip(&inl).map(|(a, b)| (a - b).abs()).fold(0.0f32, f32::max);
        assert!(max_err < 1e-3, "reconstruction error too large: {max_err}");
        assert!(l.iter().all(|x| x.is_finite()));
    }

    #[test]
    fn bypass_is_passthrough() {
        let cfg = MultibandConfig { bypass: true, bands: [active_band(); 4], ..MultibandConfig::default() };
        let mut mb = Multiband::new(48_000.0, cfg);
        let inl = sine(512, 100.0, 48_000.0, 0.9);
        let mut l = inl.clone();
        let mut r = inl.clone();
        mb.process_stereo(&mut l, &mut r);
        assert!(l.iter().zip(&inl).all(|(a, b)| (a - b).abs() < 1e-7));
    }

    #[test]
    fn low_band_active_reports_gain_reduction() {
        // Low band active, others unity.  A loud 60 Hz tone drives band 0 well
        // over threshold → the band's detector must report gain reduction.
        // (Subtractive crossovers don't isolate a near-crossover tone cleanly,
        // so the SUMMED peak isn't a reliable assertion here — see the
        // all-bands test for peak reduction.)
        let mut bands = [MultibandBandConfig::default(); 4];
        bands[0] = active_band();
        let cfg = MultibandConfig { bypass: false, bands, ..MultibandConfig::default() };
        let mut mb = Multiband::new(48_000.0, cfg);
        let mut l = sine(8192, 60.0, 48_000.0, 0.9);
        let mut r = l.clone();
        mb.process_stereo(&mut l, &mut r);
        assert!(mb.gain_reduction_db() > 1.0, "expected low-band GR, got {}", mb.gain_reduction_db());
        assert!(l.iter().all(|x| x.is_finite()));
    }

    #[test]
    fn all_bands_active_reduces_a_loud_signal() {
        // Every band aggressively compressing → behaves like a broadband
        // compressor; a loud signal's peak must drop after the envelope settles.
        let cfg = MultibandConfig { bypass: false, bands: [active_band(); 4], ..MultibandConfig::default() };
        let mut mb = Multiband::new(48_000.0, cfg);
        // Two tones in different bands so energy spans the spectrum.
        let lo = sine(8192, 80.0, 48_000.0, 0.45);
        let hi = sine(8192, 4000.0, 48_000.0, 0.45);
        let mut l: Vec<f32> = lo.iter().zip(&hi).map(|(a, b)| a + b).collect();
        let mut r = l.clone();
        let in_peak = l.iter().cloned().fold(0.0f32, |m, x| m.max(x.abs()));
        mb.process_stereo(&mut l, &mut r);
        let out_peak = l.iter().skip(4096).cloned().fold(0.0f32, |m, x| m.max(x.abs()));
        assert!(out_peak < in_peak, "expected multiband GR: in {in_peak} out {out_peak}");
        assert!(mb.gain_reduction_db() > 0.0);
        assert!(l.iter().all(|x| x.is_finite()));
    }

    #[test]
    fn low_band_compression_mostly_spares_a_high_tone() {
        // Same low-band compressor, but the signal is an 8 kHz tone (band 3).
        let mut bands = [MultibandBandConfig::default(); 4];
        bands[0] = active_band();
        let cfg = MultibandConfig { bypass: false, bands, ..MultibandConfig::default() };
        let mut mb = Multiband::new(48_000.0, cfg);
        let mut l = sine(8192, 8000.0, 48_000.0, 0.9);
        let mut r = l.clone();
        let in_peak = l.iter().cloned().fold(0.0f32, |m, x| m.max(x.abs()));
        mb.process_stereo(&mut l, &mut r);
        let out_peak = l.iter().skip(4096).cloned().fold(0.0f32, |m, x| m.max(x.abs()));
        // The high tone is in band 3 (unbypassed only via band 0), so it
        // should be largely untouched (within ~1 dB).
        assert!(out_peak > in_peak * 0.85, "high tone over-affected: in {in_peak} out {out_peak}");
    }

    #[test]
    fn crossovers_are_ordered_even_if_misconfigured() {
        let cfg = MultibandConfig { xover_lo_hz: 5000.0, xover_mid_hz: 200.0, xover_hi_hz: 100.0, ..MultibandConfig::default() };
        let xo = ordered_xovers(&cfg, 48_000.0);
        assert!(xo[0] < xo[1] && xo[1] < xo[2], "not ascending: {xo:?}");
        assert!(xo[2] < 24_000.0);
    }
}
