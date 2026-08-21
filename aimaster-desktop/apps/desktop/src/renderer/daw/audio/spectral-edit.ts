// Spectral editing — RX-style repair inside the DAW.
//
// The user draws a box on the spectrogram (a time span × a frequency band)
// and asks for one of three things:
//
//   attenuate  pull the box down by N dB — the surgical notch
//   repair     rebuild the box from the audio just before and just after it,
//              so a click vanishes and the note underneath keeps playing
//   replace    paste the same band from a different moment in the take
//
// Everything runs through the invertible STFT in ./stft.js, so the samples
// outside the box come back untouched.  Three rules make the result sound
// like an edit and not like a hole:
//
//   • Feathering.  A hard-edged box rings; the edit weight ramps in over a
//     few frames and a few bins at every border.
//   • Phase is preserved.  We only ever rewrite magnitudes (except for
//     replace, which brings its own complex values), so the residual noise
//     floor keeps its texture.
//   • Only the affected span is transformed.  A 4-minute file with a 30 ms
//     click costs a 30 ms FFT, not a 4-minute one.

import {
  binCount, hzToBin, istft, frameMagnitude, framePhase, scaleBin, secToFrame,
  setBin, stft, type Spectrogram, type StftOptions,
} from './stft.js';

export interface SpectralRegion {
  startSec: number;
  endSec: number;
  lowHz: number;
  highHz: number;
}

export type SpectralOp =
  /** Scale the box.  −Infinity dB is a full mute. */
  | { kind: 'attenuate'; gainDb: number }
  /** Interpolate the box's magnitudes from the frames on either side. */
  | { kind: 'repair' }
  /** Copy the same band from `sourceSec`. */
  | { kind: 'replace'; sourceSec: number };

export interface SpectralEditOptions extends Partial<StftOptions> {
  /** Ramp length at the time borders, in frames. */
  featherFrames?: number;
  /** Ramp length at the frequency borders, in bins. */
  featherBins?: number;
  /** 0…1 wet mix, so an edit can be dialled back without redrawing it. */
  amount?: number;
}

const DEFAULTS = { featherFrames: 2, featherBins: 3, amount: 1 } as const;

// Shorter than the analysis window used for drawing.  Time resolution is what
// makes a click edit surgical: a 2048-point window at 44.1 kHz smears an 8 ms
// tick across 46 ms, so the box would have to be far bigger than the problem.
export const DEFAULT_EDIT_FFT = 1024;

export interface RegionBounds {
  fromFrame: number; toFrame: number;   // inclusive
  lowBin: number; highBin: number;      // inclusive
}

/** The box in frame/bin coordinates, clamped to what the spectrogram holds. */
export function regionBounds(spec: Spectrogram, region: SpectralRegion): RegionBounds {
  const lastFrame = spec.frames.length - 1;
  const lastBin = binCount(spec.fftSize) - 1;
  const rawFrom = Math.floor(secToFrame(Math.min(region.startSec, region.endSec), spec.hopSize, spec.sampleRate));
  const rawTo = Math.ceil(secToFrame(Math.max(region.startSec, region.endSec), spec.hopSize, spec.sampleRate));
  const rawLow = Math.floor(hzToBin(Math.min(region.lowHz, region.highHz), spec.fftSize, spec.sampleRate));
  const rawHigh = Math.ceil(hzToBin(Math.max(region.lowHz, region.highHz), spec.fftSize, spec.sampleRate));
  return {
    fromFrame: Math.max(0, Math.min(lastFrame, rawFrom)),
    toFrame: Math.max(0, Math.min(lastFrame, rawTo)),
    lowBin: Math.max(0, Math.min(lastBin, rawLow)),
    highBin: Math.max(0, Math.min(lastBin, rawHigh)),
  };
}

// Raised-cosine ramp: 0 outside [lo, hi], 1 in the middle, smooth over
// `feather` steps at each border.
function edgeWeight(i: number, lo: number, hi: number, feather: number): number {
  if (i < lo || i > hi) return 0;
  if (feather <= 0) return 1;
  const d = Math.min(i - lo, hi - i);
  if (d >= feather) return 1;
  return 0.5 - 0.5 * Math.cos((Math.PI * (d + 0.5)) / feather);
}

/**
 * Apply an edit to a spectrogram in place.  Exposed separately from
 * {@link applySpectralEdit} so the UI can preview an edit on the spectrogram
 * it already computed for drawing.
 */
export function editSpectrogram(
  spec: Spectrogram, region: SpectralRegion, op: SpectralOp,
  options: SpectralEditOptions = {},
): void {
  const featherFrames = options.featherFrames ?? DEFAULTS.featherFrames;
  const featherBins = options.featherBins ?? DEFAULTS.featherBins;
  const amount = Math.max(0, Math.min(1, options.amount ?? DEFAULTS.amount));
  if (amount === 0) return;

  const { fromFrame, toFrame, lowBin, highBin } = regionBounds(spec, region);
  const { fftSize } = spec;

  // A feather can never eat more than half the box, or a small selection
  // would never reach full attenuation in the middle.
  const timeFeather = Math.min(featherFrames, Math.floor((toFrame - fromFrame) / 2));
  const binFeather = Math.min(featherBins, Math.floor((highBin - lowBin) / 2));

  // The frames just outside the box are the reference for `repair`.
  const beforeFrame = spec.frames[Math.max(0, fromFrame - 1)];
  const afterFrame = spec.frames[Math.min(spec.frames.length - 1, toFrame + 1)];
  const span = Math.max(1, toFrame - fromFrame);

  let sourceShift = 0;
  if (op.kind === 'replace') {
    sourceShift = Math.round(
      secToFrame(op.sourceSec, spec.hopSize, spec.sampleRate)
      - secToFrame(Math.min(region.startSec, region.endSec), spec.hopSize, spec.sampleRate),
    );
  }

  const linearGain = op.kind === 'attenuate'
    ? (op.gainDb <= -200 ? 0 : Math.pow(10, op.gainDb / 20))
    : 1;

  for (let f = fromFrame; f <= toFrame; f++) {
    const frame = spec.frames[f];
    if (!frame) continue;
    const tw = edgeWeight(f, fromFrame, toFrame, timeFeather);
    if (tw <= 0) continue;

    const sourceFrame = op.kind === 'replace'
      ? spec.frames[Math.max(0, Math.min(spec.frames.length - 1, f + sourceShift))]
      : undefined;

    for (let bin = lowBin; bin <= highBin; bin++) {
      const w = tw * edgeWeight(bin, lowBin, highBin, binFeather) * amount;
      if (w <= 0) continue;

      if (op.kind === 'attenuate') {
        // 1 at the border, `linearGain` in the middle.
        scaleBin(frame, bin, 1 + (linearGain - 1) * w, fftSize);
        continue;
      }

      const original = frameMagnitude(frame, bin);
      let target = original;

      if (op.kind === 'repair') {
        const a = beforeFrame ? frameMagnitude(beforeFrame, bin) : 0;
        const b = afterFrame ? frameMagnitude(afterFrame, bin) : 0;
        const t = (f - fromFrame) / span;
        target = a + (b - a) * t;
      } else if (sourceFrame) {
        target = frameMagnitude(sourceFrame, bin);
      }

      // Phase: repair keeps the original (the residual keeps its texture);
      // replace brings the donor's, which is what makes a paste sound like
      // the moment it came from.
      const phase = op.kind === 'replace' && sourceFrame
        ? framePhase(sourceFrame, bin)
        : framePhase(frame, bin);
      setBin(frame, bin, original + (target - original) * w, phase, fftSize);
    }
  }
}

/** Padding around the edited span, so the STFT sees real audio at its edges. */
const padSamples = (fftSize: number): number => fftSize * 2;

/**
 * Run an edit over a mono channel and return a new buffer.  Only the samples
 * near the region are transformed; the rest are copied verbatim.
 */
export function applySpectralEdit(
  samples: Float32Array, sampleRate: number,
  region: SpectralRegion, op: SpectralOp,
  options: SpectralEditOptions = {},
): Float32Array {
  const fftSize = options.fftSize ?? DEFAULT_EDIT_FFT;
  const hopSize = options.hopSize ?? fftSize / 4;
  const out = Float32Array.from(samples);
  if (samples.length === 0) return out;

  const startSec = Math.min(region.startSec, region.endSec);
  const endSec = Math.max(region.startSec, region.endSec);
  const pad = padSamples(fftSize);

  // `replace` reads from elsewhere in the take, so the slice has to cover the
  // donor as well as the destination.
  const donorSec = op.kind === 'replace' ? op.sourceSec : startSec;
  const donorEndSec = op.kind === 'replace' ? op.sourceSec + (endSec - startSec) : endSec;

  const first = Math.max(0, Math.floor(Math.min(startSec, donorSec) * sampleRate) - pad);
  const last = Math.min(samples.length, Math.ceil(Math.max(endSec, donorEndSec) * sampleRate) + pad);
  if (last <= first) return out;

  const slice = samples.subarray(first, last);
  const offsetSec = first / sampleRate;
  const spec = stft(slice, sampleRate, { fftSize, hopSize });

  const shifted: SpectralRegion = {
    startSec: startSec - offsetSec,
    endSec: endSec - offsetSec,
    lowHz: region.lowHz,
    highHz: region.highHz,
  };
  const shiftedOp: SpectralOp = op.kind === 'replace'
    ? { kind: 'replace', sourceSec: op.sourceSec - offsetSec }
    : op;

  editSpectrogram(spec, shifted, shiftedOp, options);
  const edited = istft(spec);

  // The round trip is transparent, but splicing with a short crossfade means
  // a float rounding difference at the seam can never click.
  const fade = Math.min(hopSize, Math.floor((last - first) / 4));
  for (let i = 0; i < edited.length; i++) {
    const index = first + i;
    if (index >= out.length) break;
    let w = 1;
    if (first > 0 && i < fade) w = i / fade;
    if (last < samples.length && i >= edited.length - fade) w = Math.min(w, (edited.length - 1 - i) / fade);
    out[index] = (out[index] ?? 0) * (1 - w) + (edited[i] ?? 0) * w;
  }
  return out;
}

/** Same edit across every channel of an interleaved-by-array buffer. */
export function applySpectralEditChannels(
  channels: Float32Array[], sampleRate: number,
  region: SpectralRegion, op: SpectralOp,
  options: SpectralEditOptions = {},
): Float32Array[] {
  return channels.map((ch) => applySpectralEdit(ch, sampleRate, region, op, options));
}

// ── Drawing + detection ───────────────────────────────────────────────────────

export interface SpectrogramGrid {
  width: number;            // frames
  height: number;           // bins
  /** Row-major [bin][frame], normalised 0…1 between minDb and maxDb. */
  data: Float32Array;
  minDb: number;
  maxDb: number;
}

/** Log-magnitude grid for the canvas, normalised so 0 = floor, 1 = ceiling. */
export function spectrogramGrid(spec: Spectrogram, minDb = -96, maxDb = 0): SpectrogramGrid {
  const width = spec.frames.length;
  const height = binCount(spec.fftSize);
  const data = new Float32Array(width * height);
  const range = Math.max(1e-6, maxDb - minDb);
  // Windowed magnitudes scale with the frame length; normalise so a
  // full-scale sine reads near 0 dB whatever the FFT size.
  const scale = 2 / (spec.fftSize * 0.5);

  for (let f = 0; f < width; f++) {
    const frame = spec.frames[f];
    if (!frame) continue;
    for (let bin = 0; bin < height; bin++) {
      const m = frameMagnitude(frame, bin) * scale;
      const db = m > 0 ? 20 * Math.log10(m) : minDb;
      data[bin * width + f] = Math.max(0, Math.min(1, (db - minDb) / range));
    }
  }
  return { width, height, data, minDb, maxDb };
}

export interface SpectralAnomaly {
  startSec: number;
  endSec: number;
  lowHz: number;
  highHz: number;
  /** Broadband flux at the hit, relative to the local average. */
  strength: number;
}

export interface AnomalyOptions {
  /** Ignore energy below here — clicks live in the top half. */
  minHz?: number;
  maxHz?: number;
  /** How many times the local average flux counts as a hit. */
  threshold?: number;
}

/**
 * Find click-like events: frames where high-frequency energy jumps well
 * above its neighbourhood.  This is what fills the "suspects" list next to
 * the spectrogram so the user can click one instead of drawing a box.
 */
export function findAnomalies(spec: Spectrogram, options: AnomalyOptions = {}): SpectralAnomaly[] {
  const minHz = options.minHz ?? 2000;
  const maxHz = options.maxHz ?? Math.min(16000, spec.sampleRate / 2);
  const threshold = options.threshold ?? 4;
  const lowBin = Math.max(1, Math.floor(hzToBin(minHz, spec.fftSize, spec.sampleRate)));
  const highBin = Math.min(binCount(spec.fftSize) - 1, Math.ceil(hzToBin(maxHz, spec.fftSize, spec.sampleRate)));
  if (spec.frames.length < 4 || highBin <= lowBin) return [];

  // The first and last frames overlap the STFT's zero padding, so their flux
  // is an artefact of the analysis, not a click in the material.
  const edge = Math.ceil(spec.fftSize / spec.hopSize);
  const firstFrame = edge;
  const lastFrame = spec.frames.length - edge;
  if (lastFrame - firstFrame < 3) return [];

  // Positive spectral flux, band-limited.
  const flux = new Float64Array(spec.frames.length);
  for (let f = firstFrame; f < lastFrame; f++) {
    const cur = spec.frames[f];
    const prev = spec.frames[f - 1];
    if (!cur || !prev) continue;
    let sum = 0;
    for (let bin = lowBin; bin <= highBin; bin++) {
      const d = frameMagnitude(cur, bin) - frameMagnitude(prev, bin);
      if (d > 0) sum += d;
    }
    flux[f] = sum;
  }

  let mean = 0;
  for (let f = firstFrame; f < lastFrame; f++) mean += flux[f] ?? 0;
  mean /= lastFrame - firstFrame;
  if (mean <= 0) return [];

  const out: SpectralAnomaly[] = [];
  const secPerFrame = spec.hopSize / spec.sampleRate;
  for (let f = firstFrame + 1; f < lastFrame - 1; f++) {
    const v = flux[f] ?? 0;
    if (v < mean * threshold) continue;
    // Local maximum only, so one click reports once.
    if (v < (flux[f - 1] ?? 0) || v < (flux[f + 1] ?? 0)) continue;
    out.push({
      startSec: Math.max(0, (f - 1) * secPerFrame),
      endSec: (f + 2) * secPerFrame,
      lowHz: minHz,
      highHz: maxHz,
      strength: v / mean,
    });
  }
  return out.sort((a, b) => b.strength - a.strength);
}

/** Human-readable summary for the history entry and the tooltip. */
export function describeSpectralEdit(region: SpectralRegion, op: SpectralOp): string {
  const start = Math.min(region.startSec, region.endSec);
  const end = Math.max(region.startSec, region.endSec);
  const box = `${(end - start) * 1000 < 1000
    ? `${Math.round((end - start) * 1000)} ms`
    : `${(end - start).toFixed(2)} s`} × ${Math.round(region.lowHz)}–${Math.round(region.highHz)} Hz`;
  switch (op.kind) {
    case 'attenuate':
      return `Attenuate ${op.gainDb <= -200 ? '∞' : `${op.gainDb.toFixed(1)}`} dB · ${box}`;
    case 'repair':
      return `Repair · ${box}`;
    case 'replace':
      return `Replace from ${op.sourceSec.toFixed(3)} s · ${box}`;
  }
}
