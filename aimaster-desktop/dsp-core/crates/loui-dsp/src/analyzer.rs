//! Composed analyzer graph — the public-facing realtime entry point.
//!
//! Owns one LUFS analyzer, one TP bank, one peak/RMS meter, one stereo
//! meter.  All pre-allocated.  `process` is realtime-safe.
//!
//! Snapshot output is the canonical M2-lite metering payload — its field
//! names mirror `ReferenceProfile.features.*` so a snapshot can become a
//! partial profile without remapping.

use crate::buffer::AudioBlockRef;
use crate::lufs::LufsAnalyzer;
use crate::peak_rms::PeakRmsMeter;
use crate::stereo::StereoMeter;
use crate::true_peak::TruePeakBank;
use crate::MeterSnapshot;

/// Construction-time options for the analyzer graph.
#[derive(Debug, Clone, Copy)]
pub struct AnalyzerOptions {
    /// Sample rate of input audio (Hz).
    pub sample_rate: f64,
    /// Channel count.  1 or 2 typical.
    pub channels: usize,
    /// Sliding-window length for the peak/RMS meter (seconds).
    pub peak_rms_window_sec: f64,
    /// Sliding-window length for the stereo meter (seconds).
    pub stereo_window_sec: f64,
}

impl AnalyzerOptions {
    /// Default options for a 2-channel 48 kHz pipeline:
    /// 1.0 s peak/RMS window, 1.0 s stereo window.
    pub fn stereo_48k() -> Self {
        Self {
            sample_rate: 48_000.0,
            channels: 2,
            peak_rms_window_sec: 1.0,
            stereo_window_sec: 1.0,
        }
    }
}

/// Composed analyzer.  Holds all M2-lite metering processors.
#[derive(Debug)]
pub struct AnalyzerGraph {
    opts: AnalyzerOptions,
    lufs: LufsAnalyzer,
    true_peak: TruePeakBank,
    peak_rms: PeakRmsMeter,
    stereo: StereoMeter,
    samples_processed: u64,
}

impl AnalyzerGraph {
    /// Construct.  Allocates all internal state — never call this from
    /// the audio thread.
    pub fn new(opts: AnalyzerOptions) -> Self {
        assert!(opts.sample_rate > 0.0);
        assert!(opts.channels > 0 && opts.channels <= crate::buffer::MAX_CHANNELS);
        Self {
            lufs: LufsAnalyzer::new(opts.sample_rate, opts.channels),
            true_peak: TruePeakBank::new(opts.sample_rate, opts.channels),
            peak_rms: PeakRmsMeter::new(opts.sample_rate, opts.channels, opts.peak_rms_window_sec),
            stereo: StereoMeter::new(opts.sample_rate, opts.stereo_window_sec),
            samples_processed: 0,
            opts,
        }
    }

    /// Construction-time options.
    pub fn options(&self) -> AnalyzerOptions { self.opts }

    /// Process a planar block.  Realtime-safe; no allocation.
    pub fn process_planar(&mut self, channels: &[&[f32]]) {
        if channels.is_empty() { return; }
        let frames = channels[0].len() as u64;
        self.lufs.process_planar(channels);
        self.true_peak.process_planar(channels);
        self.peak_rms.process_planar(channels);
        self.stereo.process_planar(channels);
        self.samples_processed += frames;
    }

    /// Process an `AudioBlockRef`.
    pub fn process(&mut self, block: AudioBlockRef<'_>) {
        if block.frames() == 0 { return; }
        let mut chans: [&[f32]; crate::buffer::MAX_CHANNELS] = [&[]; crate::buffer::MAX_CHANNELS];
        let n = block.channels().min(crate::buffer::MAX_CHANNELS);
        for c in 0..n {
            chans[c] = block.channel(c);
        }
        self.process_planar(&chans[..n]);
    }

    /// Finalise pending partial block (call before reading integrated
    /// LUFS at the end of input).
    pub fn flush(&mut self) {
        self.lufs.flush();
    }

    /// Get a snapshot of all current meter values.
    ///
    /// Cheap — pure arithmetic on already-accumulated state.  Allocates
    /// only if `integrated_lufs()` / `loudness_range()` need to build the
    /// gated-block series, which IS an allocation — call this off the
    /// audio thread.  For audio-thread "tick" updates, use `tick_snapshot`
    /// (TODO M2-lite-NEXT: lock-free triple-buffer publisher).
    pub fn snapshot(&self) -> MeterSnapshot {
        MeterSnapshot {
            integrated_lufs: self.lufs.integrated_lufs(),
            short_term_lufs: self.lufs.short_term_lufs(),
            momentary_lufs:  self.lufs.momentary_lufs(),
            loudness_range:  self.lufs.loudness_range(),
            true_peak_dbtp:  self.true_peak.peak_dbtp(),
            sample_peak_db:  self.peak_rms.peak_db(),
            rms_db:          self.peak_rms.rms_db(),
            correlation:     self.stereo.correlation(),
            ms_ratio_db:     self.stereo.ms_ratio_db(),
            gated_blocks:    self.lufs.gated_blocks(),
            samples_processed: self.samples_processed,
        }
    }

    /// Lightweight snapshot — momentary / short-term LUFS + TP + peak/RMS
    /// + correlation only (no gated calculations).  Allocation-free; safe
    /// to call from the audio thread in worst case.
    pub fn tick_snapshot(&self) -> MeterSnapshot {
        MeterSnapshot {
            integrated_lufs: f64::NAN,                  // available via snapshot()
            short_term_lufs: self.lufs.short_term_lufs(),
            momentary_lufs:  self.lufs.momentary_lufs(),
            loudness_range:  f64::NAN,                  // available via snapshot()
            true_peak_dbtp:  self.true_peak.peak_dbtp(),
            sample_peak_db:  self.peak_rms.peak_db(),
            rms_db:          self.peak_rms.rms_db(),
            correlation:     self.stereo.correlation(),
            ms_ratio_db:     self.stereo.ms_ratio_db(),
            gated_blocks:    0,
            samples_processed: self.samples_processed,
        }
    }

    /// Reset all internal state.
    pub fn reset(&mut self) {
        self.lufs.reset();
        self.true_peak.reset();
        self.peak_rms.reset();
        self.stereo.reset();
        self.samples_processed = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// End-to-end: a -23 dBFS sine in BOTH channels.  BS.1770-4 stereo
    /// summing makes integrated LUFS ≈ -20 (channel sum adds 3 LU).
    /// Per-channel RMS stays at -23 dBFS.  Correlation = 1.0 (mono content).
    #[test]
    fn end_to_end_stereo_sine_minus_23_dbfs_per_channel() {
        let opts = AnalyzerOptions {
            sample_rate: 48_000.0,
            channels: 2,
            peak_rms_window_sec: 1.0,
            stereo_window_sec: 1.0,
        };
        let mut a = AnalyzerGraph::new(opts);
        let n = 48_000 * 10;
        let amp = 10f32.powf(-23.0 / 20.0) * (2.0_f32).sqrt();
        let buf: Vec<f32> = (0..n)
            .map(|i| amp * (2.0 * std::f32::consts::PI * 1000.0 * i as f32 / 48_000.0).sin())
            .collect();
        a.process_planar(&[&buf, &buf]);
        a.flush();
        let s = a.snapshot();
        assert!((s.integrated_lufs - (-20.0)).abs() < 0.5,
            "I LUFS off: got {}, expected ≈ -20 (stereo sum)", s.integrated_lufs);
        // Per-channel RMS — peak_rms is averaged across channels in rms_db().
        assert!((s.rms_db - (-23.0)).abs() < 0.5, "RMS dB off: {}", s.rms_db);
        assert!((s.correlation - 1.0).abs() < 1e-3, "correlation off: {}", s.correlation);
        assert_eq!(s.samples_processed, n as u64);
    }
}
