// drum-map-session.ts — where a kit lives in the project.
//
// Maps are stored on the SESSION and referenced by tracks, not copied onto
// each track.  Two drum tracks in one song are almost always the same kit,
// and a map that has been copied is a map that has to be edited twice — the
// second copy quietly stays wrong until somebody notices the snare is on the
// old row.
//
// The reference is by id rather than by name, which is the opposite of what
// `track-input.ts` does with devices, and for the opposite reason: a device
// is a fact about the machine and has to be re-found on another one, while a
// map travels INSIDE the session file next to the track that points at it.
// There is nothing to re-find.

import { GM_DRUM_MAP, type DrumMap } from './drum-map.js';
import type { DawSession, Track, TrackId } from './types.js';
import { updateTrack } from './session-ops.js';

/** Every map in the session, tolerating one saved before maps existed. */
export function drumMapsOf(session: DawSession): DrumMap[] {
  const raw = (session as { drumMaps?: DrumMap[] }).drumMaps;
  return Array.isArray(raw) ? raw : [];
}

export function findDrumMap(session: DawSession, id: string | null | undefined): DrumMap | null {
  if (!id) return null;
  return drumMapsOf(session).find((m) => m.id === id) ?? null;
}

/**
 * The map a track plays through, or null.
 *
 * Null is a real answer, not a missing one: most tracks are not drum tracks
 * and must not have a kit applied to them.  A track pointing at a map that is
 * no longer in the session also reads null rather than falling back to
 * General MIDI — silently substituting a different kit would move every
 * instrument in the part.
 */
export function drumMapFor(session: DawSession, track: Track | undefined | null): DrumMap | null {
  const id = (track as { drumMapId?: string } | null | undefined)?.drumMapId;
  return findDrumMap(session, id);
}

export function setSessionDrumMap(session: DawSession, map: DrumMap): DawSession {
  const maps = drumMapsOf(session);
  const index = maps.findIndex((m) => m.id === map.id);
  const next = index < 0 ? [...maps, map] : maps.map((m) => (m.id === map.id ? map : m));
  return { ...session, drumMaps: next } as DawSession;
}

/** Point a track at a map, or at nothing.  Adds the map if it is new here. */
export function assignDrumMap(
  session: DawSession, trackId: TrackId, map: DrumMap | null,
): DawSession {
  const withMap = map ? setSessionDrumMap(session, map) : session;
  return updateTrack(withMap, trackId, (t) => {
    if (!map) {
      const { drumMapId: _drop, ...rest } = t as Track & { drumMapId?: string };
      return rest as Track;
    }
    return { ...t, drumMapId: map.id };
  });
}

/**
 * Remove a map from the session and from every track that used it.
 *
 * Leaving a dangling id behind would make those tracks read as "no map",
 * which is right, but the id would come back the moment somebody re-added a
 * map with the same id — so it is cleared rather than left to rot.
 */
export function removeDrumMap(session: DawSession, id: string): DawSession {
  const maps = drumMapsOf(session).filter((m) => m.id !== id);
  const tracks = session.tracks.map((t) => {
    if ((t as { drumMapId?: string }).drumMapId !== id) return t;
    const { drumMapId: _drop, ...rest } = t as Track & { drumMapId?: string };
    return rest as Track;
  });
  return { ...session, drumMaps: maps, tracks } as DawSession;
}

/** Give a session the built-in kit, if it has no maps yet. */
export function ensureDefaultDrumMap(session: DawSession): DawSession {
  return drumMapsOf(session).length > 0 ? session : setSessionDrumMap(session, GM_DRUM_MAP);
}

export function tracksUsingDrumMap(session: DawSession, id: string): Track[] {
  return session.tracks.filter((t) => (t as { drumMapId?: string }).drumMapId === id);
}
