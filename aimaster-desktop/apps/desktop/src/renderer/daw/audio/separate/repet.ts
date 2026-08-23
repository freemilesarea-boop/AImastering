// What repeats is the backing track.
//
// A four-bar loop plays the same thing every four bars.  The singer does not.
// That asymmetry is the second vocal cue, and on a mono file it is the only
// one — so it is worth doing properly rather than as a fallback.
//
// The method is Rafii's REPET-SIM, kept honest about its cost:
//
//   1. Describe each frame by a VERY small band profile — eight log-spaced
//      bands, not 2049 bins.  Speed is the obvious reason and the wrong one.
//      The real reason is that the profile has to be too coarse to see the
//      singer.  A fine profile finds the frames that hold the SAME sung note,
//      subtracts them, and reports that the vocal is part of the background —
//      which is exactly backwards.  Measured on a four-part test mix, going
//      from 32 bands to 8 took the cue's discrimination between vocal cells
//      and accompaniment cells from 1.3× to 2.0×.
//   2. For each frame, find the K most similar OTHER frames within a window of
//      ±`windowFrames`, excluding its immediate neighbours — a frame is always
//      most similar to the one 20 ms away, and that similarity says nothing.
//   3. The repeating background at that frame is the per-bin MEDIAN of those K
//      frames.  A median, not a mean, because one of the K being wrong should
//      not drag the estimate.
//   4. Novelty is what is left over: `(M − B)/M`, divided by `excess` and
//      clamped.  The division is a calibration, and it is needed: even at a
//      cell the voice plainly owns, the voice only beats the background by
//      about a third, because the band is playing there too.  Used raw, the
//      cue would multiply every vocal bin by 0.35 and the singer would come
//      back a whisper.  `excess` names how far above its own echo a bin has to
//      get before it counts as entirely new.
//
// ── The window is a parameter, not an accident ───────────────────────────────
//
// Everything else in the separator gives the same answer whether it is run in
// one pass or in chunks.  This does not, and could not: "what repeats" is a
// question about a span of time, and a different span is a different question.
// So the span is named — `windowFrames`, about eight and a half seconds by
// default, which covers four bars at anything from 110 BPM up — and the chunking in
// `separate.ts` is built around it rather than the other way round.

export interface RepetOptions {
  /** How far either side to look for repeats, in frames. */
  windowFrames: number;
  /** How many similar frames make up the background estimate. */
  neighbours: number;
  /** Frames nearer than this are ignored: adjacency is not repetition. */
  minLagFrames: number;
  /** Log-spaced bands used for the similarity comparison.  Coarse on purpose. */
  bands: number;
  /** How far above the repeating background counts as fully novel, 0…1. */
  excess: number;
}

/** At 21 ms per frame: ±8.5 s of context, and a 0.5 s exclusion around now. */
export const DEFAULT_REPET: RepetOptions = {
  windowFrames: 400,
  neighbours: 9,
  minLagFrames: 24,
  bands: 8,
  excess: 0.4,
};

/** Log-spaced band edges, so a bass note and a cymbal get comparable weight. */
function bandEdges(bins: number, bands: number): Int32Array {
  const edges = new Int32Array(bands + 1);
  // Start at bin 1: bin 0 is DC and carries no musical information.
  const lo = 1;
  const hi = bins - 1;
  for (let b = 0; b <= bands; b++) {
    const t = b / bands;
    edges[b] = Math.min(hi, Math.max(lo, Math.round(lo * Math.pow(hi / lo, t))));
  }
  // Log spacing collapses at the bottom, where consecutive edges land on the
  // same bin.  Spread those out so every band holds at least one bin.
  for (let b = 1; b <= bands; b++) {
    if ((edges[b] ?? 0) <= (edges[b - 1] ?? 0)) edges[b] = (edges[b - 1] ?? 0) + 1;
  }
  return edges;
}

/** One unit-length band profile per frame, for the similarity search. */
export function bandProfiles(
  magnitude: Float32Array, frames: number, bins: number, bands: number,
): Float32Array {
  const edges = bandEdges(bins, bands);
  const out = new Float32Array(frames * bands);
  for (let f = 0; f < frames; f++) {
    const base = f * bins;
    let energy = 0;
    for (let b = 0; b < bands; b++) {
      const from = edges[b] ?? 0;
      const to = edges[b + 1] ?? from;
      let sum = 0;
      for (let k = from; k < to; k++) sum += magnitude[base + k] ?? 0;
      const v = Math.log1p(sum);       // loudness, not amplitude
      out[f * bands + b] = v;
      energy += v * v;
    }
    // Unit length, so the dot product below IS the cosine similarity and a
    // loud bar does not out-score a quiet one that is the same music.
    const norm = Math.sqrt(energy);
    if (norm > 0) for (let b = 0; b < bands; b++) out[f * bands + b] = (out[f * bands + b] ?? 0) / norm;
  }
  return out;
}

export interface Repetition {
  /** Frame-major novelty in [0,1]: 1 = nothing like this repeats nearby. */
  novelty: Float32Array;
  /**
   * How much of this music the repetition cue found something to compare
   * against, 0…1 — one minus the average novelty, weighted by loudness.
   *
   * This used to be the median over frames of the BEST match's similarity, and
   * that number cannot say anything.  The best of eight hundred candidate
   * frames scores near 1 whatever the music is, so it came back as 1.00 on a
   * real record and 1.00 on a synthesised one — and the note that warns about
   * un-repetitive music fires below 0.75, so it could never fire at all.
   *
   * The cosine underneath was narrow too — measured on the test mix at eight
   * bands it ran 0.962 to 1.000, because every component is a loudness and the
   * cosine between two vectors in the positive orthant cannot approach zero.
   * Centring the profiles first, so the dot product is a correlation over the
   * whole of [−1, 1], widened that range sixteen-fold and was measured: it made
   * separation slightly WORSE at every setting of `excess` and was reverted.
   * The top-k search was not limited by the metric's resolution.
   *
   * What is left is the excess itself — how much of a typical bin is NOT
   * explained by the same bin in the most similar nearby frames — before the
   * `excess` knob sharpens it into a mask.  Weighted by magnitude, because a
   * novelty reading on a silent bin is not an observation about the music.
   *
   * 1 means everything here has a near-match nearby and the cue can exclude it
   * all; 0 means nothing does and the cue has nothing to say.  White noise
   * reads 0.99 and a two-second loop 0.97 — both are self-similar and both are
   * correct.  A record with a singer over a repeating band reads around 0.4:
   * the band matches and the singer does not, which is the whole point.
   */
  repetitiveness: number;
}

/**
 * `magnitude` is frame-major (`f * bins + b`).
 *
 * Cost is `frames × 2·windowFrames × bands` for the search plus
 * `frames × bins × neighbours` for the medians — linear in the audio's length,
 * which is the point of the window.
 */
export function repetition(
  magnitude: Float32Array, frames: number, bins: number,
  options: Partial<RepetOptions> = {},
): Repetition {
  const { windowFrames, neighbours, minLagFrames, bands, excess } = { ...DEFAULT_REPET, ...options };
  const scale = excess > 0 ? 1 / excess : 1;
  const profiles = bandProfiles(magnitude, frames, bins, bands);
  const novelty = new Float32Array(frames * bins);

  const k = Math.max(1, neighbours);
  const bestScore = new Float64Array(k);
  const bestFrame = new Int32Array(k);
  const gathered = new Float32Array(k);
  // Loudness-weighted running total of the novelty, for the figure returned.
  let novel = 0;
  let weight = 0;

  for (let f = 0; f < frames; f++) {
    bestScore.fill(-Infinity);
    bestFrame.fill(-1);
    const from = Math.max(0, f - windowFrames);
    const to = Math.min(frames, f + windowFrames + 1);

    for (let g = from; g < to; g++) {
      if (Math.abs(g - f) < minLagFrames) continue;
      let dot = 0;
      const a = f * bands;
      const b = g * bands;
      for (let i = 0; i < bands; i++) dot += (profiles[a + i] ?? 0) * (profiles[b + i] ?? 0);
      // Keep the running top-k by insertion — k is single digits, so a heap
      // would cost more in bookkeeping than it saves.
      if (dot <= (bestScore[k - 1] ?? -Infinity)) continue;
      let slot = k - 1;
      while (slot > 0 && (bestScore[slot - 1] ?? -Infinity) < dot) {
        bestScore[slot] = bestScore[slot - 1] ?? -Infinity;
        bestFrame[slot] = bestFrame[slot - 1] ?? -1;
        slot--;
      }
      bestScore[slot] = dot;
      bestFrame[slot] = g;
    }

    let found = 0;
    while (found < k && (bestFrame[found] ?? -1) >= 0) found++;
    const base = f * bins;
    if (found === 0) {
      // Nothing to compare against — the file is shorter than the exclusion
      // zone.  Claiming total novelty would pour the whole mix into the vocal,
      // so this says "no evidence" instead.
      for (let b = 0; b < bins; b++) novelty[base + b] = 0;
      continue;
    }
    for (let b = 0; b < bins; b++) {
      for (let i = 0; i < found; i++) {
        gathered[i] = magnitude[(bestFrame[i] ?? 0) * bins + b] ?? 0;
      }
      const background = medianOf(gathered, found);
      const here = magnitude[base + b] ?? 0;
      const raw = here > 0 ? Math.max(0, (here - background) / here) : 0;
      novelty[base + b] = Math.min(1, raw * scale);
      // The figure returned is the RAW excess, before `excess` sharpens it.
      // A diagnosis of the RECORD must not move when we retune the separator,
      // and the scaled novelty does: at `excess` 0.2 the same music reads 0.55
      // and at 0.7 it reads 0.31.
      novel += raw * here;
      weight += here;
    }
  }

  const repetitiveness = weight > 0 ? 1 - novel / weight : 0;
  return { novelty, repetitiveness };
}

function medianOf(values: Float32Array, count: number): number {
  // Insertion sort of at most a dozen values, in place, no allocation.
  for (let i = 1; i < count; i++) {
    const v = values[i] ?? 0;
    let j = i - 1;
    while (j >= 0 && (values[j] ?? 0) > v) { values[j + 1] = values[j] ?? 0; j--; }
    values[j + 1] = v;
  }
  const mid = count >> 1;
  return count % 2 === 1
    ? (values[mid] ?? 0)
    : ((values[mid - 1] ?? 0) + (values[mid] ?? 0)) * 0.5;
}
