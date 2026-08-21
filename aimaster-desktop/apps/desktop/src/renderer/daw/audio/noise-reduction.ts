// Noise reduction — learn the noise, then subtract it.
//
// The `denoise` plugin in the mixer is a broadband expander: it pushes down
// whatever sits under a threshold.  That is the right tool live, and the wrong
// one for restoration, because it knows nothing about WHAT the noise is.  A
// hiss at 6 kHz and a hum at 120 Hz get the same treatment, and anything quiet
// and musical gets punished with them.
//
// This is the RX approach instead: the user selects a moment of noise only —
// the room before the take starts — and the analyser measures its spectrum,
// bin by bin.  Everything after that is a per-bin decision.
//
// The hazard is MUSICAL NOISE: naive subtraction leaves isolated bins standing
// at random, and they warble.  Three things keep it away, and all three matter:
//
//   1. Over-subtraction with a floor (Berouti).  Take out more than measured,
//      but never below a floor — a hole in the noise floor is more audible
//      than the noise was.
//   2. Smoothing across bins.  A gain curve that jumps bin-to-bin IS the
//      warble; smoothing it removes the mechanism.
//   3. Smoothing across time.  Gains ramp between frames instead of snapping.

import {
  binCount, frameMagnitude, istft, scaleBin, stft, type Spectrogram,
} from './stft.js';

export interface NoiseProfile {
  fftSize: number;
  hopSize: number;
  sampleRate: number;
  /** Mean magnitude per bin across the learned region. */
  mean: Float32Array;
  /** Per-bin standard deviation — how much the noise floor wanders. */
  deviation: Float32Array;
  frames: number;
  durationSec: number;
}

export interface LearnOptions {
  fftSize?: number;
  hopSize?: number;
}

const DEFAULT_FFT = 2048;

/** Frames below this and the profile is guesswork, not a measurement. */
export const MIN_PROFILE_FRAMES = 4;

/**
 * Measure a noise-only region.  Throws when the region is too short to
 * measure — a bad profile is worse than none, because everything downstream
 * trusts it.
 */
export function learnNoiseProfile(
  samples: Float32Array, sampleRate: number,
  fromSec: number, toSec: number, options: LearnOptions = {},
): NoiseProfile {
  const fftSize = options.fftSize ?? DEFAULT_FFT;
  const hopSize = options.hopSize ?? fftSize / 4;
  const from = Math.max(0, Math.floor(Math.min(fromSec, toSec) * sampleRate));
  const to = Math.min(samples.length, Math.ceil(Math.max(fromSec, toSec) * sampleRate));
  if (to - from < fftSize) {
    throw new Error(`노이즈 구간이 너무 짧습니다 (최소 ${(fftSize / sampleRate).toFixed(3)}초)`);
  }

  const spec = stft(samples.subarray(from, to), sampleRate, { fftSize, hopSize });
  const bins = binCount(fftSize);
  const sum = new Float64Array(bins);
  const sumSq = new Float64Array(bins);

  // The first and last frames straddle the STFT's zero padding, so their
  // magnitudes are half a window of silence — they would drag the mean down.
  const edge = Math.ceil(fftSize / hopSize / 2);
  const first = Math.min(edge, Math.max(0, spec.frames.length - 1));
  const last = Math.max(first + 1, spec.frames.length - edge);
  let counted = 0;

  for (let f = first; f < last; f++) {
    const frame = spec.frames[f];
    if (!frame) continue;
    counted++;
    for (let bin = 0; bin < bins; bin++) {
      const m = frameMagnitude(frame, bin);
      sum[bin] = (sum[bin] ?? 0) + m;
      sumSq[bin] = (sumSq[bin] ?? 0) + m * m;
    }
  }
  if (counted < MIN_PROFILE_FRAMES) {
    throw new Error('노이즈 구간이 너무 짧습니다 — 최소 0.1초 정도 잡아주세요');
  }

  const mean = new Float32Array(bins);
  const deviation = new Float32Array(bins);
  for (let bin = 0; bin < bins; bin++) {
    const m = (sum[bin] ?? 0) / counted;
    const variance = Math.max(0, (sumSq[bin] ?? 0) / counted - m * m);
    mean[bin] = m;
    deviation[bin] = Math.sqrt(variance);
  }

  return {
    fftSize, hopSize, sampleRate, mean, deviation,
    frames: counted, durationSec: (to - from) / sampleRate,
  };
}

export interface DenoiseOptions {
  /** Deepest attenuation a noise-only bin may receive, dB. */
  reductionDb?: number;
  /** Threshold = mean + sensitivity × deviation. Higher removes more. */
  sensitivity?: number;
  /** Over-subtraction factor — how much more than measured to take out. */
  strength?: number;
  /** Gain smoothing across time, 0…1.  Higher is slower and smoother. */
  smoothing?: number;
  /** Gain smoothing radius across bins. */
  bandSmoothing?: number;
  /** `residual` outputs what WOULD be removed — the monitor that catches
   *  over-processing before you print it. */
  output?: 'clean' | 'residual';
}

const DENOISE_DEFAULTS = {
  reductionDb: 12, sensitivity: 1, strength: 1.5,
  smoothing: 0.5, bandSmoothing: 2, output: 'clean' as const,
};

/** Per-bin gains for one frame — exported so the UI can draw the curve. */
export function frameGains(
  frame: Float64Array, profile: NoiseProfile, options: DenoiseOptions = {},
): Float32Array {
  const reductionDb = options.reductionDb ?? DENOISE_DEFAULTS.reductionDb;
  const sensitivity = options.sensitivity ?? DENOISE_DEFAULTS.sensitivity;
  const strength = options.strength ?? DENOISE_DEFAULTS.strength;
  const bandSmoothing = Math.max(0, Math.round(options.bandSmoothing ?? DENOISE_DEFAULTS.bandSmoothing));
  const floor = Math.pow(10, -Math.abs(reductionDb) / 20);
  const bins = binCount(profile.fftSize);

  const raw = new Float32Array(bins);
  for (let bin = 0; bin < bins; bin++) {
    const magnitude = frameMagnitude(frame, bin);
    const threshold = (profile.mean[bin] ?? 0) + sensitivity * (profile.deviation[bin] ?? 0);
    if (magnitude <= 1e-12) { raw[bin] = 1; continue; }
    const target = Math.max(0, magnitude - strength * threshold);
    raw[bin] = Math.min(1, Math.max(floor, target / magnitude));
  }

  if (bandSmoothing === 0) return raw;

  // Smoothing the GAIN, not the spectrum: a gain curve that jumps bin to bin
  // is exactly what musical noise sounds like.
  const smoothed = new Float32Array(bins);
  for (let bin = 0; bin < bins; bin++) {
    let sum = 0;
    let n = 0;
    for (let k = bin - bandSmoothing; k <= bin + bandSmoothing; k++) {
      if (k < 0 || k >= bins) continue;
      sum += raw[k] ?? 1;
      n++;
    }
    smoothed[bin] = n > 0 ? sum / n : (raw[bin] ?? 1);
  }
  return smoothed;
}

/** Apply a profile to a spectrogram in place. */
export function denoiseSpectrogram(
  spec: Spectrogram, profile: NoiseProfile, options: DenoiseOptions = {},
): void {
  const smoothing = Math.min(0.99, Math.max(0, options.smoothing ?? DENOISE_DEFAULTS.smoothing));
  const residual = (options.output ?? DENOISE_DEFAULTS.output) === 'residual';
  const bins = binCount(spec.fftSize);
  const previous = new Float32Array(bins).fill(1);

  for (const frame of spec.frames) {
    const gains = frameGains(frame, profile, options);
    for (let bin = 0; bin < bins; bin++) {
      const target = gains[bin] ?? 1;
      const smoothed = smoothing * (previous[bin] ?? 1) + (1 - smoothing) * target;
      previous[bin] = smoothed;
      scaleBin(frame, bin, residual ? 1 - smoothed : smoothed, spec.fftSize);
    }
  }
}

/** Denoise a mono channel. */
export function reduceNoise(
  samples: Float32Array, sampleRate: number,
  profile: NoiseProfile, options: DenoiseOptions = {},
): Float32Array {
  if (samples.length === 0) return new Float32Array(0);
  const spec = stft(samples, sampleRate, { fftSize: profile.fftSize, hopSize: profile.hopSize });
  denoiseSpectrogram(spec, profile, options);
  return istft(spec);
}

/** Denoise every channel with one profile. */
export function reduceNoiseChannels(
  channels: readonly Float32Array[], sampleRate: number,
  profile: NoiseProfile, options: DenoiseOptions = {},
): Float32Array[] {
  return channels.map((ch) => reduceNoise(ch, sampleRate, profile, options));
}

/** Broadband level of a profile, dBFS — what the UI shows as "noise floor". */
export function profileFloorDb(profile: NoiseProfile): number {
  let power = 0;
  for (let bin = 0; bin < profile.mean.length; bin++) {
    const m = profile.mean[bin] ?? 0;
    power += m * m;
  }
  // Undo the window's magnitude scaling so the number reads like a meter.
  const scaled = Math.sqrt(power) * (2 / (profile.fftSize * 0.5));
  return scaled > 0 ? 20 * Math.log10(scaled) : -Infinity;
}

/** Coarse band summary of a profile, for the readout. */
export function profileBands(profile: NoiseProfile, bandCount = 12): { hz: number; db: number }[] {
  const bins = binCount(profile.fftSize);
  const nyquist = profile.sampleRate / 2;
  const out: { hz: number; db: number }[] = [];
  const scale = 2 / (profile.fftSize * 0.5);
  for (let b = 0; b < bandCount; b++) {
    const lo = Math.floor((b / bandCount) * bins);
    const hi = Math.max(lo + 1, Math.floor(((b + 1) / bandCount) * bins));
    let power = 0;
    for (let bin = lo; bin < hi; bin++) {
      const m = (profile.mean[bin] ?? 0) * scale;
      power += m * m;
    }
    const rms = Math.sqrt(power / (hi - lo));
    out.push({
      hz: ((lo + hi) / 2 / bins) * nyquist,
      db: rms > 0 ? 20 * Math.log10(rms) : -120,
    });
  }
  return out;
}
