// Deciding every beat at once instead of one at a time.
//
// Stage B matched each beat on its own.  That is the mistake this file exists
// to correct, and it is worth being precise about WHY it is a mistake, because
// "add smoothing" sounds like a polish step and it is not.
//
// A beat of arpeggiated C major contains, at any instant, one or two notes.
// Averaged over the beat it might be C and E, or E and G, or — if the bar
// began on the fifth — G and C with no third at all.  Matched alone, those
// three beats answer C, Em and C5.  Every one of those answers is the best
// available explanation of the evidence in front of it, and two of them are
// wrong, and nothing about the evidence in front of them can say which.
//
// What says which is the OTHER BEATS.  Chords last.  A label that explains
// this beat slightly worse but the whole bar much better is the right answer,
// and finding it is not a heuristic — it is the most likely sequence, which is
// a different question from a sequence of most likely answers.
//
// ── The model ───────────────────────────────────────────────────────────────
//
// A hidden Markov model whose states are the chords the vocabulary allows,
// plus one for "no chord".  Emissions are the template scores stage B already
// computes.  Viterbi finds the single most likely path.
//
// Two numbers control it, and there is a reason there are only two.
//
//   sharpness   how much a better-matching chord is preferred.  The emission
//               log-probability is `sharpness × score`; at 0 the audio says
//               nothing and the path is all prior, at ∞ it is stage B again.
//
//   switchCost  what it costs to change chord between beats.
//
// The second one deserves a note.  A textbook HMM has an N×N transition
// matrix; with a uniform off-diagonal — every chord change as likely as every
// other — that matrix collapses to a SINGLE NUMBER, the difference in log
// probability between staying and moving:
//
//     log p(stay) − log((1 − p(stay)) / (N − 1))
//
// So `switchCost` is not a simplification of the model, it IS the model, for
// any transition matrix that does not claim to know which chord follows which.
// Claiming that — that V goes to I more often than to ♭II — is a real thing to
// add and it is a KEY-DEPENDENT claim, so it is left out here rather than
// guessed at.  See the note at the bottom.

import { PITCH_CLASSES } from './chroma.js';
import {
  chordScores, chordTemplates, DEFAULT_MIN_SCORE, DEFAULT_VOCABULARY,
  type MatchOptions,
} from './chord-match.js';
import type { ChordSymbol } from '../../model/chords.js';

export interface SmoothingOptions {
  /**
   * How much the audio is allowed to argue, per beat.
   *
   * Multiplies the template score before it becomes a log-probability.  Higher
   * trusts each beat more and smooths less.
   */
  sharpness?: number;
  /**
   * The log-probability penalty for changing chord between two beats.
   *
   * The one number that decides how long chords want to be.  Zero is stage B.
   */
  switchCost?: number;
  /**
   * What each note beyond a triad has to be worth before it is written.
   *
   * Subtracted from a template's score once per extra chord tone.  Not a
   * fudge factor — a correction for a real asymmetry: a four-note template
   * has one more slot for an accident to land in, and in arpeggiated music
   * the accident is systematic.  The third of a triad, sounding alone, puts
   * its own third harmonic a major seventh above the root, so a plain C
   * played one note at a time reads as Cmaj7 with nothing wrong anywhere.
   */
  sizePenalty?: number;
  /**
   * The score the "no chord" state emits.
   *
   * A beat whose best chord scores below this is better explained by silence
   * or by material with no harmony in it than by the least bad chord.
   */
  noChordScore?: number;
}

/**
 * Measured, not guessed — see `docs/CHORDS.md`.
 *
 * Chosen by sweeping both against ten rendered fixtures and then confirming
 * the winner end to end through the whole detector, because the sweep scores
 * the decoder alone and the user gets the pipeline.
 */
export const DEFAULT_SHARPNESS = 10;
export const DEFAULT_SWITCH_COST = 1.5;
export const DEFAULT_SIZE_PENALTY = 0.02;

export interface SmoothingResult {
  /** One chord per span, or null where the path chose "no chord". */
  path: (ChordSymbol | null)[];
  /** The chosen state's score for that span — comparable to a stage-B score. */
  scores: number[];
  /**
   * How much better the chosen label was than the best OTHER label on that
   * span alone, ignoring the path.  Negative means the smoother overruled the
   * evidence of that beat, which is the whole point and is worth surfacing.
   */
  margins: number[];
}

/**
 * The most likely sequence of chords for a sequence of beat chromas.
 *
 * `bassPitches`, when given, must be one per span — the same alignment
 * everything else in this directory uses.
 */
export function smoothChords(
  spanChroma: readonly Float32Array[],
  options: SmoothingOptions & MatchOptions & {
    bassPitches?: readonly (number | null)[];
  } = {},
): SmoothingResult {
  const {
    sharpness = DEFAULT_SHARPNESS,
    switchCost = DEFAULT_SWITCH_COST,
    sizePenalty = DEFAULT_SIZE_PENALTY,
    noChordScore = DEFAULT_MIN_SCORE,
    vocabulary = DEFAULT_VOCABULARY,
    bassPitches,
    ...match
  } = options;

  const templates = chordTemplates(vocabulary);
  const chordCount = templates.length;
  // The last state is "no chord".  Keeping it in the same array as the chords
  // means the transition rule is one rule: silence is a state you move to and
  // from at the same cost as any other, which is what makes an intro of one
  // held note come out as a rest instead of as eight bars of a wrong chord.
  const stateCount = chordCount + 1;
  const NO_CHORD = chordCount;

  const spanCount = spanChroma.length;
  if (spanCount === 0) return { path: [], scores: [], margins: [] };

  // ── Emissions ─────────────────────────────────────────────────────────────
  const emission: (Float32Array | null)[] = spanChroma.map((chroma, i) => {
    const bass = bassPitches ? (bassPitches[i] ?? null) : (match.bassPitchClass ?? null);
    return chordScores(chroma, { ...match, vocabulary, bassPitchClass: bass });
  });

  // One subtraction per template, computed once.
  const penalty = new Float64Array(chordCount);
  for (let t = 0; t < chordCount; t++) {
    penalty[t] = sizePenalty * Math.max(0, (templates[t]?.members.size ?? 3) - 3);
  }

  const scoreAt = (t: number, state: number): number => {
    const row = emission[t];
    // A silent span is not "every chord scores zero" — it is a span where only
    // the no-chord state is possible at all.  Letting the chords score zero
    // there would let a path drift through silence keeping its label.
    if (!row) return state === NO_CHORD ? 0 : -Infinity;
    return state === NO_CHORD ? noChordScore : ((row[state] ?? 0) - (penalty[state] ?? 0));
  };

  // ── Viterbi ───────────────────────────────────────────────────────────────
  //
  // In log space, with the uniform-off-diagonal transition reduced to one
  // subtraction.  The recurrence per step is therefore:
  //
  //     best[j] = sharpness·score(t, j) + max( prev[j],  max_i prev[i] − cost )
  //
  // which is O(N) per step rather than O(N²), because the best predecessor for
  // every state that is NOT itself is the same state: the global best.  A
  // four-minute song is a few hundred beats × 169 states, and this is what
  // keeps it instant rather than merely fast.
  let prev = new Float64Array(stateCount);
  for (let j = 0; j < stateCount; j++) prev[j] = sharpness * scoreAt(0, j);

  const back: Int32Array[] = [];
  for (let t = 1; t < spanCount; t++) {
    let bestPrev = -Infinity;
    let bestPrevState = 0;
    for (let i = 0; i < stateCount; i++) {
      const v = prev[i] ?? -Infinity;
      if (v > bestPrev) { bestPrev = v; bestPrevState = i; }
    }
    const fromElsewhere = bestPrev - switchCost;
    const next = new Float64Array(stateCount);
    const pointers = new Int32Array(stateCount);
    for (let j = 0; j < stateCount; j++) {
      const stay = prev[j] ?? -Infinity;
      // The tie goes to STAYING.  A chord that explains this beat exactly as
      // well as a change would is not a chord change.
      const carried = stay >= fromElsewhere ? stay : fromElsewhere;
      pointers[j] = stay >= fromElsewhere ? j : bestPrevState;
      next[j] = carried + sharpness * scoreAt(t, j);
    }
    back.push(pointers);
    prev = next;
  }

  let end = 0;
  let bestEnd = -Infinity;
  for (let j = 0; j < stateCount; j++) {
    const v = prev[j] ?? -Infinity;
    if (v > bestEnd) { bestEnd = v; end = j; }
  }

  const states = new Int32Array(spanCount);
  states[spanCount - 1] = end;
  for (let t = spanCount - 1; t > 0; t--) {
    const pointers = back[t - 1];
    states[t - 1] = pointers ? (pointers[states[t] ?? 0] ?? 0) : 0;
  }

  // ── Out ───────────────────────────────────────────────────────────────────
  const path: (ChordSymbol | null)[] = [];
  const scores: number[] = [];
  const margins: number[] = [];
  for (let t = 0; t < spanCount; t++) {
    const state = states[t] ?? NO_CHORD;
    const row = emission[t];
    const chosen = scoreAt(t, state);
    let bestOther = -Infinity;
    if (row) {
      for (let j = 0; j < stateCount; j++) {
        if (j === state) continue;
        const v = scoreAt(t, j);
        if (v > bestOther) bestOther = v;
      }
    }
    path.push(state === NO_CHORD ? null : (templates[state]?.chord ?? null));
    scores.push(state === NO_CHORD ? 0 : chosen);
    margins.push(bestOther > -Infinity ? chosen - bestOther : 0);
  }
  return { path, scores, margins };
}

// ── What is deliberately not modelled ───────────────────────────────────────
//
// A transition matrix that knows music — V→I more likely than V→♭II — is the
// obvious next thing and it is not here, for a reason worth writing down: it
// is only meaningful RELATIVE TO A KEY, and this detector does not estimate
// one.  Applied without a key it is not "musical knowledge", it is a bias
// towards C major, which would make the detector better on the material a
// developer happens to test with and worse on everything else.
//
// The honest order is: estimate the key, then condition the transitions on it,
// then measure whether it helped.  That is a stage of its own.

/** Pitch-class distance on the circle of fifths, 0…6.  For the doc's tables. */
export function fifthsDistance(a: number, b: number): number {
  const step = (((a - b) * 7) % PITCH_CLASSES + PITCH_CLASSES) % PITCH_CLASSES;
  return Math.min(step, PITCH_CLASSES - step);
}
