// Pitch and formant rendering for the vocal editor — TD-PSOLA.
//
// Why PSOLA and not a granular resampler: PSOLA keeps the ORIGINAL grain
// waveform and changes only how often grains are laid down.  The waveform
// carries the vocal tract's resonances, so the formants stay where the singer
// put them and a corrected note still sounds like that singer instead of a
// chipmunk.  Resampling the grain CONTENT (rather than its placement) is then
// exactly the formant control — the two axes come apart cleanly.
//
//   pitch    ← synthesis period  (how far apart grains are placed)
//   formant  ← grain resampling  (how the grain itself is read)
//   timing   ← which analysis grain a synthesis instant borrows from
//
// The analysis gives us F0 over time, so pitch marks are derived rather than
// guessed.

import { pitchToFrequency } from '../model/midi.js';
import { curveCentsAt, shiftSemitonesAt, type VariSegment } from './pitch-analysis.js';

/** Hann window of a given length. */
function hann(length: number): Float32Array {
  const w = new Float32Array(length);
  for (let i = 0; i < length; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (length - 1));
  return w;
}

/** Linear-interpolated read, so grain resampling is not quantised to samples. */
function sampleAt(data: Float32Array, position: number): number {
  if (position <= 0) return data[0] ?? 0;
  if (position >= data.length - 1) return data[data.length - 1] ?? 0;
  const i = Math.floor(position);
  const frac = position - i;
  return (data[i] ?? 0) * (1 - frac) + (data[i + 1] ?? 0) * frac;
}

export interface ShiftOptions {
  /** Crossfade at the segment edges so an edited note does not click. */
  edgeFadeSec: number;
  /** Lowest F0 the renderer will trust; below it the segment is left alone. */
  minHz: number;
}

export const DEFAULT_SHIFT_OPTIONS: ShiftOptions = { edgeFadeSec: 0.006, minHz: 50 };

/**
 * Render one segment's edits into `output`, reading from `input`.
 * Both arrays are the whole track; only the segment's range is touched.
 */
export function renderSegment(
  input: Float32Array,
  output: Float32Array,
  sampleRate: number,
  segment: VariSegment,
  options: Partial<ShiftOptions> = {},
): void {
  const opt = { ...DEFAULT_SHIFT_OPTIONS, ...options };
  const start = Math.max(0, Math.floor(segment.startSec * sampleRate));
  const end = Math.min(input.length, Math.ceil(segment.endSec * sampleRate));
  const length = end - start;
  if (length < 64) return;

  /** Measured F0 at a segment-relative time. */
  const f0At = (tRel: number): number => {
    const pitch = segment.measured.medianPitch + curveCentsAt(segment.measured.curve, tRel) / 100;
    return pitchToFrequency(pitch);
  };

  const formantRatio = Math.pow(2, segment.edit.formantSemitones / 12);
  const timeShiftSamples = Math.round(segment.edit.timeOffsetSec * sampleRate);

  // 1. Analysis pitch marks, spaced by the measured period.
  const marks: number[] = [];
  for (let position = start; position < end;) {
    marks.push(position);
    const f0 = f0At((position - start) / sampleRate);
    const period = f0 >= opt.minHz ? sampleRate / f0 : sampleRate / 200;
    position += Math.max(8, period);
  }
  if (marks.length < 2) return;

  const rendered = new Float32Array(length);
  const normalise = new Float32Array(length);

  // 2. Lay down synthesis grains at the shifted period.
  for (let position = start; position < end;) {
    const tRel = (position - start) / sampleRate;
    const f0 = f0At(tRel);
    if (f0 < opt.minHz) { position += sampleRate / 200; continue; }

    const shift = shiftSemitonesAt(segment, tRel);
    const ratio = Math.pow(2, shift / 12);
    const analysisPeriod = sampleRate / f0;
    const synthesisPeriod = Math.max(8, analysisPeriod / ratio);

    // Nearest analysis mark — this is where the timing axis lives.
    let nearest = marks[0] ?? start;
    let bestDistance = Infinity;
    for (const m of marks) {
      const d = Math.abs(m - position);
      if (d < bestDistance) { bestDistance = d; nearest = m; }
    }

    const grainLength = Math.max(16, Math.round(analysisPeriod * 2));
    const window = hann(grainLength);
    const half = grainLength / 2;

    for (let i = 0; i < grainLength; i++) {
      // Grain content is resampled ONLY for formant shifting.
      const readOffset = (i - half) * formantRatio;
      const readPosition = nearest + readOffset;
      const writeIndex = Math.round(position - start + (i - half)) + timeShiftSamples;
      if (writeIndex < 0 || writeIndex >= length) continue;
      const value = sampleAt(input, readPosition) * (window[i] ?? 0);
      rendered[writeIndex] = (rendered[writeIndex] ?? 0) + value;
      normalise[writeIndex] = (normalise[writeIndex] ?? 0) + (window[i] ?? 0);
    }

    position += synthesisPeriod;
  }

  // 3. Normalise the overlap-add and blend into the output.
  const fade = Math.max(1, Math.round(opt.edgeFadeSec * sampleRate));
  for (let i = 0; i < length; i++) {
    const weight = normalise[i] ?? 0;
    const value = weight > 1e-4 ? (rendered[i] ?? 0) / weight : (input[start + i] ?? 0);
    let blend = 1;
    if (i < fade) blend = i / fade;
    else if (i > length - fade) blend = Math.max(0, (length - i) / fade);
    const original = input[start + i] ?? 0;
    output[start + i] = original * (1 - blend) + value * blend;
  }
}

/**
 * Apply every segment's edits to a channel.
 * Untouched regions pass through sample-for-sample.
 */
export function renderVariAudioChannel(
  input: Float32Array,
  sampleRate: number,
  segments: readonly VariSegment[],
  options: Partial<ShiftOptions> = {},
): Float32Array {
  const output = new Float32Array(input.length);
  output.set(input);
  for (const segment of segments) {
    if (isNeutral(segment)) continue;
    renderSegment(input, output, sampleRate, segment, options);
  }
  return output;
}

/** True when a segment would render bit-identical to its source. */
export function isNeutral(segment: VariSegment): boolean {
  const e = segment.edit;
  return e.pitchOffsetCents === 0
    && e.vibratoScale === 1
    && e.driftScale === 1
    && e.curveScale === 1
    && e.formantSemitones === 0
    && e.timeOffsetSec === 0;
}

/** Multi-channel convenience — every channel gets the same edits. */
export function renderVariAudio(
  channels: readonly Float32Array[],
  sampleRate: number,
  segments: readonly VariSegment[],
  options: Partial<ShiftOptions> = {},
): Float32Array[] {
  return channels.map((c) => renderVariAudioChannel(c, sampleRate, segments, options));
}
