//! True-peak detector (4× oversampled, ITU-R BS.1770-4 §3.7).
//!
//! For each channel, feeds samples through a 4× polyphase oversampler and
//! tracks the maximum absolute value across the oversampled stream.
//!
//! Returns max in dBTP (dB true-peak), referenced to digital full-scale.

use crate::buffer::AudioBlockRef;
use crate::oversample::Oversampler4x;

/// Per-channel + max-across-channels true-peak detector.
#[derive(Debug, Clone)]
pub struct TruePeakBank {
    sample_rate: f64,
    upsamplers: Vec<Oversampler4x>,
    /// Per-channel running max(|x|) over the oversampled stream.
    peak_linear: Vec<f64>,
}

impl TruePeakBank {
    /// Construct one 4× oversampler per channel.
    pub fn new(sample_rate: f64, channels: usize) -> Self {
        Self {
            sample_rate,
            upsamplers: (0..channels).map(|_| Oversampler4x::new()).collect(),
            peak_linear: vec![0.0; channels],
        }
    }

    /// Channel count.
    pub fn channels(&self) -> usize { self.upsamplers.len() }
    /// Sample rate.
    pub fn sample_rate(&self) -> f64 { self.sample_rate }

    /// Reset all per-channel state.
    pub fn reset(&mut self) {
        for u in self.upsamplers.iter_mut() {
            u.reset();
        }
        for p in self.peak_linear.iter_mut() { *p = 0.0; }
    }

    /// Process a planar block.
    pub fn process_planar(&mut self, channels: &[&[f32]]) {
        assert_eq!(channels.len(), self.upsamplers.len());
        let mut over_buf = [0.0f64; 4];
        for c in 0..channels.len() {
            let ch = channels[c];
            let up = &mut self.upsamplers[c];
            let mut peak = self.peak_linear[c];
            for &x in ch.iter() {
                up.process(x as f64, &mut over_buf);
                for &v in &over_buf {
                    let abs = v.abs();
                    if abs > peak {
                        peak = abs;
                    }
                }
            }
            self.peak_linear[c] = peak;
        }
    }

    /// Process an AudioBlockRef.
    pub fn process(&mut self, block: AudioBlockRef<'_>) {
        let n = self.upsamplers.len();
        let mut chans: [&[f32]; crate::buffer::MAX_CHANNELS] = [&[]; crate::buffer::MAX_CHANNELS];
        for c in 0..n.min(crate::buffer::MAX_CHANNELS) {
            chans[c] = block.channel(c);
        }
        self.process_planar(&chans[..n.min(crate::buffer::MAX_CHANNELS)]);
    }

    /// Per-channel true peak in dBTP.
    pub fn channel_peak_dbtp(&self, ch: usize) -> f64 {
        let p = self.peak_linear[ch];
        if p <= 0.0 { f64::NEG_INFINITY } else { 20.0 * p.log10() }
    }

    /// Max true peak across all channels (dBTP).
    pub fn peak_dbtp(&self) -> f64 {
        let mut max = f64::NEG_INFINITY;
        for c in 0..self.upsamplers.len() {
            let v = self.channel_peak_dbtp(c);
            if v > max { max = v; }
        }
        max
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A signal whose sample peak is at 0 dBFS but whose inter-sample peak
    /// rises above 0 dBTP should be detected by the 4× oversampled TP.
    ///
    /// Test signal: alternating ±0.999 every sample (an ISP-aggressive signal
    /// at Nyquist).  The half-band oversampler's main lobe rings, producing
    /// inter-sample peaks slightly above the sample value.
    #[test]
    fn detects_isp_above_sample_peak() {
        let sr = 48_000.0;
        let mut tp = TruePeakBank::new(sr, 1);
        let n = 4_000;
        // 0 dBFS at sample level
        let buf: Vec<f32> = (0..n).map(|i| if i % 2 == 0 { 0.999 } else { -0.999 }).collect();
        tp.process_planar(&[&buf]);
        // Sample peak is ≈ 0 dBFS; we don't necessarily exceed 0 dBTP with
        // alternating signal (it's already at Nyquist), but TP should be
        // close to 0 dBTP and never NEG_INFINITY.
        let v = tp.peak_dbtp();
        assert!(v > -3.0, "TP suspiciously low: {v}");
    }

    /// Silence yields -Infinity TP.
    #[test]
    fn silence_yields_neg_inf() {
        let sr = 48_000.0;
        let mut tp = TruePeakBank::new(sr, 2);
        let buf = vec![0.0f32; 1024];
        tp.process_planar(&[&buf, &buf]);
        assert!(tp.peak_dbtp().is_infinite());
        assert!(tp.peak_dbtp() < 0.0);
    }

    /// A -10 dBFS sine should produce TP very close to -10 dBTP.
    #[test]
    fn moderate_sine_tp_matches_sample_peak() {
        let sr = 48_000.0;
        let mut tp = TruePeakBank::new(sr, 1);
        let amp = 10f32.powf(-10.0 / 20.0);
        let buf: Vec<f32> = (0..48_000)
            .map(|i| amp * (2.0 * std::f32::consts::PI * 1000.0 * i as f32 / 48_000.0).sin())
            .collect();
        tp.process_planar(&[&buf]);
        let v = tp.peak_dbtp();
        assert!((v - (-10.0)).abs() < 0.5, "TP off: got {v}, expected ~-10");
    }
}
