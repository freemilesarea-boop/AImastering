//! EBU R128 / ITU-R BS.1770-4 LUFS meter.
//!
//! Implements:
//!   * Momentary loudness — 400 ms window (overlapped, hop = 100 ms).
//!   * Short-term loudness — 3-second window (overlapped, hop = 100 ms).
//!   * Integrated loudness — gated mean over 400-ms blocks
//!     (absolute gate -70 LUFS, relative gate -10 LU below pre-gate average).
//!   * Loudness Range (LRA) — gated 3-second blocks, 10th vs 95th percentile
//!     (absolute gate -70 LUFS, relative gate -20 LU below ungated mean).
//!
//! Each block's mean-square is computed during streaming; momentary value
//! is `mean of last 4 sub-block MS values` because the 400 ms window equals
//! 4 × 100 ms hops.  Short-term value uses 30 hops.
//!
//! No allocation in `process_frame`.  History buffers are pre-allocated to
//! `MAX_HISTORY_BLOCKS` blocks (large enough for a 10-minute analysis at
//! 100 ms hop).

use crate::k_weighting::KWeightingBank;

/// Block hop = 100 ms.  Both momentary and short-term windows are integer
/// multiples of this hop.
pub const BLOCK_HOP_MS: f64 = 100.0;

/// Maximum number of 100-ms blocks kept in history (≈ 60 minutes at 100 ms hop).
pub const MAX_HISTORY_BLOCKS: usize = 36_000;

/// Absolute gate threshold (BS.1770-4 §5.1.3).
pub const ABS_GATE_LUFS: f64 = -70.0;
/// Relative gate offset for integrated LUFS (BS.1770-4 §5.1.3).
pub const REL_GATE_OFFSET_LU: f64 = -10.0;
/// Relative gate offset for LRA (EBU R128 §3.6).
pub const LRA_REL_GATE_OFFSET_LU: f64 = -20.0;

/// Channel weights from BS.1770-4 table 1.
///
/// Index: number of channels (1..=8) → vector of channel weights.
pub fn channel_weights(channels: usize) -> Vec<f64> {
    match channels {
        1 => vec![1.0],
        2 => vec![1.0, 1.0],
        3 => vec![1.0, 1.0, 1.0],
        4 => vec![1.0, 1.0, 1.41, 1.41],
        5 => vec![1.0, 1.0, 1.0, 1.41, 1.41],
        6 => vec![1.0, 1.0, 1.0, 0.0, 1.41, 1.41],   // 5.1 (LFE skipped)
        7 => vec![1.0, 1.0, 1.0, 0.0, 1.41, 1.41, 1.41],
        8 => vec![1.0, 1.0, 1.0, 0.0, 1.41, 1.41, 1.41, 1.41],
        _ => vec![1.0; channels],
    }
}

/// EBU R128 / BS.1770-4 LUFS analyzer.
///
/// Streaming: feed frames; query metrics at any time.
#[derive(Debug)]
pub struct LufsAnalyzer {
    sample_rate: f64,
    channels: usize,
    weights: Vec<f64>,
    k: KWeightingBank,
    /// 100-ms block size in samples.
    block_samples: usize,
    /// Per-channel sum-of-squares accumulator for the current block.
    block_sum_sq: Vec<f64>,
    /// Samples processed within the current block.
    block_samples_seen: usize,
    /// History of (weighted) mean-squares per 100-ms block.
    block_ms_history: Vec<f64>,
}

impl LufsAnalyzer {
    /// Construct a new analyzer.
    pub fn new(sample_rate: f64, channels: usize) -> Self {
        assert!(sample_rate > 0.0 && channels > 0);
        let block_samples = (sample_rate * BLOCK_HOP_MS / 1000.0).round() as usize;
        let weights = channel_weights(channels);
        Self {
            sample_rate,
            channels,
            weights,
            k: KWeightingBank::new(sample_rate, channels),
            block_samples,
            block_sum_sq: vec![0.0; channels],
            block_samples_seen: 0,
            block_ms_history: Vec::with_capacity(MAX_HISTORY_BLOCKS),
        }
    }

    /// Reset all state.
    pub fn reset(&mut self) {
        self.k.reset();
        for v in self.block_sum_sq.iter_mut() { *v = 0.0; }
        self.block_samples_seen = 0;
        self.block_ms_history.clear();
    }

    /// Channel count.
    pub fn channels(&self) -> usize { self.channels }

    /// Sample rate.
    pub fn sample_rate(&self) -> f64 { self.sample_rate }

    /// How many 100-ms blocks have completed so far.
    pub fn blocks_observed(&self) -> usize { self.block_ms_history.len() }

    /// Process a planar block.  `channels.len()` must equal `self.channels()`,
    /// and all channel slices must have the same length.
    pub fn process_planar(&mut self, channels: &[&[f32]]) {
        assert_eq!(channels.len(), self.channels);
        if channels.is_empty() {
            return;
        }
        let frames = channels[0].len();
        for c in 1..channels.len() {
            debug_assert_eq!(channels[c].len(), frames);
        }

        // Per-frame work loop.  No allocation.
        let mut weighted = [0.0f64; crate::buffer::MAX_CHANNELS];
        let mut out = [0.0f64; crate::buffer::MAX_CHANNELS];
        let n_ch = self.channels.min(crate::buffer::MAX_CHANNELS);
        for i in 0..frames {
            for c in 0..n_ch {
                weighted[c] = channels[c][i] as f64;
            }
            self.k.process_frame(&weighted[..n_ch], &mut out[..n_ch]);
            for c in 0..n_ch {
                self.block_sum_sq[c] += out[c] * out[c];
            }
            self.block_samples_seen += 1;
            if self.block_samples_seen >= self.block_samples {
                self.commit_block();
            }
        }
    }

    /// Convenience: process an `AudioBlockRef`.
    pub fn process(&mut self, block: crate::buffer::AudioBlockRef<'_>) {
        assert_eq!(block.channels(), self.channels);
        let mut chans: [&[f32]; 8] = [&[]; 8];
        let n = self.channels.min(8);
        for c in 0..n {
            chans[c] = block.channel(c);
        }
        self.process_planar(&chans[..n]);
    }

    /// Finalise the current partial block (if any).  Useful at end of input.
    pub fn flush(&mut self) {
        if self.block_samples_seen > 0 {
            self.commit_block();
        }
    }

    fn commit_block(&mut self) {
        // Weighted mean-square: sum_c (w_c · sum_sq_c / n)
        let n = self.block_samples_seen as f64;
        if n <= 0.0 {
            return;
        }
        let mut weighted_ms = 0.0f64;
        for c in 0..self.channels {
            let mean_sq = self.block_sum_sq[c] / n;
            weighted_ms += self.weights[c] * mean_sq;
            self.block_sum_sq[c] = 0.0;
        }
        if self.block_ms_history.len() < MAX_HISTORY_BLOCKS {
            self.block_ms_history.push(weighted_ms);
        }
        self.block_samples_seen = 0;
    }

    /// Convert weighted mean-square to LUFS (BS.1770-4 §5.1.2).
    fn ms_to_lufs(ms: f64) -> f64 {
        if ms <= 0.0 {
            f64::NEG_INFINITY
        } else {
            -0.691 + 10.0 * ms.log10()
        }
    }

    /// Momentary loudness — last 4 blocks (400 ms) sum / 4.
    pub fn momentary_lufs(&self) -> f64 {
        let blocks = &self.block_ms_history;
        if blocks.len() < 4 {
            return f64::NEG_INFINITY;
        }
        let len = blocks.len();
        let sum: f64 = blocks[len - 4..].iter().sum();
        Self::ms_to_lufs(sum / 4.0)
    }

    /// Short-term loudness — last 30 blocks (3 s) sum / 30.
    pub fn short_term_lufs(&self) -> f64 {
        let blocks = &self.block_ms_history;
        if blocks.len() < 30 {
            return f64::NEG_INFINITY;
        }
        let len = blocks.len();
        let sum: f64 = blocks[len - 30..].iter().sum();
        Self::ms_to_lufs(sum / 30.0)
    }

    /// Build 400-ms gated-block series (sliding 400-ms windows, hop 100 ms)
    /// and return their LUFS values.  Allocates — call only outside the
    /// audio thread (snapshots, file-render finalisation, etc.).
    fn gated_block_lufs_400ms(&self) -> Vec<f64> {
        let blocks = &self.block_ms_history;
        if blocks.len() < 4 {
            return Vec::new();
        }
        let mut out = Vec::with_capacity(blocks.len().saturating_sub(3));
        for i in 0..=(blocks.len() - 4) {
            let sum: f64 = blocks[i..i + 4].iter().sum();
            out.push(Self::ms_to_lufs(sum / 4.0));
        }
        out
    }

    /// 3-second gated-block series.  Hop 100 ms.
    fn gated_block_lufs_3s(&self) -> Vec<f64> {
        let blocks = &self.block_ms_history;
        if blocks.len() < 30 {
            return Vec::new();
        }
        let mut out = Vec::with_capacity(blocks.len().saturating_sub(29));
        for i in 0..=(blocks.len() - 30) {
            let sum: f64 = blocks[i..i + 30].iter().sum();
            out.push(Self::ms_to_lufs(sum / 30.0));
        }
        out
    }

    /// Integrated loudness — gated mean (BS.1770-4 §5.1.3).
    pub fn integrated_lufs(&self) -> f64 {
        let series = self.gated_block_lufs_400ms();
        if series.is_empty() {
            return f64::NEG_INFINITY;
        }
        // Stage 1: absolute gate.
        let above_abs: Vec<f64> = series.iter().copied().filter(|&l| l >= ABS_GATE_LUFS).collect();
        if above_abs.is_empty() {
            return f64::NEG_INFINITY;
        }
        let pre_mean = lufs_mean(&above_abs);
        let rel_threshold = pre_mean + REL_GATE_OFFSET_LU;
        // Stage 2: relative gate.
        let above_rel: Vec<f64> = above_abs.iter().copied().filter(|&l| l >= rel_threshold).collect();
        if above_rel.is_empty() {
            return f64::NEG_INFINITY;
        }
        lufs_mean(&above_rel)
    }

    /// Loudness Range (EBU R128 §3.6).
    pub fn loudness_range(&self) -> f64 {
        let mut series = self.gated_block_lufs_3s();
        if series.is_empty() {
            return 0.0;
        }
        series.retain(|l| *l >= ABS_GATE_LUFS);
        if series.is_empty() {
            return 0.0;
        }
        let mean = lufs_mean(&series);
        let rel_threshold = mean + LRA_REL_GATE_OFFSET_LU;
        series.retain(|l| *l >= rel_threshold);
        if series.is_empty() {
            return 0.0;
        }
        series.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let p10 = percentile(&series, 0.10);
        let p95 = percentile(&series, 0.95);
        p95 - p10
    }

    /// Number of blocks accepted by both gates (informational).
    pub fn gated_blocks(&self) -> u32 {
        let series = self.gated_block_lufs_400ms();
        if series.is_empty() { return 0; }
        let above_abs: Vec<f64> = series.iter().copied().filter(|&l| l >= ABS_GATE_LUFS).collect();
        if above_abs.is_empty() { return 0; }
        let pre_mean = lufs_mean(&above_abs);
        let rel = pre_mean + REL_GATE_OFFSET_LU;
        above_abs.iter().filter(|&&l| l >= rel).count() as u32
    }
}

/// Mean of a slice of LUFS values, computed in mean-square space (per BS.1770-4
/// 5.1.3 — the gated mean is over MS, not over LUFS).
fn lufs_mean(values: &[f64]) -> f64 {
    if values.is_empty() {
        return f64::NEG_INFINITY;
    }
    let sum_ms: f64 = values
        .iter()
        .map(|&l| 10f64.powf((l + 0.691) / 10.0))
        .sum();
    LufsAnalyzer::ms_to_lufs(sum_ms / values.len() as f64)
}

/// Linear-interpolated percentile.  `values` must be sorted ascending.
fn percentile(values: &[f64], p: f64) -> f64 {
    let n = values.len();
    if n == 0 { return f64::NEG_INFINITY; }
    if n == 1 { return values[0]; }
    let pos = p.clamp(0.0, 1.0) * (n - 1) as f64;
    let lo = pos.floor() as usize;
    let hi = (lo + 1).min(n - 1);
    let frac = pos - lo as f64;
    values[lo] + (values[hi] - values[lo]) * frac
}

#[cfg(test)]
mod tests {
    use super::*;

    /// EBU R128 Tech 3341 test scenario: 1 kHz sine at -23 dBFS RMS *per
    /// channel*, stereo, 10 s.
    ///
    /// BS.1770-4 channel summing weights L and R equally at 1.0, so summed
    /// mean-square is 2× per-channel mean-square → +3.01 LU.  Expected
    /// integrated LUFS ≈ −23 + 3.01 ≈ −20 LUFS.  (Tech 3341's published
    /// vector is a -20 LUFS sine for exactly this reason.)
    #[test]
    fn one_khz_sine_stereo_yields_minus_20_lufs() {
        let sr = 48_000.0;
        let mut a = LufsAnalyzer::new(sr, 2);
        let n = 48_000 * 10;
        let amp = 10f32.powf(-23.0 / 20.0) * (2.0_f32).sqrt(); // -23 dBFS RMS per channel
        let mut left  = Vec::with_capacity(n);
        let mut right = Vec::with_capacity(n);
        for i in 0..n {
            let s = amp * (2.0 * std::f32::consts::PI * 1000.0 * i as f32 / sr as f32).sin();
            left.push(s);
            right.push(s);
        }
        a.process_planar(&[&left, &right]);
        a.flush();
        let i_lufs = a.integrated_lufs();
        assert!(
            (i_lufs - (-20.0)).abs() < 0.5,
            "integrated LUFS off: got {i_lufs}, expected ≈ -20 (stereo channel sum)"
        );
    }

    /// Mono input of same sine should land at -23 LUFS-I (no channel summing).
    #[test]
    fn one_khz_sine_mono_yields_minus_23_lufs() {
        let sr = 48_000.0;
        let mut a = LufsAnalyzer::new(sr, 1);
        let n = 48_000 * 10;
        let amp = 10f32.powf(-23.0 / 20.0) * (2.0_f32).sqrt();
        let buf: Vec<f32> = (0..n)
            .map(|i| amp * (2.0 * std::f32::consts::PI * 1000.0 * i as f32 / sr as f32).sin())
            .collect();
        a.process_planar(&[&buf]);
        a.flush();
        let i_lufs = a.integrated_lufs();
        assert!(
            (i_lufs - (-23.0)).abs() < 0.5,
            "mono integrated LUFS off: got {i_lufs}, expected ≈ -23"
        );
    }

    #[test]
    fn silent_input_yields_neg_inf() {
        let sr = 48_000.0;
        let mut a = LufsAnalyzer::new(sr, 2);
        let n = 48_000 * 4;
        let left = vec![0.0f32; n];
        let right = vec![0.0f32; n];
        a.process_planar(&[&left, &right]);
        a.flush();
        assert!(a.integrated_lufs() < -69.9);
    }

    #[test]
    fn channel_weights_table() {
        assert_eq!(channel_weights(1), vec![1.0]);
        assert_eq!(channel_weights(2), vec![1.0, 1.0]);
        assert_eq!(channel_weights(5), vec![1.0, 1.0, 1.0, 1.41, 1.41]);
        // 5.1: LFE channel weight is 0.
        assert_eq!(channel_weights(6)[3], 0.0);
    }
}
