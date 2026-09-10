// Choosing WHERE to play a chord, not just which notes it has.
//
// `voiceChord` puts every chord in root position above a floor, which is the
// right answer for a single chord and the wrong one for a progression.  A
// measured C–G–Am–F comes out
//
//     [60,64,67]  [67,71,74]  [69,72,76]  [65,69,72]
//
// which is 37 semitones of movement and a top note swinging over nine.  A
// keyboard player's hand does not do that: it stays put and moves the notes
// that have to move.  The same four chords, voice-led, are a few semitones of
// travel with the common tones held.
//
// This is the difference between a generated backing part that sounds like a
// part and one that sounds like homework, and it is not a matter of taste —
// it is the one thing that is objectively measurable about a voicing, so it
// is measured.
//
// ── How ─────────────────────────────────────────────────────────────────────
//
// For each chord, every inversion is a candidate.  Score each by how far the
// voices have to travel from the chord before, and take the cheapest.  Two
// corrections to that, both of which matter:
//
//   The register is anchored.  Cheapest-move alone lets a progression drift
//   downward for eighty bars, because each individual step is cheap.  A pull
//   toward the centre of the register costs a little and prevents that.
//
//   A slash chord keeps its bass.  If the chart says C/E the lowest note is
//   E, because that is what the chart SAYS, and a voicer that overrules the
//   annotation is answering a question nobody asked.

import { findQuality, type ChordSymbol } from './chords.js';
import { pitchClass } from './scales.js';

export interface VoicingOptions {
  /** Where the voicing sits.  The centre is what the register is pulled to. */
  lowPitch?: number;
  highPitch?: number;
  /**
   * How hard the register pulls, per semitone away from centre.
   *
   * Small: it should only decide between voicings that are otherwise close.
   * Large enough and it overrules voice leading, which is the failure this
   * whole file exists to avoid.
   */
  anchor?: number;
  /** Add the root an octave below the voicing — a left hand under it. */
  withBass?: boolean;
}

/**
 * Three octaves, not two — and the width is what makes the leading real.
 *
 * Measured: in a two-octave register a triad has about five candidate
 * voicings, all clustered near the middle, so the anchor alone picks the same
 * one the leading would and the travel term changes 1 voicing in 9.  Widen it
 * to C3–C6 and the same progression comes out 22 semitones of travel against
 * the anchor's 33, differing in 4 of 9.
 *
 * The width costs nothing in practice because the anchor still pulls to the
 * centre: on every fixture measured, the notes actually used stayed inside
 * 59–72 whichever register was allowed.  What the extra room buys is the
 * FREEDOM to move somewhere better, which is the whole point of leading.
 */
export const DEFAULT_VOICING: Required<Omit<VoicingOptions, 'withBass'>> = {
  lowPitch: 48,   // C3
  highPitch: 84,  // C6
  anchor: 0.35,
};

/** The pitch classes of a chord, root first. */
export function chordPitchClasses(chord: ChordSymbol): number[] {
  const intervals = findQuality(chord.qualityId)?.intervals ?? [0, 4, 7];
  const seen = new Set<number>();
  const out: number[] = [];
  for (const interval of intervals) {
    const pc = pitchClass(chord.root + interval);
    if (seen.has(pc)) continue;
    seen.add(pc);
    out.push(pc);
  }
  return out;
}

/**
 * Every inversion of a chord that fits the register.
 *
 * An inversion is the same notes with a different one at the bottom, so this
 * rotates the pitch-class list and stacks each rotation upward.
 */
export function voicingCandidates(
  chord: ChordSymbol, options: VoicingOptions = {},
): number[][] {
  const { lowPitch = DEFAULT_VOICING.lowPitch, highPitch = DEFAULT_VOICING.highPitch } = options;
  const classes = chordPitchClasses(chord);
  if (classes.length === 0) return [];

  // A slash chord's bass is a statement, not a preference: the chart already
  // decided which note is at the bottom.
  const bottomPc = chord.bass !== null && chord.bass !== undefined
    ? pitchClass(chord.bass)
    : null;

  const out: number[][] = [];
  for (let rotation = 0; rotation < classes.length; rotation++) {
    const order = [...classes.slice(rotation), ...classes.slice(0, rotation)];
    if (bottomPc !== null && order[0] !== bottomPc) continue;
    // Start the bottom voice on every octave that keeps the whole stack in
    // range, so the same inversion is offered high and low.
    for (let bottom = lowPitch; bottom <= highPitch; bottom += 12) {
      const first = bottom + pitchClass((order[0] ?? 0) - pitchClass(bottom));
      const stack: number[] = [first];
      for (let i = 1; i < order.length; i++) {
        const previous = stack[i - 1] ?? first;
        // Each voice above the last, by the smallest positive step.
        const step = pitchClass((order[i] ?? 0) - pitchClass(previous));
        stack.push(previous + (step === 0 ? 12 : step));
      }
      if ((stack[stack.length - 1] ?? 0) > highPitch) continue;
      if ((stack[0] ?? 0) < lowPitch) continue;
      out.push(stack);
    }
  }
  if (out.length > 0) return out;

  // Nothing fitted — a wide seventh in a narrow register.  Root position at
  // the floor is a worse answer than a well-led one and a much better answer
  // than no chord at all, so it is the fallback rather than the plan.
  const first = lowPitch + pitchClass((classes[0] ?? 0) - pitchClass(lowPitch));
  const stack = [first];
  for (let i = 1; i < classes.length; i++) {
    const previous = stack[i - 1] ?? first;
    const step = pitchClass((classes[i] ?? 0) - pitchClass(previous));
    stack.push(previous + (step === 0 ? 12 : step));
  }
  return [stack];
}

/**
 * How far the voices travel between two voicings.
 *
 * Each note of the new voicing counts the distance to the NEAREST note of the
 * old one, rather than pairing by index.  Pairing by index would punish a
 * triad following a seventh for having one fewer voice, and it is the held
 * common tone that makes a progression sound connected — so a note that is
 * already there must cost zero.
 */
export function voiceDistance(from: readonly number[], to: readonly number[]): number {
  if (from.length === 0) return 0;
  let total = 0;
  for (const pitch of to) {
    let best = Infinity;
    for (const previous of from) best = Math.min(best, Math.abs(pitch - previous));
    total += best;
  }
  return total;
}

/**
 * A progression, voiced so the hand stays still.
 *
 * The first chord has nothing to lead from, so it is placed nearest the
 * centre of the register; everything after it follows the cheapest path.
 */
export function voiceLead(
  chords: readonly ChordSymbol[], options: VoicingOptions = {},
): number[][] {
  const {
    lowPitch = DEFAULT_VOICING.lowPitch,
    highPitch = DEFAULT_VOICING.highPitch,
    anchor = DEFAULT_VOICING.anchor,
    withBass = false,
  } = options;
  const centre = (lowPitch + highPitch) / 2;

  const out: number[][] = [];
  let previous: number[] | null = null;
  for (const chord of chords) {
    const candidates = voicingCandidates(chord, { lowPitch, highPitch });
    if (candidates.length === 0) { out.push([]); continue; }

    let best = candidates[0] as number[];
    let bestCost = Infinity;
    for (const candidate of candidates) {
      const middle = candidate.reduce((a, b) => a + b, 0) / candidate.length;
      const pull = Math.abs(middle - centre) * anchor;
      const travel = previous ? voiceDistance(previous, candidate) : 0;
      const cost = travel + pull;
      if (cost < bestCost) { bestCost = cost; best = candidate; }
    }
    previous = best;
    out.push(withBass ? [rootBelow(chord, best, lowPitch), ...best] : best);
  }
  return out;
}

/**
 * The chord's root (or slash bass) an octave or more below the voicing.
 *
 * Kept out of the voice-leading cost on purpose: a bass line follows the
 * chart's roots, and letting it choose an inversion to save movement would
 * turn a root-motion bass into a wandering inner voice.
 */
function rootBelow(chord: ChordSymbol, voicing: readonly number[], lowPitch: number): number {
  const pc = pitchClass(chord.bass ?? chord.root);
  const ceiling = (voicing[0] ?? lowPitch) - 1;
  let pitch = lowPitch - 12 + pitchClass(pc - pitchClass(lowPitch - 12));
  while (pitch + 12 <= ceiling) pitch += 12;
  return pitch;
}

/** Total semitones of travel across a whole progression — the number to watch. */
export function totalMovement(voicings: readonly (readonly number[])[]): number {
  let total = 0;
  for (let i = 1; i < voicings.length; i++) {
    total += voiceDistance(voicings[i - 1] ?? [], voicings[i] ?? []);
  }
  return total;
}
