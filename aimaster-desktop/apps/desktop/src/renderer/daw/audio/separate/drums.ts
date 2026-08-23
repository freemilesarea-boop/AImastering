// Taking the kit apart.
//
// The drum stem is everything the harmonic/percussive split called a transient.
// Splitting THAT into kick, snare, toms and cymbals cannot be done by frequency
// alone — a kick and a floor tom overlap almost completely, and a snare's body
// sits exactly where a rack tom's does.  What separates them is the SHAPE of
// the hit across the whole spectrum at the moment it lands.
//
// So the method has two halves:
//
//   WHAT IS BEING HIT, per frame.  Onsets are found in the percussive energy,
//   and each one is scored against four templates.  The scores are not a
//   choice — a kick and a hat land on the same beat constantly — they are four
//   presences, each decaying with its own tail, because a crash rings for two
//   seconds and a kick is gone in a fifth of one.
//
//   WHERE THAT INSTRUMENT LIVES, per bin.  Four fixed band curves, because
//   although a kick and a tom overlap they do not overlap EVERYWHERE, and the
//   part of the spectrum they do not share is what the split hangs on.
//
// The two are multiplied and normalised:
//
//     w[c][t][f] = presence[c][t] · template[c][f]
//     mask[c]    = w[c] / Σ_c w[c]
//
// which sums to one by construction, so the four pieces still add back up to
// the drum stem they came from — and therefore to the record.
//
// ── What this gets right, and what it does not ───────────────────────────────
//
// Kick and cymbals are the easy pair: they sit at opposite ends and their
// templates barely touch.  Snare is decent, because the snare wires put
// broadband noise up at 2–8 kHz that nothing else in a kit does.  TOMS ARE THE
// WEAK ONE and honestly so: a tom is a pitched low-mid hit with little noise,
// which is a kick with a longer tail as far as any of this can tell.  A fill
// comes out mostly right; a single tom under a busy groove does not.

import { binHz } from './spectrum.js';

export type DrumPart = 'kick' | 'snare' | 'toms' | 'cymbals';

export const DRUM_PARTS: readonly DrumPart[] = ['kick', 'snare', 'toms', 'cymbals'];

// These four are INTERNAL.  The app ships two drum stems — 킥 and everything
// else — because that is what measured well; `stem-tree.ts` records the numbers
// that made the decision.  The other three stay here because the kick's mask is
// normalised against them, and a kick that only has to beat "not kick" is a
// worse kick than one that has to beat a floor tom specifically.
//
// What was here and is not any more: a sharpening exponent on the presences,
// a shell-and-wires conjunction for the snare, and a running-median hi-hat
// floor so the snare could claim the burst above it.  All three were built to
// tell a snare from a cymbal, all three worked a little, and none of them
// moved 킥 or 나머지 드럼 by more than 0.8 of a point once those two were the
// only stems left.  They were removed rather than kept as knobs that do
// nothing measurable.

export interface DrumOptions {
  /** How much louder than the local floor a frame must be to be an onset. */
  onsetThreshold: number;
  /** How long each part keeps ringing after it is struck, in seconds. */
  decaySec: Record<DrumPart, number>;
  /**
   * Floor under every presence.
   *
   * Without it, a frame between hits divides by zero and the split falls back
   * to templates alone — which is fine — but a frame where the classifier is
   * merely UNSURE would swing wildly between neighbours.  A floor makes the
   * templates the quiet default everywhere and lets the onsets argue over the
   * rest.
   */
  presenceFloor: number;
}

export const DEFAULT_DRUMS: DrumOptions = {
  onsetThreshold: 1.6,
  // The kick's is not a guess at how long a kick drum rings — it is how long a
  // kick is still MASKING what is under it, which on a compressed modern record
  // is far longer than the hit.  At 0.18 s the credit in `percussive.ts` died
  // before the sub tail did and the tail went back to the bass stem; measured
  // on the hard fixture, lengthening it moved 킥 from 19 % to 32 % recovered and
  // cost 나머지 드럼 nothing.
  decaySec: { kick: 0.45, snare: 0.25, toms: 0.45, cymbals: 1.2 },
  presenceFloor: 0.04,
};

/**
 * Where each part lives, as a gain per bin.
 *
 * These are not guesses at where a drum's energy is loudest; they are where a
 * drum is DISTINCTIVE.  The kick curve does not extend to 200 Hz even though a
 * kick is loud there, because so is everything else in a kit — including it
 * would only take energy away from the parts that own that region.
 */
export function drumTemplates(
  bins: number, fftSize: number, sampleRate: number,
): Record<DrumPart, Float32Array> {
  const make = (f: (hz: number) => number): Float32Array => {
    const out = new Float32Array(bins);
    for (let b = 0; b < bins; b++) out[b] = Math.max(0, Math.min(1, f(binHz(b, fftSize, sampleRate))));
    return out;
  };
  // Raised-cosine ramps, so no template has an edge that would print itself on
  // the audio as a filter sweep.
  const ramp = (hz: number, from: number, to: number): number => {
    if (from === to) return hz >= from ? 1 : 0;
    const t = (hz - from) / (to - from);
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    return 0.5 * (1 - Math.cos(Math.PI * t));
  };
  return {
    // Bottom octave and a half, gone by 160 Hz.
    kick: make((hz) => 1 - ramp(hz, 70, 160)),
    // Two humps: the shell around 150–400 Hz, and the wires from 1.5 kHz up.
    snare: make((hz) =>
      Math.max(ramp(hz, 110, 190) * (1 - ramp(hz, 320, 620)) * 0.9,
               ramp(hz, 1200, 2600) * (1 - ramp(hz, 7000, 11000)))),
    // The register between kick and snare, where a tom's fundamental sits.
    toms: make((hz) => ramp(hz, 60, 110) * (1 - ramp(hz, 260, 520))),
    // Everything above the snare wires, and nothing below.
    cymbals: make((hz) => ramp(hz, 3500, 7000)),
  };
}

export interface DrumPresence {
  /** One value per part per frame, ≥ presenceFloor. */
  presence: Record<DrumPart, Float32Array>;
  /** How many onsets were found — the UI reports it, because zero is a fact. */
  onsets: number;
}

/**
 * Score every onset in the percussive material and let the scores decay.
 *
 * `percussive` is the drum stem's magnitude, frame-major.  `bandOf` maps a bin
 * to one of the four templates; it is the templates themselves, so the
 * classifier and the mask agree about what a kick looks like.
 */
export function drumPresence(
  percussive: Float32Array, frames: number, bins: number,
  templates: Record<DrumPart, Float32Array>, hopSec: number,
  options: Partial<DrumOptions> = {},
): DrumPresence {
  const { onsetThreshold, decaySec, presenceFloor } = { ...DEFAULT_DRUMS, ...options };
  const presence: Record<DrumPart, Float32Array> = {
    kick: new Float32Array(frames), snare: new Float32Array(frames),
    toms: new Float32Array(frames), cymbals: new Float32Array(frames),
  };
  for (const part of DRUM_PARTS) presence[part].fill(presenceFloor);
  if (frames === 0) return { presence, onsets: 0 };

  // Per-frame energy in each template's region, and the total.
  const scores: Record<DrumPart, Float32Array> = {
    kick: new Float32Array(frames), snare: new Float32Array(frames),
    toms: new Float32Array(frames), cymbals: new Float32Array(frames),
  };
  const total = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const base = f * bins;
    let sum = 0;
    for (const part of DRUM_PARTS) {
      const tpl = templates[part];
      let s = 0;
      for (let b = 0; b < bins; b++) s += (percussive[base + b] ?? 0) * (tpl[b] ?? 0);
      scores[part][f] = s;
      sum += s;
    }
    total[f] = sum;
  }

  // Onsets: a frame whose energy rises well above the recent local level.  A
  // fixed threshold would find every hit in a loud bar and none in a quiet one.
  const RUN = 24;
  let onsets = 0;
  for (let f = 1; f < frames; f++) {
    let floor = 0;
    let count = 0;
    for (let k = Math.max(0, f - RUN); k < f; k++) { floor += total[k] ?? 0; count++; }
    const local = count > 0 ? floor / count : 0;
    const rise = (total[f] ?? 0) - (total[f - 1] ?? 0);
    if (rise <= 0) continue;
    if ((total[f] ?? 0) < local * onsetThreshold) continue;
    onsets++;

    // Each part's share of THIS hit, relative to what its template would see
    // in silence.  A hit is rarely one drum, so all four get a share.
    const hitTotal = DRUM_PARTS.reduce((t, p) => t + (scores[p][f] ?? 0), 0);
    if (hitTotal <= 0) continue;
    for (const part of DRUM_PARTS) {
      const share = (scores[part][f] ?? 0) / hitTotal;
      const tail = Math.max(1, Math.round((decaySec[part] ?? 0.2) / Math.max(hopSec, 1e-6)));
      for (let k = 0; k < tail && f + k < frames; k++) {
        // Exponential, reaching about a twentieth of its value at `tail`.
        const value = share * Math.exp((-3 * k) / tail);
        if (value > (presence[part][f + k] ?? 0)) presence[part][f + k] = value;
      }
    }
  }
  return { presence, onsets };
}

/**
 * Four masks over the drum stem, summing to one at every bin.
 *
 * `out` is written in place: one array per part, frame-major, so the caller
 * can keep a single set of buffers for the whole run.
 */
export function drumMasks(
  out: Record<DrumPart, Float32Array>,
  presence: Record<DrumPart, Float32Array>,
  templates: Record<DrumPart, Float32Array>,
  frames: number, bins: number,
): void {
  for (let f = 0; f < frames; f++) {
    const base = f * bins;
    for (let b = 0; b < bins; b++) {
      let sum = 0;
      for (const part of DRUM_PARTS) {
        const w = (presence[part][f] ?? 0) * (templates[part][b] ?? 0);
        out[part][base + b] = w;
        sum += w;
      }
      if (sum > 0) {
        // Normalise all but the last from the running total, then give the
        // last one exactly what is left.  Dividing all four independently
        // leaves a rounding residue, and a residue is a stem that does not
        // add back up.
        let given = 0;
        for (let i = 0; i < DRUM_PARTS.length - 1; i++) {
          const part = DRUM_PARTS[i]!;
          const share = (out[part][base + b] ?? 0) / sum;
          out[part][base + b] = share;
          given += share;
        }
        out[DRUM_PARTS[DRUM_PARTS.length - 1]!][base + b] = 1 - given;
      } else {
        // Nowhere near a template — silence, in practice.  Split it evenly so
        // the masks still sum to one.
        const even = 1 / DRUM_PARTS.length;
        let given = 0;
        for (let i = 0; i < DRUM_PARTS.length - 1; i++) {
          out[DRUM_PARTS[i]!][base + b] = even;
          given += even;
        }
        out[DRUM_PARTS[DRUM_PARTS.length - 1]!][base + b] = 1 - given;
      }
    }
  }
}
