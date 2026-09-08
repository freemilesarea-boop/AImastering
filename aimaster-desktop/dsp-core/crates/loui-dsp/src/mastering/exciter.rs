//! Multiband harmonic exciter — adds harmonics, not just level.
//!
//! Four bands, each driven into its own saturator and blended back against
//! the dry band.  Because the harmonics are generated *inside* a band, the
//! low end can be given weight without smearing the top, and air can be
//! added without making the bass fuzzy.
//!
//! Five characters, chosen for what they actually do to the harmonic series
//! rather than for period flavour:
//!
//! | Mode | Non-linearity | Harmonics | Use |
//! |---|---|---|---|
//! | `Warm` | soft cubic | odd, gentle | thickening without brightness |
//! | `Retro` | asymmetric | 2nd-dominant | vintage colour, fattens lows |
//! | `Tape` | hyperbolic tangent | odd, compressed | glue, rounds transients |
//! | `Tube` | asymmetric quadratic | strong 2nd | presence, "expensive" sheen |
//! | `Triode` | hard-ish asymmetric | 2nd + 3rd | aggressive, for air bands |
//!
//! Post-saturation each band is level-matched to its dry input, so turning
//! `amount` up changes the *character* rather than smuggling in a volume
//! boost — the classic reason exciters sound better than they are.

use crate::crossover::{Crossover4, BANDS};
use super::config::{ExciterConfig, ExciterMode};
use super::StereoModule;

/// Level-matching detector time constant, in seconds.
const MATCH_TAU_S: f64 = 0.05;

/// Apply the mode's non-linearity to a drive-scaled sample.
#[inline]
fn saturate(mode: ExciterMode, x: f64) -> f64 {
    match mode {
        // Soft cubic — the classic gentle odd-harmonic curve.
        ExciterMode::Warm => {
            let c = x.clamp(-1.5, 1.5);
            c - c * c * c / 6.0
        }
        // Asymmetric: positive half compresses harder → strong 2nd harmonic.
        ExciterMode::Retro => {
            if x >= 0.0 { x / (1.0 + x.abs()) } else { 0.8 * x / (1.0 + 0.5 * x.abs()) }
        }
        // Tape: tanh, odd harmonics, naturally compressive.
        ExciterMode::Tape => x.tanh(),
        // Tube: quadratic asymmetry on top of a soft clip.
        ExciterMode::Tube => {
            let s = x.tanh();
            s + 0.18 * (s * s - 0.5 * s.abs())
        }
        // Triode: harder knee, both 2nd and 3rd.
        ExciterMode::Triode => {
            let s = (1.5 * x).tanh() / 1.5;
            s + 0.25 * s * s - 0.12 * s * s * s
        }
    }
}

/// Per-band level-matching state.
#[derive(Clone, Copy, Default)]
struct BandMatch {
    dry_env: f64,
    wet_env: f64,
}

/// Multiband harmonic exciter.
pub struct Exciter {
    cfg: ExciterConfig,
    xo_l: Crossover4,
    xo_r: Crossover4,
    match_l: [BandMatch; BANDS],
    match_r: [BandMatch; BANDS],
    env_coeff: f64,
}

impl Exciter {
    /// Construct from a sample rate + config.
    pub fn new(sample_rate: f64, cfg: ExciterConfig) -> Self {
        Self {
            cfg,
            xo_l: Crossover4::new(sample_rate, cfg.crossover_hz),
            xo_r: Crossover4::new(sample_rate, cfg.crossover_hz),
            match_l: [BandMatch::default(); BANDS],
            match_r: [BandMatch::default(); BANDS],
            env_coeff: (-1.0 / (MATCH_TAU_S * sample_rate)).exp(),
        }
    }

    /// Update parameters.
    pub fn set_config(&mut self, cfg: ExciterConfig) {
        self.cfg = cfg;
        self.xo_l.set_freqs(cfg.crossover_hz);
        self.xo_r.set_freqs(cfg.crossover_hz);
    }

    /// The crossover frequencies actually in use.
    pub fn crossover_hz(&self) -> [f64; BANDS - 1] { self.xo_l.freqs() }

    /// True when at least one band is blended in, or the output trim is
    /// non-zero.  Otherwise the band splitter is skipped so a neutral
    /// exciter is bit-transparent rather than merely flat.
    fn is_active(&self) -> bool {
        !self.cfg.bypass
            && (self.cfg.output_db != 0.0
                || self.cfg.band_amount_pct.iter().any(|a| *a > 0.0))
    }

    /// Excite one band and level-match it back to its dry level.
    #[inline]
    fn excite_band(
        mode: ExciterMode, drive: f64, amount: f64, coeff: f64,
        m: &mut BandMatch, dry: f64,
    ) -> f64 {
        if amount <= 0.0 {
            return dry;
        }
        let wet_raw = saturate(mode, dry * drive);

        // Track both envelopes so the wet path can be matched to the dry one.
        let d = dry.abs();
        let w = wet_raw.abs();
        m.dry_env = d + coeff * (m.dry_env - d);
        m.wet_env = w + coeff * (m.wet_env - w);
        let match_gain = if m.wet_env > 1e-9 {
            (m.dry_env / m.wet_env).clamp(0.0, 8.0)
        } else {
            1.0
        };

        dry * (1.0 - amount) + wet_raw * match_gain * amount
    }
}

impl StereoModule for Exciter {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        if !self.is_active() {
            return;
        }
        let n = left.len().min(right.len());
        let coeff = self.env_coeff;
        let mode = self.cfg.mode;
        let post = 10f64.powf(self.cfg.output_db.clamp(-12.0, 12.0) / 20.0);

        // Per-band drive and blend, resolved once per block.
        let mut drive = [1.0f64; BANDS];
        let mut amount = [0.0f64; BANDS];
        for k in 0..BANDS {
            amount[k] = (self.cfg.band_amount_pct[k] / 100.0).clamp(0.0, 1.0);
            drive[k] = 10f64.powf(self.cfg.drive_db.clamp(0.0, 24.0) / 20.0);
        }

        for i in 0..n {
            let bl = self.xo_l.split(left[i] as f64);
            let br = self.xo_r.split(right[i] as f64);
            let mut sum_l = 0.0;
            let mut sum_r = 0.0;
            for k in 0..BANDS {
                sum_l += Self::excite_band(mode, drive[k], amount[k], coeff, &mut self.match_l[k], bl[k]);
                sum_r += Self::excite_band(mode, drive[k], amount[k], coeff, &mut self.match_r[k], br[k]);
            }
            left[i] = (sum_l * post) as f32;
            right[i] = (sum_r * post) as f32;
        }
    }

    fn reset(&mut self) {
        self.xo_l.reset();
        self.xo_r.reset();
        self.match_l = [BandMatch::default(); BANDS];
        self.match_r = [BandMatch::default(); BANDS];
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fft::Fft;

    fn cfg() -> ExciterConfig {
        ExciterConfig {
            mode: ExciterMode::Tube,
            crossover_hz: [120.0, 800.0, 5_000.0],
            band_amount_pct: [0.0; BANDS],
            drive_db: 6.0,
            output_db: 0.0,
            bypass: false,
        }
    }

    fn tone(n: usize, freq: f64, sr: f64, amp: f32) -> Vec<f32> {
        (0..n).map(|i| (2.0 * std::f64::consts::PI * freq * i as f64 / sr).sin() as f32 * amp).collect()
    }

    fn rms(x: &[f32]) -> f64 {
        (x.iter().map(|v| (*v as f64) * (*v as f64)).sum::<f64>() / x.len() as f64).sqrt()
    }

    /// Energy at `freq` relative to total, via a windowed FFT of the tail.
    fn harmonic_energy(x: &[f32], sr: f64, freq: f64) -> f64 {
        let n = 4096;
        let fft = Fft::new(n);
        let start = x.len() - n;
        let win = crate::window::Window::hann(n);
        let mut buf = vec![0.0f32; n];
        win.apply(&x[start..start + n], &mut buf);
        let mut mag = vec![0.0; n / 2 + 1];
        let mut re = vec![0.0; n];
        let mut im = vec![0.0; n];
        fft.magnitude(&buf, &mut mag, &mut re, &mut im);
        let bin = (freq / (sr / n as f64)).round() as usize;
        mag[bin.saturating_sub(1)].max(mag[bin]).max(mag[(bin + 1).min(mag.len() - 1)])
    }

    #[test]
    fn bypass_is_passthrough() {
        let mut e = Exciter::new(48_000.0, ExciterConfig { bypass: true, ..cfg() });
        let mut l = tone(512, 440.0, 48_000.0, 0.5);
        let orig = l.clone();
        let mut r = l.clone();
        e.process_stereo(&mut l, &mut r);
        assert_eq!(l, orig);
    }

    /// Zero amount in every band = crossover split and sum, i.e. flat.
    #[test]
    fn zero_amount_is_transparent() {
        let mut e = Exciter::new(48_000.0, cfg());
        let n = 16_384;
        let input = tone(n, 1_000.0, 48_000.0, 0.4);
        let mut l = input.clone();
        let mut r = input.clone();
        e.process_stereo(&mut l, &mut r);
        let delta = 20.0 * (rms(&l[n / 2..]) / rms(&input[n / 2..])).log10();
        assert!(delta.abs() < 0.5, "drifted {delta:.2} dB with amount 0");
    }

    /// Driving a band must actually create harmonics.
    #[test]
    fn generates_harmonics() {
        let mut c = cfg();
        c.band_amount_pct[2] = 100.0; // high-mid band contains 2 kHz
        c.drive_db = 12.0;
        let mut e = Exciter::new(48_000.0, c);
        let n = 32_768;
        let input = tone(n, 2_000.0, 48_000.0, 0.4);
        let mut l = input.clone();
        let mut r = input.clone();
        e.process_stereo(&mut l, &mut r);

        let h2_before = harmonic_energy(&input, 48_000.0, 4_000.0);
        let h2_after = harmonic_energy(&l, 48_000.0, 4_000.0);
        assert!(h2_after > h2_before * 8.0,
                "expected 2nd-harmonic growth, {h2_before:.4} → {h2_after:.4}");
    }

    /// Level matching must keep the output near the input level even at
    /// full drive — an exciter that just gets louder is cheating.
    #[test]
    fn level_matched_within_a_few_db() {
        for mode in [ExciterMode::Warm, ExciterMode::Retro, ExciterMode::Tape,
                     ExciterMode::Tube, ExciterMode::Triode] {
            let mut c = cfg();
            c.mode = mode;
            c.band_amount_pct = [100.0; BANDS];
            c.drive_db = 18.0;
            let mut e = Exciter::new(48_000.0, c);
            let n = 32_768;
            let input = tone(n, 1_000.0, 48_000.0, 0.3);
            let mut l = input.clone();
            let mut r = input.clone();
            e.process_stereo(&mut l, &mut r);
            let delta = 20.0 * (rms(&l[n / 2..]) / rms(&input[n / 2..])).log10();
            assert!(delta.abs() < 3.0, "{mode:?} drifted {delta:.1} dB");
        }
    }

    #[test]
    fn output_stays_finite_at_extremes() {
        let mut c = cfg();
        c.band_amount_pct = [100.0; BANDS];
        c.drive_db = 24.0;
        let mut e = Exciter::new(48_000.0, c);
        let mut l = vec![0.0f32; 8192];
        for (i, s) in l.iter_mut().enumerate() { *s = if i % 4 == 0 { 3.0 } else { -3.0 }; }
        let mut r = l.clone();
        e.process_stereo(&mut l, &mut r);
        assert!(l.iter().all(|s| s.is_finite()));
    }
}
