// From a stream of frames to a list of chords.
//
// The chroma comes out ten times a second.  A chord lasts a bar.  Matching
// every frame on its own and printing the results gives a chord chart with
// four hundred entries in it, most of them flickering between the right
// answer and its neighbour — which is not a worse version of the feature, it
// is an unusable one.
//
// Two things turn frames into chords, and the first matters more.
//
// ── Beat-synchronous averaging ──────────────────────────────────────────────
//
// Chords change on beats.  Averaging the chroma across a beat and matching
// once per beat is the single largest accuracy gain available here, for two
// reasons that compound: a beat's worth of frames is ten times the evidence
// for one decision, and the arpeggios, passing notes and grace notes that
// make individual frames wrong are exactly what averaging removes.
//
// It also makes the output EDITABLE.  A chord that begins on a beat can be
// dragged, retyped and re-timed in the chord track; one that begins at
// 12.7314 seconds cannot.
//
// The beat grid comes from the tempo detector this repo already has.  When it
// is not confident — and on material with no drums it will not be, because
// that detector reads amplitude transients — this falls back to a fixed
// window and SAYS SO, rather than laying a confident grid over music that
// does not have one.
//
// ── Merging ─────────────────────────────────────────────────────────────────
//
// Four beats of C is one chord, not four.  Consecutive identical labels
// collapse, and a segment too short to be a chord is ABSORBED BY ITS
// NEIGHBOUR rather than published: a single beat of "F#dim7" in the middle of
// eight bars of C is not a passing chord, it is one bad frame that won.
//
// Absorbed, not dropped — and the difference is not pedantic.  Dropping was
// what this did first, and stabs exposed it: play C G Am F as quarter-bar
// hits and the tail of each hit reads as its own major seventh, which splits
// every chord into two one-beat runs.  Drop both and the chart came back
// "C C Am Am" — two chords silently deleted and the one before them stretched
// over the hole.  Absorbing merges them instead, and the label is the one
// with MORE EVIDENCE behind it (score summed over its beats, so a long run
// outweighs a blip and a clean attack outweighs a smeared decay).
//
// A run's length is measured by what it COVERS — from where it starts to
// where the next chord starts — not by how many beats matched it.  A chord
// struck once and left to ring is silent for most of its bar, and it is still
// that chord for the whole bar.

import { chordAt, formatChord, type ChordEvent, type ChordSymbol } from '../../model/chords.js';
import { nextId } from '../../model/ids.js';
import { PITCH_CLASSES } from './chroma.js';
import {
  bassPitchOf, matchChord, type ChordVocabulary, type MatchOptions,
} from './chord-match.js';

// ── The grid ────────────────────────────────────────────────────────────────

export interface BeatGrid {
  /** Beat boundaries in seconds, ascending. */
  times: number[];
  /** True when this came from a detected tempo rather than a fallback. */
  fromTempo: boolean;
  /** What the tempo detector said, 0…1.  Zero for the fallback. */
  confidence: number;
  bpm: number;
}

/**
 * Below this the tempo detector is guessing, and a guessed grid is worse than
 * no grid: every chord boundary lands in the wrong place and the averaging
 * mixes two chords into each window.
 */
export const MIN_TEMPO_CONFIDENCE = 0.35;

/** The window a gridless track is analysed in, in seconds. */
export const FALLBACK_WINDOW_SEC = 0.5;

/**
 * Beat boundaries over `durationSec`.
 *
 * `phaseSec` is where the detector thinks beat one is; the grid is walked
 * BACKWARDS from it as well as forwards, because a song rarely starts on the
 * first beat the detector was confident about and the first bars are the ones
 * a user checks first.
 */
export function beatGrid(
  durationSec: number,
  tempo: { bpm: number; phaseSec: number; confidence: number } | null,
  minConfidence = MIN_TEMPO_CONFIDENCE,
): BeatGrid {
  if (tempo && tempo.bpm > 0 && tempo.confidence >= minConfidence) {
    const period = 60 / tempo.bpm;
    const times: number[] = [];
    let first = tempo.phaseSec;
    while (first - period > -1e-9) first -= period;
    for (let t = first; t < durationSec + period; t += period) {
      if (t >= -1e-9) times.push(Math.max(0, t));
    }
    return { times, fromTempo: true, confidence: tempo.confidence, bpm: tempo.bpm };
  }
  const times: number[] = [];
  for (let t = 0; t < durationSec; t += FALLBACK_WINDOW_SEC) times.push(t);
  times.push(durationSec);
  return { times, fromTempo: false, confidence: 0, bpm: 0 };
}

/**
 * Average the chroma frames inside each grid span.
 *
 * Spans with no frames — a grid finer than the hop, or a gap at the end —
 * come back as zero vectors, which read downstream as "no chord" rather than
 * as an arbitrary one.
 */
export function beatChroma(
  frames: readonly Float32Array[], hopSec: number, grid: readonly number[],
): Float32Array[] {
  const out: Float32Array[] = [];
  for (let i = 0; i + 1 < grid.length; i++) {
    const from = Math.max(0, Math.ceil((grid[i] ?? 0) / hopSec));
    const to = Math.min(frames.length, Math.ceil((grid[i + 1] ?? 0) / hopSec));
    const sum = new Float32Array(PITCH_CLASSES);
    let used = 0;
    for (let f = from; f < to; f++) {
      const frame = frames[f];
      if (!frame) continue;
      let any = false;
      for (let k = 0; k < PITCH_CLASSES; k++) if ((frame[k] ?? 0) > 0) { any = true; break; }
      // Silent frames are skipped so that the average is over the frames that
      // HAVE something in them: a beat that is half silence and half chord is
      // a chord, not a chord at half strength.
      //
      // This cannot change a match, and the comment here used to claim it
      // could.  Counting the zeros scales the whole vector down uniformly,
      // and every consumer is scale-invariant — `matchChord` normalises
      // before the dot product and `bassPitchOf` compares ratios — so the
      // score and the margin come out bit-identical either way (measured
      // across a 20× range).  What it keeps true is the MAGNITUDE, so that a
      // span vector means "how much of this pitch class was sounding while
      // anything was" rather than "…averaged over some silence too".
      if (!any) continue;
      for (let k = 0; k < PITCH_CLASSES; k++) sum[k] = (sum[k] ?? 0) + (frame[k] ?? 0);
      used += 1;
    }
    if (used > 0) for (let k = 0; k < PITCH_CLASSES; k++) sum[k] = (sum[k] ?? 0) / used;
    out.push(sum);
  }
  return out;
}

// ── Segments ────────────────────────────────────────────────────────────────

export interface ChordSegment {
  chord: ChordSymbol;
  startSec: number;
  endSec: number;
  /** Mean match score over the beats that make it up. */
  score: number;
  /** Mean lead over the runner-up.  Low means "check this one". */
  margin: number;
  /** How many grid spans it covers — including the ones it rings through. */
  beats: number;
}

export interface SegmentOptions extends MatchOptions {
  /** Per-span bass pitch classes, when a bass stem was analysed. */
  bassPitches?: readonly (number | null)[];
  /**
   * Segments covering fewer grid spans than this are absorbed into a
   * neighbour.
   *
   * In BEATS, not seconds: one beat of a strange chord inside eight bars of
   * one chord is a bad frame, at any tempo.
   */
  minBeats?: number;
}

export const DEFAULT_MIN_BEATS = 2;

/**
 * Match each span, then collapse.
 *
 * The collapsing is the part that has to be right.  Runs of the same label
 * become one segment; a run too short to be a chord is dropped and the
 * segment before it extended over the hole, because leaving a gap would make
 * the chord track claim there is no chord where there plainly is one.
 */
export function segmentChords(
  spanChroma: readonly Float32Array[], grid: readonly number[],
  options: SegmentOptions = {},
): ChordSegment[] {
  const { bassPitches, minBeats = DEFAULT_MIN_BEATS, ...match } = options;

  interface Span { label: string; chord: ChordSymbol; score: number; margin: number }
  const spans: (Span | null)[] = spanChroma.map((chroma, i) => {
    const bass = bassPitches ? (bassPitches[i] ?? null) : (match.bassPitchClass ?? null);
    const hit = matchChord(chroma, { ...match, bassPitchClass: bass });
    if (!hit) return null;
    return { label: formatChord(hit.chord), chord: hit.chord, score: hit.score, margin: hit.margin };
  });

  interface Run {
    label: string;
    chord: ChordSymbol;
    /** First span of the run. */
    from: number;
    /** One past its last MATCHED span — which is not where it ends. */
    to: number;
    scoreSum: number;
    marginSum: number;
    /** How many spans actually matched, for averaging the scores. */
    matched: number;
  }

  // Runs of the same label.
  const runs: Run[] = [];
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i];
    if (!span) continue;
    const last = runs[runs.length - 1];
    if (last && last.label === span.label && last.to === i) {
      last.to = i + 1;
      last.scoreSum += span.score;
      last.marginSum += span.margin;
      last.matched += 1;
      continue;
    }
    runs.push({
      label: span.label, chord: span.chord, from: i, to: i + 1,
      scoreSum: span.score, marginSum: span.margin, matched: 1,
    });
  }

  // What a run covers: from where it starts to where the next chord starts.
  // The silence after a stab, and the beats a bad frame lost, belong to the
  // chord that was sounding through them.
  const coverage = (index: number): number =>
    ((runs[index + 1]?.from ?? spanChroma.length) - (runs[index]?.from ?? 0));

  // Absorb every run too short to be a chord, weakest first.  Each pass
  // removes exactly one run, so this terminates.
  for (;;) {
    let worst = -1;
    for (let i = 0; i < runs.length; i++) {
      if (coverage(i) >= minBeats) continue;
      if (worst < 0 || coverage(i) < coverage(worst)) worst = i;
    }
    if (worst < 0) break;
    const run = runs[worst];
    if (!run) break;

    // Only a run it actually touches.  A short run with silence on both sides
    // has no neighbour to belong to, and inventing one would stretch an
    // unrelated chord across a rest.
    const prev = runs[worst - 1];
    const next = runs[worst + 1];
    const intoIndex = prev && prev.to === run.from
      ? (next && run.to === next.from && next.scoreSum > prev.scoreSum ? worst + 1 : worst - 1)
      : (next && run.to === next.from ? worst + 1 : -1);
    const into = intoIndex >= 0 ? runs[intoIndex] : undefined;
    if (!into) { runs.splice(worst, 1); continue; }

    // The label with more evidence behind it wins the merged span.  Summed,
    // not averaged: eight beats of C outweigh one loud beat of F#dim7, and
    // between two equally short runs the cleaner match wins.
    if (run.scoreSum > into.scoreSum) { into.label = run.label; into.chord = run.chord; }
    into.from = Math.min(into.from, run.from);
    into.to = Math.max(into.to, run.to);
    into.scoreSum += run.scoreSum;
    into.marginSum += run.marginSum;
    into.matched += run.matched;
    runs.splice(worst, 1);
  }

  // Re-merge whatever that left adjacent — absorbing a one-beat blip between
  // two runs of C makes those two runs one run of C, and not doing this
  // second pass leaves the chart with the same chord printed twice in a row.
  const merged: Run[] = [];
  for (const run of runs) {
    const last = merged[merged.length - 1];
    if (last && last.label === run.label) {
      last.to = run.to;
      last.scoreSum += run.scoreSum;
      last.marginSum += run.marginSum;
      last.matched += run.matched;
      continue;
    }
    merged.push({ ...run });
  }

  return merged.map((run, index) => {
    const next = merged[index + 1];
    const beats = (next?.from ?? spanChroma.length) - run.from;
    const evidence = Math.max(1, run.matched);
    return {
      chord: run.chord,
      startSec: grid[run.from] ?? 0,
      // A segment runs until the next one starts, not until its own last
      // matched beat ends.
      endSec: next ? (grid[next.from] ?? 0) : (grid[grid.length - 1] ?? 0),
      // Averaged over the beats that carried evidence, not over the beats it
      // covers: a chord held through four bars of silence is not four bars
      // less certain than the beat that proved it.
      score: run.scoreSum / evidence,
      margin: run.marginSum / evidence,
      beats,
    };
  });
}

// ── Out to the chord track ──────────────────────────────────────────────────

export interface ChordReadout {
  events: ChordEvent[];
  segments: ChordSegment[];
  grid: BeatGrid;
  tuningCents: number;
  vocabulary: ChordVocabulary;
  /** Segments whose margin is below `UNSURE_MARGIN` — worth a second look. */
  unsure: number;
}

/**
 * Below this lead over the runner-up, the answer is a coin toss.
 *
 * Surfaced rather than hidden.  A chart that marks its own doubtful bars is
 * more useful than one that is silently wrong in six places, because the
 * person arranging can check six bars and cannot check ninety.
 */
export const UNSURE_MARGIN = 0.04;

/** Segments as chord-track events. */
export function toChordEvents(segments: readonly ChordSegment[]): ChordEvent[] {
  return segments.map((s) => ({
    id: nextId('chord'),
    timeSec: s.startSec,
    chord: s.chord,
  }));
}

/** `C · Am7 · F · G7` — the progression on one line. */
export function describeProgression(
  segments: readonly ChordSegment[], limit = 12,
): string {
  const names = segments.map((s) => formatChord(s.chord));
  if (names.length <= limit) return names.join(' · ');
  return `${names.slice(0, limit).join(' · ')} … (${names.length}개)`;
}

/** The chord sounding at a time, from a readout — for the playhead display. */
export function chordAtTime(readout: ChordReadout, timeSec: number): ChordEvent | null {
  return chordAt(readout.events, timeSec);
}

/** Per-span bass pitch classes from a bass stem's chroma. */
export function bassPitchesFor(
  frames: readonly Float32Array[], hopSec: number, grid: readonly number[],
): (number | null)[] {
  return beatChroma(frames, hopSec, grid).map((c) => bassPitchOf(c));
}
