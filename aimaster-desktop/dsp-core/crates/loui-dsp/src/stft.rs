//! Realtime-safe STFT overlap-add processing engine.
//!
//! Spectral-domain modules (de-noise, spectral shaper, stabilizer, match EQ)
//! all need the same scaffolding: accumulate input, window, forward FFT, let
//! a callback modify the spectrum, inverse FFT, window again, overlap-add,
//! and hand back a *delayed* stream of the same length as the input block.
//!
//! [`StftEngine`] is that scaffolding, for one channel.
//!
//! # Latency
//!
//! The engine is causal: it emits `frame_size` samples of latency.  Modules
//! that use it report the same figure through `Chain::latency_samples`, so
//! the host can compensate (or, for the realtime preview, simply accept it).
//!
//! # Windowing / COLA
//!
//! Hann analysis window + Hann synthesis window at 75 % overlap
//! (`hop = frame / 4`).  Hann² at that hop sums to a constant 1.5, so the
//! overlap-add output is scaled by `1/1.5` to reconstruct unity gain.  With
//! an identity spectral callback the engine is a bit-accurate (to f32
//! rounding) delay line — enforced by `identity_is_delay_line` below.
//!
//! # Realtime safety
//!
//! Every buffer is allocated in [`StftEngine::new`].  `process_block` does
//! no allocation, takes no locks and has bounded loops.

use crate::fft::Fft;
use crate::window::Window;

/// Overlap factor — 75 % overlap (hop = frame / 4).
pub const OVERLAP: usize = 4;

/// Hann² COLA sum at 75 % overlap.
const COLA_SUM: f64 = 1.5;

/// One channel of STFT overlap-add processing.
///
/// The spectral callback receives the half-spectrum (`frame/2 + 1` bins) as
/// separate real / imaginary slices, plus the bin width in Hz.
pub struct StftEngine {
    fft: Fft,
    window: Window,
    frame: usize,
    hop: usize,
    sample_rate: f64,

    /// Sliding analysis buffer — the last `frame` input samples.
    in_ring: Vec<f32>,
    /// Write cursor into `in_ring` (wraps at `frame`).
    in_write: usize,
    /// Samples accumulated since the last transform.
    filled: usize,

    /// Overlap-add accumulator, `frame` long, read/written circularly.
    ola: Vec<f32>,
    /// Read cursor into `ola`.
    ola_read: usize,

    /// Scratch — time-domain frame (windowed).
    frame_buf: Vec<f32>,
    /// Scratch — FFT real part.
    re: Vec<f64>,
    /// Scratch — FFT imaginary part.
    im: Vec<f64>,

    /// True until `frame` samples have been seen (output is silent then).
    priming: usize,
}

impl StftEngine {
    /// Construct for a sample rate and frame size (power of two, ≥ 64).
    pub fn new(sample_rate: f64, frame: usize) -> Self {
        assert!(frame >= 64 && frame.is_power_of_two(), "STFT frame must be a power of two ≥ 64");
        let hop = frame / OVERLAP;
        Self {
            fft: Fft::new(frame),
            window: Window::hann_periodic(frame),
            frame,
            hop,
            sample_rate,
            in_ring: vec![0.0; frame],
            in_write: 0,
            filled: 0,
            ola: vec![0.0; frame],
            ola_read: 0,
            frame_buf: vec![0.0; frame],
            re: vec![0.0; frame],
            im: vec![0.0; frame],
            priming: frame,
        }
    }

    /// Frame size in samples.
    pub fn frame_size(&self) -> usize { self.frame }

    /// Hop size in samples.
    pub fn hop_size(&self) -> usize { self.hop }

    /// Number of half-spectrum bins the callback sees (`frame / 2 + 1`).
    pub fn bin_count(&self) -> usize { self.frame / 2 + 1 }

    /// Width of one FFT bin in Hz.
    pub fn bin_width_hz(&self) -> f64 { self.sample_rate / self.frame as f64 }

    /// Processing latency in samples (equals the frame size).
    pub fn latency_samples(&self) -> usize { self.frame }

    /// Clear all state (transport seek / source swap).
    pub fn reset(&mut self) {
        self.in_ring.fill(0.0);
        self.ola.fill(0.0);
        self.in_write = 0;
        self.filled = 0;
        self.ola_read = 0;
        self.priming = self.frame;
    }

    /// Process one block in place, applying `spectral` to every completed
    /// analysis frame.
    ///
    /// The callback signature is `(re, im, bin_width_hz)` where `re`/`im`
    /// are `bin_count()` long.  The engine mirrors the modified half-spectrum
    /// into the conjugate half before the inverse transform, so the callback
    /// only ever deals with bins `0 ..= frame/2`.
    pub fn process_block<F>(&mut self, buf: &mut [f32], mut spectral: F)
    where
        F: FnMut(&mut [f64], &mut [f64], f64),
    {
        for sample in buf.iter_mut() {
            // Push input into the sliding analysis ring.
            self.in_ring[self.in_write] = *sample;
            self.in_write = (self.in_write + 1) % self.frame;
            self.filled += 1;

            // Pull the (delayed) output written by earlier transforms, and
            // clear the slot so the next overlap-add starts from zero.
            let out = self.ola[self.ola_read];
            self.ola[self.ola_read] = 0.0;
            self.ola_read = (self.ola_read + 1) % self.frame;

            *sample = if self.priming > 0 {
                self.priming -= 1;
                0.0
            } else {
                out
            };

            if self.filled >= self.hop {
                self.filled = 0;
                self.transform(&mut spectral);
            }
        }
    }

    /// Run one analysis → callback → synthesis cycle.
    fn transform<F>(&mut self, spectral: &mut F)
    where
        F: FnMut(&mut [f64], &mut [f64], f64),
    {
        let n = self.frame;
        let bins = n / 2 + 1;
        let bin_width = self.sample_rate / n as f64;

        // Analysis: unwrap the ring (oldest sample first) and window.
        let coeffs = self.window.coeffs();
        for i in 0..n {
            let src = (self.in_write + i) % n;
            self.frame_buf[i] = self.in_ring[src] * coeffs[i];
        }

        for i in 0..n {
            self.re[i] = self.frame_buf[i] as f64;
            self.im[i] = 0.0;
        }
        self.fft.process(&mut self.re, &mut self.im);

        // Spectral callback over the half-spectrum.
        spectral(&mut self.re[..bins], &mut self.im[..bins], bin_width);

        // Rebuild the conjugate-symmetric upper half.
        for k in 1..n / 2 {
            self.re[n - k] = self.re[k];
            self.im[n - k] = -self.im[k];
        }
        // Bins 0 and N/2 must be purely real for a real output signal.
        self.im[0] = 0.0;
        self.im[n / 2] = 0.0;

        // Inverse FFT via the forward transform:
        //   ifft(x) = conj(fft(conj(x))) / N
        for v in self.im.iter_mut() { *v = -*v; }
        self.fft.process(&mut self.re, &mut self.im);
        let norm = 1.0 / (n as f64 * COLA_SUM);

        // Synthesis window + overlap-add at the *newest* frame position.
        // The output slot for frame sample `i` is `ola_read + i` (mod frame),
        // because `ola_read` now points at the sample that will be emitted
        // `frame` samples from now — i.e. exactly this frame's start.
        for i in 0..n {
            let v = self.re[i] * norm * coeffs[i] as f64;
            let slot = (self.ola_read + i) % n;
            self.ola[slot] += v as f32;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn noise(n: usize) -> Vec<f32> {
        // Deterministic pseudo-noise — no rand dependency.
        let mut state = 0x2545_F491_4F6C_DD1Du64;
        (0..n)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                ((state >> 40) as f32 / 8_388_608.0) - 1.0
            })
            .collect()
    }

    /// With an identity callback the engine must reconstruct the input,
    /// delayed by exactly `frame` samples.
    #[test]
    fn identity_is_delay_line() {
        let frame = 512;
        let mut e = StftEngine::new(48_000.0, frame);
        let input = noise(8192);
        let mut out = input.clone();
        // Process in irregular block sizes to exercise the ring wrap.
        let mut off = 0;
        for &blk in [128usize, 64, 333, 512, 97].iter().cycle() {
            let end = (off + blk).min(out.len());
            if off >= end { break; }
            e.process_block(&mut out[off..end], |_re, _im, _bw| {});
            off = end;
            if off >= out.len() { break; }
        }
        // Compare the delayed region.
        let mut worst = 0.0f32;
        for i in frame..input.len() {
            worst = worst.max((out[i] - input[i - frame]).abs());
        }
        assert!(worst < 1e-3, "identity STFT should be a delay line, worst error {worst}");
    }

    /// Zeroing every bin must silence the output.
    #[test]
    fn zeroing_spectrum_silences() {
        let mut e = StftEngine::new(48_000.0, 256);
        let mut buf = noise(4096);
        e.process_block(&mut buf, |re, im, _| {
            re.fill(0.0);
            im.fill(0.0);
        });
        assert!(buf[1024..].iter().all(|s| s.abs() < 1e-6));
    }

    /// Output must stay finite for pathological input.
    #[test]
    fn survives_extreme_input() {
        let mut e = StftEngine::new(48_000.0, 256);
        let mut buf = vec![0.0f32; 2048];
        for (i, s) in buf.iter_mut().enumerate() {
            *s = if i % 2 == 0 { 8.0 } else { -8.0 };
        }
        e.process_block(&mut buf, |_, _, _| {});
        assert!(buf.iter().all(|s| s.is_finite()));
    }

    #[test]
    fn reset_clears_tail() {
        let mut e = StftEngine::new(48_000.0, 128);
        let mut buf = vec![1.0f32; 1024];
        e.process_block(&mut buf, |_, _, _| {});
        e.reset();
        let mut silence = vec![0.0f32; 1024];
        e.process_block(&mut silence, |_, _, _| {});
        assert!(silence.iter().all(|s| s.abs() < 1e-6), "reset should clear the OLA tail");
    }
}
