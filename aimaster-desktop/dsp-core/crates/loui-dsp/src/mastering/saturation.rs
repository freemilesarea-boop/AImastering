//! Saturation / exciter — harmonic colour, realtime-safe.
//!
//! A drive → waveshaper → dry/wet mix stage with four characters and an
//! optional 4-band mode (per-band drive scaling via the shared subtractive
//! crossover).  Each shaper has unit slope at the origin, so with `drive == 0`
//! (or `bypass`) the stage is a clean passthrough — the default is a no-op.
//!
//! Characters:
//!   * Warm   — gentle soft saturation `t/(1+|t|)` (few harmonics)
//!   * Tape   — `tanh(t)` (smooth odd harmonics)
//!   * Tube   — asymmetric tanh (even + odd harmonics) + DC block
//!   * Modern — harder odd soft-clip `t/(1+t⁴)^¼`
//!
//! Realtime-safe: per-sample, all state pre-allocated, no allocation.

use super::config::{db_to_lin, SaturationCharacter, SaturationConfig};
use super::crossover::{ordered_xovers3, subtractive_bands, Lr4Lowpass};
use super::StereoModule;

const N_BANDS: usize = 4;
const N_XOVER: usize = 3;
/// Max pre-gain pushed into the shaper at drive = 100 (dB).
const MAX_DRIVE_DB: f64 = 18.0;
/// DC-block one-pole coefficient (≈ 5 Hz high-pass at 48 kHz).
const DC_R: f64 = 0.9995;

/// Unit-slope-at-origin waveshaper for a character.
#[inline]
fn shape(ch: SaturationCharacter, t: f64) -> f64 {
    match ch {
        SaturationCharacter::Warm => t / (1.0 + t.abs()),
        SaturationCharacter::Tape => t.tanh(),
        SaturationCharacter::Tube => {
            // Asymmetric: same unit slope each side, different curvature →
            // even harmonics.  DC handled by the per-channel DC block.
            if t >= 0.0 { t.tanh() } else { 0.85 * (t / 0.85).tanh() }
        }
        SaturationCharacter::Modern => t / (1.0 + t * t * t * t).powf(0.25),
    }
}

/// Saturate one sample with an effective drive (%).  drive ≤ 0 → passthrough.
#[inline]
fn saturate(ch: SaturationCharacter, x: f64, drive_pct: f64) -> f64 {
    if drive_pct <= 0.0 {
        return x;
    }
    let drive_gain = db_to_lin((drive_pct / 100.0) * MAX_DRIVE_DB);
    shape(ch, x * drive_gain) / drive_gain
}

/// One-pole DC blocker (per channel).
#[derive(Clone, Copy, Default)]
struct DcBlock {
    x1: f64,
    y1: f64,
}
impl DcBlock {
    #[inline]
    fn process(&mut self, x: f64) -> f64 {
        let y = x - self.x1 + DC_R * self.y1;
        self.x1 = x;
        self.y1 = y;
        y
    }
    fn reset(&mut self) {
        self.x1 = 0.0;
        self.y1 = 0.0;
    }
}

/// Saturation / exciter module.
pub struct Saturation {
    sr: f64,
    cfg: SaturationConfig,
    lp_l: [Lr4Lowpass; N_XOVER],
    lp_r: [Lr4Lowpass; N_XOVER],
    dc_l: DcBlock,
    dc_r: DcBlock,
}

impl Saturation {
    pub fn new(sample_rate: f64, cfg: SaturationConfig) -> Self {
        let xo = ordered_xovers3(cfg.xover_lo_hz, cfg.xover_mid_hz, cfg.xover_hi_hz, sample_rate);
        Self {
            sr: sample_rate,
            cfg,
            lp_l: [Lr4Lowpass::new(sample_rate, xo[0]), Lr4Lowpass::new(sample_rate, xo[1]), Lr4Lowpass::new(sample_rate, xo[2])],
            lp_r: [Lr4Lowpass::new(sample_rate, xo[0]), Lr4Lowpass::new(sample_rate, xo[1]), Lr4Lowpass::new(sample_rate, xo[2])],
            dc_l: DcBlock::default(),
            dc_r: DcBlock::default(),
        }
    }

    pub fn set_config(&mut self, cfg: SaturationConfig) {
        let xo = ordered_xovers3(cfg.xover_lo_hz, cfg.xover_mid_hz, cfg.xover_hi_hz, self.sr);
        for i in 0..N_XOVER {
            self.lp_l[i].set(self.sr, xo[i]);
            self.lp_r[i].set(self.sr, xo[i]);
        }
        self.cfg = cfg;
    }

    /// True when the stage would not alter the signal.
    fn is_unity(&self) -> bool {
        if self.cfg.drive <= 0.0 || self.cfg.mix_pct <= 0.0 {
            return true;
        }
        if self.cfg.multiband_enabled {
            self.cfg.band_drives_pct.iter().all(|&d| d <= 0.0)
        } else {
            false
        }
    }

    /// Wet (saturated) value for one channel sample, using the channel's
    /// crossover filters when multiband is enabled.
    #[inline]
    fn wet_sample(cfg: &SaturationConfig, lp: &mut [Lr4Lowpass; N_XOVER], x: f64) -> f64 {
        if cfg.multiband_enabled {
            let bands = subtractive_bands(lp, x);
            let mut sum = 0.0;
            for b in 0..N_BANDS {
                let d = cfg.drive * (cfg.band_drives_pct[b] / 100.0);
                sum += saturate(cfg.character, bands[b], d);
            }
            sum
        } else {
            // Keep the split filters' state coherent for click-free toggling.
            let _ = subtractive_bands(lp, x);
            saturate(cfg.character, x, cfg.drive)
        }
    }
}

impl StereoModule for Saturation {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        if self.cfg.bypass || self.is_unity() {
            return;
        }
        let mix = (self.cfg.mix_pct / 100.0).clamp(0.0, 1.0);
        let dry = 1.0 - mix;
        let dc_block = matches!(self.cfg.character, SaturationCharacter::Tube);
        let n = left.len().min(right.len());
        for i in 0..n {
            let xl = left[i] as f64;
            let xr = right[i] as f64;
            let mut wl = Self::wet_sample(&self.cfg, &mut self.lp_l, xl);
            let mut wr = Self::wet_sample(&self.cfg, &mut self.lp_r, xr);
            if dc_block {
                wl = self.dc_l.process(wl);
                wr = self.dc_r.process(wr);
            }
            let ol = dry * xl + mix * wl;
            let or = dry * xr + mix * wr;
            left[i] = if ol.is_finite() { ol as f32 } else { xl as f32 };
            right[i] = if or.is_finite() { or as f32 } else { xr as f32 };
        }
    }

    fn reset(&mut self) {
        for i in 0..N_XOVER {
            self.lp_l[i].reset();
            self.lp_r[i].reset();
        }
        self.dc_l.reset();
        self.dc_r.reset();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(n: usize, freq: f64, sr: f64, amp: f32) -> Vec<f32> {
        (0..n).map(|i| (2.0 * std::f64::consts::PI * freq * i as f64 / sr).sin() as f32 * amp).collect()
    }

    fn cfg(character: SaturationCharacter, drive: f64) -> SaturationConfig {
        SaturationConfig { bypass: false, character, drive, mix_pct: 100.0, ..SaturationConfig::default() }
    }

    #[test]
    fn default_is_passthrough() {
        let mut s = Saturation::new(48_000.0, SaturationConfig::default());
        let inl = sine(256, 440.0, 48_000.0, 0.5);
        let mut l = inl.clone();
        let mut r = inl.clone();
        s.process_stereo(&mut l, &mut r);
        assert!(l.iter().zip(&inl).all(|(a, b)| (a - b).abs() < 1e-7));
    }

    #[test]
    fn drive_zero_is_passthrough_even_when_enabled() {
        let mut s = Saturation::new(48_000.0, cfg(SaturationCharacter::Tape, 0.0));
        let inl = sine(256, 440.0, 48_000.0, 0.5);
        let mut l = inl.clone();
        let mut r = inl.clone();
        s.process_stereo(&mut l, &mut r);
        assert!(l.iter().zip(&inl).all(|(a, b)| (a - b).abs() < 1e-7));
    }

    #[test]
    fn mix_zero_is_dry() {
        let mut s = Saturation::new(48_000.0, SaturationConfig { mix_pct: 0.0, ..cfg(SaturationCharacter::Tube, 80.0) });
        let inl = sine(256, 440.0, 48_000.0, 0.5);
        let mut l = inl.clone();
        let mut r = inl.clone();
        s.process_stereo(&mut l, &mut r);
        assert!(l.iter().zip(&inl).all(|(a, b)| (a - b).abs() < 1e-6));
    }

    #[test]
    fn tape_drive_changes_signal_but_stays_bounded() {
        let mut s = Saturation::new(48_000.0, cfg(SaturationCharacter::Tape, 80.0));
        let inl = sine(1024, 440.0, 48_000.0, 0.8);
        let mut l = inl.clone();
        let mut r = inl.clone();
        s.process_stereo(&mut l, &mut r);
        let changed = l.iter().zip(&inl).any(|(a, b)| (a - b).abs() > 1e-3);
        assert!(changed, "saturation had no effect");
        assert!(l.iter().all(|x| x.is_finite() && x.abs() <= 1.5));
    }

    #[test]
    fn high_drive_soft_clips_a_loud_tone() {
        // tanh soft-clip → loud peak compressed below input peak.
        let mut s = Saturation::new(48_000.0, cfg(SaturationCharacter::Tape, 100.0));
        let mut l = sine(1024, 440.0, 48_000.0, 0.95);
        let mut r = l.clone();
        s.process_stereo(&mut l, &mut r);
        let out_peak = l.iter().cloned().fold(0.0f32, |m, x| m.max(x.abs()));
        assert!(out_peak < 0.95, "expected soft-clip, peak {out_peak}");
    }

    #[test]
    fn tube_output_is_dc_free() {
        // The asymmetric tube shaper adds DC; the DC block must remove it.
        let mut s = Saturation::new(48_000.0, cfg(SaturationCharacter::Tube, 90.0));
        let n = 8192;
        let mut l = sine(n, 200.0, 48_000.0, 0.8);
        let mut r = l.clone();
        s.process_stereo(&mut l, &mut r);
        let mean: f64 = l.iter().skip(2048).map(|&x| x as f64).sum::<f64>() / (n - 2048) as f64;
        assert!(mean.abs() < 0.02, "DC not removed: mean {mean}");
        assert!(l.iter().all(|x| x.is_finite()));
    }

    #[test]
    fn multiband_unity_drive_is_passthrough() {
        // Multiband on but all band drives 0 → unity (subtractive sum = input).
        let c = SaturationConfig { bypass: false, multiband_enabled: true, drive: 80.0, band_drives_pct: [0.0; 4], ..SaturationConfig::default() };
        let mut s = Saturation::new(48_000.0, c);
        let inl = sine(1024, 300.0, 48_000.0, 0.5);
        let mut l = inl.clone();
        let mut r = inl.clone();
        s.process_stereo(&mut l, &mut r);
        assert!(l.iter().zip(&inl).all(|(a, b)| (a - b).abs() < 1e-6));
    }

    #[test]
    fn multiband_per_band_drive_saturates_and_stays_finite() {
        let c = SaturationConfig { bypass: false, multiband_enabled: true, character: SaturationCharacter::Tape, drive: 100.0, band_drives_pct: [0.0, 0.0, 100.0, 100.0], mix_pct: 100.0, ..SaturationConfig::default() };
        let mut s = Saturation::new(48_000.0, c);
        let inl = sine(2048, 4000.0, 48_000.0, 0.8);
        let mut l = inl.clone();
        let mut r = inl.clone();
        s.process_stereo(&mut l, &mut r);
        let changed = l.iter().zip(&inl).any(|(a, b)| (a - b).abs() > 1e-3);
        assert!(changed, "high-band drive had no effect");
        assert!(l.iter().all(|x| x.is_finite() && x.abs() <= 1.5));
    }
}
