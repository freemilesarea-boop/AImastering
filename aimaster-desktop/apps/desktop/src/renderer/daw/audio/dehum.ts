// De-hum — mains hum is a noise profile that happens to be a comb.
//
// That framing is the whole design.  Hum is 50 or 60 Hz plus its harmonics,
// present for the entire take at a near-constant level; it is exactly the kind
// of thing the learned-profile denoiser already removes well.  So instead of a
// second subtraction engine, this module builds a NoiseProfile whose only
// non-zero bins are the harmonic comb, and hands it to the same code path.
// The residual monitor and the smoothing come along for free.
//
// Two things make it a de-hummer rather than a comb notch:
//
//   • The level per harmonic is the PERSISTENT level, taken as a low
//     percentile of that bin over time — not its mean.  Hum is always there,
//     so the quietest moments at that bin ARE the hum.  A bass note that
//     happens to sit on 100 Hz raises the mean but not the 20th percentile,
//     so it survives.
//   • Nothing is removed unless the comb is actually there.  Detection scores
//     both the harmonic structure AND how stationary the fundamental is,
//     because a sustained bass note has harmonics too — it just does not hold
//     the same level for the entire take.

import {
  binCount, frameMagnitude, hzToBin, stft, type Spectrogram,
} from './stft.js';
import { reduceNoise, type DenoiseOptions, type NoiseProfile } from './noise-reduction.js';

export interface HumHarmonic {
  hz: number;
  bin: number;
  /** Persistent level at this harmonic, linear magnitude. */
  level: number;
}

export interface HumDetection {
  /** Refined fundamental — mains is nominal, never exact. */
  f0: number;
  /** Which nominal standard it matched. */
  nominal: 50 | 60;
  harmonics: HumHarmonic[];
  /** 0…1.  Harmonic structure × stationarity. */
  confidence: number;
  /** Comb-shaped profile, ready for the subtraction path. */
  profile: NoiseProfile;
}

export interface HumOptions {
  /** Frequency resolution.  8192 gives ~5.4 Hz bins at 44.1 kHz, which is
   *  narrow enough to notch 50 Hz without taking the bass with it. */
  fftSize?: number;
  hopSize?: number;
  /** Seconds analysed for detection.  Hum is stationary, so a window is
   *  enough — and a 4-minute file does not need a 4-minute analysis. */
  analysisSec?: number;
  /** Harmonics tracked, up to Nyquist. */
  maxHarmonics?: number;
  /** Bins each side of a harmonic that count as part of it. */
  widthBins?: number;
  /** Percentile of a bin's level over time taken as "the hum". */
  percentile?: number;
  /** Below this, report nothing rather than guess. */
  minConfidence?: number;
}

const HUM_DEFAULTS = {
  fftSize: 8192, analysisSec: 20, maxHarmonics: 40,
  widthBins: 1, percentile: 0.2, minConfidence: 0.35,
};

export const NOMINAL_HUM: readonly (50 | 60)[] = [50, 60];

function percentileOf(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[index] ?? 0;
}

/** Magnitudes at one bin across every frame. */
function binOverTime(spec: Spectrogram, bin: number): number[] {
  const out: number[] = [];
  for (const frame of spec.frames) out.push(frameMagnitude(frame, bin));
  return out;
}

/** Mean magnitude spectrum of a spectrogram. */
function meanSpectrum(spec: Spectrogram): Float64Array {
  const bins = binCount(spec.fftSize);
  const out = new Float64Array(bins);
  if (spec.frames.length === 0) return out;
  for (const frame of spec.frames) {
    for (let bin = 0; bin < bins; bin++) out[bin] = (out[bin] ?? 0) + frameMagnitude(frame, bin);
  }
  for (let bin = 0; bin < bins; bin++) out[bin] = (out[bin] ?? 0) / spec.frames.length;
  return out;
}

/** Parabolic peak refinement — a bin index is 5 Hz wide; hum is not. */
function refinePeak(spectrum: Float64Array, bin: number): number {
  const a = spectrum[bin - 1] ?? 0;
  const b = spectrum[bin] ?? 0;
  const c = spectrum[bin + 1] ?? 0;
  const denominator = a - 2 * b + c;
  if (Math.abs(denominator) < 1e-20) return bin;
  const offset = (0.5 * (a - c)) / denominator;
  return bin + Math.max(-0.5, Math.min(0.5, offset));
}

/** Median of the bins around `bin`, excluding the peak itself. */
function localFloor(spectrum: Float64Array, bin: number, radius = 12, skip = 2): number {
  const values: number[] = [];
  for (let k = bin - radius; k <= bin + radius; k++) {
    if (k < 0 || k >= spectrum.length) continue;
    if (Math.abs(k - bin) <= skip) continue;
    values.push(spectrum[k] ?? 0);
  }
  return percentileOf(values, 0.5);
}

/**
 * Look for mains hum.  Returns null when the comb is not convincingly there —
 * removing a comb that is not hum is how a bass guitar loses its low end.
 */
export function detectHum(
  samples: Float32Array, sampleRate: number, options: HumOptions = {},
): HumDetection | null {
  const requested = options.fftSize ?? HUM_DEFAULTS.fftSize;
  const analysisSec = options.analysisSec ?? HUM_DEFAULTS.analysisSec;
  const maxHarmonics = options.maxHarmonics ?? HUM_DEFAULTS.maxHarmonics;
  const widthBins = Math.max(0, options.widthBins ?? HUM_DEFAULTS.widthBins);
  const percentile = options.percentile ?? HUM_DEFAULTS.percentile;
  const minConfidence = options.minConfidence ?? HUM_DEFAULTS.minConfidence;

  // The window has to hold at least a few frames of the chosen FFT size.
  let fftSize = requested;
  while (fftSize > 1024 && samples.length < fftSize * 2) fftSize /= 2;
  const hopSize = options.hopSize ?? fftSize / 4;
  if (samples.length < fftSize * 2) return null;

  // Analyse from the middle — the head of a take is often the count-in.
  const windowSamples = Math.min(samples.length, Math.round(analysisSec * sampleRate));
  const start = Math.max(0, Math.floor((samples.length - windowSamples) / 2));
  const spec = stft(samples.subarray(start, start + windowSamples), sampleRate, { fftSize, hopSize });
  if (spec.frames.length < 4) return null;

  const spectrum = meanSpectrum(spec);
  const bins = binCount(fftSize);
  const nyquist = sampleRate / 2;

  let best: HumDetection | null = null;

  for (const nominal of NOMINAL_HUM) {
    // Find the actual peak within ±2 Hz of nominal — mains drifts.
    const centre = Math.round(hzToBin(nominal, fftSize, sampleRate));
    const span = Math.max(1, Math.ceil(hzToBin(2, fftSize, sampleRate)));
    let peakBin = centre;
    let peak = -1;
    for (let bin = centre - span; bin <= centre + span; bin++) {
      if (bin < 1 || bin >= bins) continue;
      const v = spectrum[bin] ?? 0;
      if (v > peak) { peak = v; peakBin = bin; }
    }
    const floor = localFloor(spectrum, peakBin);
    if (peak <= floor * 2) continue;                       // no peak worth calling hum

    let f0 = (refinePeak(spectrum, peakBin) * sampleRate) / fftSize;

    // Refine against a mid harmonic.  An error of 0.1 Hz at the fundamental is
    // 4 Hz by the 40th harmonic — enough for the comb to walk off the hum and
    // onto whatever is nearby.  Measuring the 8th harmonic and dividing cuts
    // that error by eight.
    for (const k of [8, 6, 4]) {
      const expected = hzToBin(f0 * k, fftSize, sampleRate);
      if (expected >= bins - 2 || expected < 2) continue;
      const search = Math.max(1, Math.ceil(hzToBin(1.5, fftSize, sampleRate)));
      let bin = Math.round(expected);
      let level = -1;
      for (let b = Math.round(expected) - search; b <= Math.round(expected) + search; b++) {
        if (b < 1 || b >= bins) continue;
        const v = spectrum[b] ?? 0;
        if (v > level) { level = v; bin = b; }
      }
      if (level <= localFloor(spectrum, bin) * 2) continue;
      f0 = (refinePeak(spectrum, bin) * sampleRate) / fftSize / k;
      break;
    }

    // How much of the comb is actually present?
    let present = 0;
    let considered = 0;
    for (let k = 1; k <= 12; k++) {
      const hz = f0 * k;
      if (hz >= nyquist) break;
      considered++;
      const bin = Math.round(hzToBin(hz, fftSize, sampleRate));
      if (bin >= bins - 1) break;
      let local = 0;
      for (let d = -widthBins; d <= widthBins; d++) local = Math.max(local, spectrum[bin + d] ?? 0);
      if (local > localFloor(spectrum, bin) * 2.5) present++;
    }
    const harmonicScore = considered > 0 ? present / considered : 0;

    // Stationarity: hum is always there, so its quiet percentile sits close to
    // its median.  A bass note that happens to be at 50 Hz does not.
    const overTime = binOverTime(spec, peakBin);
    const low = percentileOf(overTime, 0.1);
    const median = percentileOf(overTime, 0.5);
    const stationarity = median > 1e-12 ? Math.min(1, low / median) : 0;

    const confidence = harmonicScore * stationarity;
    if (confidence < minConfidence) continue;
    if (best && confidence <= best.confidence) continue;

    // Persistent level per harmonic, and the comb-shaped profile.
    const mean = new Float32Array(bins);
    const harmonics: HumHarmonic[] = [];
    for (let k = 1; k <= maxHarmonics; k++) {
      const hz = f0 * k;
      if (hz >= nyquist) break;
      const bin = Math.round(hzToBin(hz, fftSize, sampleRate));
      if (bin < 1 || bin >= bins) break;
      // If the loudest thing near the expected harmonic is not AT the expected
      // harmonic, that energy is not our comb — it is a note that happens to
      // live nearby, and notching it would be the tool doing damage.
      let strongestBin = bin;
      let strongest = -1;
      for (let d = -widthBins - 2; d <= widthBins + 2; d++) {
        const target = bin + d;
        if (target < 1 || target >= bins) continue;
        const v = spectrum[target] ?? 0;
        if (v > strongest) { strongest = v; strongestBin = target; }
      }
      if (Math.abs(strongestBin - bin) > widthBins) continue;

      let level = 0;
      for (let d = -widthBins; d <= widthBins; d++) {
        const target = bin + d;
        if (target < 1 || target >= bins) continue;
        const persistent = percentileOf(binOverTime(spec, target), percentile);
        mean[target] = Math.max(mean[target] ?? 0, persistent);
        if (d === 0) level = persistent;
      }
      // A harmonic that is not above the local floor is not worth notching.
      if (level > localFloor(spectrum, bin) * 1.2) {
        harmonics.push({ hz, bin, level });
      } else {
        for (let d = -widthBins; d <= widthBins; d++) {
          const target = bin + d;
          if (target >= 0 && target < bins) mean[target] = 0;
        }
      }
    }
    if (harmonics.length === 0) continue;

    best = {
      f0,
      nominal,
      harmonics,
      confidence,
      profile: {
        fftSize, hopSize, sampleRate, mean,
        deviation: new Float32Array(bins),
        frames: spec.frames.length,
        durationSec: windowSamples / sampleRate,
      },
    };
  }

  return best;
}

export interface DehumOptions extends DenoiseOptions {
  /** Harmonics above this index are left alone. */
  maxHarmonics?: number;
}

/**
 * Remove the detected comb.
 *
 * `bandSmoothing` is forced to 0: the general denoiser smooths gains across
 * bins to avoid warbling, but here that would widen every notch into its
 * neighbours and take the bass with it.  A comb is meant to be narrow.
 */
export function removeHum(
  samples: Float32Array, sampleRate: number,
  detection: HumDetection, options: DehumOptions = {},
): Float32Array {
  const profile = options.maxHarmonics === undefined
    ? detection.profile
    : limitHarmonics(detection, options.maxHarmonics);
  return reduceNoise(samples, sampleRate, profile, {
    reductionDb: 24,
    strength: 1,
    sensitivity: 0,
    smoothing: 0.3,
    ...options,
    bandSmoothing: 0,
  });
}

export function removeHumChannels(
  channels: readonly Float32Array[], sampleRate: number,
  detection: HumDetection, options: DehumOptions = {},
): Float32Array[] {
  return channels.map((ch) => removeHum(ch, sampleRate, detection, options));
}

/** A copy of the profile with only the first `count` harmonics kept. */
function limitHarmonics(detection: HumDetection, count: number): NoiseProfile {
  const mean = Float32Array.from(detection.profile.mean);
  detection.harmonics.forEach((h, index) => {
    if (index < count) return;
    for (let d = -2; d <= 2; d++) {
      const bin = h.bin + d;
      if (bin >= 0 && bin < mean.length) mean[bin] = 0;
    }
  });
  return { ...detection.profile, mean };
}

export function describeHum(detection: HumDetection | null): string {
  if (!detection) return '험이 검출되지 않았습니다';
  return `${detection.nominal} Hz 계열 · 실측 ${detection.f0.toFixed(2)} Hz`
    + ` · 하모닉 ${detection.harmonics.length}개 · 확신도 ${(detection.confidence * 100).toFixed(0)}%`;
}
