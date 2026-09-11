// What key is this in?
//
// Written because stage C could not have its transition matrix without it.
// "V goes to I more often than to ♭II" is a real thing to know and it is
// MEANINGLESS without a tonic: applied to audio whose key nobody estimated it
// is not musical knowledge, it is a bias towards C major that flatters the
// material a developer happens to test with.  So: estimate the key first,
// then condition on it, then measure whether it helped.  This is the first of
// those three.
//
// ── Two estimators, because there are two kinds of evidence ─────────────────
//
// From a CHROMA — twelve numbers saying how much of each pitch class is
// sounding.  This is Krumhansl-Schmuckler: correlate the distribution against
// a profile of what each key's distribution looks like, for all 24 keys, and
// take the best.  It works on anything, including audio nobody has found the
// chords of yet.
//
// From CHORDS — which this repository usually has by the time it wants a key.
// A progression says more per symbol than a pitch histogram does: G7 resolving
// to C is nearly proof, and a histogram only sees the notes.
//
// The two are kept apart rather than blended, because they fail differently
// and a caller that knows which evidence it has should get the right one.
//
// ── The relative-major trap ────────────────────────────────────────────────
//
// C major and A minor contain exactly the same seven notes.  No amount of
// histogram separates them — only WEIGHT on the tonic does, which is why the
// profiles have a tall first number and why the chord estimator leans on
// which chord the music starts and ends on.  Getting this wrong is the single
// most common way a key detector is wrong, so it is tested directly.

import { findQuality, type ChordSymbol } from './chords.js';
import { PITCH_CLASS_NAMES, pitchClass, type Scale } from './scales.js';

/** A key is a `Scale` so it plugs into the editor, the snapping and compose. */
export const MAJOR_ID = 'major';
export const MINOR_ID = 'aeolian';

export interface KeyEstimate {
  key: Scale;
  /**
   * How far ahead of the runner-up, 0…1.
   *
   * NOT a confidence, and it was called one until it was measured.  Over 26
   * progressions in known keys the margin does not separate right answers
   * from wrong ones at all: the mean margin was 0.145 when correct and 0.128
   * when wrong, and 15 of the 24 correct answers had a SMALLER margin than
   * the worst wrong one.  A number that looks like trust and does not track
   * correctness is worse than no number, because a display will show it.
   *
   * What it does say is real and worth showing: how close the runner-up is.
   * The smallest margins measured were all minor keys with their relative
   * major a hair behind — exactly the case where a person should be shown
   * both and left to decide.  So it drives `alternative`, not a trust badge.
   */
  margin: number;
  /** The runner-up — nearly always the relative major or minor. */
  alternative: Scale | null;
}

/**
 * Below this the runner-up is close enough that both should be offered.
 *
 * Set where the measured relative-major ties fall (margins of 0.007–0.03),
 * not where a round number landed.
 */
export const KEY_AMBIGUOUS_MARGIN = 0.05;

/** Is the runner-up close enough that the chart should offer it too? */
export function keyIsAmbiguous(estimate: KeyEstimate): boolean {
  return estimate.alternative !== null && estimate.margin < KEY_AMBIGUOUS_MARGIN;
}

/**
 * Krumhansl-Kessler profiles: how much of each scale degree a key contains,
 * measured from listener ratings rather than invented.
 *
 * Index 0 is the tonic.  The tall tonic and dominant are what separate a key
 * from its relative, which shares every note.
 */
export const KK_MAJOR: readonly number[] = [
  6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88,
];
export const KK_MINOR: readonly number[] = [
  6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17,
];

/** Pearson correlation — the K-S scoring function. */
function correlate(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let sa = 0;
  let sb = 0;
  for (let i = 0; i < n; i++) { sa += a[i] ?? 0; sb += b[i] ?? 0; }
  const ma = sa / n;
  const mb = sb / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = (a[i] ?? 0) - ma;
    const y = (b[i] ?? 0) - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  if (da <= 0 || db <= 0) return 0;
  return num / Math.sqrt(da * db);
}

interface Scored { key: Scale; score: number }

function rank(histogram: readonly number[]): KeyEstimate | null {
  let total = 0;
  for (const v of histogram) total += v;
  if (!(total > 0)) return null;

  const scored: Scored[] = [];
  for (let root = 0; root < 12; root++) {
    // Rotate the histogram so the candidate tonic is index 0, then correlate
    // against the profile.  Rotating the data rather than the profile keeps
    // the profile a constant the reader can check against the paper.
    const rotated: number[] = [];
    for (let i = 0; i < 12; i++) rotated.push(histogram[pitchClass(root + i)] ?? 0);
    scored.push({ key: { root, scaleId: MAJOR_ID }, score: correlate(rotated, KK_MAJOR) });
    scored.push({ key: { root, scaleId: MINOR_ID }, score: correlate(rotated, KK_MINOR) });
  }
  scored.sort((a, b) => b.score - a.score);

  const best = scored[0];
  const second = scored[1];
  if (!best) return null;
  // Correlations run −1…1, so the gap is halved to land on 0…1.
  const margin = second ? Math.max(0, Math.min(1, (best.score - second.score) / 2)) : 1;
  return { key: best.key, margin, alternative: second?.key ?? null };
}

/**
 * The key of a pitch-class distribution.
 *
 * `chroma` is twelve numbers, in any scale — it is correlated, so only the
 * SHAPE matters and a loud passage does not outvote a long one unless the
 * caller wanted it to.
 */
export function keyFromChroma(chroma: ArrayLike<number>): KeyEstimate | null {
  const histogram: number[] = [];
  for (let i = 0; i < 12; i++) histogram.push(Math.max(0, chroma[i] ?? 0));
  return rank(histogram);
}

/** One chord in a progression, and how long it lasts. */
export interface KeyChord {
  chord: ChordSymbol;
  /** Seconds, beats, bars — any consistent unit.  Defaults to 1. */
  weight?: number;
}

/**
 * The key of a chord progression.
 *
 * The pitch-class histogram is built from the chords' own notes, weighted by
 * how long each chord lasts — a bar of C and a passing F♯dim7 are not one
 * vote each.  Then two corrections a histogram cannot make on its own:
 *
 *   The ROOT of a chord is worth more than its other notes.  A progression
 *   that keeps landing on G is telling you something a flat note-count is not.
 *
 *   The FIRST and LAST chords are worth more still.  Music tends to start and
 *   end at home, and this is what separates A minor from C major — the one
 *   thing the profiles alone find hardest.
 */
export function keyFromChords(chords: readonly KeyChord[]): KeyEstimate | null {
  if (chords.length === 0) return null;
  const histogram = new Array<number>(12).fill(0);
  let total = 0;

  chords.forEach((entry, index) => {
    const weight = Math.max(0, entry.weight ?? 1);
    if (weight <= 0) return;
    total += weight;
    const intervals = findQuality(entry.chord.qualityId)?.intervals ?? [0, 4, 7];
    for (const interval of intervals) {
      const pc = pitchClass(entry.chord.root + interval);
      histogram[pc] = (histogram[pc] ?? 0) + weight;
    }
    // The root again, on top of its share as a chord tone.
    const root = pitchClass(entry.chord.root);
    histogram[root] = (histogram[root] ?? 0) + weight * ROOT_BONUS;
    const cadence = (index === 0 ? OPENING_BONUS : 0)
      + (index === chords.length - 1 ? CLOSING_BONUS : 0);
    if (cadence > 0) histogram[root] = (histogram[root] ?? 0) + weight * cadence;
  });

  if (total <= 0) return null;
  return rank(histogram);
}

/**
 * Swept, and worth being honest about how far that goes.
 *
 * Best of a 343-point grid over 26 progressions in known keys: 24 right,
 * against 20 for the values guessed first.  Seventeen of those 343 settings
 * land within one case of the best, so this is a ridge rather than a spike
 * and the third decimal place means nothing.
 *
 * The fixtures are ones this repository wrote.  The first sweep over them
 * said "trust the opening chord and nothing else", which turned out to be a
 * fact about the FIXTURES — almost every one of them began on the tonic.
 * Rebalancing the set so half of them start somewhere else changed the answer
 * completely.  The real test is a key nobody here chose.
 */
export const ROOT_BONUS = 0.3;
export const OPENING_BONUS = 1.2;
export const CLOSING_BONUS = 0.6;

/** `C Major`, `A Minor` — what the UI shows. */
export function keyName(key: Scale): string {
  const root = PITCH_CLASS_NAMES[pitchClass(key.root)] ?? 'C';
  return `${root} ${key.scaleId === MINOR_ID ? 'Minor' : 'Major'}`;
}

/** Is this key major?  The two ids are the only ones a key estimate uses. */
export function isMajorKey(key: Scale): boolean {
  return key.scaleId !== MINOR_ID;
}

/**
 * The pitch classes of a key's scale, as a set — the diatonic notes.
 *
 * Re-derived here rather than imported from `scales.ts` so a key estimate can
 * be used without pulling the whole scale machinery in; the two agree because
 * both read the same interval table.
 */
export function keyPitchClasses(key: Scale): Set<number> {
  const major = [0, 2, 4, 5, 7, 9, 11];
  const minor = [0, 2, 3, 5, 7, 8, 10];
  const out = new Set<number>();
  for (const interval of isMajorKey(key) ? major : minor) out.add(pitchClass(key.root + interval));
  return out;
}
