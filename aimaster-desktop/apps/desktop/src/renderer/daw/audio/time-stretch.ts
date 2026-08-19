// Time stretching — WSOLA, driven by a warp map.
//
// Pitch must not move when time does, so `playbackRate` is off the table.
// WSOLA (waveform-similarity overlap-add) is the right tool for a DAW's warp:
// it works in the time domain, so it keeps transients crisp and costs a
// fraction of a phase vocoder, and it is exact at ratio 1.
//
// How it works, per output frame:
//   1. The warp map says which source position this output moment reads from.
//   2. That position is only a NOMINAL one.  Copying from it verbatim would
//      splice two waveforms at a random phase and buzz.  So we search a small
//      neighbourhood for the offset whose waveform best continues the frame
//      we just wrote — that similarity search is the whole trick.
//   3. Overlap-add with a Hann window at 50 % overlap, which sums to exactly
//      1, so no normalisation pass is needed.
//
// The search is coarse-to-fine (step 4, then ±4 at step 1).  A full search
// is ~4× the cost for a correlation peak that is never more than a couple of
// samples away from where the coarse pass put it.

import type { WarpMode } from '../model/warp.js';

export interface StretchOptions {
  /** Analysis/synthesis window, samples.  Rounded to an even number. */
  windowSamples: number;
  /** How far the similarity search may move the read position, samples. */
  searchSamples: number;
  /** false → plain overlap-add: smooth, but it smears transients. */
  similaritySearch: boolean;
}

/**
 * Ableton's warp modes are really just window/search presets, and saying so
 * is more useful than pretending they are four algorithms.
 *
 *   beats    short window — drums keep their attack
 *   tones    medium — the default for pitched, monophonic material
 *   texture  long window, no search — pads and noise, smooth over musical
 *   complex  medium window, wide search — dense mixes
 */
export function modeOptions(mode: WarpMode, sampleRate: number): StretchOptions {
  const ms = (v: number): number => Math.max(64, Math.round((v / 1000) * sampleRate / 2) * 2);
  switch (mode) {
    case 'beats':   return { windowSamples: ms(23), searchSamples: ms(6),  similaritySearch: true };
    case 'texture': return { windowSamples: ms(93), searchSamples: 0,      similaritySearch: false };
    case 'complex': return { windowSamples: ms(46), searchSamples: ms(23), similaritySearch: true };
    case 'tones':
    default:        return { windowSamples: ms(46), searchSamples: ms(12), similaritySearch: true };
  }
}

/** Periodic Hann.  At 50 % overlap two of these sum to exactly 1. */
function hann(size: number): Float64Array {
  const w = new Float64Array(size);
  for (let i = 0; i < size; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
  return w;
}

function sampleAt(input: Float32Array, index: number): number {
  return index >= 0 && index < input.length ? (input[index] ?? 0) : 0;
}

/**
 * Normalised cross-correlation between the source at `pos` and `target`.
 * Normalising matters: without it the search always drifts toward the loudest
 * part of the neighbourhood instead of the best-matching one.
 */
function similarity(
  input: Float32Array, pos: number, target: Float64Array, length: number, stride: number,
): number {
  let dot = 0;
  let energy = 0;
  for (let i = 0; i < length; i += stride) {
    const v = sampleAt(input, pos + i);
    dot += v * (target[i] ?? 0);
    energy += v * v;
  }
  return energy > 1e-12 ? dot / Math.sqrt(energy) : 0;
}

export interface StretchPlan {
  /** Source read position for each synthesis frame. */
  positions: Int32Array;
  /** Window length used, samples. */
  windowSamples: number;
  /** Synthesis hop — half the window. */
  hopSamples: number;
}

/**
 * Decide where every output frame reads from.
 *
 * `sourceSampleAt(outSample)` returns the nominal source position, in
 * samples, for an output sample index — i.e. the warp map already resolved.
 * Any monotonically increasing function works, which is what lets one call
 * handle a piecewise map with a different ratio in every segment.
 *
 * Planning is separated from rendering because a stereo file has to use the
 * SAME read positions on both channels.  Searching each channel on its own
 * would let them land a few samples apart, and a few samples of relative
 * delay is an audible collapse of the stereo image.
 */
export function planStretch(
  reference: Float32Array,
  outLength: number,
  sourceSampleAt: (outSample: number) => number,
  options: StretchOptions,
): StretchPlan {
  const N = Math.max(64, options.windowSamples - (options.windowSamples % 2));
  const hop = N >> 1;
  const frames = Math.max(0, Math.ceil(outLength / hop));
  const positions = new Int32Array(frames);
  const search = Math.max(0, Math.floor(options.searchSamples));
  // Correlate over half a window: the part that overlaps what was just
  // written is the part that has to line up.
  const corrLength = hop;
  const corrStride = 2;

  // The waveform the next frame should continue from.
  const target = new Float64Array(corrLength);
  let haveTarget = false;

  for (let frame = 0; frame < frames; frame++) {
    const nominal = Math.round(sourceSampleAt(frame * hop));
    let pos = nominal;

    if (options.similaritySearch && search > 0 && haveTarget) {
      let bestScore = -Infinity;
      let bestPos = nominal;
      for (let delta = -search; delta <= search; delta += 4) {
        const score = similarity(reference, nominal + delta, target, corrLength, corrStride);
        if (score > bestScore) { bestScore = score; bestPos = nominal + delta; }
      }
      // Refine around the coarse winner — the true peak is never far.
      const coarse = bestPos;
      for (let delta = -3; delta <= 3; delta++) {
        const candidate = coarse + delta;
        const score = similarity(reference, candidate, target, corrLength, corrStride);
        if (score > bestScore) { bestScore = score; bestPos = candidate; }
      }
      pos = bestPos;
    }

    positions[frame] = pos;
    for (let i = 0; i < corrLength; i++) target[i] = sampleAt(reference, pos + hop + i);
    haveTarget = true;
  }

  return { positions, windowSamples: N, hopSamples: hop };
}

/** Overlap-add one channel using a plan. */
export function renderStretch(input: Float32Array, outLength: number, plan: StretchPlan): Float32Array {
  const out = new Float32Array(outLength);
  const { positions, windowSamples: N, hopSamples: hop } = plan;
  const window = hann(N);
  for (let frame = 0; frame < positions.length; frame++) {
    const outStart = frame * hop;
    const pos = positions[frame] ?? 0;
    for (let i = 0; i < N; i++) {
      const index = outStart + i;
      if (index >= outLength) break;
      out[index] = (out[index] ?? 0) + sampleAt(input, pos + i) * (window[i] ?? 0);
    }
  }
  return out;
}

/** Stretch one channel — plan and render in one call. */
export function stretchChannel(
  input: Float32Array,
  outLength: number,
  sourceSampleAt: (outSample: number) => number,
  options: StretchOptions,
): Float32Array {
  if (outLength === 0 || input.length === 0) return new Float32Array(outLength);
  return renderStretch(input, outLength, planStretch(input, outLength, sourceSampleAt, options));
}

/**
 * Stretch every channel with ONE plan, made from the mono sum so the search
 * follows the music rather than whichever channel happened to be channel 0.
 */
export function stretchChannels(
  channels: readonly Float32Array[],
  outLength: number,
  sourceSampleAt: (outSample: number) => number,
  options: StretchOptions,
): Float32Array[] {
  if (channels.length === 0) return [];
  if (outLength === 0) return channels.map(() => new Float32Array(0));

  const first = channels[0] ?? new Float32Array(0);
  let reference = first;
  if (channels.length > 1) {
    reference = new Float32Array(first.length);
    for (let i = 0; i < first.length; i++) {
      let sum = 0;
      for (const ch of channels) sum += ch[i] ?? 0;
      reference[i] = sum / channels.length;
    }
  }

  const plan = planStretch(reference, outLength, sourceSampleAt, options);
  return channels.map((ch) => renderStretch(ch, outLength, plan));
}
