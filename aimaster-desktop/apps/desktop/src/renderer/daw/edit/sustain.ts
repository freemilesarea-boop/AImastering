// sustain.ts — the pedal, which is part of the note.
//
// A sustain pedal is not a curve.  It is a switch, and what it does is stop
// notes ending: press it, and everything sounding keeps sounding until it
// comes up, whatever the written note lengths say.
//
// This repository already knew that.  `midi-capture.ts` folds a recorded
// CC64 into note LENGTH and says why in its own docblock — "THE PEDAL IS PART
// OF THE NOTE" — so a performance played with a pedal arrives as notes that
// are already the right length, and everything downstream just works.
//
// What had no path was every OTHER way a pedal gets into a session:
//
//   · a .mid imported with pedalling — `midi-file.ts` reads CC64 into the
//     part's `controllers` lane, session-migrate carries it, the List Editor
//     shows it, MIDI export writes it back out, and NOTHING in the engine
//     ever read `clip.controllers`.  The pedal survived a full round trip
//     and never once sounded.
//   · a pedal drawn by hand in the Key Editor's controller lane.
//
// So this turns a pedal lane into the note lengths the rest of the engine
// already understands, at the point where a part becomes sound.  Applying it
// there rather than inside an instrument matters: only two of the built-in
// instruments use the shared `adsr()` helper, so an envelope-level pedal
// would have sustained a Rhodes and not a guitar.  Every instrument takes a
// duration.
//
// STEPPED, not interpolated.  `curveValueAt` ramps between points, which is
// right for a mod wheel and wrong for a pedal: a foot that presses at bar 1
// and lifts at bar 3 is holding the pedal down for two bars, not sliding it
// gradually up and back. Reading a pedal through an interpolating curve
// would half-release it through the middle of every span.

import { noteEndBeat, type ExpressionPoint, type MidiNote } from '../model/midi.js';

/** Sustain pedal.  Mirrors `midi-capture.ts`, which owns the recording side. */
export const SUSTAIN_CC = 64;

/**
 * Above this the pedal is DOWN.
 *
 * The MIDI spec's own threshold: a controller sends 0 or 127 for a switch,
 * and half-pedalling — which a sampled piano would resolve into partial
 * damping — is not something this engine can express, so it rounds.
 */
export const PEDAL_DOWN = 0.5;

export interface PedalSpan {
  /** Beat the pedal went down, relative to the part. */
  from: number;
  /** Beat it came up.  `Infinity` when it never does. */
  to: number;
}

/**
 * The spans a pedal lane is held down for.
 *
 * Points are read as a step function — see the note on interpolation above.
 * A lane that starts already down (its first point is a press) is honoured
 * from that point, not from the start of the part: a pedal nobody has
 * touched yet is up.
 */
export function pedalSpans(points: readonly ExpressionPoint[]): PedalSpan[] {
  const sorted = [...points].sort((a, b) => a.timeBeat - b.timeBeat);
  const spans: PedalSpan[] = [];
  let openedAt: number | null = null;
  for (const point of sorted) {
    const down = point.value >= PEDAL_DOWN;
    if (down && openedAt === null) openedAt = point.timeBeat;
    else if (!down && openedAt !== null) {
      spans.push({ from: openedAt, to: point.timeBeat });
      openedAt = null;
    }
  }
  // A lane that ends with the pedal still down holds to the end of whatever
  // it is applied to.  Closing it at the last point instead would release
  // every note exactly where the data runs out, which is an artefact of the
  // recording stopping rather than anything the player did.
  if (openedAt !== null) spans.push({ from: openedAt, to: Infinity });
  return spans;
}

/** The span holding at `beat`, or null when the pedal is up. */
function spanAt(spans: readonly PedalSpan[], beat: number): PedalSpan | null {
  for (const span of spans) {
    if (beat >= span.from && beat < span.to) return span;
  }
  return null;
}

/**
 * Notes lengthened by a pedal.
 *
 * A note whose END falls inside a held span rings on until the pedal lifts.
 * Notes are only ever made LONGER: a pedal cannot cut a note short, and a
 * note already longer than the span it ends in keeps its own length.
 *
 * `limitBeat` bounds a span that never closes — the part's own end — so an
 * unreleased pedal does not schedule a note of infinite length.
 */
export function sustainedNotes(
  notes: readonly MidiNote[], points: readonly ExpressionPoint[], limitBeat = Infinity,
): MidiNote[] {
  if (points.length === 0) return [...notes];
  const spans = pedalSpans(points);
  if (spans.length === 0) return [...notes];
  return notes.map((note) => {
    const end = noteEndBeat(note);
    const span = spanAt(spans, end);
    if (!span) return note;
    const lifted = Math.min(span.to, limitBeat);
    if (!Number.isFinite(lifted) || lifted <= end) return note;
    return { ...note, durationBeat: lifted - note.startBeat };
  });
}
