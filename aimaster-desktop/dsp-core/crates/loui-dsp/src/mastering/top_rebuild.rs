//! Spectral Top Rebuild — replace a damaged top end instead of boosting it.
//!
//! Generative music tools decode audio from a learned representation rather
//! than recording it, and the top octave is where that shows: above roughly
//! 9 kHz the detail is reconstructed, and it arrives as a watery, swirling
//! shimmer on consonants and breath. Vocals get it worst, because that is
//! where their consonants live.
//!
//! An exciter cannot fix this. An exciter ADDS harmonics on top of what is
//! already there, so the swirl is still underneath — now with a bright
//! layer over it. The only thing that removes the artefact is removing the
//! band that carries it, and the only way to do that without ending up dull
//! is to put something back.
//!
//! So this module does three things, in order:
//!
//!   1. **Split** at the damage frequency, using an LR4 crossover so the two
//!      halves sum back flat.
//!   2. **Fade out** the damaged half by `amount`.
//!   3. **Fade in** a replacement, synthesised by driving a healthy band
//!      from the midrange into a waveshaper, filtering the result into the
//!      target range, and **scaling it to the envelope the original band
//!      had**.
//!
//! That last step is the one that decides whether this sounds like a
//! recording or like a noise generator. Harmonics with a fixed level are a
//! constant hiss; harmonics that rise and fall with the original top end
//! read as the same performance with its detail restored.
//!
//! Zero added latency — biquads and envelope followers only, no FFT. That
//! matters here: the STFT modules cost 2048 samples (≈43 ms) and this one
//! is meant to be usable while tracking against the preview.
//!
//! Bit-transparent at `amount_pct = 0` — the module returns before touching
//! the samples.
//!
//! # What it cannot do
//!
//! On a two-track master the vocal is already mixed in. Rebuilding the top
//! rebuilds it for cymbals and hats too. Treating the voice alone needs
//! source separation, which this is not.

use crate::biquad::{Biquad, BiquadCoeffs};
use crate::crossover::Crossover2;
use super::config::TopRebuildConfig;
use super::StereoModule;

/// Ceiling on the envelope-matching gain.
///
/// The synthesised band is divided by its own envelope to normalise it. In
/// a near-silent passage that divisor approaches zero, and without a cap the
/// module would answer digital silence with full-scale noise.
const MAX_MATCH_GAIN: f64 = 8.0;
/// Floor added to every envelope divisor.
const ENV_FLOOR: f64 = 1e-6;

/// A one-pole envelope follower with separate rise and fall.
#[derive(Clone, Copy, Default)]
struct Envelope {
    value: f64,
    attack: f64,
    release: f64,
}

impl Envelope {
    fn set(&mut self, sr: f64, attack_ms: f64, release_ms: f64) {
        self.attack = time_const(sr, attack_ms);
        self.release = time_const(sr, release_ms);
    }
    #[inline]
    fn process(&mut self, x: f64) -> f64 {
        let a = x.abs();
        let c = if a > self.value { self.attack } else { self.release };
        self.value = a + (self.value - a) * c;
        self.value
    }
    fn reset(&mut self) {
        self.value = 0.0;
    }
}

fn time_const(sr: f64, ms: f64) -> f64 {
    let t = ms.clamp(0.05, 5_000.0) * 0.001;
    (-1.0 / (t * sr)).exp()
}

/// Everything one channel needs.
struct Channel {
    split: Crossover2,
    /// Band-pass isolating the healthy source region, as two biquads.
    src_hp: Biquad,
    src_lp: Biquad,
    /// Keeps the synthesised harmonics inside the target range.
    synth_hp: Biquad,
    synth_lp: Biquad,
    /// Envelope of the ORIGINAL damaged band — what the replacement copies.
    env_target: Envelope,
    /// Envelope of the synthesised band — what it is normalised by.
    env_synth: Envelope,
}

impl Channel {
    fn new(sr: f64) -> Self {
        let flat = BiquadCoeffs::peaking(sr, 1_000.0, 1.0, 0.0);
        Self {
            split: Crossover2::new(sr, 9_000.0),
            src_hp: Biquad::new(flat),
            src_lp: Biquad::new(flat),
            synth_hp: Biquad::new(flat),
            synth_lp: Biquad::new(flat),
            env_target: Envelope::default(),
            env_synth: Envelope::default(),
        }
    }

    fn reset(&mut self) {
        self.split.reset();
        self.src_hp.reset();
        self.src_lp.reset();
        self.synth_hp.reset();
        self.synth_lp.reset();
        self.env_target.reset();
        self.env_synth.reset();
    }
}

/// Spectral Top Rebuild.
pub struct TopRebuild {
    sr: f64,
    cfg: TopRebuildConfig,
    l: Channel,
    r: Channel,
    /// Odd-harmonic share, 0..1, from `character_pct`.
    odd_mix: f64,
}

impl TopRebuild {
    /// Construct from a sample rate + config.
    pub fn new(sample_rate: f64, cfg: TopRebuildConfig) -> Self {
        let mut m = Self {
            sr: sample_rate,
            cfg,
            l: Channel::new(sample_rate),
            r: Channel::new(sample_rate),
            odd_mix: 0.5,
        };
        m.set_config(cfg);
        m
    }

    /// Update parameters.  Recomputes coefficients; never allocates.
    pub fn set_config(&mut self, cfg: TopRebuildConfig) {
        self.cfg = cfg;
        let nyq = self.sr * 0.5;
        let cross = cfg.crossover_hz.clamp(2_000.0, (nyq * 0.9).max(2_100.0));

        // The source band.  An octave either side of the chosen centre: wide
        // enough to carry the voice's character, narrow enough that its own
        // harmonics land in the target range rather than past Nyquist.
        let src = cfg.source_hz.clamp(500.0, cross * 0.9);
        let src_lo = (src * 0.5).clamp(100.0, nyq * 0.9);
        let src_hi = (src * 2.0).clamp(src_lo * 1.2, nyq * 0.9);

        // The replacement is filtered back into the band it is replacing.
        // The upper limit is deliberately below Nyquist: waveshaping folds
        // anything past it back down as aliasing, which would be a second
        // artefact replacing the first.
        let synth_hi = (nyq * 0.82).min(19_000.0);

        for ch in [&mut self.l, &mut self.r] {
            ch.split.set_freq(cross);
            ch.src_hp.set_coeffs(BiquadCoeffs::high_pass(self.sr, src_lo, 0.707));
            ch.src_lp.set_coeffs(BiquadCoeffs::low_pass(self.sr, src_hi, 0.707));
            ch.synth_hp.set_coeffs(BiquadCoeffs::high_pass(self.sr, cross, 0.707));
            ch.synth_lp.set_coeffs(BiquadCoeffs::low_pass(self.sr, synth_hi, 0.707));
            // Fast rise, slower fall: consonants have to arrive on time, and
            // a fall as fast as the rise would chatter between syllables.
            let follow = cfg.follow_ms.clamp(0.5, 200.0);
            ch.env_target.set(self.sr, follow * 0.25, follow);
            ch.env_synth.set(self.sr, follow * 0.25, follow);
        }

        self.odd_mix = (cfg.character_pct / 100.0).clamp(0.0, 1.0);
    }

    /// False when the module cannot change the signal.
    pub fn is_active(&self) -> bool {
        !self.cfg.bypass && self.cfg.amount_pct > 0.001
    }

    /// Shape one sample into harmonics.
    ///
    /// Cubing triples the frequency; rectifying doubles it.  A 3 kHz source
    /// therefore reaches 9 kHz through the odd path and 6 kHz through the
    /// even one, which is why `character` reads as bright versus warm.
    #[inline]
    fn shape(&self, x: f64) -> f64 {
        let odd = x * x * x;
        // Rectification carries a DC offset; the synth high-pass removes it.
        let even = x.abs();
        odd * self.odd_mix + even * (1.0 - self.odd_mix)
    }

    #[inline]
    fn process_sample(ch: &mut Channel, x: f64, amount: f64, odd_mix: f64) -> f64 {
        let (low, high) = ch.split.split(x);

        // What the damaged band was doing, in level terms.
        let target_env = ch.env_target.process(high);

        // Harmonics, generated from a healthy band and filtered into place.
        let src = ch.src_lp.process(ch.src_hp.process(x));
        let odd = src * src * src;
        let even = src.abs();
        let shaped = odd * odd_mix + even * (1.0 - odd_mix);
        let synth = ch.synth_lp.process(ch.synth_hp.process(shaped));

        // Scale the replacement to the envelope the original band had.  This
        // is what makes it read as restored detail rather than added noise.
        let synth_env = ch.env_synth.process(synth);
        let gain = (target_env / (synth_env + ENV_FLOOR)).min(MAX_MATCH_GAIN);

        low + high * (1.0 - amount) + synth * gain * amount
    }
}

impl StereoModule for TopRebuild {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        if !self.is_active() {
            return;
        }
        let amount = (self.cfg.amount_pct / 100.0).clamp(0.0, 1.0);
        let odd_mix = self.odd_mix;
        for i in 0..left.len().min(right.len()) {
            let l = Self::process_sample(&mut self.l, left[i] as f64, amount, odd_mix);
            let r = Self::process_sample(&mut self.r, right[i] as f64, amount, odd_mix);
            left[i] = l as f32;
            right[i] = r as f32;
        }
    }

    fn reset(&mut self) {
        self.l.reset();
        self.r.reset();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> TopRebuildConfig {
        TopRebuildConfig { amount_pct: 100.0, crossover_hz: 9_000.0, ..TopRebuildConfig::default() }
    }

    const SR: f64 = 48_000.0;

    fn render(c: TopRebuildConfig, gen: impl Fn(usize) -> f32, n: usize) -> Vec<f32> {
        let mut m = TopRebuild::new(SR, c);
        let mut l: Vec<f32> = (0..n).map(&gen).collect();
        let mut r = l.clone();
        for a in (0..n).step_by(512) {
            let b = (a + 512).min(n);
            m.process_stereo(&mut l[a..b], &mut r[a..b]);
        }
        l
    }

    fn sine(hz: f64, amp: f32) -> impl Fn(usize) -> f32 {
        move |i| (2.0 * std::f64::consts::PI * hz * i as f64 / SR).sin() as f32 * amp
    }

    /// Magnitude at one frequency, by Goertzel.
    ///
    /// A one-pole high-pass was the first attempt and it was useless here:
    /// at 6 dB/octave a 3 kHz fundamental leaks straight into a "9 kHz and
    /// above" measurement and swamps the thing being measured.  These tests
    /// are about energy MOVING between two specific frequencies, so they
    /// measure those two frequencies.
    fn magnitude_at(x: &[f32], hz: f64) -> f64 {
        // Second half only: the filters and envelopes need to settle.
        let from = x.len() / 2;
        let n = x.len() - from;
        let w = 2.0 * std::f64::consts::PI * hz / SR;
        let coeff = 2.0 * w.cos();
        let (mut s1, mut s2) = (0.0f64, 0.0f64);
        for &v in &x[from..] {
            let s0 = v as f64 + coeff * s1 - s2;
            s2 = s1;
            s1 = s0;
        }
        ((s1 * s1 + s2 * s2 - coeff * s1 * s2).max(0.0)).sqrt() / (n as f64 * 0.5)
    }

    #[test]
    fn zero_amount_is_exact_passthrough() {
        let mut m = TopRebuild::new(SR, TopRebuildConfig { amount_pct: 0.0, ..cfg() });
        let mut l = [0.3f32, -0.7, 0.1, 0.55];
        let mut r = [0.2f32, 0.4, -0.5, 0.05];
        let (lc, rc) = (l, r);
        m.process_stereo(&mut l, &mut r);
        assert_eq!(l, lc);
        assert_eq!(r, rc);
    }

    #[test]
    fn the_damaged_band_is_removed() {
        // A 12 kHz tone with nothing below it: there is no source to
        // synthesise from, so full amount must take it away rather than
        // leave it or replace it with something invented.
        let n = 1 << 15;
        let wet = render(cfg(), sine(12_000.0, 0.5), n);
        let dry = render(TopRebuildConfig { amount_pct: 0.0, ..cfg() }, sine(12_000.0, 0.5), n);
        let after = magnitude_at(&wet, 12_000.0);
        let before = magnitude_at(&dry, 12_000.0);
        assert!(
            after < before * 0.25,
            "damaged band survived: {after:.4} of {before:.4}",
        );
    }

    #[test]
    fn the_damage_is_replaced_rather_than_merely_cut() {
        // The point of the module.  Feed a healthy 4.5 kHz body plus a quiet
        // 12 kHz "artefact": the artefact must go, and harmonics must appear
        // in its place.  Cutting alone would leave the top empty, which is
        // what makes an ordinary high-cut the wrong tool.
        let n = 1 << 15;
        let material = |i: usize| sine(4_500.0, 0.5)(i) + sine(12_000.0, 0.08)(i);
        let dry = render(TopRebuildConfig { amount_pct: 0.0, ..cfg() }, material, n);
        let wet = render(cfg(), material, n);

        let artefact_before = magnitude_at(&dry, 12_000.0);
        let artefact_after = magnitude_at(&wet, 12_000.0);
        assert!(
            artefact_after < artefact_before * 0.5,
            "the artefact tone stayed: {artefact_after:.4} of {artefact_before:.4}",
        );

        // 4.5 kHz doubled lands at 9 kHz — the even path's contribution.
        let rebuilt_before = magnitude_at(&dry, 9_000.0);
        let rebuilt_after = magnitude_at(&wet, 9_000.0);
        assert!(
            rebuilt_after > rebuilt_before * 4.0 && rebuilt_after > 1e-4,
            "nothing was rebuilt: {rebuilt_before:.5} → {rebuilt_after:.5} at 9 kHz",
        );
    }

    #[test]
    fn the_replacement_follows_the_original_envelope() {
        // The property that decides whether this sounds like restored detail
        // or like a noise generator: the rebuilt band must be PROPORTIONAL
        // to how much the original band had, not a fixed amount of hiss.
        //
        // Measured as a progression rather than against a floor, because a
        // crossover always passes some of the body through — that leakage is
        // real content the module is right to replace, and a pass/fail line
        // drawn near it would be testing the filter slope, not the design.
        let n = 1 << 15;
        let at = |artefact: f32| {
            let out = render(cfg(), move |i| sine(4_500.0, 0.5)(i) + sine(12_000.0, artefact)(i), n);
            magnitude_at(&out, 9_000.0)
        };
        let (none, some, more) = (at(0.0), at(0.04), at(0.16));
        assert!(
            some > none * 1.5 && more > some * 1.5,
            "rebuilt level did not track the original: {none:.5} → {some:.5} → {more:.5}",
        );
    }

    #[test]
    fn digital_silence_gets_no_replacement() {
        // The absolute version of the same promise, and the one that would
        // be most obvious to a listener: a silent passage stays silent.
        let out = render(cfg(), |_| 0.0, 1 << 14);
        assert!(out.iter().all(|&x| x == 0.0), "synthesised something from silence");
    }

    #[test]
    fn character_moves_energy_higher() {
        // Odd harmonics reach further up than even ones — 3x versus 2x.  A
        // 4.5 kHz source therefore lands at 9 kHz through the even path and
        // 13.5 kHz through the odd one.
        let n = 1 << 15;
        let material = |i: usize| sine(4_500.0, 0.5)(i) + sine(12_000.0, 0.08)(i);
        let warm = render(TopRebuildConfig { character_pct: 0.0, ..cfg() }, material, n);
        let bright = render(TopRebuildConfig { character_pct: 100.0, ..cfg() }, material, n);
        let hw = magnitude_at(&warm, 13_500.0);
        let hb = magnitude_at(&bright, 13_500.0);
        assert!(hb > hw * 2.0, "character did not move energy up: warm {hw:.5} vs bright {hb:.5}");
    }

    #[test]
    fn silence_stays_silent() {
        let out = render(cfg(), |_| 0.0, 4096);
        assert!(out.iter().all(|&x| x == 0.0), "module produced output from silence");
    }

    #[test]
    fn a_hostile_config_does_not_produce_nan() {
        for (cross, src, follow, ch) in [
            (0.0, 0.0, 0.0, 0.0),
            (-100.0, -100.0, -1.0, -50.0),
            (1e9, 1e9, 1e9, 1e9),
        ] {
            let c = TopRebuildConfig {
                amount_pct: 100.0, crossover_hz: cross, source_hz: src,
                follow_ms: follow, character_pct: ch, bypass: false,
            };
            let out = render(c, sine(1_000.0, 0.6), 4096);
            assert!(out.iter().all(|x| x.is_finite()), "cross={cross} src={src} gave non-finite");
        }
    }

    #[test]
    fn a_loud_input_does_not_explode() {
        // The envelope match divides by a measured level; the cap on that
        // ratio is what keeps a near-silent synth path from screaming.
        let n = 1 << 15;
        let out = render(cfg(), sine(500.0, 0.95), n);
        let peak = out.iter().fold(0.0f32, |m, x| m.max(x.abs()));
        assert!(peak < 4.0, "output ran away: peak {peak}");
        assert!(out.iter().all(|x| x.is_finite()));
    }
}
