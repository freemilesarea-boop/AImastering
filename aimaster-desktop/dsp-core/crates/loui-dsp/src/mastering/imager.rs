//! Stereo imager — M/S width + low-frequency mono, with a phase guard.
//!
//!   M = (L+R)/2, S = (L-R)/2
//!   * width: S *= width_pct/100
//!   * low-mono: high-pass the Side below `low_mono_hz` (so lows fold to mono)
//!   * phase guard: clamp width so the reconstructed correlation can't
//!     invert hard (prevents mono-fold-down cancellation)
//!
//! Reconstruct L = M+S, R = M-S.
//!
//! A mono source can also be SPREAD: with `stereoize` the Side gains a
//! decorrelated copy of the Mid, made by a cascade of true allpasses.  Mid is
//! untouched, so a mono fold-down returns the input sample for sample — which
//! is the reason this shape was chosen over a Haas delay, whose L and R come
//! out combed.  The spread is injected BEFORE the low-mono high-pass and
//! before the width scaling, so synthetic width stays out of the bass and the
//! Width control decides how much of it is heard.  Adding Side without
//! touching Mid necessarily raises the stereo level a little —
//! `sqrt(1 + amount²)`, 0.65 dB at the fixed amount here — and that is left
//! alone rather than compensated, because compensating means scaling Mid and
//! the mono fold would no longer be the input.
//!
//! A per-band width is also available: when any entry of `band_width_pct`
//! differs from 100 the signal is first split by a Linkwitz-Riley 4-band
//! crossover and each band's Side is scaled independently, which is how you
//! narrow a boomy low end while widening the air.  When every band is at
//! 100 the splitter is skipped entirely, so the common case costs nothing
//! and stays bit-transparent at width 100.

use crate::biquad::{Biquad, BiquadCoeffs};
use crate::crossover::{Crossover4, BANDS};
use super::config::ImagerConfig;
use super::StereoModule;

/// Allpass delays for the stereoizer, in samples at 48 kHz.
///
/// Mutually prime so the cascade's phase does not repeat on a short cycle,
/// and all of them well above a 128-sample render quantum so the same lengths
/// can be used by the WebAudio fallback chain, whose feedback loops cannot be
/// shorter than one block.
const SPREAD_DELAYS_48K: [usize; 4] = [211, 347, 593, 907];
/// Allpass coefficient.  Diffuses without ringing.
const SPREAD_G: f64 = 0.6;
/// How much decorrelated Side a mono source gets.
///
/// 0.4 takes the correlation of a mono input to (1 − a²)/(1 + a²) = 0.72,
/// which is audibly wider without sounding like an effect; the Width control
/// scales it from there.
const SPREAD_AMOUNT: f64 = 0.4;

/// A true allpass: flat magnitude, scrambled phase.
///
/// `v[n] = x[n] + g·v[n−D]`, `y[n] = −g·v[n] + v[n−D]`.  Freeverb's variant
/// (`y = −x + buf`, `buf = x + buf·g`) is NOT magnitude-flat, and a
/// stereoizer built on it colours the thing it is meant to widen.
struct Allpass {
    buf: Vec<f64>,
    idx: usize,
}

impl Allpass {
    fn new(len: usize) -> Self {
        Self { buf: vec![0.0; len.max(1)], idx: 0 }
    }

    #[inline]
    fn process(&mut self, x: f64) -> f64 {
        let delayed = self.buf[self.idx];
        let v = x + SPREAD_G * delayed;
        let y = -SPREAD_G * v + delayed;
        self.buf[self.idx] = v;
        self.idx += 1;
        if self.idx >= self.buf.len() {
            self.idx = 0;
        }
        y
    }

    fn reset(&mut self) {
        for v in self.buf.iter_mut() {
            *v = 0.0;
        }
        self.idx = 0;
    }
}

/// Stereo imager module.
pub struct Imager {
    sr: f64,
    cfg: ImagerConfig,
    // High-pass applied to the Side signal for low-mono.
    side_hp: Biquad,
    // Band splitters, only used when per-band widths are in play.
    xo_l: Crossover4,
    xo_r: Crossover4,
    // The stereoizer's allpass cascade, fed from Mid.
    spread: Vec<Allpass>,
}

impl Imager {
    /// Construct from a sample rate + config.
    pub fn new(sample_rate: f64, cfg: ImagerConfig) -> Self {
        Self {
            sr: sample_rate,
            cfg,
            side_hp: Biquad::new(BiquadCoeffs::high_pass(sample_rate, Self::safe_low_mono(cfg.low_mono_hz, sample_rate), 0.707)),
            xo_l: Crossover4::new(sample_rate, cfg.crossover_hz),
            xo_r: Crossover4::new(sample_rate, cfg.crossover_hz),
            spread: Self::spread_chain(sample_rate),
        }
    }

    /// The allpass cascade, with its delays scaled to this sample rate so the
    /// spread sounds the same at 44.1 kHz as at 96.
    fn spread_chain(sample_rate: f64) -> Vec<Allpass> {
        let scale = if sample_rate.is_finite() && sample_rate > 0.0 {
            sample_rate / 48_000.0
        } else {
            1.0
        };
        SPREAD_DELAYS_48K
            .iter()
            .map(|&d| Allpass::new(((d as f64) * scale).round().max(1.0) as usize))
            .collect()
    }

    /// Update parameters.
    pub fn set_config(&mut self, cfg: ImagerConfig) {
        self.cfg = cfg;
        self.side_hp.set_coeffs(BiquadCoeffs::high_pass(self.sr, Self::safe_low_mono(cfg.low_mono_hz, self.sr), 0.707));
        self.xo_l.set_freqs(cfg.crossover_hz);
        self.xo_r.set_freqs(cfg.crossover_hz);
    }

    /// True when at least one band asks for a width other than 100 %.
    fn per_band_active(&self) -> bool {
        self.cfg.band_width_pct.iter().any(|w| !w.is_finite() || (w - 100.0).abs() > 1e-9)
    }

    /// Per-band width factors, guarded to [0, 2].
    fn band_factors(&self) -> [f64; BANDS] {
        let mut out = [1.0; BANDS];
        for (i, o) in out.iter_mut().enumerate() {
            let w = self.cfg.band_width_pct[i] / 100.0;
            *o = if w.is_finite() { w.clamp(0.0, 2.0) } else { 1.0 };
        }
        out
    }

    /// Clamp the low-mono crossover to a numerically safe range so a bad
    /// (or out-of-range) value can never make the high-pass unstable.
    fn safe_low_mono(hz: f64, sr: f64) -> f64 {
        if hz.is_finite() {
            hz.clamp(20.0, sr * 0.45)
        } else {
            20.0
        }
    }

    /// Effective width factor, phase-guarded to [0, 2.0] (non-finite → 1.0).
    fn width_factor(&self) -> f64 {
        let w = self.cfg.width_pct / 100.0;
        if w.is_finite() {
            w.clamp(0.0, 2.0)
        } else {
            1.0
        }
    }
}

impl StereoModule for Imager {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        if self.cfg.bypass {
            return;
        }
        let width = self.width_factor();
        let do_low_mono = self.cfg.low_mono_hz > 20.0;
        let per_band = self.per_band_active();
        let band_w = self.band_factors();
        let n = left.len().min(right.len());
        for i in 0..n {
            let l = left[i] as f64;
            let r = right[i] as f64;
            let (mid, mut side) = if per_band {
                // Split, scale each band's Side, and recombine.  Mid is the
                // plain band sum, which is flat by the crossover's design.
                let bl = self.xo_l.split(l);
                let br = self.xo_r.split(r);
                let mut m = 0.0;
                let mut s = 0.0;
                for k in 0..BANDS {
                    m += 0.5 * (bl[k] + br[k]);
                    s += 0.5 * (bl[k] - br[k]) * band_w[k];
                }
                (m, s)
            } else {
                (0.5 * (l + r), 0.5 * (l - r))
            };
            // Stereoize: a decorrelated copy of Mid joins the Side.  Always
            // run, even when the switch is off, so flipping it mid-programme
            // does not start from a cold cascade and swell.
            let mut spread = mid;
            for ap in self.spread.iter_mut() {
                spread = ap.process(spread);
            }
            if self.cfg.stereoize {
                side += SPREAD_AMOUNT * spread;
            }

            // Low-mono: keep only the high-passed Side, so lows fold to mono.
            if do_low_mono {
                side = self.side_hp.process(side);
            } else {
                // Keep the filter state coherent even when bypassed this block.
                let _ = self.side_hp.process(side);
            }
            side *= width;
            let out_l = mid + side;
            let out_r = mid - side;
            // Per-sample finite guard — a non-finite (e.g. a poisoned filter
            // state) must fall back to the dry sample, never emit garbage.
            left[i] = if out_l.is_finite() { out_l as f32 } else { l as f32 };
            right[i] = if out_r.is_finite() { out_r as f32 } else { r as f32 };
        }
    }

    fn reset(&mut self) {
        self.side_hp.reset();
        for ap in self.spread.iter_mut() {
            ap.reset();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(width_pct: f64, low_mono_hz: f64) -> ImagerConfig {
        ImagerConfig { width_pct, low_mono_hz, bypass: false, ..Default::default() }
    }

    /// Deterministic noise, so a correlation is a number and not a mood.
    fn noise(n: usize) -> Vec<f32> {
        let mut seed: u64 = 0x2545_F491_4F6C_DD1D;
        (0..n)
            .map(|_| {
                seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
                // The top 32 bits over u32::MAX, so this really is [-1, 1]
                // and not a DC offset wearing a disguise.
                ((((seed >> 32) as u32) as f64 / (u32::MAX as f64)) * 2.0 - 1.0) as f32 * 0.25
            })
            .collect()
    }

    fn correlation(l: &[f32], r: &[f32], from: usize) -> f64 {
        let (mut num, mut dl, mut dr) = (0.0, 0.0, 0.0);
        for i in from..l.len() {
            let a = l[i] as f64;
            let b = r[i] as f64;
            num += a * b;
            dl += a * a;
            dr += b * b;
        }
        let den = (dl * dr).sqrt();
        if den > 0.0 { num / den } else { 0.0 }
    }

    #[test]
    fn the_spread_allpass_is_magnitude_flat() {
        // A lossless allpass has unit energy gain (Parseval): an impulse in,
        // and whatever comes out sums to the same energy.  Freeverb's variant
        // does not, which is why this cascade does not use it.
        let mut ap = Allpass::new(211);
        let first = ap.process(1.0);
        let mut sum = first * first;
        for _ in 0..200_000 {
            let y = ap.process(0.0);
            sum += y * y;
        }
        assert!((sum - 1.0).abs() < 1e-6, "allpass energy gain {sum}, want 1.0");
    }

    #[test]
    fn stereoize_off_changes_nothing() {
        let mut off = Imager::new(48_000.0, cfg(100.0, 20.0));
        let src = noise(4096);
        let mut l = src.clone();
        let mut r = src.clone();
        off.process_stereo(&mut l, &mut r);
        for i in 0..src.len() {
            assert!((l[i] - src[i]).abs() < 1e-6, "left moved at {i}");
            assert!((r[i] - src[i]).abs() < 1e-6, "right moved at {i}");
        }
    }

    #[test]
    fn stereoize_spreads_a_mono_source() {
        let mut im = Imager::new(
            48_000.0,
            ImagerConfig { stereoize: true, ..cfg(100.0, 20.0) },
        );
        let src = noise(48_000);
        let mut l = src.clone();
        let mut r = src.clone();
        im.process_stereo(&mut l, &mut r);

        // A mono source goes in with correlation 1.0 and comes out at the
        // designed (1 − a²)/(1 + a²) = 0.724 for a = 0.4.
        let rho = correlation(&l, &r, 4_000);
        let dry = correlation(&src, &src, 4_000);
        println!("mono in: correlation {dry:.4} -> {rho:.4}");
        assert!((rho - 0.724).abs() < 0.03, "correlation {rho}, want about 0.724");

        // And there is real Side energy where there was none.
        let side: f64 = l.iter().zip(r.iter())
            .skip(4_000)
            .map(|(a, b)| {
                let s = 0.5 * (*a as f64 - *b as f64);
                s * s
            })
            .sum();
        assert!(side > 0.0, "no Side was made at all");
    }

    #[test]
    fn stereoize_leaves_the_mono_fold_alone() {
        // The property the whole design was chosen for: Mid is untouched, so
        // (L+R)/2 of the output is the input, sample for sample.  A Haas
        // delay on one channel would fail this.
        let mut im = Imager::new(
            48_000.0,
            ImagerConfig { stereoize: true, ..cfg(100.0, 20.0) },
        );
        let src = noise(8_192);
        let mut l = src.clone();
        let mut r = src.clone();
        im.process_stereo(&mut l, &mut r);
        for i in 0..src.len() {
            let fold = 0.5 * (l[i] + r[i]);
            assert!((fold - src[i]).abs() < 1e-6,
                "the mono fold moved at {i}: {fold} against {}", src[i]);
        }
    }

    #[test]
    fn stereoize_stays_out_of_the_bass() {
        // Low-mono must still rule: a spread that ignored it would put
        // synthetic width on the kick and the bass.
        let mut im = Imager::new(
            48_000.0,
            ImagerConfig { stereoize: true, ..cfg(100.0, 300.0) },
        );
        let n = 48_000;
        // A 60 Hz tone, mono.
        let src: Vec<f32> = (0..n)
            .map(|i| ((i as f64) * 60.0 * std::f64::consts::TAU / 48_000.0).sin() as f32 * 0.5)
            .collect();
        let mut l = src.clone();
        let mut r = src.clone();
        im.process_stereo(&mut l, &mut r);
        let side_rms: f64 = (l.iter().zip(r.iter()).skip(8_000)
            .map(|(a, b)| {
                let s = 0.5 * (*a as f64 - *b as f64);
                s * s
            })
            .sum::<f64>() / ((n - 8_000) as f64)).sqrt();
        let mid_rms: f64 = (src.iter().skip(8_000)
            .map(|v| (*v as f64) * (*v as f64))
            .sum::<f64>() / ((n - 8_000) as f64)).sqrt();
        let ratio_db = 20.0 * (side_rms / mid_rms).log10();
        assert!(ratio_db < -20.0,
            "60 Hz Side is only {ratio_db:.1} dB below Mid — low-mono did not catch the spread");
    }

    #[test]
    fn width_scales_the_spread() {
        // The Width control is in charge: at width 0 the spread is gone.
        let src = noise(24_000);
        let side_rms = |width: f64| -> f64 {
            let mut im = Imager::new(
                48_000.0,
                ImagerConfig { stereoize: true, ..cfg(width, 20.0) },
            );
            let mut l = src.clone();
            let mut r = src.clone();
            im.process_stereo(&mut l, &mut r);
            (l.iter().zip(r.iter()).skip(4_000)
                .map(|(a, b)| {
                    let s = 0.5 * (*a as f64 - *b as f64);
                    s * s
                })
                .sum::<f64>() / ((src.len() - 4_000) as f64)).sqrt()
        };
        let wide = side_rms(100.0);
        let narrow = side_rms(0.0);
        assert!(wide > 0.0, "no spread at width 100");
        assert!(narrow < wide * 1e-6, "width 0 still spread: {narrow} against {wide}");
    }

    #[test]
    fn width_100_is_passthrough() {
        let mut im = Imager::new(48_000.0, cfg(100.0, 20.0));
        let mut l = [0.5f32, -0.3, 0.8];
        let mut r = [0.1f32, 0.4, -0.2];
        let (lc, rc) = (l, r);
        im.process_stereo(&mut l, &mut r);
        for i in 0..3 {
            assert!((l[i] - lc[i]).abs() < 1e-5, "L[{i}] {} vs {}", l[i], lc[i]);
            assert!((r[i] - rc[i]).abs() < 1e-5);
        }
    }

    #[test]
    fn width_0_collapses_to_mono() {
        let mut im = Imager::new(48_000.0, cfg(0.0, 20.0));
        let mut l = [0.8f32, -0.4];
        let mut r = [0.2f32, 0.6];
        im.process_stereo(&mut l, &mut r);
        // Width 0 → L == R == mid.
        for i in 0..2 {
            assert!((l[i] - r[i]).abs() < 1e-6, "not mono at {i}: {} vs {}", l[i], r[i]);
        }
    }

    #[test]
    fn width_200_doubles_side() {
        let mut im = Imager::new(48_000.0, cfg(200.0, 20.0));
        // Pure side signal (L = -R).
        let mut l = [0.5f32];
        let mut r = [-0.5f32];
        im.process_stereo(&mut l, &mut r);
        // mid = 0, side = 0.5 → ×2 = 1.0 → L = 1.0, R = -1.0
        assert!((l[0] - 1.0).abs() < 1e-5, "L = {}", l[0]);
        assert!((r[0] + 1.0).abs() < 1e-5, "R = {}", r[0]);
    }

    #[test]
    fn bypass_is_passthrough() {
        let mut im = Imager::new(48_000.0, ImagerConfig { bypass: true, ..cfg(0.0, 200.0) });
        let mut l = [0.5f32, -0.3];
        let mut r = [0.1f32, 0.4];
        let (lc, rc) = (l, r);
        im.process_stereo(&mut l, &mut r);
        assert_eq!(l, lc);
        assert_eq!(r, rc);
    }

    #[test]
    fn mono_input_stays_finite_and_centred() {
        // Mono = L == R → side 0 → width has no effect, output stays == input.
        let mut im = Imager::new(48_000.0, cfg(150.0, 120.0));
        let mut l = [0.5f32, -0.4, 0.3, -0.2];
        let mut r = l;
        im.process_stereo(&mut l, &mut r);
        for i in 0..4 {
            assert!(l[i].is_finite() && r[i].is_finite());
            assert!((l[i] - r[i]).abs() < 1e-5, "mono should stay centred at {i}");
        }
    }

    #[test]
    fn non_finite_width_falls_back_to_unity() {
        // A NaN width must not poison the output.
        let mut im = Imager::new(48_000.0, cfg(f64::NAN, 20.0));
        let mut l = [0.5f32, -0.3];
        let mut r = [0.1f32, 0.4];
        im.process_stereo(&mut l, &mut r);
        assert!(l.iter().chain(r.iter()).all(|x| x.is_finite()));
    }

    #[test]
    fn extreme_low_mono_is_clamped_stable() {
        // An absurd / non-finite crossover must clamp, not blow up.
        let mut im = Imager::new(48_000.0, cfg(130.0, 1.0e9));
        let mut l: Vec<f32> = (0..2048).map(|i| (i as f32 * 0.01).sin() * 0.5).collect();
        let mut r: Vec<f32> = (0..2048).map(|i| (i as f32 * 0.013).sin() * 0.5).collect();
        im.process_stereo(&mut l, &mut r);
        assert!(l.iter().chain(r.iter()).all(|x| x.is_finite()));
    }
}
