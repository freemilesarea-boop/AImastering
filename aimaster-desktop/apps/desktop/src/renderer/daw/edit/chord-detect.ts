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

export interface ChordDetectOptions {
  /** How often to look, in seconds (default: one bar at the session tempo). */
  intervalSec: number;
  /** Offset added to every event (a part's timeline position). */
  offsetSec?: number;
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
  const { intervalSec, offsetSec = 0, minScore = 0.35 } = options;
  if (intervalSec <= 0 || notes.length === 0) return [];

  const end = notes.reduce((max, n) => Math.max(max, n.startSec + n.durationSec), 0);
  const events: ChordEvent[] = [];
  let previous = '';

  for (let t = 0; t < end - 1e-6; t += intervalSec) {
    // Look slightly after the boundary so a chord that starts exactly on the
    // beat is fully sounding.
    const sounding = notesAt(notes, t + Math.min(0.02, intervalSec / 8));
    if (sounding.length < 2) continue;
    const match = detectChord(sounding.map((n) => n.pitch));
    if (!match || match.score < minScore) continue;
    const label = formatChord(match.chord);
    if (label === previous) continue;
    previous = label;
    events.push({ id: nextId('chord'), timeSec: offsetSec + t, chord: match.chord });
  }
  return events;
}

/** One bar in seconds, from tempo and time signature. */
export function barSeconds(tempoBpm: number, beatsPerBar: number): number {
  return (60 / Math.max(1, tempoBpm)) * Math.max(1, beatsPerBar);
}
