// Track-level verbs that are not about time.
//
// Duplicating a track is the one that has to be careful.  A DAW's session is
// a graph held together by ids — playlists point at a track, clips at a
// playlist, automation lanes at a parameter, sends at a bus — and a duplicate
// made by copying the object hands you two tracks that share their insides.
// Editing one then edits the other, which is not a bug anyone finds quickly.
//
// So everything that IDENTIFIES a copy is new, and everything that DESCRIBES
// it is carried over.

import { addTrack, findTrack } from '../model/session-ops.js';
import { nextId } from '../model/ids.js';
import type { DawSession, Track, TrackId } from '../model/types.js';

/**
 * A free name in the "Vox 2" family.
 *
 * Cubase counts up rather than saying "copy of", because a session with four
 * doubles wants Vox 2, 3, 4 and not "copy of copy of Vox".  A name that
 * already ends in a number counts on from there.
 */
export function nextTrackName(taken: readonly string[], name: string): string {
  const match = /^(.*?)\s*(\d+)$/.exec(name);
  const stem = (match?.[1] ?? name).trim() || name;
  const from = match ? Number(match[2]) : 1;
  const used = new Set(taken);
  for (let n = from + 1; n < from + 1000; n++) {
    const candidate = `${stem} ${n}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${stem} ${Date.now()}`;
}

/**
 * Copy a track, its clips, its processing and its routing.
 *
 * What is deliberately NOT carried:
 *   • the freeze.  A frozen track's audio is a file on disk that belongs to
 *     the original; pointing a second track at it would mean unfreezing one
 *     silently changes the other.
 *   • the record arm.  Two armed tracks on one input is a double-record
 *     nobody asked for, and it is one click to arm the copy.
 *
 * Automation comes across with new lane ids but the SAME points: a duplicate
 * that lost its fader moves is not the track you duplicated.
 */
export function duplicateTrack(session: DawSession, trackId: TrackId): DawSession {
  const source = findTrack(session, trackId);
  if (!source) return session;

  const playlistIds = new Map<string, string>();
  const playlists = source.playlists.map((p) => {
    const id = nextId('pl');
    playlistIds.set(p.id, id);
    return { ...p, id, clips: p.clips.map((c) => ({ ...c, id: nextId('clip') })) };
  });

  const copy: Track = {
    ...source,
    id: nextId('trk'),
    name: nextTrackName(session.tracks.map((t) => t.name), source.name),
    playlists,
    activePlaylistId: playlistIds.get(source.activePlaylistId) ?? playlists[0]?.id ?? source.activePlaylistId,
    automation: source.automation.map((lane) => ({
      ...lane,
      id: nextId('lane'),
      points: lane.points.map((pt) => ({ ...pt, id: nextId('pt') })),
    })),
    inserts: source.inserts.map((i) => ({ ...i, id: nextId('ins'), params: { ...i.params } })),
    sends: source.sends.map((s) => ({ ...s, id: nextId('snd') })),
    frozen: null,
    recordArm: false,
  };

  // Placed directly under the original, where a duplicate belongs — appending
  // it to the end of a forty-track session is the same as losing it.
  const next = addTrack(session, copy);
  const from = next.tracks.findIndex((t) => t.id === copy.id);
  const at = next.tracks.findIndex((t) => t.id === source.id);
  if (from < 0 || at < 0 || from === at + 1) return next;
  const tracks = [...next.tracks];
  const [moved] = tracks.splice(from, 1);
  tracks.splice(at + (from > at ? 1 : 0), 0, moved!);
  return { ...next, tracks };
}
