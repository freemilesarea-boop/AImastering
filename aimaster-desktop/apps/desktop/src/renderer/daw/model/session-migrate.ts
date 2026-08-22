// Opening a session written by an older build.
//
// Version 2 moved MIDI notes from seconds to beats.  A v1 file on disk is
// still a real session somebody made, so it opens — the notes are converted
// on the way in, using the tempo map that file itself carries.
//
// The conversion is done here and nowhere else.  Once `migrateSession` has
// run, the rest of the app may assume beats without checking a version.

import { DAW_SESSION_VERSION } from './types.js';
import { secToBeat, tempoMapOf, type TempoMap } from './tempo-map.js';

/** What a v1 note looked like. */
interface LegacyNote {
  startSec?: number;
  durationSec?: number;
  expression?: Array<{ points?: Array<{ timeSec?: number; timeBeat?: number; value: number }> }>;
  [key: string]: unknown;
}

export interface MigrationResult {
  session: Record<string, unknown>;
  /** One line per thing that changed, for the load toast. */
  notes: string[];
}

/**
 * Bring a parsed session object up to the current version.
 *
 * Takes and returns loose objects on purpose: the input is a file, and
 * typing it as a `DawSession` before it has been converted would be the
 * claim this function exists to earn.
 */
export function migrateSession(raw: Record<string, unknown>): MigrationResult {
  const version = typeof raw['version'] === 'number' ? raw['version'] : 0;
  const notes: string[] = [];
  let session = raw;

  if (version < 2) {
    const converted = notesToBeats(session);
    session = converted.session;
    if (converted.count > 0) {
      notes.push(`MIDI 노트 ${converted.count}개를 박자 기준으로 변환했습니다`);
    }
  }

  return { session: { ...session, version: DAW_SESSION_VERSION }, notes };
}

/** True when this file predates the current format and needs converting. */
export function needsMigration(raw: Record<string, unknown>): boolean {
  const version = typeof raw['version'] === 'number' ? raw['version'] : 0;
  return version > 0 && version < DAW_SESSION_VERSION;
}

/**
 * v1 → v2: note seconds become beats.
 *
 * A v1 note's `startSec` was measured from its PART's start, so the beat it
 * lands on is read from the part's position on the map — not from second
 * zero.  Reading it any other way would move every note in every part that
 * does not begin at the top of the session.
 */
function notesToBeats(raw: Record<string, unknown>): {
  session: Record<string, unknown>; count: number;
} {
  const map = tempoMapOf(raw as never);
  let count = 0;

  const convertNote = (note: LegacyNote, partStartSec: number): LegacyNote => {
    if (note['startBeat'] !== undefined) return note;      // already converted
    const startSec = typeof note.startSec === 'number' ? note.startSec : 0;
    const durationSec = typeof note.durationSec === 'number' ? note.durationSec : 0;
    const originBeat = secToBeat(map, partStartSec);
    const startBeat = secToBeat(map, partStartSec + startSec) - originBeat;
    const endBeat = secToBeat(map, partStartSec + startSec + durationSec) - originBeat;
    count += 1;

    const { startSec: _s, durationSec: _d, ...rest } = note;
    return {
      ...rest,
      startBeat,
      durationBeat: Math.max(0, endBeat - startBeat),
      ...(note.expression
        ? {
          expression: note.expression.map((curve) => ({
            ...curve,
            // Curve points were note-relative seconds; the note's own span is
            // the only frame they can be re-read in.
            points: (curve.points ?? []).map((point) => {
              if (point.timeBeat !== undefined) return point;
              const t = typeof point.timeSec === 'number' ? point.timeSec : 0;
              const { timeSec: _t, ...restPoint } = point;
              return {
                ...restPoint,
                timeBeat: secToBeat(map, partStartSec + startSec + t) - originBeat - startBeat,
              };
            }),
          })),
        }
        : {}),
    };
  };

  const convertClip = (clip: Record<string, unknown>): Record<string, unknown> => {
    const startSec = typeof clip['startSec'] === 'number' ? clip['startSec'] : 0;
    const list = Array.isArray(clip['notes']) ? (clip['notes'] as LegacyNote[]) : null;
    const lanes = Array.isArray(clip['controllers'])
      ? (clip['controllers'] as Array<Record<string, unknown>>)
      : null;
    if (!list && !lanes) return clip;
    return {
      ...clip,
      ...(list ? { notes: list.map((n) => convertNote(n, startSec)) } : {}),
      ...(lanes ? { controllers: lanes.map((lane) => convertLane(lane, map, startSec)) } : {}),
    };
  };

  const tracks = Array.isArray(raw['tracks']) ? (raw['tracks'] as Array<Record<string, unknown>>) : [];
  const nextTracks = tracks.map((track) => {
    const playlists = Array.isArray(track['playlists'])
      ? (track['playlists'] as Array<Record<string, unknown>>)
      : [];
    return {
      ...track,
      playlists: playlists.map((playlist) => ({
        ...playlist,
        clips: Array.isArray(playlist['clips'])
          ? (playlist['clips'] as Array<Record<string, unknown>>).map(convertClip)
          : playlist['clips'],
      })),
    };
  });

  // Library patterns are authored at the top of the session's map: they have
  // no placement of their own until they are dropped onto a track.
  const patterns = Array.isArray(raw['patterns']) ? (raw['patterns'] as Array<Record<string, unknown>>) : null;
  const nextPatterns = patterns?.map((pattern) => ({
    ...pattern,
    notes: Array.isArray(pattern['notes'])
      ? (pattern['notes'] as LegacyNote[]).map((n) => convertNote(n, 0))
      : pattern['notes'],
  }));

  return {
    session: {
      ...raw,
      tracks: nextTracks,
      ...(nextPatterns ? { patterns: nextPatterns } : {}),
    },
    count,
  };
}

/** A part-level controller lane: points measured from the PART start. */
function convertLane(
  lane: Record<string, unknown>, map: TempoMap, partStartSec: number,
): Record<string, unknown> {
  const points = Array.isArray(lane['points'])
    ? (lane['points'] as Array<{ timeSec?: number; timeBeat?: number; value: number }>)
    : null;
  if (!points) return lane;
  const originBeat = secToBeat(map, partStartSec);
  return {
    ...lane,
    points: points.map((point) => {
      if (point.timeBeat !== undefined) return point;
      const t = typeof point.timeSec === 'number' ? point.timeSec : 0;
      const { timeSec: _t, ...rest } = point;
      return { ...rest, timeBeat: secToBeat(map, partStartSec + t) - originBeat };
    }),
  };
}
