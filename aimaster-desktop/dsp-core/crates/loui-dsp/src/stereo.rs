//! Stereo correlation + Mid/Side ratio meter.
//!
//! Tracks running per-channel means, cross-products and squared sums for a
//! sliding window.  No allocation in `process`.

use crate::buffer::AudioBlockRef;

/// Stereo correlation / M-S ratio meter.
#[derive(Debug, Clone)]
pub struct StereoMeter {
    sample_rate: f64,
    /// Window length in samples.
    window: usize,
    history_l: Vec<f64>,
    history_r: Vec<f64>,
    history_lr: Vec<f64>,
    history_l2: Vec<f64>,
    history_r2: Vec<f64>,
    history_m2: Vec<f64>,
    history_s2: Vec<f64>,
    write_idx: usize,
    filled: bool,
    sum_l: f64,
    sum_r: f64,
    sum_lr: f64,
    sum_l2: f64,
    sum_r2: f64,
    sum_m2: f64,
    sum_s2: f64,
}

impl StereoMeter {
    /// Construct with the given sliding window in seconds.
    pub fn new(sample_rate: f64, window_sec: f64) -> Self {
        assert!(sample_rate > 0.0 && window_sec > 0.0);
        let window = ((sample_rate * window_sec).round() as usize).max(1);
        Self {
            sample_rate,
            window,
            history_l:  vec![0.0; window],
            history_r:  vec![0.0; window],
            history_lr: vec![0.0; window],
            history_l2: vec![0.0; window],
            history_r2: vec![0.0; window],
            history_m2: vec![0.0; window],
            history_s2: vec![0.0; window],
            write_idx: 0,
            filled: false,
            sum_l:  0.0,
            sum_r:  0.0,
            sum_lr: 0.0,
            sum_l2: 0.0,
            sum_r2: 0.0,
            sum_m2: 0.0,
            sum_s2: 0.0,
        }
    }

    /// Reset all state.
    pub fn reset(&mut self) {
        for v in self.history_l.iter_mut()  { *v = 0.0; }
        for v in self.history_r.iter_mut()  { *v = 0.0; }
        for v in self.history_lr.iter_mut() { *v = 0.0; }
        for v in self.history_l2.iter_mut() { *v = 0.0; }
        for v in self.history_r2.iter_mut() { *v = 0.0; }
        for v in self.history_m2.iter_mut() { *v = 0.0; }
        for v in self.history_s2.iter_mut() { *v = 0.0; }
        self.write_idx = 0;
        self.filled = false;
        self.sum_l  = 0.0;
        self.sum_r  = 0.0;
        self.sum_lr = 0.0;
        self.sum_l2 = 0.0;
        self.sum_r2 = 0.0;
        self.sum_m2 = 0.0;
        self.sum_s2 = 0.0;
    }

    /// Process a single L/R frame.
    #[inline]
    pub fn process_frame(&mut self, l: f32, r: f32) {
        let lf = l as f64;
        let rf = r as f64;
        let m = 0.5 * (lf + rf);
        let s = 0.5 * (lf - rf);
        let lr = lf * rf;
        let l2 = lf * lf;
        let r2 = rf * rf;
        let m2 = m * m;
        let s2 = s * s;

        let idx = self.write_idx;
        self.sum_l  += lf - self.history_l[idx];
        self.sum_r  += rf - self.history_r[idx];
        self.sum_lr += lr - self.history_lr[idx];
        self.sum_l2 += l2 - self.history_l2[idx];
        self.sum_r2 += r2 - self.history_r2[idx];
        self.sum_m2 += m2 - self.history_m2[idx];
        self.sum_s2 += s2 - self.history_s2[idx];

        self.history_l[idx]  = lf;
        self.history_r[idx]  = rf;
        self.history_lr[idx] = lr;
        self.history_l2[idx] = l2;
        self.history_r2[idx] = r2;
        self.history_m2[idx] = m2;
        self.history_s2[idx] = s2;

        self.write_idx += 1;
        if self.write_idx >= self.window {
            self.write_idx = 0;
            self.filled = true;
        }
    }

    /// Process a planar stereo block (channels.len() must be 2).
    pub fn process_planar(&mut self, channels: &[&[f32]]) {
        if channels.len() == 1 {
            // Mono — treat as L == R.
            let l = channels[0];
            for &x in l.iter() {
                self.process_frame(x, x);
            }
            return;
        }
        assert!(channels.len() >= 2);
        let frames = channels[0].len();
        for i in 0..frames {
            self.process_frame(channels[0][i], channels[1][i]);
        }
    }

    /// Process an AudioBlockRef (1 or 2 channels).
    pub fn process(&mut self, block: AudioBlockRef<'_>) {
        if block.channels() == 1 {
            self.process_planar(&[block.channel(0)]);
        } else {
            self.process_planar(&[block.channel(0), block.channel(1)]);
        }
    }

    fn count(&self) -> f64 {
        if self.filled { self.window as f64 } else { self.write_idx as f64 }
    }

    /// Pearson correlation between L and R over the sliding window.
    ///
    /// Returns 1.0 when the window has not started accumulating yet.
    pub fn correlation(&self) -> f64 {
        let n = self.count();
        if n < 2.0 {
            return 1.0;
        }
        let mean_l = self.sum_l / n;
        let mean_r = self.sum_r / n;
        let num = self.sum_lr - n * mean_l * mean_r;
        let var_l = (self.sum_l2 - n * mean_l * mean_l).max(0.0);
        let var_r = (self.sum_r2 - n * mean_r * mean_r).max(0.0);
        let denom = (var_l * var_r).sqrt() + 1e-18;
        (num / denom).clamp(-1.0, 1.0)
    }

    /// Mid/Side energy ratio in dB.  `+Infinity` if S energy is zero (mono).
    pub fn ms_ratio_db(&self) -> f64 {
        let n = self.count();
        if n < 1.0 { return f64::INFINITY; }
        let mean_m2 = (self.sum_m2 / n).max(0.0);
        let mean_s2 = (self.sum_s2 / n).max(0.0);
        if mean_s2 <= 1e-18 { return f64::INFINITY; }
        10.0 * (mean_m2 / mean_s2).log10()
    }

    /// Stereo width index 0..4.  1.0 ≈ balanced stereo, 0 = mono, >1 = wide.
    pub fn width_index(&self) -> f64 {
        let n = self.count();
        if n < 1.0 { return 1.0; }
        let mean_m2 = (self.sum_m2 / n).max(0.0);
        let mean_s2 = (self.sum_s2 / n).max(0.0);
        let denom = mean_m2 + mean_s2;
        if denom <= 1e-18 { return 1.0; }
        let raw = 2.0 * mean_s2 / denom;
        (raw * 2.0).clamp(0.0, 4.0)
    }

    /// Sample rate.
    pub fn sample_rate(&self) -> f64 { self.sample_rate }
    /// Window length in samples.
    pub fn window_samples(&self) -> usize { self.window }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mono_is_perfectly_correlated() {
        let mut m = StereoMeter::new(48_000.0, 1.0);
        let n = 48_000;
        for i in 0..n {
            let s = (i as f32 / 100.0).sin();
            m.process_frame(s, s);
        }
        let corr = m.correlation();
        assert!((corr - 1.0).abs() < 1e-3, "mono correlation should be ~1.0, got {corr}");
    }

    #[test]
    fn antiphase_is_minus_one() {
        let mut m = StereoMeter::new(48_000.0, 1.0);
        let n = 48_000;
        for i in 0..n {
            let s = (i as f32 / 100.0).sin();
            m.process_frame(s, -s);
        }
        let corr = m.correlation();
        assert!((corr - (-1.0)).abs() < 1e-3, "antiphase correlation should be ~-1.0, got {corr}");
    }

    #[test]
    fn ms_ratio_for_mono_is_infinity() {
        let mut m = StereoMeter::new(48_000.0, 0.5);
        for i in 0..24_000 {
            let s = (i as f32 / 100.0).sin();
            m.process_frame(s, s);
        }
        assert!(m.ms_ratio_db().is_infinite());
    }
}
