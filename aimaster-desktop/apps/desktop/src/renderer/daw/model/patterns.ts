// Patterns — a phrase you write once and place many times.
//
// This is the one idea from FL Studio that changes how a project is built.  A
// copied clip and a placed pattern look identical on the timeline and behave
// completely differently: fix a wrong note in a copied clip and you have fixed
// it in ONE of the eight places the chorus appears.  Fix it in a pattern and
// it is fixed everywhere, because there was only ever one copy of the notes.
//
// The implementation is deliberately small.  A clip already has everything a
// placement needs — position, length, track.  All that is added is a link:
//
//     clip.patternId → the notes live over there
//
// Everything that READS notes goes through `clipNotes()`, everything that
// WRITES them goes through `writeClipNotes()`, and the two of them decide
// whether the target is the clip or the pattern behind it.  That keeps the
// change to two functions instead of to every caller.

import { nextId } from './ids.js';
import { updateClip } from './session-ops.js';
import { secToBeat, tempoMapOf } from './tempo-map.js';
import type { MidiNote } from './midi.js';
import type { Clip, ClipId, DawSession, TrackId } from './types.js';

export interface Pattern {
  id: string;
  name: string;
  color: string;
  /** The phrase itself. */
  notes: MidiNote[];
  /** Musical length, seconds at the tempo it was written at. */
  durationSec: number;
  /** Tempo the notes were written against, so a placement can be re-timed. */
  baseBpm: number;
}

export const PATTERN_COLORS = [
  '#C6A768', '#6E9BD6', '#6FBF8F', '#D46A6A', '#B08FD6', '#D69A6E',
] as const;

export function createPattern(
  name: string, notes: MidiNote[], durationSec: number, baseBpm: number, index = 0,
): Pattern {
  return {
    id: nextId('pat'),
    name,
    color: PATTERN_COLORS[index % PATTERN_COLORS.length] ?? PATTERN_COLORS[0],
    notes,
    durationSec,
    baseBpm,
  };
}

// ── Library ───────────────────────────────────────────────────────────────────

export function findPattern(session: DawSession, patternId: string): Pattern | undefined {
  return session.patterns?.find((p) => p.id === patternId);
}

export function addPattern(session: DawSession, pattern: Pattern): DawSession {
  return { ...session, patterns: [...(session.patterns ?? []), pattern] };
}

export function updatePattern(
  session: DawSession, patternId: string, fn: (p: Pattern) => Pattern,
): DawSession {
  const patterns = session.patterns ?? [];
  let changed = false;
  const next = patterns.map((p) => {
    if (p.id !== patternId) return p;
    const updated = fn(p);
    if (updated !== p) changed = true;
    return updated;
  });
  return changed ? { ...session, patterns: next } : session;
}

export function renamePattern(session: DawSession, patternId: string, name: string): DawSession {
  return updatePattern(session, patternId, (p) => (p.name === name ? p : { ...p, name }));
}

/** Every clip that plays this pattern. */
export function patternUsage(
  session: DawSession, patternId: string,
): { trackId: TrackId; clipId: ClipId; startSec: number }[] {
  const out: { trackId: TrackId; clipId: ClipId; startSec: number }[] = [];
  for (const track of session.tracks) {
    for (const playlist of track.playlists) {
      for (const clip of playlist.clips) {
        if (clip.patternId === patternId) {
          out.push({ trackId: track.id, clipId: clip.id, startSec: clip.startSec });
        }
      }
    }
  }
  return out;
}

/**
 * Delete a pattern.  Placements are unlinked first — given their own copy of
 * the notes — rather than silently emptied.  Losing a pattern must never lose
 * the music that was playing it.
 */
export function removePattern(session: DawSession, patternId: string): DawSession {
  const pattern = findPattern(session, patternId);
  if (!pattern) return session;
  let next = session;
  for (const use of patternUsage(session, patternId)) {
    next = unlinkClip(next, use.trackId, use.clipId);
  }
  return { ...next, patterns: (next.patterns ?? []).filter((p) => p.id !== patternId) };
}

// ── Reading and writing notes ─────────────────────────────────────────────────

/**
 * The notes a clip plays.  Pattern-backed clips carry no notes of their own;
 * this is the ONE place that resolves the link, so nothing downstream has to
 * know the difference.
 */
export function clipNotes(session: DawSession, clip: Clip): MidiNote[] {
  if (!clip.patternId) return clip.notes;
  return findPattern(session, clip.patternId)?.notes ?? clip.notes;
}

/**
 * Write notes back through the link.  Editing a placement edits the PATTERN,
 * which is the whole point — the change lands in every placement at once.
 */
export function writeClipNotes(
  session: DawSession, trackId: TrackId, clipId: ClipId, notes: MidiNote[],
): DawSession {
  const track = session.tracks.find((t) => t.id === trackId);
  const clip = track?.playlists.flatMap((p) => p.clips).find((c) => c.id === clipId);
  if (!clip) return session;
  if (clip.patternId) return updatePattern(session, clip.patternId, (p) => ({ ...p, notes }));
  return updateClip(session, trackId, clipId, (c) => ({ ...c, notes }));
}

// ── Placement ─────────────────────────────────────────────────────────────────

/** A clip that plays a pattern.  It stores no notes — that is the link. */
export function patternClip(pattern: Pattern, startSec: number, tempoBpm: number): Partial<Clip> {
  const scale = pattern.baseBpm > 0 ? pattern.baseBpm / Math.max(1, tempoBpm) : 1;
  return {
    kind: 'midi',
    patternId: pattern.id,
    name: pattern.name,
    startSec,
    durationSec: pattern.durationSec * scale,
    notes: [],
  };
}

/**
 * Turn a placement into an independent copy.  The escape hatch: once one
 * chorus needs a different ending, it stops being the same pattern.
 */
export function unlinkClip(session: DawSession, trackId: TrackId, clipId: ClipId): DawSession {
  const track = session.tracks.find((t) => t.id === trackId);
  const clip = track?.playlists.flatMap((p) => p.clips).find((c) => c.id === clipId);
  if (!clip?.patternId) return session;
  const notes = clipNotes(session, clip).map((n) => ({ ...n, id: nextId('note') }));
  return updateClip(session, trackId, clipId, (c) => {
    const { patternId: _dropped, ...rest } = c;
    return { ...rest, notes };
  });
}

/** Capture a clip's notes as a new pattern, and link the clip to it. */
export function captureAsPattern(
  session: DawSession, trackId: TrackId, clipId: ClipId, name: string, tempoBpm: number,
): { session: DawSession; pattern: Pattern } | null {
  const track = session.tracks.find((t) => t.id === trackId);
  const clip = track?.playlists.flatMap((p) => p.clips).find((c) => c.id === clipId);
  if (!clip || clip.kind !== 'midi' || clip.patternId) return null;

  const pattern = createPattern(
    name, clip.notes, clip.durationSec, tempoBpm, (session.patterns ?? []).length);
  const withPattern = addPattern(session, pattern);
  return {
    session: updateClip(withPattern, trackId, clipId, (c) => ({
      ...c, patternId: pattern.id, notes: [], name: pattern.name,
    })),
    pattern,
  };
}

/**
 * Another clip's notes, moved into `host`'s time base.
 *
 * Two features need exactly this and would otherwise each grow their own copy:
 * MIDI-guided pitch correction (a guide melody over a vocal that sits
 * elsewhere on the timeline) and ghost notes (chords drawn behind the part
 * being edited).  Both ask the same question — "what is this other part
 * playing, in MY clock" — so it is answered once.
 *
 * Pattern-backed sources resolve through the link, so a placed pattern works
 * as a guide or a ghost like anything else.
 */
export function notesInClipTime(
  session: DawSession, host: Clip, sourceTrackId: TrackId, sourceClipId: ClipId,
): MidiNote[] {
  const track = session.tracks.find((t) => t.id === sourceTrackId);
  const source = track?.playlists.flatMap((p) => p.clips).find((c) => c.id === sourceClipId);
  if (!source || source.kind !== 'midi') return [];
  // Both parts are anchored in seconds but the notes are in beats, so the
  // shift between the two frames is measured in beats — a guide part two
  // bars later stays two bars later even across a tempo change between them.
  const map = tempoMapOf(session);
  const shift = secToBeat(map, source.startSec) - secToBeat(map, host.startSec);
  return clipNotes(session, source).map((n) => ({ ...n, startBeat: n.startBeat + shift }));
}

export function describePattern(session: DawSession, pattern: Pattern): string {
  const uses = patternUsage(session, pattern.id).length;
  return `${pattern.name} · 노트 ${pattern.notes.length}개 · ${pattern.durationSec.toFixed(2)}s`
    + ` · 배치 ${uses}회`;
}
