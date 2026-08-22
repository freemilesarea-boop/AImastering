// Chord detection over a MIDI part → chord-track events.
//
// The Chord Track is only useful if it is easy to fill, so this reads the
// notes that are actually sounding on each beat division and writes the
// chord that explains them.  Repeats are collapsed, because a bar of Cmaj7
// is one chord, not four.

import { notesAt } from './midi-edit.js';
import { detectChord, formatChord, type ChordEvent } from '../model/chords.js';
import type { MidiNote } from '../model/midi.js';
import { nextId } from '../model/ids.js';
import { beatToTimelineSec, type PartClock } from '../model/note-time.js';

export interface ChordDetectOptions {
  /** How often to look, in BEATS (default: one bar of the session meter). */
  intervalBeat: number;
  /** The part's frame — turns a beat inside it into a timeline second. */
  clock: PartClock;
  /** Ignore weak matches — below this the detector is guessing. */
  minScore?: number;
}

/**
 * Scan a part and return the chord events it implies.
 * Consecutive identical chords are merged into the first one.
 */
export function detectChordTrack(
  notes: readonly MidiNote[], options: ChordDetectOptions,
): ChordEvent[] {
  const { intervalBeat, clock, minScore = 0.35 } = options;
  if (intervalBeat <= 0 || notes.length === 0) return [];

  const end = notes.reduce((max, n) => Math.max(max, n.startBeat + n.durationBeat), 0);
  const events: ChordEvent[] = [];
  let previous = '';

  for (let t = 0; t < end - 1e-6; t += intervalBeat) {
    // Look slightly after the boundary so a chord that starts exactly on the
    // beat is fully sounding.
    const sounding = notesAt(notes, t + Math.min(0.05, intervalBeat / 8));
    if (sounding.length < 2) continue;
    const match = detectChord(sounding.map((n) => n.pitch));
    if (!match || match.score < minScore) continue;
    const label = formatChord(match.chord);
    if (label === previous) continue;
    previous = label;
    events.push({ id: nextId('chord'), timeSec: beatToTimelineSec(clock, t), chord: match.chord });
  }
  return events;
}

/** One bar in seconds, from tempo and time signature. */
export function barSeconds(tempoBpm: number, beatsPerBar: number): number {
  return (60 / Math.max(1, tempoBpm)) * Math.max(1, beatsPerBar);
}
