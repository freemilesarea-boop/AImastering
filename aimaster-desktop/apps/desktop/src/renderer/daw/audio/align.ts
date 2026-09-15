// Audio alignment — putting a double on top of the lead, to the millisecond.
//
// A doubled vocal is the same line sung twice.  The words land in the same
// order and roughly the same places, but never the same MILLISECONDS: the
// second take breathes a little later, holds a vowel a little longer, clips a
// consonant the first one leant on.  Nudging the whole clip fixes the average
// and nothing else, because the error is not a constant offset — it drifts,
// phrase by phrase, in both directions.
//
// Dynamic time warping is the tool for exactly that shape of problem: it
// finds the monotone mapping between two sequences that costs the least, so
// "this syllable here is that syllable there" comes out of the data instead
// of being guessed.  What it produces is a PATH, not audio — a list of
// (guide time, target time) pairs — and that is deliberate.  This repo
// already has a warp engine that turns a source-time → timeline-time mapping
// into audio, drawn in the warp editor and draggable afterwards.  Alignment
// that renders its own audio would be a second, worse copy of it, and would
// throw away the ability to see and fix what it decided.
//
// Three things make the difference between an aligner and a syllable
// scrambler, and all three are here:
//
//   THE BAND.  A double is late by tens of milliseconds, not by bars.
//   Letting the path wander a whole take away from the diagonal costs
//   quadratic time and buys nothing but the freedom to match the wrong word.
//   The Sakoe-Chiba band is what makes this both fast and sane.
//
//   THE FEATURE.  Loudness alone matches a quiet vowel to a quiet vowel
//   anywhere nearby.  What actually marks the same moment in two takes is
//   where the energy JUMPS — the consonants.  So the distance is level plus
//   a half-wave-rectified derivative, which is an onset strength in all but
//   name.
//
//   THE SLOPE LIMIT.  An unconstrained path is allowed to stand still on one
//   axis, which means stretching a moment of the double to cover half a
//   second of the lead.  That is the artefact everyone recognises as "the
//   aligner ate it".  Markers are emitted only where the local ratio stays
//   inside a musical range.

const EPS = 1e-9;

export interface AlignOptions {
  /** Envelope resolution.  10 ms is a syllable's worth of detail. */
  hopSec: number;
  /**
   * How far the double may sit from the lead, either way.  This is the band:
   * anything outside it is not a timing difference, it is a different take of
   * a different line.
   */
  maxDriftSec: number;
  /** Envelope smoothing, so one loud sample is not a landmark. */
  smoothSec: number;
  /** A marker roughly this often, in guide seconds. */
  markerEverySec: number;
  /** Local stretch ratios outside this range are refused, not applied. */
  minRatio: number;
  maxRatio: number;
  /**
   * Cost ceiling on the matrix.  A ten-minute take at 10 ms hops with a wide
   * band is hundreds of millions of cells; rather than freeze, the hop grows
   * until the work fits and the alignment comes out coarser but finished.
   */
  maxCells: number;
}

export const DEFAULT_ALIGN: AlignOptions = {
  hopSec: 0.01,
  maxDriftSec: 0.35,
  smoothSec: 0.02,
  markerEverySec: 0.12,
  minRatio: 0.5,
  maxRatio: 2,
  maxCells: 8_000_000,
};

export interface AlignFeature {
  /** Normalised log level per hop, 0…1. */
  level: Float32Array;
  /** Half-wave-rectified rise in level per hop, 0…1 — where the consonants are. */
  onset: Float32Array;
  hopSec: number;
}

/**
 * The two numbers per hop the matching runs on.
 *
 * Log, not linear: a double sung 6 dB quieter is the same performance, and a
 * linear envelope would call every one of its syllables a poor match for the
 * lead's.  Normalising afterwards finishes the job — what is being compared
 * is the SHAPE of the two takes, not their levels.
 */
export function alignFeature(
  samples: ArrayLike<number>, sampleRate: number, options: AlignOptions = DEFAULT_ALIGN,
): AlignFeature {
  const hop = Math.max(1, Math.round(options.hopSec * sampleRate));
  const count = Math.max(1, Math.ceil(samples.length / hop));
  const rms = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const from = i * hop;
    const to = Math.min(samples.length, from + hop);
    let sum = 0;
    for (let j = from; j < to; j++) { const v = samples[j] ?? 0; sum += v * v; }
    rms[i] = Math.sqrt(sum / Math.max(1, to - from));
  }

  // Smooth before taking a derivative, or the derivative is mostly noise.
  const span = Math.max(1, Math.round(options.smoothSec / options.hopSec));
  const smooth = new Float32Array(count);
  let run = 0;
  for (let i = 0; i < count; i++) {
    run += rms[i]!;
    if (i >= span) run -= rms[i - span]!;
    smooth[i] = run / Math.min(span, i + 1);
  }

  const level = new Float32Array(count);
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < count; i++) {
    const db = 20 * Math.log10(Math.max(1e-6, smooth[i]!));
    level[i] = db;
    if (db < lo) lo = db;
    if (db > hi) hi = db;
  }
  const range = Math.max(1, hi - lo);
  for (let i = 0; i < count; i++) level[i] = (level[i]! - lo) / range;

  const onset = new Float32Array(count);
  let peak = EPS;
  for (let i = 1; i < count; i++) {
    const rise = level[i]! - level[i - 1]!;
    onset[i] = rise > 0 ? rise : 0;
    if (onset[i]! > peak) peak = onset[i]!;
  }
  for (let i = 0; i < count; i++) onset[i] = onset[i]! / peak;

  return { level, onset, hopSec: options.hopSec };
}

/** A monotone mapping: `guideSec[k]` in the lead is `targetSec[k]` in the double. */
export interface AlignPath {
  guideSec: number[];
  targetSec: number[];
  /** Mean cost per step — how well the two takes actually matched. */
  cost: number;
  /** Hop the match ran at, which may be coarser than asked for. */
  hopSec: number;
}

/** Hop that keeps the banded matrix under the cell ceiling. */
export function alignHopSec(
  guideSec: number, targetSec: number, options: AlignOptions = DEFAULT_ALIGN,
): number {
  const longest = Math.max(guideSec, targetSec, options.hopSec);
  let hop = options.hopSec;
  for (let i = 0; i < 12; i++) {
    const rows = Math.ceil(longest / hop);
    const width = 2 * Math.ceil(options.maxDriftSec / hop) + 1;
    if (rows * width <= options.maxCells) break;
    hop *= 2;
  }
  return hop;
}

/**
 * Match the double to the lead.
 *
 * Banded DTW: row i may only be matched against columns within `radius` of
 * where a straight proportional read would put it, so the path cannot leave
 * the neighbourhood of the diagonal.  Costs outside the band are infinite,
 * which is the band — not a heuristic on top of one.
 */
export function alignPath(
  guide: AlignFeature, target: AlignFeature, options: AlignOptions = DEFAULT_ALIGN,
): AlignPath | null {
  const n = guide.level.length;
  const m = target.level.length;
  if (n < 2 || m < 2) return null;
  const hopSec = guide.hopSec;

  const radius = Math.max(1, Math.ceil(options.maxDriftSec / hopSec));
  const slope = m / n;
  const width = 2 * radius + 1;
  // Column the band is centred on for row i, and the offset of j within it.
  const centre = (i: number): number => Math.round(i * slope);
  const at = (i: number, j: number): number => {
    const off = j - (centre(i) - radius);
    return off < 0 || off >= width ? -1 : i * width + off;
  };

  const D = new Float32Array(n * width).fill(Infinity);
  const cost = (i: number, j: number): number => {
    const dl = guide.level[i]! - target.level[j]!;
    const don = guide.onset[i]! - target.onset[j]!;
    // Onsets weighted heavier than level: a consonant is a landmark, a vowel
    // is a plateau, and plateaus are what a matcher slides along.
    return (dl < 0 ? -dl : dl) + 2 * (don < 0 ? -don : don);
  };

  for (let i = 0; i < n; i++) {
    const from = Math.max(0, centre(i) - radius);
    const to = Math.min(m - 1, centre(i) + radius);
    for (let j = from; j <= to; j++) {
      const here = at(i, j);
      if (here < 0) continue;
      if (i === 0 && j === 0) { D[here] = cost(0, 0); continue; }
      let best = Infinity;
      if (i > 0) { const k = at(i - 1, j); if (k >= 0 && D[k]! < best) best = D[k]!; }
      if (j > 0) { const k = at(i, j - 1); if (k >= 0 && D[k]! < best) best = D[k]!; }
      if (i > 0 && j > 0) { const k = at(i - 1, j - 1); if (k >= 0 && D[k]! < best) best = D[k]!; }
      if (best === Infinity) continue;
      D[here] = cost(i, j) + best;
    }
  }

  const endCell = at(n - 1, m - 1);
  if (endCell < 0 || !Number.isFinite(D[endCell]!)) return null;

  // Walk back.  Recomputing the comparison rather than storing a direction
  // per cell: the same three reads, and no second array the size of the first.
  const gs: number[] = [];
  const ts: number[] = [];
  let i = n - 1;
  let j = m - 1;
  let steps = 0;
  while (i > 0 || j > 0) {
    gs.push(i * hopSec);
    ts.push(j * hopSec);
    steps += 1;
    const diag = i > 0 && j > 0 ? at(i - 1, j - 1) : -1;
    const up = i > 0 ? at(i - 1, j) : -1;
    const left = j > 0 ? at(i, j - 1) : -1;
    const dv = diag >= 0 ? D[diag]! : Infinity;
    const uv = up >= 0 ? D[up]! : Infinity;
    const lv = left >= 0 ? D[left]! : Infinity;
    if (dv <= uv && dv <= lv) { i -= 1; j -= 1; }
    else if (uv <= lv) { i -= 1; }
    else { j -= 1; }
  }
  gs.push(0);
  ts.push(0);
  gs.reverse();
  ts.reverse();

  return {
    guideSec: gs, targetSec: ts, hopSec,
    cost: D[endCell]! / Math.max(1, steps + 1),
  };
}

/** One point of the mapping the warp markers are built from. */
export interface AlignPoint {
  guideSec: number;
  targetSec: number;
}

/**
 * Thin the path down to the points worth putting a marker on.
 *
 * A marker every hop would be one every 10 ms, which is both useless to drag
 * and a stretch ratio recomputed from quantisation noise.  Sampling on the
 * GUIDE axis keeps the output evenly spaced where it is read — and any span
 * whose local ratio falls outside the musical range is dropped rather than
 * printed, because that is the artefact people hear as the aligner eating a
 * syllable.
 */
export function alignPoints(
  path: AlignPath, options: AlignOptions = DEFAULT_ALIGN,
): AlignPoint[] {
  const step = Math.max(path.hopSec, options.markerEverySec);
  const out: AlignPoint[] = [];
  let nextAt = 0;
  for (let k = 0; k < path.guideSec.length; k++) {
    const g = path.guideSec[k]!;
    const t = path.targetSec[k]!;
    if (out.length > 0 && g < nextAt) continue;
    const prev = out[out.length - 1];
    if (prev) {
      const dg = g - prev.guideSec;
      const dt = t - prev.targetSec;
      // One rule, not two.  A span that does not advance on the target axis
      // has a ratio of zero or less and falls out of the range check below,
      // so a separate "strictly increasing" test would be a branch that can
      // never be reached at any sane setting.  The guarantee the warp map
      // actually needs is enforced where the markers are built.
      const ratio = dg > EPS ? dt / dg : 0;
      if (ratio < options.minRatio || ratio > options.maxRatio) continue;
    }
    out.push({ guideSec: g, targetSec: t });
    nextAt = g + step;
  }
  return out;
}

/** How far the double was out, before it was moved. */
export interface AlignDrift {
  maxSec: number;
  meanSec: number;
}

export function driftOf(points: readonly AlignPoint[]): AlignDrift {
  if (points.length === 0) return { maxSec: 0, meanSec: 0 };
  let max = 0;
  let sum = 0;
  for (const p of points) {
    const d = Math.abs(p.targetSec - p.guideSec);
    if (d > max) max = d;
    sum += d;
  }
  return { maxSec: max, meanSec: sum / points.length };
}
