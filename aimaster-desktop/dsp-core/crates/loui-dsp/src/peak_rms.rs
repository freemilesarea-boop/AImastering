//! Realtime peak + RMS meter.
//!
//! Tracks per-channel sample peak (max |x|) and sliding-window RMS.
//! The RMS window length is set at construction.  No allocation in `process`.

use crate::buffer::AudioBlockRef;

/// Sliding-window peak + RMS meter.
#[derive(Debug, Clone)]
pub struct PeakRmsMeter {
    sample_rate: f64,
    channels: usize,
    /// Window length in samples.
    window: usize,
    /// Per-channel ring buffer of x².
    history: Vec<Vec<f64>>,
    /// Per-channel running sum-of-squares.
    sum_sq: Vec<f64>,
    /// Write index per channel.
    write_idx: Vec<usize>,
    /// Whether the window has filled at least once.
    filled: Vec<bool>,
    /// Per-channel running peak (max |x| over entire history — non-decaying).
    peak_lin: Vec<f64>,
}

impl PeakRmsMeter {
    /// Construct a meter with the given RMS window in seconds.
    pub fn new(sample_rate: f64, channels: usize, window_sec: f64) -> Self {
        assert!(sample_rate > 0.0 && channels > 0 && window_sec > 0.0);
        let window = (sample_rate * window_sec).round() as usize;
        let window = window.max(1);
        Self {
            sample_rate,
            channels,
            window,
            history: (0..channels).map(|_| vec![0.0; window]).collect(),
            sum_sq: vec![0.0; channels],
            write_idx: vec![0; channels],
            filled: vec![false; channels],
            peak_lin: vec![0.0; channels],
        }
    }

    /// Sample rate.
    pub fn sample_rate(&self) -> f64 { self.sample_rate }
    /// Channel count.
    pub fn channels(&self) -> usize { self.channels }
    /// Window length in samples.
    pub fn window_samples(&self) -> usize { self.window }

    /// Reset all state.
    pub fn reset(&mut self) {
        for c in 0..self.channels {
            for v in self.history[c].iter_mut() { *v = 0.0; }
            self.sum_sq[c] = 0.0;
            self.write_idx[c] = 0;
            self.filled[c] = false;
            self.peak_lin[c] = 0.0;
        }
    }

    /// Process a planar block.
    pub fn process_planar(&mut self, channels: &[&[f32]]) {
        assert_eq!(channels.len(), self.channels);
        for c in 0..self.channels {
            let ch = channels[c];
            let history = &mut self.history[c];
            let mut idx = self.write_idx[c];
            let mut sum = self.sum_sq[c];
            let mut peak = self.peak_lin[c];
            let mut filled = self.filled[c];
            for &x in ch.iter() {
                let xf = x as f64;
                let abs = xf.abs();
                if abs > peak {
                    peak = abs;
                }
                let new_sq = xf * xf;
                let old_sq = history[idx];
                sum += new_sq - old_sq;
                if sum < 0.0 { sum = 0.0; } // guard against fp drift
                history[idx] = new_sq;
                idx += 1;
                if idx >= self.window {
                    idx = 0;
                    filled = true;
                }
            }
            self.write_idx[c] = idx;
            self.sum_sq[c] = sum;
            self.peak_lin[c] = peak;
            self.filled[c] = filled;
        }
    }

    /// Process a borrowed block (channel count must match).
    pub fn process(&mut self, block: AudioBlockRef<'_>) {
        assert_eq!(block.channels(), self.channels);
        let mut chans: [&[f32]; crate::buffer::MAX_CHANNELS] = [&[]; crate::buffer::MAX_CHANNELS];
        let n = self.channels.min(crate::buffer::MAX_CHANNELS);
        for c in 0..n {
            chans[c] = block.channel(c);
        }
        self.process_planar(&chans[..n]);
    }

    /// Per-channel current peak in dBFS.  `-Infinity` if the channel is silent.
    pub fn channel_peak_db(&self, ch: usize) -> f64 {
        let p = self.peak_lin[ch];
        if p <= 0.0 { f64::NEG_INFINITY } else { 20.0 * p.log10() }
    }

    /// Per-channel current sliding-window RMS in dBFS.
    pub fn channel_rms_db(&self, ch: usize) -> f64 {
        let denom = if self.filled[ch] {
            self.window as f64
        } else if self.write_idx[ch] == 0 {
            // No samples yet.
            return f64::NEG_INFINITY;
        } else {
            self.write_idx[ch] as f64
        };
        let mean_sq = self.sum_sq[ch] / denom;
        if mean_sq <= 0.0 { f64::NEG_INFINITY } else { 10.0 * mean_sq.log10() }
    }

    /// Max peak across all channels (dBFS).
    pub fn peak_db(&self) -> f64 {
        let mut max = f64::NEG_INFINITY;
        for c in 0..self.channels {
            let v = self.channel_peak_db(c);
            if v > max { max = v; }
        }
        max
    }

    /// RMS averaged across channels (dBFS).
    pub fn rms_db(&self) -> f64 {
        let denom = if self.filled.iter().all(|&f| f) {
            self.window as f64
        } else {
            // partial fill — use min write_idx across channels (conservative)
            let min_idx = self.write_idx.iter().copied().min().unwrap_or(0);
            if min_idx == 0 { return f64::NEG_INFINITY; }
            min_idx as f64
        };
        let total_ms: f64 = self.sum_sq.iter().map(|s| s / denom).sum::<f64>() / self.channels as f64;
        if total_ms <= 0.0 { f64::NEG_INFINITY } else { 10.0 * total_ms.log10() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dc_at_unity_gives_zero_dbfs_peak_and_rms() {
        let mut m = PeakRmsMeter::new(48_000.0, 1, 1.0);
        let buf = vec![1.0f32; 48_000];
        m.process_planar(&[&buf]);
        assert!((m.channel_peak_db(0) - 0.0).abs() < 0.01);
        assert!((m.channel_rms_db(0) - 0.0).abs() < 0.01);
    }

    #[test]
    fn sine_minus_6_dbfs_peak_minus_9_dbfs_rms() {
        let mut m = PeakRmsMeter::new(48_000.0, 1, 1.0);
        let n = 48_000;
        let amp = 10f32.powf(-6.0 / 20.0);
        let buf: Vec<f32> = (0..n)
            .map(|i| amp * (2.0 * std::f32::consts::PI * 1000.0 * i as f32 / 48_000.0).sin())
            .collect();
        m.process_planar(&[&buf]);
        assert!((m.channel_peak_db(0) - (-6.0)).abs() < 0.1);
        // RMS of a sine = peak / sqrt(2) → -6 dBFS - 3.01 dB = -9.01 dBFS
        assert!((m.channel_rms_db(0) - (-9.01)).abs() < 0.2);
    }
}
