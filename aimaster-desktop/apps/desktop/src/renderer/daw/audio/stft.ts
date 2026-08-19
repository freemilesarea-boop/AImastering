// Short-time Fourier transform with exact reconstruction.
//
// Spectral editing only works if the transform is invertible: whatever the
// user does NOT select has to come back bit-for-bit (to floating-point
// tolerance).  That means weighted overlap-add — a Hann window on analysis
// AND on synthesis, with the hop set so the squared windows sum to a
// constant.  At 75 % overlap that constant is 1.5, and dividing by it makes
// an untouched round trip transparent.
//
// Layout: frames are stored as interleaved [re, im, re, im, …] of length
// 2·fftSize, so one Float64Array per frame and no object churn.

import { fft, hannWindow, isPow2, magnitude } from './fft.js';

export interface StftOptions {
  fftSize: number;
  /** Samples between frame starts.  fftSize/4 gives 75 % overlap. */
  hopSize: number;
}

export const DEFAULT_STFT: StftOptions = { fftSize: 2048, hopSize: 512 };

export interface Spectrogram {
  frames: Float64Array[];
  fftSize: number;
  hopSize: number;
  sampleRate: number;
  /** Samples in the source, so inverse() can trim back to length. */
  length: number;
}

export const binCount = (fftSize: number): number => fftSize / 2 + 1;

export function binToHz(bin: number, fftSize: number, sampleRate: number): number {
  return (bin * sampleRate) / fftSize;
}

export function hzToBin(hz: number, fftSize: number, sampleRate: number): number {
  return (hz * fftSize) / sampleRate;
}

export function frameToSec(frame: number, hopSize: number, sampleRate: number): number {
  return (frame * hopSize) / sampleRate;
}

export function secToFrame(sec: number, hopSize: number, sampleRate: number): number {
  return (sec * sampleRate) / hopSize;
}

/** Forward transform.  The signal is zero-padded by one frame at each end. */
export function stft(
  samples: ArrayLike<number>, sampleRate: number, options: Partial<StftOptions> = {},
): Spectrogram {
  const { fftSize, hopSize } = { ...DEFAULT_STFT, ...options };
  if (!isPow2(fftSize)) throw new Error('fftSize must be a power of two');

  const window = hannWindow(fftSize);
  const frameCount = Math.max(1, Math.ceil(samples.length / hopSize) + 1);
  const frames: Float64Array[] = [];

  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);

  for (let f = 0; f < frameCount; f++) {
    const offset = f * hopSize - (fftSize >> 1);
    re.fill(0);
    im.fill(0);
    for (let i = 0; i < fftSize; i++) {
      const index = offset + i;
      const value = index >= 0 && index < samples.length ? (samples[index] ?? 0) : 0;
      re[i] = value * (window[i] ?? 0);
    }
    fft(re, im, false);

    const frame = new Float64Array(fftSize * 2);
    for (let i = 0; i < fftSize; i++) {
      frame[i * 2] = re[i] ?? 0;
      frame[i * 2 + 1] = im[i] ?? 0;
    }
    frames.push(frame);
  }

  return { frames, fftSize, hopSize, sampleRate, length: samples.length };
}

/** Inverse transform: weighted overlap-add back to a signal. */
export function istft(spec: Spectrogram): Float32Array {
  const { frames, fftSize, hopSize, length } = spec;
  const window = hannWindow(fftSize);
  const out = new Float64Array(length + fftSize * 2);
  const norm = new Float64Array(length + fftSize * 2);
  const half = fftSize >> 1;

  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);

  frames.forEach((frame, f) => {
    for (let i = 0; i < fftSize; i++) {
      re[i] = frame[i * 2] ?? 0;
      im[i] = frame[i * 2 + 1] ?? 0;
    }
    fft(re, im, true);

    const offset = f * hopSize - half;
    for (let i = 0; i < fftSize; i++) {
      const index = offset + i + half;      // shifted into the padded buffer
      if (index < 0 || index >= out.length) continue;
      const w = window[i] ?? 0;
      out[index] = (out[index] ?? 0) + (re[i] ?? 0) * w;
      norm[index] = (norm[index] ?? 0) + w * w;
    }
  });

  const result = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const weight = norm[i + half] ?? 0;
    result[i] = weight > 1e-8 ? (out[i + half] ?? 0) / weight : 0;
  }
  return result;
}

// ── Frame access ──────────────────────────────────────────────────────────────

export function frameMagnitude(frame: Float64Array, bin: number): number {
  return magnitude(frame[bin * 2] ?? 0, frame[bin * 2 + 1] ?? 0);
}

export function framePhase(frame: Float64Array, bin: number): number {
  return Math.atan2(frame[bin * 2 + 1] ?? 0, frame[bin * 2] ?? 0);
}

/** Write a bin from magnitude + phase, keeping the spectrum conjugate-symmetric. */
export function setBin(
  frame: Float64Array, bin: number, mag: number, phase: number, fftSize: number,
): void {
  const re = mag * Math.cos(phase);
  const im = mag * Math.sin(phase);
  frame[bin * 2] = re;
  frame[bin * 2 + 1] = im;
  // A real signal's spectrum mirrors around Nyquist; without this the inverse
  // transform produces a complex (i.e. wrong) result.
  const mirror = fftSize - bin;
  if (bin > 0 && mirror < fftSize) {
    frame[mirror * 2] = re;
    frame[mirror * 2 + 1] = -im;
  }
}

/** Scale one bin's magnitude, leaving its phase alone. */
export function scaleBin(frame: Float64Array, bin: number, gain: number, fftSize: number): void {
  const re = (frame[bin * 2] ?? 0) * gain;
  const im = (frame[bin * 2 + 1] ?? 0) * gain;
  frame[bin * 2] = re;
  frame[bin * 2 + 1] = im;
  const mirror = fftSize - bin;
  if (bin > 0 && mirror < fftSize) {
    frame[mirror * 2] = re;
    frame[mirror * 2 + 1] = -im;
  }
}

/** Magnitudes of one frame, for drawing. */
export function frameMagnitudes(frame: Float64Array, fftSize: number): Float32Array {
  const bins = binCount(fftSize);
  const out = new Float32Array(bins);
  for (let bin = 0; bin < bins; bin++) out[bin] = frameMagnitude(frame, bin);
  return out;
}

/** Total energy in a time/frequency box — used by the tests and the UI readout. */
export function regionEnergy(
  spec: Spectrogram, fromFrame: number, toFrame: number, lowBin: number, highBin: number,
): number {
  let sum = 0;
  for (let f = Math.max(0, fromFrame); f < Math.min(spec.frames.length, toFrame); f++) {
    const frame = spec.frames[f];
    if (!frame) continue;
    for (let bin = Math.max(0, lowBin); bin <= Math.min(binCount(spec.fftSize) - 1, highBin); bin++) {
      const m = frameMagnitude(frame, bin);
      sum += m * m;
    }
  }
  return sum;
}
