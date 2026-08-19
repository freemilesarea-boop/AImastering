// De-clip — put back the peaks that were cut off.
//
// A clipped sample is not a damaged sample; it is a MISSING one.  The
// waveform went above what the converter could represent and came back with
// its top sliced flat, so the information is not corrupted — it is absent.
//
// That reframing is the whole implementation.  The de-clicker already knows
// how to rebuild missing samples: fit an autoregressive model to the audio
// around a gap and solve for the samples that best satisfy it.  So de-clipping
// is de-clicking with a different detector — find the flat tops, call them
// gaps, and reuse `interpolateGap`.
//
// Two things are specific to clipping and matter:
//
//   The reconstruction must be ALLOWED to exceed full scale.  Constraining the
//   fill to ±1 would just re-clip it, more smoothly.  The peaks come back
//   above 1.0 and the whole signal is scaled down afterwards, which is what
//   restores the shape rather than the level.
//
//   A loud peak is not a clipped peak.  This is the trap: a sine at full scale
//   spends several samples above any sensible threshold, and they barely move,
//   so "consecutive and nearly equal" flags a clean signal as damaged.  What
//   actually separates them is the SLOPE.  A real clip has a derivative
//   discontinuity — the waveform arrives at the ceiling moving fast and stops
//   dead — while a sine's peak decelerates into its turn.  So the detector
//   requires the run to be flat to within a hair AND to be entered abruptly.

import { interpolateGap, type InterpolateOptions } from './declick.js';

export interface ClipRun {
  /** First clipped sample. */
  from: number;
  /** One past the last. */
  to: number;
  /** +1 for a positive clip, −1 for a negative one. */
  sign: number;
}

export interface DeclipOptions extends InterpolateOptions {
  /** Level at or above which a sample counts as pinned. */
  thresholdLinear?: number;
  /**
   * When the loudest sample sits below `thresholdLinear`, use the signal's own
   * peak as the ceiling instead.  Audio that was clipped in the box and then
   * turned down still has flat tops; they are just not at 0 dBFS any more.
   */
  autoCeiling?: boolean;
  /** How much the samples inside a run may vary and still count as flat. */
  flatnessTolerance?: number;
  /**
   * How much steeper the entry into the run must be than anything inside it.
   * This is the test that tells a clipped top from a loud peak.
   */
  minSlopeRatio?: number;
  /** Minimum consecutive samples before it is a flat top and not a peak. */
  minRunSamples?: number;
  /** Runs longer than this are too much missing audio to invent. */
  maxRunMs?: number;
  /** Extra samples rebuilt each side, where the curve was already bending. */
  guardSamples?: number;
  /**
   * Repair passes over the same runs.
   *
   * This is where de-clipping differs from de-clicking.  A click is isolated,
   * so the audio around it is clean and one pass is enough.  Clipping is
   * PERIODIC — every loud cycle has a flat top — so the first pass fits its
   * model to context that is itself still damaged.  A second pass sees a
   * buffer whose other runs have already been rebuilt, and does measurably
   * better.  On light clipping it changes nothing; on heavy clipping (where
   * every cycle is missing a third of its peak) it is the difference between
   * recovering half the damage and recovering three quarters of it.
   */
  passes?: number;
  /**
   * Scale the result so the restored peaks fit.  Off means the buffer may
   * exceed ±1 and the caller deals with it.
   */
  normalise?: boolean;
  /** Headroom left when normalising, dB. */
  headroomDb?: number;
}

const DEFAULTS = {
  thresholdLinear: 0.985,
  autoCeiling: true,
  flatnessTolerance: 0.002,
  minSlopeRatio: 4,
  minRunSamples: 3,
  maxRunMs: 10,
  guardSamples: 1,
  passes: 3,
  normalise: true,
  headroomDb: 0.3,
};

/**
 * Find the flat tops.
 *
 * The run has to be both PINNED (at or above the threshold) and FLAT (the
 * samples inside it barely move).  A loud transient can sit above the
 * threshold for a few samples while still curving; that is a peak, not a clip,
 * and rebuilding it would invent a bigger one.
 */
export function detectClipping(
  samples: Float32Array, sampleRate: number, options: DeclipOptions = {},
): ClipRun[] {
  const minRun = Math.max(2, Math.round(options.minRunSamples ?? DEFAULTS.minRunSamples));
  const maxRun = Math.round(((options.maxRunMs ?? DEFAULTS.maxRunMs) / 1000) * sampleRate);
  const flatness = options.flatnessTolerance ?? DEFAULTS.flatnessTolerance;
  const slopeRatio = options.minSlopeRatio ?? DEFAULTS.minSlopeRatio;

  let threshold = options.thresholdLinear ?? DEFAULTS.thresholdLinear;
  if (options.autoCeiling ?? DEFAULTS.autoCeiling) {
    let peak = 0;
    for (let i = 0; i < samples.length; i++) {
      const v = Math.abs(samples[i] ?? 0);
      if (v > peak) peak = v;
    }
    // The ceiling is wherever the loudest sample is — including when that is
    // 0 dBFS.  Using a threshold BELOW the real ceiling is the subtle bug
    // here: the run then swallows the unclipped shoulders on either side, the
    // flatness test sees them move, and the whole run is rejected.  Audio
    // clipped in the box and then turned down is the same case with the
    // ceiling somewhere else.
    if (peak > 0) threshold = peak * 0.9995;
  }

  const runs: ClipRun[] = [];
  let i = 0;
  while (i < samples.length) {
    const value = samples[i] ?? 0;
    if (Math.abs(value) < threshold) { i++; continue; }

    const sign = value >= 0 ? 1 : -1;
    let end = i;
    while (end + 1 < samples.length) {
      const next = samples[end + 1] ?? 0;
      if (Math.abs(next) < threshold || Math.sign(next) !== sign) break;
      end++;
    }
    const length = end - i + 1;

    if (length >= minRun && length <= maxRun) {
      let min = Infinity;
      let max = -Infinity;
      let innerSlope = 0;
      for (let k = i; k <= end; k++) {
        const v = Math.abs(samples[k] ?? 0);
        if (v < min) min = v;
        if (v > max) max = v;
        if (k > i) innerSlope = Math.max(innerSlope, Math.abs(v - Math.abs(samples[k - 1] ?? 0)));
      }
      // The slope the waveform was travelling at when it hit the ceiling.
      const entrySlope = i > 0
        ? Math.abs(Math.abs(samples[i] ?? 0) - Math.abs(samples[i - 1] ?? 0))
        : Infinity;

      const flat = max - min <= flatness;
      const abrupt = entrySlope > innerSlope * slopeRatio || innerSlope === 0;
      if (flat && abrupt) runs.push({ from: i, to: end + 1, sign });
    }
    i = end + 1;
  }
  return runs;
}

export interface DeclipResult {
  samples: Float32Array;
  /** Runs rebuilt. */
  repaired: number;
  /** Runs found but left alone (too long to invent). */
  skipped: number;
  /** Peak after reconstruction, before any normalising. */
  restoredPeak: number;
  /** Gain applied to fit the result back inside full scale, dB. */
  appliedGainDb: number;
}

/** Rebuild the flat tops of one channel. */
export function declip(
  samples: Float32Array, sampleRate: number, options: DeclipOptions = {},
): DeclipResult {
  const guard = Math.max(0, options.guardSamples ?? DEFAULTS.guardSamples);
  const normalise = options.normalise ?? DEFAULTS.normalise;
  const headroom = options.headroomDb ?? DEFAULTS.headroomDb;
  const runs = detectClipping(samples, sampleRate, options);

  const passes = Math.max(1, Math.round(options.passes ?? DEFAULTS.passes));
  const out = Float32Array.from(samples);
  let repaired = 0;
  let skipped = 0;

  for (let pass = 0; pass < passes; pass++) {
    for (const run of runs) {
      // The guard reaches into the samples either side, where the waveform was
      // already bending toward the ceiling and is therefore also wrong.
      const from = Math.max(1, run.from - guard);
      const to = Math.min(out.length - 1, run.to + guard);
      const length = to - from;
      if (length <= 0) { if (pass === 0) skipped++; continue; }
      interpolateGap(out, from, length, options);
      if (pass === 0) repaired++;
    }
  }

  let restoredPeak = 0;
  for (let i = 0; i < out.length; i++) {
    const v = Math.abs(out[i] ?? 0);
    if (v > restoredPeak) restoredPeak = v;
  }

  let appliedGainDb = 0;
  const ceiling = Math.pow(10, -Math.abs(headroom) / 20);
  if (normalise && restoredPeak > ceiling) {
    const gain = ceiling / restoredPeak;
    for (let i = 0; i < out.length; i++) out[i] = (out[i] ?? 0) * gain;
    appliedGainDb = 20 * Math.log10(gain);
  }

  return { samples: out, repaired, skipped, restoredPeak, appliedGainDb };
}

/**
 * Rebuild every channel, with ONE gain applied to all of them.
 *
 * Normalising per channel would change the balance between them — a stereo
 * image is a ratio, and a de-clipper has no business moving it.
 */
export function declipChannels(
  channels: readonly Float32Array[], sampleRate: number, options: DeclipOptions = {},
): { channels: Float32Array[]; repaired: number; skipped: number; appliedGainDb: number } {
  const perChannel = channels.map((ch) =>
    declip(ch, sampleRate, { ...options, normalise: false }));

  const repaired = perChannel.reduce((sum, r) => sum + r.repaired, 0);
  const skipped = perChannel.reduce((sum, r) => sum + r.skipped, 0);
  const peak = perChannel.reduce((max, r) => Math.max(max, r.restoredPeak), 0);

  const normalise = options.normalise ?? DEFAULTS.normalise;
  const ceiling = Math.pow(10, -Math.abs(options.headroomDb ?? DEFAULTS.headroomDb) / 20);
  let appliedGainDb = 0;
  let out = perChannel.map((r) => r.samples);

  if (normalise && peak > ceiling) {
    const gain = ceiling / peak;
    appliedGainDb = 20 * Math.log10(gain);
    out = out.map((ch) => {
      const scaled = new Float32Array(ch.length);
      for (let i = 0; i < ch.length; i++) scaled[i] = (ch[i] ?? 0) * gain;
      return scaled;
    });
  }

  return { channels: out, repaired, skipped, appliedGainDb };
}

/** Share of samples sitting at the ceiling — the "how bad is it" number. */
export function clippingRatio(
  samples: Float32Array, thresholdLinear = DEFAULTS.thresholdLinear,
): number {
  if (samples.length === 0) return 0;
  let pinned = 0;
  for (let i = 0; i < samples.length; i++) {
    if (Math.abs(samples[i] ?? 0) >= thresholdLinear) pinned++;
  }
  return pinned / samples.length;
}

export function describeClipping(runs: readonly ClipRun[], sampleRate: number): string {
  if (runs.length === 0) return '클리핑된 구간이 없습니다';
  const total = runs.reduce((sum, r) => sum + (r.to - r.from), 0);
  return `클리핑 구간 ${runs.length}개 · 총 ${((total / sampleRate) * 1000).toFixed(1)} ms`;
}
