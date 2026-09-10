// Twelve numbers in, a chord symbol out.
//
// The chord vocabulary already exists — `model/chords.ts` has 22 qualities
// with their intervals, and `detectChord()` matches a SET of MIDI pitch
// classes against them.  Audio does not give a set.  It gives twelve
// continuous numbers where every one is non-zero, the third of the chord is
// sometimes quieter than a passing note in the melody, and a wrong answer
// looks exactly like a right one.  So the matching is different work even
// though the vocabulary is shared.
//
// ── Why cosine against binary templates ─────────────────────────────────────
//
// A template is the chord's pitch classes as ones and everything else as
// zeros, L2-normalised.  The score is the dot product, which for two unit
// vectors is the cosine of the angle between them.
//
// That choice does one important thing for free.  A dominant seventh CONTAINS
// a major triad, so any scoring that just counts matched notes prefers the
// triad on a seventh chord (all three of its notes are present) and prefers
// the seventh on a triad (three of four is still a lot).  Normalising by the
// template's own size fixes both directions:
//
//     a real triad   → triad template 1.000, seventh template 0.866
//     a real seventh → seventh template 1.000, triad template 0.866
//
// The subset and the superset both lose to the truth, and neither needs a
// hand-written rule.
//
// ── Vocabulary size is the accuracy dial ────────────────────────────────────
//
// This is the one number that decides how often the detector is right, and it
// is not a tuning parameter — it is a question about what the user wants.
// Twenty-four major/minor chords is the reliable tier.  Adding sevenths adds
// the distinctions a real chart needs and costs accuracy, because a seventh is
// the quietest note in most voicings and because m7 and its relative major 6
// are the SAME FOUR NOTES.  The full 22 qualities include chords that differ
// by one note from three others.
//
// Sevenths is the default because that is what was asked for.

import {
  QUALITIES, makeChord, type ChordSymbol,
} from '../../model/chords.js';
import { PITCH_CLASSES } from './chroma.js';

/** How much harmony the detector is allowed to say. */
export type ChordVocabulary = 'basic' | 'sevenths' | 'full';

/**
 * Which qualities each tier may answer with.
 *
 * `sevenths` is the standard large-vocabulary set from the chord-recognition
 * literature — the fourteen qualities a lead sheet actually uses — rather
 * than "the triads plus whatever sevenths we happen to have".
 */
export const VOCABULARY_QUALITIES: Readonly<Record<ChordVocabulary, readonly string[]>> = {
  basic: ['maj', 'min'],
  sevenths: [
    'maj', 'min', 'dim', 'aug',
    'maj7', 'min7', 'dom7', 'dim7', 'min7b5', 'minMaj7',
    'maj6', 'min6', 'sus2', 'sus4',
  ],
  full: QUALITIES.map((q) => q.id),
};

export const DEFAULT_VOCABULARY: ChordVocabulary = 'sevenths';

export interface ChordTemplate {
  chord: ChordSymbol;
  /** L2-normalised, twelve long. */
  vector: Float32Array;
  /** Pitch classes the chord contains — for the bass test. */
  members: ReadonlySet<number>;
}

const templateCache = new Map<ChordVocabulary, ChordTemplate[]>();

/**
 * Every chord the tier can say, as unit vectors.
 *
 * Built once per vocabulary: a four-minute song is a few thousand matches
 * against the same 168 templates.
 */
export function chordTemplates(vocabulary: ChordVocabulary = DEFAULT_VOCABULARY): ChordTemplate[] {
  const hit = templateCache.get(vocabulary);
  if (hit) return hit;

  const wanted = new Set(VOCABULARY_QUALITIES[vocabulary]);
  const out: ChordTemplate[] = [];
  for (const quality of QUALITIES) {
    if (!wanted.has(quality.id)) continue;
    for (let root = 0; root < PITCH_CLASSES; root++) {
      const vector = new Float32Array(PITCH_CLASSES);
      const members = new Set<number>();
      for (const interval of quality.intervals) {
        // `% 12` collapses the ninth and the thirteenth onto their pitch
        // class, which is the only thing a chroma can see.  A 9 chord is
        // therefore a 7 chord plus a second here — that is not a limitation of
        // this file, it is what folding octaves means.
        const pc = (((root + interval) % PITCH_CLASSES) + PITCH_CLASSES) % PITCH_CLASSES;
        members.add(pc);
      }
      const norm = Math.sqrt(members.size);
      for (const pc of members) vector[pc] = 1 / norm;
      out.push({ chord: makeChord(root, quality.id), vector, members });
    }
  }
  templateCache.set(vocabulary, out);
  return out;
}

export interface MatchOptions {
  vocabulary?: ChordVocabulary;
  /**
   * The bass note's pitch class, when a bass stem is available.
   *
   * Worth more than it looks.  Am7 and C6 are the SAME FOUR NOTES — A C E G —
   * and no amount of chroma tells them apart; the bass does, completely.  The
   * same goes for every inversion.
   */
  bassPitchClass?: number | null;
  /** How much a matching bass is worth.  See `DEFAULT_BASS_WEIGHT`. */
  bassWeight?: number;
  /** Below this the answer is "no chord" rather than a guess. */
  minScore?: number;
}

/**
 * How much the bass moves the answer.
 *
 * Big enough to decide between two chords that share every note, small enough
 * that a bass playing a passing tone under a held chord does not rewrite it.
 * A cosine score between a real chord and its own template runs 0.85–1.0 and
 * between a chord and a plausible neighbour 0.75–0.9, so a tenth is about the
 * size of the gap it needs to close.
 */
export const DEFAULT_BASS_WEIGHT = 0.1;

/**
 * Below this, the frame is not a chord.
 *
 * Deliberately low.  A frame that is genuinely ambiguous is better handled by
 * the smoothing downstream — which can see the frames either side of it —
 * than by being thrown away here, where the only context is twelve numbers.
 */
export const DEFAULT_MIN_SCORE = 0.55;

export interface ChordMatch {
  chord: ChordSymbol;
  /** Cosine similarity plus the bass bonus, 0…~1.1. */
  score: number;
  /**
   * How far ahead of the runner-up, 0…1.
   *
   * The number to show a user, and the one to trust: a 0.95 that beat its
   * rival by 0.001 is a coin toss with a confident face on.
   */
  margin: number;
}

/**
 * The chord that best explains this chroma.
 *
 * Returns null when the vector is silent or nothing scores well enough.  Null
 * is a real answer: an intro of one held bass note is not a chord, and
 * inventing one there puts a wrong label in front of the user for eight bars.
 */
export function matchChord(
  chroma: Float32Array, options: MatchOptions = {},
): ChordMatch | null {
  const {
    vocabulary = DEFAULT_VOCABULARY,
    bassPitchClass = null,
    bassWeight = DEFAULT_BASS_WEIGHT,
    minScore = DEFAULT_MIN_SCORE,
  } = options;

  // A zero vector is silence, and silence has no chord.  Normalising it would
  // produce twelve NaNs and then a confident answer built out of them.
  let energy = 0;
  for (let i = 0; i < PITCH_CLASSES; i++) energy += (chroma[i] ?? 0) ** 2;
  if (energy <= 1e-12) return null;
  const scale = 1 / Math.sqrt(energy);

  let best: ChordMatch | null = null;
  let second = -Infinity;

  for (const template of chordTemplates(vocabulary)) {
    let dot = 0;
    for (let i = 0; i < PITCH_CLASSES; i++) {
      dot += (chroma[i] ?? 0) * scale * (template.vector[i] ?? 0);
    }
    let score = dot;
    if (bassPitchClass !== null) {
      // The full bonus for a chord ROOTED on the bass; half for one that
      // merely contains it, which is what an inversion looks like.
      if (template.chord.root === bassPitchClass) score += bassWeight;
      else if (template.members.has(bassPitchClass)) score += bassWeight * 0.5;
    }
    if (!best || score > best.score) {
      if (best) second = Math.max(second, best.score);
      best = { chord: template.chord, score, margin: 0 };
    } else if (score > second) {
      second = score;
    }
  }

  if (!best || best.score < minScore) return null;

  // A slash chord, when the bass is in the chord but is not its root.  Written
  // only when we actually measured a bass — guessing an inversion from chroma
  // alone is guessing, and a wrong slash is worse than no slash.
  const chord = bassPitchClass !== null
    && bassPitchClass !== best.chord.root
    && chordMembers(best.chord).has(bassPitchClass)
    ? makeChord(best.chord.root, best.chord.qualityId, bassPitchClass)
    : best.chord;

  const margin = second > -Infinity
    ? Math.max(0, Math.min(1, (best.score - second) / Math.max(1e-9, best.score)))
    : 1;
  return { chord, score: best.score, margin };
}

/** The pitch classes a chord contains. */
export function chordMembers(chord: ChordSymbol): Set<number> {
  const quality = QUALITIES.find((q) => q.id === chord.qualityId);
  const out = new Set<number>();
  for (const interval of quality?.intervals ?? []) {
    out.add((((chord.root + interval) % PITCH_CLASSES) + PITCH_CLASSES) % PITCH_CLASSES);
  }
  return out;
}

/**
 * The pitch class a bass stem is playing, or null.
 *
 * The bass chroma is dominated by one note almost by definition, so this is
 * an argmax with a confidence gate rather than a pitch tracker: if the top
 * two are close it is a slide, a fill, or a chord being played on the bass,
 * and none of those should decide the harmony.
 */
export function bassPitchOf(chroma: Float32Array, ratio = 1.3): number | null {
  let bestPc = -1;
  let best = 0;
  let second = 0;
  for (let i = 0; i < PITCH_CLASSES; i++) {
    const v = chroma[i] ?? 0;
    if (v > best) { second = best; best = v; bestPc = i; }
    else if (v > second) { second = v; }
  }
  if (best <= 0) return null;
  return best >= second * ratio ? bestPc : null;
}

/**
 * Every template's score for this chroma, in template order.
 *
 * The same arithmetic `matchChord` does, without the argmax — the smoother
 * needs all of them, because the whole point of it is that the best answer
 * for one beat is not always the best answer for the beat in the song.
 *
 * Returns null for silence, which is a different statement from "every chord
 * scores badly" and has to stay distinguishable downstream.
 */
export function chordScores(
  chroma: Float32Array, options: MatchOptions = {},
): Float32Array | null {
  const {
    vocabulary = DEFAULT_VOCABULARY,
    bassPitchClass = null,
    bassWeight = DEFAULT_BASS_WEIGHT,
  } = options;

  let energy = 0;
  for (let i = 0; i < PITCH_CLASSES; i++) energy += (chroma[i] ?? 0) ** 2;
  if (energy <= 1e-12) return null;
  const scale = 1 / Math.sqrt(energy);

  const templates = chordTemplates(vocabulary);
  const out = new Float32Array(templates.length);
  for (let t = 0; t < templates.length; t++) {
    const template = templates[t];
    if (!template) continue;
    let dot = 0;
    for (let i = 0; i < PITCH_CLASSES; i++) {
      dot += (chroma[i] ?? 0) * scale * (template.vector[i] ?? 0);
    }
    if (bassPitchClass !== null) {
      if (template.chord.root === bassPitchClass) dot += bassWeight;
      else if (template.members.has(bassPitchClass)) dot += bassWeight * 0.5;
    }
    out[t] = dot;
  }
  return out;
}
