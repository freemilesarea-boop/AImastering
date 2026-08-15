//! Spectral stage — Match EQ, Spectral Shaper, Stabilizer and the Tonal
//! Balance readout, all sharing a single STFT pass.
//!
//! These four features all want the same thing: the magnitude spectrum of
//! the signal, frame by frame.  Giving each its own STFT would cost four
//! transforms and four frames of latency.  Running them as one stage costs
//! one of each, and lets them compose the way an engineer expects — the
//! per-bin gains multiply, so a Stabilizer move and a Match EQ move add in
//! dB rather than fighting over the same filter.
//!
//! ```text
//!   FFT ─► source average ─┬─► Match EQ gain ─┐
//!                          ├─► Shaper gain    ├─► × ─► IFFT
//!                          └─► Stabilizer gain┘
//!                          └─► Tonal Balance readout (metering only)
//! ```
//!
//! **Match EQ** compares a long-term average of the source against a
//! reference curve and applies the difference, scaled by `amount`.  This is
//! how you make a mix sit in the same tonal space as a reference track.
//!
//! **Spectral Shaper** works per frame, not on the average: any bin sticking
//! out above its own spectral neighbourhood by more than `threshold_db` is
//! pulled back down.  That is what tames a resonant ring or a harsh band
//! that only appears on some notes, without a static EQ notch.
//!
//! **Stabilizer** moves the long-term average towards a target tilt, which
//! smooths out the broad tonal lumps a mix accumulates.  Slower and gentler
//! than Match EQ, and it does not need a reference.
//!
//! All curves live on a shared 32-band logarithmic grid (`CURVE_BANDS`),
//! which is also what the UI draws and what a reference profile stores.

use crate::stft::StftEngine;
use super::config::SpectralConfig;
use super::StereoModule;

/// STFT frame for the spectral stage.
pub const SPECTRAL_FRAME: usize = 2048;
/// Half-spectrum bins.
const BINS: usize = SPECTRAL_FRAME / 2 + 1;

/// Bands in the shared logarithmic curve grid.
pub const CURVE_BANDS: usize = 32;
/// Lowest band centre, Hz.
const CURVE_LO_HZ: f64 = 20.0;
/// Highest band centre, Hz.
const CURVE_HI_HZ: f64 = 20_000.0;

/// Time constant of the long-term source average, in frames.  ~2 s at
/// 48 kHz with a 512-sample hop.
const AVG_FRAMES: f64 = 190.0;

/// Maximum move any single spectral feature may apply, in dB.  A hard stop
/// so a pathological curve can never turn into a noise blast.
const MAX_MOVE_DB: f64 = 18.0;

/// Centre frequency of curve band `i`.
pub fn curve_band_hz(i: usize) -> f64 {
    let t = i as f64 / (CURVE_BANDS - 1) as f64;
    CURVE_LO_HZ * (CURVE_HI_HZ / CURVE_LO_HZ).powf(t)
}

/// Per-channel STFT + spectral scratch.
struct ChannelState {
    stft: StftEngine,
    /// Smoothed magnitude spectrum used by the shaper's neighbourhood test.
    frame_mag: Vec<f64>,
    /// Blurred copy of `frame_mag` — the local spectral "floor".
    neighbourhood: Vec<f64>,
    /// Final per-bin gain applied this frame.
    gain: Vec<f64>,
}

impl ChannelState {
    fn new(sample_rate: f64) -> Self {
        Self {
            stft: StftEngine::new(sample_rate, SPECTRAL_FRAME),
            frame_mag: vec![0.0; BINS],
            neighbourhood: vec![0.0; BINS],
            gain: vec![1.0; BINS],
        }
    }

    fn reset(&mut self) {
        self.stft.reset();
        self.frame_mag.fill(0.0);
        self.neighbourhood.fill(0.0);
        self.gain.fill(1.0);
    }
}

/// The shared spectral stage.
pub struct Spectral {
    cfg: SpectralConfig,
    left: ChannelState,
    right: ChannelState,
    /// Long-term average source level per curve band, in dB.  Shared across
    /// channels so the stage never pulls the stereo image around.
    source_db: [f64; CURVE_BANDS],
    /// Frames folded into `source_db` so far (drives the warm-up ramp).
    avg_frames: u32,
    /// Which curve band each FFT bin belongs to.
    bin_band: Vec<usize>,
    /// Scratch: energy accumulator per curve band.
    band_acc: [f64; CURVE_BANDS],
    /// Scratch: bin count per curve band.
    band_count: [u32; CURVE_BANDS],
    /// Per-band correction currently applied, in dB (Match EQ + Stabilizer).
    applied_db: [f64; CURVE_BANDS],
}

/// Map an FFT bin to its curve band.
fn band_for_hz(hz: f64) -> usize {
    if hz <= CURVE_LO_HZ {
        return 0;
    }
    let t = (hz / CURVE_LO_HZ).log10() / (CURVE_HI_HZ / CURVE_LO_HZ).log10();
    ((t * (CURVE_BANDS - 1) as f64).round() as usize).min(CURVE_BANDS - 1)
}

impl Spectral {
    /// Construct from a sample rate + config.
    pub fn new(sample_rate: f64, cfg: SpectralConfig) -> Self {
        let bin_width = sample_rate / SPECTRAL_FRAME as f64;
        let bin_band = (0..BINS).map(|k| band_for_hz(k as f64 * bin_width)).collect();
        Self {
            cfg,
            left: ChannelState::new(sample_rate),
            right: ChannelState::new(sample_rate),
            source_db: [f64::NEG_INFINITY; CURVE_BANDS],
            avg_frames: 0,
            bin_band,
            band_acc: [0.0; CURVE_BANDS],
            band_count: [0; CURVE_BANDS],
            applied_db: [0.0; CURVE_BANDS],
        }
    }

    /// Update parameters.
    pub fn set_config(&mut self, cfg: SpectralConfig) {
        self.cfg = cfg;
    }

    /// Processing latency in samples.  Zero when nothing in the stage is
    /// active, since the STFT is skipped entirely in that case.
    pub fn latency_samples(&self) -> usize {
        if self.is_active() { self.left.stft.latency_samples() } else { 0 }
    }

    /// True when at least one spectral feature would change the signal.
    fn is_active(&self) -> bool {
        if self.cfg.bypass {
            return false;
        }
        let c = &self.cfg;
        (c.match_enabled && c.match_amount_pct > 0.0)
            || (c.shaper_enabled && c.shaper_amount_pct > 0.0)
            || (c.stabilizer_enabled && c.stabilizer_amount_pct > 0.0)
            || c.analysis_only
    }

    /// The measured long-term source curve, in dB per curve band.  This is
    /// the Tonal Balance readout; `-inf` for bands not yet observed.
    pub fn source_curve_db(&self) -> [f64; CURVE_BANDS] { self.source_db }

    /// The correction currently applied, in dB per curve band.
    pub fn applied_curve_db(&self) -> [f64; CURVE_BANDS] { self.applied_db }

    /// Deviation of the source curve from the configured target, in dB per
    /// curve band.  This is what a tonal-balance display draws.  Bands with
    /// no observation yet read 0.
    pub fn tonal_deviation_db(&self) -> [f64; CURVE_BANDS] {
        let mut out = [0.0; CURVE_BANDS];
        let target = self.normalised_target_db();
        let src = self.normalised_source_db();
        for i in 0..CURVE_BANDS {
            if src[i].is_finite() && target[i].is_finite() {
                out[i] = src[i] - target[i];
            }
        }
        out
    }

    /// Whether the long-term average has seen enough frames to be trusted.
    pub fn analysis_ready(&self) -> bool {
        self.avg_frames as f64 >= AVG_FRAMES * 0.5
    }

    /// Source curve normalised to zero mean (so absolute level does not
    /// leak into a tonal comparison).
    fn normalised_source_db(&self) -> [f64; CURVE_BANDS] {
        normalise(&self.source_db)
    }

    /// Target curve normalised the same way.  When Match EQ is off, the
    /// target is the Stabilizer's tilt line rather than a reference.
    fn normalised_target_db(&self) -> [f64; CURVE_BANDS] {
        if self.cfg.match_enabled {
            normalise(&self.cfg.target_curve_db)
        } else {
            let mut tilt = [0.0; CURVE_BANDS];
            let slope = self.cfg.stabilizer_tilt_db_per_oct;
            let base = curve_band_hz(0);
            for (i, t) in tilt.iter_mut().enumerate() {
                *t = slope * (curve_band_hz(i) / base).log2();
            }
            normalise(&tilt)
        }
    }
}

/// Subtract the mean of the finite entries, leaving a shape rather than a level.
fn normalise(curve: &[f64; CURVE_BANDS]) -> [f64; CURVE_BANDS] {
    let mut sum = 0.0;
    let mut n = 0u32;
    for v in curve.iter() {
        if v.is_finite() {
            sum += *v;
            n += 1;
        }
    }
    let mean = if n > 0 { sum / n as f64 } else { 0.0 };
    let mut out = [f64::NEG_INFINITY; CURVE_BANDS];
    for (i, v) in curve.iter().enumerate() {
        if v.is_finite() {
            out[i] = v - mean;
        }
    }
    out
}

impl Spectral {
    /// Compute the per-band correction from Match EQ + Stabilizer.
    fn update_correction(&mut self) {
        let c = self.cfg;
        let src = self.normalised_source_db();
        let mut corr = [0.0f64; CURVE_BANDS];

        if c.match_enabled && c.match_amount_pct > 0.0 {
            let target = normalise(&c.target_curve_db);
            let amount = (c.match_amount_pct / 100.0).clamp(0.0, 1.0);
            for b in 0..CURVE_BANDS {
                if src[b].is_finite() && target[b].is_finite() {
                    corr[b] += ((target[b] - src[b]) * amount)
                        .clamp(-c.match_max_move_db, c.match_max_move_db);
                }
            }
        }

        if c.stabilizer_enabled && c.stabilizer_amount_pct > 0.0 {
            let mut tilt = [0.0; CURVE_BANDS];
            let base = curve_band_hz(0);
            for (i, t) in tilt.iter_mut().enumerate() {
                *t = c.stabilizer_tilt_db_per_oct * (curve_band_hz(i) / base).log2();
            }
            let target = normalise(&tilt);
            let amount = (c.stabilizer_amount_pct / 100.0).clamp(0.0, 1.0);
            for b in 0..CURVE_BANDS {
                if src[b].is_finite() && target[b].is_finite() {
                    corr[b] += ((target[b] - src[b]) * amount)
                        .clamp(-c.stabilizer_max_move_db, c.stabilizer_max_move_db);
                }
            }
        }

        // Smooth across bands so the correction is a curve, not a comb.
        let w = c.curve_smoothing_bands.clamp(0, 6) as usize;
        if w > 0 {
            let mut smoothed = [0.0f64; CURVE_BANDS];
            for b in 0..CURVE_BANDS {
                let lo = b.saturating_sub(w);
                let hi = (b + w).min(CURVE_BANDS - 1);
                let mut acc = 0.0;
                for j in lo..=hi { acc += corr[j]; }
                smoothed[b] = acc / (hi - lo + 1) as f64;
            }
            corr = smoothed;
        }

        for b in 0..CURVE_BANDS {
            self.applied_db[b] = corr[b].clamp(-MAX_MOVE_DB, MAX_MOVE_DB);
        }
    }
}

impl StereoModule for Spectral {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        if !self.is_active() {
            return;
        }

        // The left channel drives analysis (and the shared correction); the
        // right channel reuses the same correction so the image is stable.
        let analysis_only = self.cfg.analysis_only;
        let shaper_on = self.cfg.shaper_enabled && self.cfg.shaper_amount_pct > 0.0 && !analysis_only;
        let shaper_threshold = self.cfg.shaper_threshold_db.clamp(1.0, 24.0);
        let shaper_amount = (self.cfg.shaper_amount_pct / 100.0).clamp(0.0, 1.0);
        let shaper_lo_band = band_for_hz(self.cfg.shaper_low_hz.max(20.0));
        let shaper_hi_band = band_for_hz(self.cfg.shaper_high_hz.max(20.0));
        let blur = self.cfg.shaper_blur_bins.clamp(1, 64) as usize;

        for pass in 0..2 {
            let is_left = pass == 0;
            let buf: &mut [f32] = if is_left { left } else { right };

            // Analysis and correction updates run on the left pass only.
            if is_left {
                // Split the borrow: `process_block` needs `&mut stft` while the
                // closure writes the sibling scratch buffers.
                let ChannelState { stft, frame_mag, neighbourhood, gain } = &mut self.left;
                let bin_band = &self.bin_band;
                let source_db = &mut self.source_db;
                let band_acc = &mut self.band_acc;
                let band_count = &mut self.band_count;
                let avg_frames = &mut self.avg_frames;
                let applied_db = &self.applied_db;

                stft.process_block(buf, |re, im, _bw| {
                    let bins = re.len();
                    for k in 0..bins {
                        frame_mag[k] = (re[k] * re[k] + im[k] * im[k]).sqrt();
                    }

                    // ── Long-term band average ───────────────────────────
                    band_acc.fill(0.0);
                    band_count.fill(0);
                    for k in 0..bins {
                        let b = bin_band[k];
                        band_acc[b] += frame_mag[k] * frame_mag[k];
                        band_count[b] += 1;
                    }
                    *avg_frames = avg_frames.saturating_add(1);
                    let alpha = (1.0 / (*avg_frames as f64).min(AVG_FRAMES))
                        .clamp(1.0 / AVG_FRAMES, 1.0);
                    for b in 0..CURVE_BANDS {
                        if band_count[b] == 0 { continue; }
                        let power = band_acc[b] / band_count[b] as f64;
                        let db = 10.0 * power.max(1e-20).log10();
                        source_db[b] = if source_db[b].is_finite() {
                            source_db[b] + alpha * (db - source_db[b])
                        } else {
                            db
                        };
                    }

                    // ── Per-bin gain: curve correction ───────────────────
                    for k in 0..bins {
                        gain[k] = 10f64.powf(applied_db[bin_band[k]] / 20.0);
                    }

                    // ── Per-bin gain: spectral shaper ────────────────────
                    if shaper_on {
                        apply_shaper(
                            frame_mag, neighbourhood, gain, bins, bin_band, blur,
                            shaper_lo_band, shaper_hi_band, shaper_threshold, shaper_amount,
                        );
                    }

                    if !analysis_only {
                        for k in 0..bins {
                            re[k] *= gain[k];
                            im[k] *= gain[k];
                        }
                    }
                });
            } else {
                let ChannelState { stft, frame_mag, neighbourhood, gain } = &mut self.right;
                let bin_band = &self.bin_band;
                let applied_db = &self.applied_db;

                stft.process_block(buf, |re, im, _bw| {
                    let bins = re.len();
                    for k in 0..bins {
                        frame_mag[k] = (re[k] * re[k] + im[k] * im[k]).sqrt();
                        gain[k] = 10f64.powf(applied_db[bin_band[k]] / 20.0);
                    }
                    if shaper_on {
                        apply_shaper(
                            frame_mag, neighbourhood, gain, bins, bin_band, blur,
                            shaper_lo_band, shaper_hi_band, shaper_threshold, shaper_amount,
                        );
                    }
                    if !analysis_only {
                        for k in 0..bins {
                            re[k] *= gain[k];
                            im[k] *= gain[k];
                        }
                    }
                });
            }
        }

        // Recompute the curve correction for the next block from the average
        // this block just refined.
        self.update_correction();
    }

    fn reset(&mut self) {
        self.left.reset();
        self.right.reset();
        self.source_db = [f64::NEG_INFINITY; CURVE_BANDS];
        self.avg_frames = 0;
        self.applied_db = [0.0; CURVE_BANDS];
    }
}

/// Pull down bins that stick out above their spectral neighbourhood.
#[allow(clippy::too_many_arguments)]
fn apply_shaper(
    mag: &[f64], neighbourhood: &mut [f64], gain: &mut [f64], bins: usize,
    bin_band: &[usize], blur: usize, lo_band: usize, hi_band: usize,
    threshold_db: f64, amount: f64,
) {
    // Local spectral floor — the moving average that "sticking out" is
    // judged against.  Computed with a sliding window sum rather than a
    // running accumulator so f64 cancellation cannot drift over a long run.
    for k in 0..bins {
        let lo = k.saturating_sub(blur);
        let hi = (k + blur).min(bins - 1);
        let mut sum = 0.0;
        for j in lo..=hi { sum += mag[j]; }
        neighbourhood[k] = sum / (hi - lo + 1) as f64;
    }

    for k in 0..bins {
        let band = bin_band[k];
        if band < lo_band || band > hi_band {
            continue;
        }
        let floor = neighbourhood[k].max(1e-12);
        let excess_db = 20.0 * (mag[k] / floor).max(1e-12).log10();
        if excess_db > threshold_db {
            let cut = ((excess_db - threshold_db) * amount).min(MAX_MOVE_DB);
            gain[k] *= 10f64.powf(-cut / 20.0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> SpectralConfig {
        SpectralConfig::default()
    }

    fn tone(n: usize, freq: f64, sr: f64, amp: f32) -> Vec<f32> {
        (0..n).map(|i| (2.0 * std::f64::consts::PI * freq * i as f64 / sr).sin() as f32 * amp).collect()
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
    fn inactive_stage_is_bit_transparent() {
        let mut s = Spectral::new(48_000.0, cfg());
        let mut l = tone(4096, 1_000.0, 48_000.0, 0.4);
        let orig = l.clone();
        let mut r = l.clone();
        s.process_stereo(&mut l, &mut r);
        assert_eq!(l, orig, "an inactive spectral stage must not even add latency");
        assert_eq!(s.latency_samples(), 0);
    }

    #[test]
    fn bypass_wins_over_enabled_features() {
        let mut c = cfg();
        c.match_enabled = true;
        c.match_amount_pct = 100.0;
        c.bypass = true;
        let mut s = Spectral::new(48_000.0, c);
        let mut l = tone(4096, 1_000.0, 48_000.0, 0.4);
        let orig = l.clone();
        let mut r = l.clone();
        s.process_stereo(&mut l, &mut r);
        assert_eq!(l, orig);
    }

    /// Analysis-only mode must measure without touching the audio (beyond
    /// the STFT's own delay).
    #[test]
    fn analysis_only_measures_without_processing() {
        let mut c = cfg();
        c.analysis_only = true;
        let mut s = Spectral::new(48_000.0, c);
        let n = 48_000 * 2;
        let input = white(n, 0.2, 99);
        let mut l = input.clone();
        let mut r = input.clone();
        s.process_stereo(&mut l, &mut r);
        assert!(s.analysis_ready());
        // Delayed reconstruction, not silence and not distortion.
        let mut worst = 0.0f32;
        for i in SPECTRAL_FRAME..n {
            worst = worst.max((l[i] - input[i - SPECTRAL_FRAME]).abs());
        }
        assert!(worst < 1e-3, "analysis-only altered the signal by {worst}");
    }

    /// White noise should read as a roughly flat tonal curve.
    #[test]
    fn white_noise_reads_flat() {
        let mut c = cfg();
        c.analysis_only = true;
        let mut s = Spectral::new(48_000.0, c);
        let mut l = white(48_000 * 2, 0.2, 4242);
        let mut r = white(48_000 * 2, 0.2, 8888);
        s.process_stereo(&mut l, &mut r);
        let curve = s.source_curve_db();
        // Ignore the lowest bands — at 23 Hz resolution they hold one bin.
        let mid: Vec<f64> = (8..CURVE_BANDS).map(|i| curve[i]).filter(|v| v.is_finite()).collect();
        let mean = mid.iter().sum::<f64>() / mid.len() as f64;
        let spread = mid.iter().fold(0.0f64, |a, v| a.max((v - mean).abs()));
        assert!(spread < 6.0, "white noise curve spread {spread:.1} dB, curve {curve:?}");
    }

    /// Match EQ towards a bright target must actually lift the top.
    #[test]
    fn match_eq_moves_towards_target() {
        let mut c = cfg();
        c.match_enabled = true;
        c.match_amount_pct = 100.0;
        c.match_max_move_db = 12.0;
        // Target: +1.5 dB per octave tilt (much brighter than white noise).
        let base = curve_band_hz(0);
        for i in 0..CURVE_BANDS {
            c.target_curve_db[i] = 1.5 * (curve_band_hz(i) / base).log2();
        }
        let mut s = Spectral::new(48_000.0, c);
        let n = 48_000 * 4;
        let mut l = white(n, 0.2, 31337);
        let mut r = white(n, 0.2, 1234);
        s.process_stereo(&mut l, &mut r);

        let applied = s.applied_curve_db();
        // Low bands should be cut, high bands boosted.
        assert!(applied[10] < -1.0, "low band not cut: {}", applied[10]);
        assert!(applied[28] > 1.0, "high band not boosted: {}", applied[28]);
    }

    /// The spectral shaper must pull down a resonant tone sitting on top of
    /// broadband material, without flattening the material itself.
    #[test]
    fn shaper_tames_a_resonance() {
        let mut c = cfg();
        c.shaper_enabled = true;
        c.shaper_amount_pct = 100.0;
        c.shaper_threshold_db = 6.0;
        let mut s = Spectral::new(48_000.0, c);

        let n = 48_000 * 2;
        let noise = white(n, 0.05, 777);
        let ring = tone(n, 3_000.0, 48_000.0, 0.5);
        let input: Vec<f32> = noise.iter().zip(ring.iter()).map(|(a, b)| a + b).collect();
        let mut l = input.clone();
        let mut r = input.clone();
        s.process_stereo(&mut l, &mut r);

        let before = rms(&input[n / 2..]);
        let after = rms(&l[n / 2..]);
        let delta = 20.0 * (after / before).log10();
        assert!(delta < -3.0, "resonance should be reduced, total moved {delta:.1} dB");
        assert!(l.iter().all(|v| v.is_finite()));
    }

    /// Broadband material alone must survive the shaper — nothing sticks out.
    #[test]
    fn shaper_leaves_broadband_alone() {
        let mut c = cfg();
        c.shaper_enabled = true;
        c.shaper_amount_pct = 100.0;
        c.shaper_threshold_db = 9.0;
        let mut s = Spectral::new(48_000.0, c);
        let n = 48_000 * 2;
        let input = white(n, 0.2, 5150);
        let mut l = input.clone();
        let mut r = input.clone();
        s.process_stereo(&mut l, &mut r);
        let delta = 20.0 * (rms(&l[n / 2..]) / rms(&input[n / 2..])).log10();
        assert!(delta.abs() < 2.0, "broadband moved {delta:.1} dB");
    }

    #[test]
    fn tonal_deviation_is_zero_against_its_own_curve() {
        let mut c = cfg();
        c.analysis_only = true;
        c.match_enabled = true;
        let mut s = Spectral::new(48_000.0, c);
        let mut l = white(48_000 * 2, 0.2, 606);
        let mut r = l.clone();
        s.process_stereo(&mut l, &mut r);
        // Feed the measured curve back in as the target.
        let measured = s.source_curve_db();
        let mut c2 = s.cfg;
        c2.target_curve_db = measured;
        s.set_config(c2);
        let dev = s.tonal_deviation_db();
        let worst = dev.iter().fold(0.0f64, |a, v| a.max(v.abs()));
        assert!(worst < 1e-6, "self-deviation should be zero, got {worst}");
    }

    #[test]
    fn output_stays_finite_under_extreme_curves() {
        let mut c = cfg();
        c.match_enabled = true;
        c.match_amount_pct = 100.0;
        c.match_max_move_db = 24.0;
        c.shaper_enabled = true;
        c.shaper_amount_pct = 100.0;
        c.stabilizer_enabled = true;
        c.stabilizer_amount_pct = 100.0;
        for i in 0..CURVE_BANDS {
            c.target_curve_db[i] = if i % 2 == 0 { 40.0 } else { -40.0 };
        }
        let mut s = Spectral::new(48_000.0, c);
        let mut l = white(48_000, 0.9, 13);
        let mut r = white(48_000, 0.9, 17);
        s.process_stereo(&mut l, &mut r);
        assert!(l.iter().all(|v| v.is_finite()));
        assert!(r.iter().all(|v| v.is_finite()));
    }
}
