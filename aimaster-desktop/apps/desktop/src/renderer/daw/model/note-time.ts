// The one place MIDI beats become seconds.
//
// Notes are stored in BEATS from their part's start (`model/midi.ts`).  The
// audio engine, the canvas and every measurement work in SECONDS.  This
// module is the only conversion, so there is exactly one definition of
// "where is this note" and no second copy to drift.
//
// The rule, in one line:
//
//     absoluteBeat = beatOf(partStartSec) + note.startBeat
//
// The part is anchored in seconds; its notes ride the tempo map from there.
// So a part that starts at 0:10 stays at 0:10 when the tempo changes, and a
// note on beat 4 inside it stays four beats in — which is what a musician
// means by both.  A note's DURATION in seconds is therefore not a property
// of the note at all: it is the distance between two points on the map, and
// a note spanning a tempo ramp is genuinely longer at one end than the other.

import { beatToSec, secToBeat, type TempoMap } from './tempo-map.js';
import { noteEndBeat, type MidiNote } from './midi.js';

/**
 * A part's time frame, resolved once.
 *
 * Built per part and reused for every note in it: `secToBeat` walks the
 * tempo segments, and doing that per note in a draw loop is the difference
 * between a piano roll that scrolls and one that stutters.
 */
export interface PartClock {
  readonly map: TempoMap;
  /** Where the part starts, in seconds. */
  readonly startSec: number;
  /** The same instant in beats — the origin note beats are measured from. */
  readonly startBeat: number;
}

export function partClock(map: TempoMap, partStartSec: number): PartClock {
  return { map, startSec: partStartSec, startBeat: secToBeat(map, partStartSec) };
}

/** Part-relative beat → absolute seconds on the timeline. */
export function beatToTimelineSec(clock: PartClock, beat: number): number {
  return beatToSec(clock.map, clock.startBeat + beat);
}

/** Absolute seconds on the timeline → part-relative beat. */
export function timelineSecToBeat(clock: PartClock, sec: number): number {
  return secToBeat(clock.map, sec) - clock.startBeat;
}

/** Where the note starts on the timeline, in seconds. */
export function noteStartSec(clock: PartClock, note: MidiNote): number {
  return beatToTimelineSec(clock, note.startBeat);
}

/** Where the note ends on the timeline, in seconds. */
export function noteEndSec(clock: PartClock, note: MidiNote): number {
  return beatToTimelineSec(clock, noteEndBeat(note));
}

export interface NoteSpan {
  startSec: number;
  endSec: number;
  durationSec: number;
}

/**
 * The note's sounding span in seconds.
 *
 * `durationSec` is measured, not assumed: across a tempo ramp it is not
 * `durationBeat × beatSeconds` at either end.
 */
export function noteSpan(clock: PartClock, note: MidiNote): NoteSpan {
  const startSec = beatToTimelineSec(clock, note.startBeat);
  const endSec = beatToTimelineSec(clock, noteEndBeat(note));
  return { startSec, endSec, durationSec: Math.max(0, endSec - startSec) };
}

/** Seconds a length in beats takes at the part start — for defaults, not rendering. */
export function beatsToSecAt(clock: PartClock, beats: number): number {
  return beatToTimelineSec(clock, beats) - clock.startSec;
}

/** Length in beats of a duration in seconds measured from the part start. */
export function secToBeatsAt(clock: PartClock, seconds: number): number {
  return timelineSecToBeat(clock, clock.startSec + seconds);
}

/**
 * Beat inside a note at a given moment, for sampling per-note curves.
 * Clamped to the note so a curve never reads past its own end.
 */
export function beatIntoNote(clock: PartClock, note: MidiNote, timelineSec: number): number {
  const b = timelineSecToBeat(clock, timelineSec) - note.startBeat;
  return b < 0 ? 0 : b > note.durationBeat ? note.durationBeat : b;
}
