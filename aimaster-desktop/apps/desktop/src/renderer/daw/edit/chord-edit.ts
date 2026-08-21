// Editing the chord track.
//
// The chord track has existed as DATA for a while: `detectChords` writes it
// from a MIDI part, the Riff Machine reads it, the scale assistant reads it.
// What was missing was any way to touch it — you could not type a chord, fix
// one the detector got wrong, or move a change that landed half a beat late.
//
// A chord event stores only where it STARTS, exactly like an arrangement
// section: what is sounding at 1:12 is the last change at or before 1:12, and
// its end is the next one.  Two events at the same second would be a chord
// nobody can ever hear, so they are refused rather than sorted.
//
// The one thing this module insists on is that TYPING IS THE PRIMARY INPUT.
// A picker of root × quality is 12 × N clicks to say "Cmaj7", and every
// musician can already type "Cmaj7".  `parseChord` already exists and is
// strict; this file wraps it so a typo comes back as a sentence rather than a
// silent no-op.

import { formatChord, makeChord, parseChord, transposeChord, type ChordEvent, type ChordSymbol } from '../model/chords.js';
import { setChordTrack } from '../model/session-ops.js';
import { nextId } from '../model/ids.js';
import type { DawSession } from '../model/types.js';

/** Two changes closer than this are the same change. */
export const MIN_CHORD_GAP_SEC = 0.05;

export type ChordEdit =
  | { ok: true; events: ChordEvent[] }
  | { ok: false; reason: string };

export function sortedChords(session: DawSession): ChordEvent[] {
  return [...session.chordTrack].sort((a, b) => a.timeSec - b.timeSec);
}

export interface ChordRange {
  event: ChordEvent;
  startSec: number;
  /** The next change, or `songEndSec` for the last one. */
  endSec: number;
  index: number;
}

/**
 * Every chord as a range.
 *
 * `songEndSec` comes from the caller for the same reason the arrangement lane
 * asks for it: where the song ends is a question about the clips, and this
 * module does not know about clips.
 */
export function chordRanges(
  events: readonly ChordEvent[], songEndSec: number,
): ChordRange[] {
  const sorted = [...events].sort((a, b) => a.timeSec - b.timeSec);
  return sorted.map((event, index) => {
    const next = sorted[index + 1];
    return {
      event,
      index,
      startSec: event.timeSec,
      endSec: next ? next.timeSec : Math.max(event.timeSec, songEndSec),
    };
  });
}

// ── Typing a chord ────────────────────────────────────────────────────────────

export type ChordParse =
  | { ok: true; chord: ChordSymbol }
  | { ok: false; reason: string };

/**
 * Read what the user typed.
 *
 * Empty is a distinct answer from wrong: clearing the box is a request to
 * cancel, not a malformed chord, and telling someone their empty string is not
 * a chord is the kind of message that makes a tool feel hostile.
 */
export function parseChordInput(text: string): ChordParse {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { ok: false, reason: '' };
  const chord = parseChord(trimmed);
  if (!chord) {
    return {
      ok: false,
      reason: `'${trimmed}' 를 코드로 읽지 못했습니다 — C · Am · G7 · Fmaj7 · Bm7b5 · D/F# 처럼 써 주세요`,
    };
  }
  return { ok: true, chord };
}

// ── Editing the list ──────────────────────────────────────────────────────────

export function addChord(
  events: readonly ChordEvent[], timeSec: number, chord: ChordSymbol,
): ChordEdit {
  const at = Math.max(0, timeSec);
  if (events.some((e) => Math.abs(e.timeSec - at) < MIN_CHORD_GAP_SEC)) {
    return { ok: false, reason: '이미 여기에 코드가 있습니다' };
  }
  return {
    ok: true,
    events: [...events, { id: nextId('chord'), timeSec: at, chord }]
      .sort((a, b) => a.timeSec - b.timeSec),
  };
}

export function removeChord(events: readonly ChordEvent[], id: string): ChordEvent[] {
  return events.filter((e) => e.id !== id);
}

export function setChord(
  events: readonly ChordEvent[], id: string, chord: ChordSymbol,
): ChordEvent[] {
  return events.map((e) => (e.id === id ? { ...e, chord } : e));
}

/**
 * Move a change in time, clamped between its neighbours.
 *
 * Letting one overtake the next would silently reorder the progression, and
 * dragging a block is never a request to reorder anything.
 */
export function moveChord(
  events: readonly ChordEvent[], id: string, toSec: number,
): ChordEvent[] {
  const sorted = [...events].sort((a, b) => a.timeSec - b.timeSec);
  const index = sorted.findIndex((e) => e.id === id);
  const target = sorted[index];
  if (index < 0 || !target) return [...events];
  const before = sorted[index - 1];
  const after = sorted[index + 1];
  const lo = before ? before.timeSec + MIN_CHORD_GAP_SEC : 0;
  const hi = after ? after.timeSec - MIN_CHORD_GAP_SEC : Infinity;
  const next = Math.min(hi, Math.max(lo, toSec));
  if (Math.abs(next - target.timeSec) < 1e-9) return [...events];
  sorted[index] = { ...target, timeSec: next };
  return sorted;
}

/** Transpose the whole progression, or just the named events. */
export function transposeChords(
  events: readonly ChordEvent[], semitones: number, ids?: ReadonlySet<string>,
): ChordEvent[] {
  if (semitones === 0) return [...events];
  return events.map((e) => (!ids || ids.has(e.id)
    ? { ...e, chord: transposeChord(e.chord, semitones) } : e));
}

/** Shift chord changes at or after a moment — the ripple edits call this. */
export function shiftChords(
  events: readonly ChordEvent[], fromSec: number, deltaSec: number,
): ChordEvent[] {
  if (deltaSec === 0) return [...events];
  return events
    .map((e) => (e.timeSec >= fromSec - 1e-9
      ? { ...e, timeSec: Math.max(0, e.timeSec + deltaSec) } : e))
    .sort((a, b) => a.timeSec - b.timeSec);
}

/**
 * Lay a progression out on a grid — what "4마디마다 코드 하나" means.
 *
 * Used by the lane's "빈 진행 만들기" button so a songwriter can type over a
 * skeleton instead of clicking a plus button sixteen times.
 */
export function chordGrid(
  startSec: number, intervalSec: number, count: number, chord = makeChord(0),
): ChordEvent[] {
  const out: ChordEvent[] = [];
  const safe = Math.max(0.05, intervalSec);
  for (let i = 0; i < Math.max(0, Math.min(256, Math.floor(count))); i++) {
    out.push({ id: nextId('chord'), timeSec: Math.max(0, startSec) + i * safe, chord });
  }
  return out;
}

// ── Session-level convenience ─────────────────────────────────────────────────

export function withChords(session: DawSession, events: readonly ChordEvent[]): DawSession {
  return setChordTrack(session, [...events]);
}

/** `C · Am · F · G` over the whole song, or a window of it. */
export function describeChords(
  events: readonly ChordEvent[], fromSec = 0, toSec = Infinity,
): string {
  const inside = [...events]
    .sort((a, b) => a.timeSec - b.timeSec)
    .filter((e) => e.timeSec >= fromSec - 1e-9 && e.timeSec <= toSec + 1e-9);
  if (inside.length === 0) return '코드 없음';
  return inside.map((e) => formatChord(e.chord)).join(' · ');
}
