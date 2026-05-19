//! Audio buffer types.
//!
//! `AudioBuffer` is an owned, planar `f32` buffer.  `AudioBlockRef` and
//! `AudioBlockMut` are zero-allocation borrowed views suitable for the
//! audio thread.

/// Maximum channel count supported by the M2-lite analyzers.
///
/// Larger surround formats can be added later, but raising this constant
/// is a SemVer-relevant change because it sizes some pre-allocated state
/// in downstream processors.
pub const MAX_CHANNELS: usize = 8;

/// Owned planar audio buffer.
///
/// Layout: `data[channel][frame]`.  Channels share the same length.
#[derive(Debug, Clone)]
pub struct AudioBuffer {
    sample_rate: u32,
    channels: usize,
    frames: usize,
    /// Planar storage.  `data.len() == channels * frames`.
    data: Vec<f32>,
}

impl AudioBuffer {
    /// Allocate a zeroed planar buffer.
    pub fn new(sample_rate: u32, channels: usize, frames: usize) -> Self {
        assert!(channels > 0 && channels <= MAX_CHANNELS, "channels out of range");
        Self {
            sample_rate,
            channels,
            frames,
            data: vec![0.0; channels * frames],
        }
    }

    /// Take ownership of an existing planar `Vec<f32>` (length must equal
    /// `channels * frames`).
    pub fn from_planar(sample_rate: u32, channels: usize, frames: usize, data: Vec<f32>) -> Self {
        assert!(channels > 0 && channels <= MAX_CHANNELS);
        assert_eq!(data.len(), channels * frames);
        Self { sample_rate, channels, frames, data }
    }

    /// Sample rate in Hz.
    pub fn sample_rate(&self) -> u32 { self.sample_rate }
    /// Channel count.
    pub fn channels(&self) -> usize { self.channels }
    /// Frame count (samples per channel).
    pub fn frames(&self) -> usize { self.frames }
    /// Duration in seconds.
    pub fn duration_sec(&self) -> f64 {
        if self.sample_rate == 0 { 0.0 } else { self.frames as f64 / self.sample_rate as f64 }
    }

    /// Borrow channel `ch` immutably.
    pub fn channel(&self, ch: usize) -> &[f32] {
        let start = ch * self.frames;
        &self.data[start .. start + self.frames]
    }

    /// Borrow channel `ch` mutably.
    pub fn channel_mut(&mut self, ch: usize) -> &mut [f32] {
        let start = ch * self.frames;
        &mut self.data[start .. start + self.frames]
    }

    /// Take a borrowed read-only view.
    pub fn as_ref(&self) -> AudioBlockRef<'_> {
        AudioBlockRef {
            sample_rate: self.sample_rate,
            channels: self.channels,
            frames: self.frames,
            data: &self.data,
        }
    }
}

/// Read-only borrowed view into a planar audio buffer.
///
/// Cheap to pass into realtime processors — no allocation.  All accessor
/// methods are constant-time.
#[derive(Debug, Clone, Copy)]
pub struct AudioBlockRef<'a> {
    sample_rate: u32,
    channels: usize,
    frames: usize,
    data: &'a [f32],
}

impl<'a> AudioBlockRef<'a> {
    /// Construct a new borrowed planar view.  Panics if lengths disagree.
    pub fn new(sample_rate: u32, channels: usize, frames: usize, data: &'a [f32]) -> Self {
        assert_eq!(data.len(), channels * frames);
        Self { sample_rate, channels, frames, data }
    }

    /// Sample rate in Hz.
    pub fn sample_rate(&self) -> u32 { self.sample_rate }
    /// Channel count.
    pub fn channels(&self) -> usize { self.channels }
    /// Frame count (samples per channel).
    pub fn frames(&self) -> usize { self.frames }
    /// Borrow channel `ch`.
    pub fn channel(&self, ch: usize) -> &[f32] {
        let start = ch * self.frames;
        &self.data[start .. start + self.frames]
    }
}

/// Mutable borrowed view — used by oversamplers and offline post-processing.
#[derive(Debug)]
pub struct AudioBlockMut<'a> {
    sample_rate: u32,
    channels: usize,
    frames: usize,
    data: &'a mut [f32],
}

impl<'a> AudioBlockMut<'a> {
    /// Construct.  Panics if lengths disagree.
    pub fn new(sample_rate: u32, channels: usize, frames: usize, data: &'a mut [f32]) -> Self {
        assert_eq!(data.len(), channels * frames);
        Self { sample_rate, channels, frames, data }
    }
    /// Sample rate in Hz.
    pub fn sample_rate(&self) -> u32 { self.sample_rate }
    /// Channel count.
    pub fn channels(&self) -> usize { self.channels }
    /// Frame count.
    pub fn frames(&self) -> usize { self.frames }
    /// Borrow channel `ch` mutably.
    pub fn channel_mut(&mut self, ch: usize) -> &mut [f32] {
        let start = ch * self.frames;
        &mut self.data[start .. start + self.frames]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channel_views_round_trip() {
        let mut buf = AudioBuffer::new(48_000, 2, 16);
        for (i, v) in buf.channel_mut(0).iter_mut().enumerate() {
            *v = i as f32;
        }
        for (i, v) in buf.channel_mut(1).iter_mut().enumerate() {
            *v = (100 + i) as f32;
        }
        assert_eq!(buf.channel(0)[5], 5.0);
        assert_eq!(buf.channel(1)[5], 105.0);
        assert_eq!(buf.duration_sec(), 16.0 / 48_000.0);
    }
}
