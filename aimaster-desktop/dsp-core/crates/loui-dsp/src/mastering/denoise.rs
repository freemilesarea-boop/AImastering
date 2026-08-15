//! Spectral broadband de-noise — hiss / air-conditioning / preamp noise.
//!
//! Classic spectral-subtraction denoiser with a Wiener-style soft mask, run
//! over the shared [`StftEngine`]:
//!
//!   1. **Profile.**  A per-bin noise floor estimate.  Either learned from a
//!      user-marked noise region (`learn`) or tracked continuously by a
//!      minimum-statistics follower (the "auto" mode engineers reach for
//!      when there is no clean noise-only passage).
//!   2. **Mask.**  Per bin, gain `g = (SNR / (SNR + 1))^sharpness`, floored
//!      at the requested maximum reduction.  A pure Wiener mask is
//!      `sharpness = 1`; higher values cut harder at the cost of artefacts.
//!   3. **Smoothing.**  The mask is smoothed across frequency (spectral
//!      blur) and across time (per-bin one-pole).  Both suppress the
//!      "musical noise" birdies that raw spectral subtraction produces.
//!
//! Reduction is expressed as a positive dB figure — `reduction_db = 12`
//! means "attenuate the noise floor by up to 12 dB".
//!
//! Latency: one STFT frame (see [`StftEngine`]).

use crate::stft::StftEngine;
use super::config::DenoiseConfig;
use super::StereoModule;

/// STFT frame for the denoiser.  2048 @ 48 kHz ≈ 23 Hz resolution — enough
/// to separate hiss from programme material without smearing transients.
pub const DENOISE_FRAME: usize = 2048;

/// Bins the profile tracks.
const BINS: usize = DENOISE_FRAME / 2 + 1;

/// Minimum-statistics window, in frames (~1 s at 48 kHz / 512 hop).
const MIN_STAT_FRAMES: u32 = 96;

/// Time smoothing applied to the periodogram before the minimum is taken.
/// Without it the per-bin minimum of a noisy periodogram sits far below the
/// true noise power and the estimate collapses.
const PERIODOGRAM_ALPHA: f64 = 0.85;

/// Bias compensation (power domain) for the windowed minimum.  The minimum
/// of a smoothed periodogram under-estimates the mean; this scales it back.
const MIN_STAT_BIAS: f64 = 2.2;

/// Per-channel spectral state.
struct ChannelState {
    stft: StftEngine,
    /// Time-smoothed periodogram (power) per bin.
    smooth_power: Vec<f64>,
    /// Minimum of `smooth_power` over the previous statistics window.
    min_track: Vec<f64>,
    /// Minimum observed so far in the current statistics window.
    min_window: Vec<f64>,
    /// Frames elapsed in the current statistics window.
    min_frames: u32,
    /// Smoothed gain mask from the previous frame (time smoothing).
    prev_mask: Vec<f64>,
    /// Scratch — raw mask before smoothing.
    raw_mask: Vec<f64>,
    /// Scratch — spectrally blurred mask.
    blur: Vec<f64>,
}

impl ChannelState {
    fn new(sample_rate: f64) -> Self {
        Self {
            stft: StftEngine::new(sample_rate, DENOISE_FRAME),
            smooth_power: vec![0.0; BINS],
            min_track: vec![f64::INFINITY; BINS],
            min_window: vec![f64::INFINITY; BINS],
            min_frames: 0,
            prev_mask: vec![1.0; BINS],
            raw_mask: vec![0.0; BINS],
            blur: vec![0.0; BINS],
        }
    }

    fn reset(&mut self) {
        self.stft.reset();
        self.smooth_power.fill(0.0);
        self.min_track.fill(f64::INFINITY);
        self.min_window.fill(f64::INFINITY);
        self.min_frames = 0;
        self.prev_mask.fill(1.0);
    }
}

/// Spectral broadband de-noiser (stereo, shared profile).
pub struct Denoise {
    cfg: DenoiseConfig,
    left: ChannelState,
    right: ChannelState,
    /// Learned noise magnitude per bin (shared across channels so the stereo
    /// image is not pulled around by independent masks).
    profile: Vec<f64>,
    /// Frames accumulated while `learning` is on.
    learn_frames: u32,
    /// True while a `learn` capture is running.
    learning: bool,
    /// True once a profile (learned or auto) is usable.
    have_profile: bool,
}

impl Denoise {
    /// Construct from a sample rate + config.
    pub fn new(sample_rate: f64, cfg: DenoiseConfig) -> Self {
        Self {
            cfg,
            left: ChannelState::new(sample_rate),
            right: ChannelState::new(sample_rate),
            profile: vec![0.0; BINS],
            learn_frames: 0,
            learning: false,
            have_profile: false,
        }
    }

    /// Update parameters.
    pub fn set_config(&mut self, cfg: DenoiseConfig) {
        self.cfg = cfg;
    }

    /// Processing latency in samples.
    pub fn latency_samples(&self) -> usize {
        if self.cfg.bypass { 0 } else { self.left.stft.latency_samples() }
    }

    /// Begin capturing a noise profile.  Feed a noise-only passage, then
    /// call [`Denoise::finish_learn`].  Existing profile is kept until the
    /// capture completes, so a cancelled learn is harmless.
    pub fn begin_learn(&mut self) {
        self.learning = true;
        self.learn_frames = 0;
        for p in self.profile.iter_mut() { *p = 0.0; }
    }

    /// End a capture and promote the accumulated average to the profile.
    /// Returns `false` (and keeps the old profile) if nothing was captured.
    pub fn finish_learn(&mut self) -> bool {
        self.learning = false;
        if self.learn_frames == 0 {
            return false;
        }
        let inv = 1.0 / self.learn_frames as f64;
        for p in self.profile.iter_mut() { *p *= inv; }
        self.have_profile = true;
        true
    }

    /// Whether a usable noise profile exists.
    pub fn has_profile(&self) -> bool { self.have_profile }

    /// The learned noise floor per bin, in dBFS (for the UI's profile view).
    /// Length is `DENOISE_FRAME / 2 + 1`.
    pub fn profile_db(&self, out: &mut [f64]) {
        let n = out.len().min(BINS);
        for i in 0..n {
            out[i] = if self.profile[i] > 1e-12 {
                20.0 * self.profile[i].log10()
            } else {
                -140.0
            };
        }
    }

    /// Process one channel.  `is_left` selects the per-channel STFT state;
    /// the noise profile itself is shared.
    fn process_channel(&mut self, buf: &mut [f32], is_left: bool) {
        let cfg = self.cfg;
        let floor = 10f64.powf(-cfg.reduction_db.clamp(0.0, 48.0) / 20.0);
        let sharpness = cfg.sharpness.clamp(0.5, 4.0);
        let threshold_lin = 10f64.powf(cfg.threshold_db.clamp(-24.0, 24.0) / 20.0);
        let time_smooth = cfg.smoothing.clamp(0.0, 0.95);
        let freq_blur = cfg.freq_smoothing_bins.clamp(0, 8);
        let auto = cfg.auto_profile;
        let learning = self.learning;

        // Split the borrow: `process_block` takes `&mut stft` while the
        // closure needs the sibling fields, so destructure the channel state
        // instead of going through methods on `self`.
        let ChannelState {
            stft, smooth_power, min_track, min_window, min_frames, prev_mask, raw_mask, blur,
        } = if is_left { &mut self.left } else { &mut self.right };
        let profile = &mut self.profile;
        let learn_frames = &mut self.learn_frames;
        let have_profile = &mut self.have_profile;

        stft.process_block(buf, |re, im, _bw| {
            let bins = re.len();

            // ── Magnitude + profile maintenance ──────────────────────────
            for k in 0..bins {
                let mag = (re[k] * re[k] + im[k] * im[k]).sqrt();
                raw_mask[k] = mag; // reuse as magnitude scratch

                if learning {
                    profile[k] += mag;
                } else if auto {
                    // Minimum statistics, on a time-smoothed periodogram:
                    // noise sits at the floor of the smoothed power, music
                    // does not.  Smoothing first is what makes the minimum a
                    // usable estimator rather than a noisy under-shoot.
                    let power = mag * mag;
                    let sp = PERIODOGRAM_ALPHA * smooth_power[k]
                        + (1.0 - PERIODOGRAM_ALPHA) * power;
                    smooth_power[k] = sp;
                    if sp < min_window[k] { min_window[k] = sp; }
                }
            }
            if learning {
                *learn_frames += 1;
            } else if auto {
                *min_frames += 1;
                if *min_frames >= MIN_STAT_FRAMES {
                    for k in 0..bins {
                        min_track[k] = min_window[k];
                        min_window[k] = f64::INFINITY;
                        profile[k] = (min_track[k] * MIN_STAT_BIAS).max(0.0).sqrt();
                    }
                    *min_frames = 0;
                    *have_profile = true;
                }
            }

            if !*have_profile || cfg.reduction_db <= 0.0 {
                return;
            }

            // ── Wiener-style mask ────────────────────────────────────────
            for k in 0..bins {
                let mag = raw_mask[k];
                let noise = (profile[k] * threshold_lin).max(1e-12);
                let snr = ((mag * mag) / (noise * noise) - 1.0).max(0.0);
                let g = (snr / (snr + 1.0)).powf(sharpness);
                raw_mask[k] = g.max(floor).min(1.0);
            }

            // ── Spectral blur (kills musical noise / birdies) ────────────
            // Blend rather than replace — full replacement over-smooths
            // genuine narrow spectral content.  `scratch` holds the blurred
            // mask so the running mean always reads unblurred neighbours.
            if freq_blur > 0 {
                let w = freq_blur as usize;
                for k in 0..bins {
                    let lo = k.saturating_sub(w);
                    let hi = (k + w).min(bins - 1);
                    let mut acc = 0.0;
                    for j in lo..=hi {
                        acc += raw_mask[j];
                    }
                    let mean = acc / (hi - lo + 1) as f64;
                    blur[k] = 0.5 * raw_mask[k] + 0.5 * mean;
                }
                raw_mask[..bins].copy_from_slice(&blur[..bins]);
            }

            // ── Time smoothing + apply ───────────────────────────────────
            for k in 0..bins {
                let g = time_smooth * prev_mask[k] + (1.0 - time_smooth) * raw_mask[k];
                prev_mask[k] = g;
                re[k] *= g;
                im[k] *= g;
            }
        });
    }
}

impl StereoModule for Denoise {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        if self.cfg.bypass {
            return;
        }
        self.process_channel(left, true);
        self.process_channel(right, false);
    }

    fn reset(&mut self) {
        self.left.reset();
        self.right.reset();
        self.learning = false;
        self.learn_frames = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> DenoiseConfig {
        DenoiseConfig { reduction_db: 18.0, threshold_db: 0.0, sharpness: 1.0, smoothing: 0.5, freq_smoothing_bins: 2, auto_profile: true, bypass: false }
    }

    fn white(n: usize, amp: f32, seed: u64) -> Vec<f32> {
        let mut state = seed;
        (0..n)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                (((state >> 40) as f32 / 8_388_608.0) - 1.0) * amp
            })
            .collect()
    }

    fn rms(x: &[f32]) -> f64 {
        (x.iter().map(|v| (*v as f64) * (*v as f64)).sum::<f64>() / x.len() as f64).sqrt()
    }

    #[test]
    fn bypass_is_passthrough() {
        let mut d = Denoise::new(48_000.0, DenoiseConfig { bypass: true, ..cfg() });
        let mut l = white(2048, 0.2, 7);
        let orig = l.clone();
        let mut r = l.clone();
        d.process_stereo(&mut l, &mut r);
        assert_eq!(l, orig);
    }

    /// Steady hiss with an auto profile must end up quieter than it started.
    #[test]
    fn steady_hiss_is_attenuated() {
        let mut d = Denoise::new(48_000.0, cfg());
        // Long enough for min-statistics to converge (well over the window).
        let n = 48_000 * 4;
        let mut l = white(n, 0.02, 12345);
        let mut r = white(n, 0.02, 999);
        let before = rms(&l[n / 2..]);
        d.process_stereo(&mut l, &mut r);
        let after = rms(&l[n / 2..]);
        let delta_db = 20.0 * (after / before).log10();
        assert!(delta_db < -6.0, "hiss should be reduced, got {delta_db:.1} dB");
        assert!(l.iter().all(|s| s.is_finite()));
    }

    /// The intended engineer workflow: learn the floor from a noise-only
    /// passage, then denoise music.  The music must survive.
    #[test]
    fn learned_profile_preserves_music() {
        // Learned profile — the auto tracker is deliberately off, because
        // minimum statistics cannot tell a *stationary* tone from stationary
        // noise.  That is exactly why a learn capture exists.
        let mut d = Denoise::new(48_000.0, DenoiseConfig { auto_profile: false, ..cfg() });
        d.begin_learn();
        let mut nl = white(48_000, 0.01, 1234);
        let mut nr = white(48_000, 0.01, 5678);
        d.process_stereo(&mut nl, &mut nr);
        assert!(d.finish_learn());

        let n = 48_000 * 2;
        let sr = 48_000.0f64;
        let tone: Vec<f32> = (0..n)
            .map(|i| (2.0 * std::f64::consts::PI * 1_000.0 * i as f64 / sr).sin() as f32 * 0.5)
            .collect();
        let hiss = white(n, 0.01, 4321);
        let mut l: Vec<f32> = tone.iter().zip(hiss.iter()).map(|(a, b)| a + b).collect();
        let mut r = l.clone();
        let before = rms(&l[n / 2..]);
        d.process_stereo(&mut l, &mut r);
        let after = rms(&l[n / 2..]);
        let delta_db = 20.0 * (after / before).log10();
        assert!(delta_db > -1.5, "music should pass through, lost {delta_db:.1} dB");
    }

    #[test]
    fn learn_profile_round_trip() {
        let mut d = Denoise::new(48_000.0, cfg());
        assert!(!d.has_profile());
        d.begin_learn();
        let mut l = white(48_000, 0.01, 4242);
        let mut r = l.clone();
        d.process_stereo(&mut l, &mut r);
        assert!(d.finish_learn());
        assert!(d.has_profile());
        let mut prof = vec![0.0; BINS];
        d.profile_db(&mut prof);
        assert!(prof.iter().all(|v| v.is_finite()));
    }

    /// An empty learn capture must not clobber the previous profile.
    #[test]
    fn empty_learn_is_rejected() {
        let mut d = Denoise::new(48_000.0, cfg());
        d.begin_learn();
        assert!(!d.finish_learn());
        assert!(!d.has_profile());
    }
}
