// Immutable session operations.
//
// Every function returns a NEW session (structurally shared where nothing
// changed) so the store can keep an undo stack of plain snapshots.  Callers
// never mutate what they are given.
//
// The clip operations are the "edit fast and exactly" surface: split, trim,
// heal, consolidate, nudge, clip gain, fades.  They are deliberately pure so
// they can be unit-tested to the sample without an audio device.

import {
  DAW_SESSION_VERSION, NO_FADE, INSERT_SLOTS, SEND_SLOTS,
  type AudioFileRef, type AutomationLane, type BusDef, type Clip, type DawSession,
  type FileId, type GroupDef, type Insert, type Playlist, type Send, type Track,
  type TrackId, type TrackKind, type ClipId, type BusId, type OutputTarget,
} from './types.js';
import { nextId } from './ids.js';
import { DEFAULT_MIDI_CONFIG } from './midi.js';
import type { ChordEvent, ChordSymbol } from './chords.js';
import { EMPTY_RACK } from './macros.js';
import { emptyGrid } from './session-view.js';
import { scheduleShiftSec } from './track-delay.js';

// ── Construction ──────────────────────────────────────────────────────────────

export const DEFAULT_TRACK_HEIGHT = 96;

export const TRACK_COLORS = [
  '#4f7fd6', '#4fa87a', '#c98a3e', '#a05fc0', '#c05f6f',
  '#3fa3a3', '#8a8f4f', '#6f6fd6', '#c06f9f', '#5f9fc0',
] as const;

export function createPlaylist(name: string, clips: Clip[] = []): Playlist {
  return { id: nextId('pl'), name, clips };
}

export function createTrack(
  name: string,
  kind: TrackKind = 'audio',
  over: Partial<Track> = {},
): Track {
  const playlist = createPlaylist(`${name}.01`);
  const colorIndex = Math.abs(hashString(name)) % TRACK_COLORS.length;
  return {
    id: nextId('trk'),
    name,
    kind,
    color: TRACK_COLORS[colorIndex] ?? '#4f7fd6',
    playlists: [playlist],
    activePlaylistId: playlist.id,
    volumeDb: 0,
    pan: 0,
    mute: false,
    solo: false,
    soloSafe: false,
    recordArm: false,
    inserts: [],
    sends: [],
    input: null,
    output: { kind: 'master' },
    groupIds: [],
    vcaId: null,
    automation: [],
    height: DEFAULT_TRACK_HEIGHT,
    frozen: null,
    instrumentId: kind === 'instrument' ? 'polysynth' : null,
    instrumentParams: {},
    parentId: null,
    collapsed: false,
    macros: EMPTY_RACK,
    deviceGraph: null,
    racks: [],
    ...over,
  };
}

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

export function createBus(name: string, channels: 1 | 2 = 2): BusDef {
  return { id: nextId('bus'), name, channels };
}

/**
 * What a session is called before anyone names it.
 *
 * One constant, because there were two: `createSession` defaulted to
 * 'Untitled' while the store that makes the app's actual first session passed
 * 'Untitled Session'.  Anything asking "has this been named yet" compared
 * against one of them and was wrong about the other.
 */
export const DEFAULT_SESSION_NAME = 'Untitled Session';

export function createSession(name = DEFAULT_SESSION_NAME, sampleRate = 48_000): DawSession {
  const master = createTrack('Master', 'master', { output: { kind: 'none' } });
  return {
    version: DAW_SESSION_VERSION,
    id: nextId('ses'),
    name,
    sampleRate,
    tempoBpm: 120,
    timeSignature: [4, 4],
    files: [],
    tracks: [master],
    buses: [],
    groups: [],
    markers: [],
    chordTrack: [],
    delayCompensation: true,
    sessionGrid: emptyGrid(),
  };
}

export function createClip(fileId: FileId, name: string, over: Partial<Clip> = {}): Clip {
  return {
    id: nextId('clip'),
    kind: 'audio',
    fileId,
    notes: [],
    controllers: [],
    pitchSegments: [],
    midiConfig: DEFAULT_MIDI_CONFIG,
    name,
    startSec: 0,
    offsetSec: 0,
    durationSec: 0,
    gainDb: 0,
    fadeIn: NO_FADE,
    fadeOut: NO_FADE,
    muted: false,
    ...over,
  };
}

/** An empty MIDI part — the container the Key Editor opens. */
export function createMidiPart(name: string, over: Partial<Clip> = {}): Clip {
  return {
    id: nextId('clip'),
    kind: 'midi',
    fileId: '',
    notes: [],
    controllers: [],
    pitchSegments: [],
    midiConfig: DEFAULT_MIDI_CONFIG,
    name,
    startSec: 0,
    offsetSec: 0,
    durationSec: 4,
    gainDb: 0,
    fadeIn: NO_FADE,
    fadeOut: NO_FADE,
    muted: false,
    ...over,
  };
}

// ── Lookups ───────────────────────────────────────────────────────────────────

export function findTrack(session: DawSession, id: TrackId): Track | undefined {
  return session.tracks.find((t) => t.id === id);
}

export function activePlaylist(track: Track): Playlist | undefined {
  return track.playlists.find((p) => p.id === track.activePlaylistId);
}

export function trackClips(track: Track): Clip[] {
  return activePlaylist(track)?.clips ?? [];
}

export function findFile(session: DawSession, id: FileId): AudioFileRef | undefined {
  return session.files.find((f) => f.id === id);
}

export function clipEnd(clip: Clip): number {
  return clip.startSec + clip.durationSec;
}

/** The clip under `timeSec` on this track, if any. */
export function clipAt(track: Track, timeSec: number): Clip | undefined {
  return trackClips(track).find((c) => timeSec >= c.startSec && timeSec < clipEnd(c));
}

/** Session length = the end of the last clip on any track. */
/**
 * Name the session.
 *
 * Nothing used to: `createSession` said 'Untitled' and no code path ever
 * changed it, which is why every row in the mastering list read "Untitled
 * Session.wav" and two different songs were indistinguishable in it.
 *
 * Blank and whitespace-only names are refused rather than stored, because a
 * nameless session is the problem this exists to solve.
 */
export function renameSession(session: DawSession, name: string): DawSession {
  const trimmed = name.trim();
  return trimmed.length === 0 ? session : { ...session, name: trimmed };
}

/** Whether the session still has the name it was born with. */
export function isUntitled(session: DawSession): boolean {
  const name = session.name.trim();
  return name.length === 0 || name === DEFAULT_SESSION_NAME || name === 'Untitled';
}

export function sessionEndSec(session: DawSession): number {
  let end = 0;
  for (const t of session.tracks) {
    // A Track Delay moves when the clips SOUND, and the end of the song is
    // when the last sound stops — not when the last rectangle stops being
    // drawn.  Without this a track pushed 200 ms late loses its tail in every
    // bounce and stem, and only that track.
    const shift = scheduleShiftSec(t);
    for (const c of trackClips(t)) end = Math.max(end, clipEnd(c) + shift);
  }
  return end;
}

// ── Generic track / clip updates ──────────────────────────────────────────────

export function updateTrack(
  session: DawSession, id: TrackId, fn: (t: Track) => Track,
): DawSession {
  let changed = false;
  const tracks = session.tracks.map((t) => {
    if (t.id !== id) return t;
    const next = fn(t);
    if (next !== t) changed = true;
    return next;
  });
  return changed ? { ...session, tracks } : session;
}

/** Apply `fn` to the track's ACTIVE playlist clips. */
export function updateClips(
  session: DawSession, trackId: TrackId, fn: (clips: Clip[]) => Clip[],
): DawSession {
  return updateTrack(session, trackId, (t) => {
    const pl = activePlaylist(t);
    if (!pl) return t;
    const clips = fn(pl.clips);
    if (clips === pl.clips) return t;
    return {
      ...t,
      playlists: t.playlists.map((p) => (p.id === pl.id ? { ...p, clips: sortClips(clips) } : p)),
    };
  });
}

export function sortClips(clips: Clip[]): Clip[] {
  return [...clips].sort((a, b) => a.startSec - b.startSec);
}

export function updateClip(
  session: DawSession, trackId: TrackId, clipId: ClipId, fn: (c: Clip) => Clip,
): DawSession {
  return updateClips(session, trackId, (clips) =>
    clips.map((c) => (c.id === clipId ? fn(c) : c)));
}

// ── Track management ──────────────────────────────────────────────────────────

export function addTrack(session: DawSession, track: Track, atIndex?: number): DawSession {
  const tracks = [...session.tracks];
  // Master always stays last, like the far-right strip in a console.
  const masterIndex = tracks.findIndex((t) => t.kind === 'master');
  const limit = masterIndex === -1 ? tracks.length : masterIndex;
  const index = atIndex === undefined ? limit : Math.min(atIndex, limit);
  tracks.splice(index, 0, track);
  return { ...session, tracks };
}

export function removeTrack(session: DawSession, id: TrackId): DawSession {
  const target = findTrack(session, id);
  if (!target || target.kind === 'master') return session;
  return {
    ...session,
    tracks: session.tracks
      .filter((t) => t.id !== id)
      // Drop dangling VCA assignments and group memberships.
      .map((t) => (t.vcaId === id ? { ...t, vcaId: null } : t)),
    groups: session.groups.map((g) =>
      g.memberIds.includes(id) ? { ...g, memberIds: g.memberIds.filter((m) => m !== id) } : g),
  };
}

export function moveTrack(session: DawSession, id: TrackId, toIndex: number): DawSession {
  const from = session.tracks.findIndex((t) => t.id === id);
  if (from === -1) return session;
  const tracks = [...session.tracks];
  const [moved] = tracks.splice(from, 1);
  if (!moved) return session;
  const masterIndex = tracks.findIndex((t) => t.kind === 'master');
  const limit = masterIndex === -1 ? tracks.length : masterIndex;
  tracks.splice(Math.max(0, Math.min(toIndex, limit)), 0, moved);
  return { ...session, tracks };
}

// ── Inserts / sends ───────────────────────────────────────────────────────────

export function createInsert(slot: number, pluginId: string, label: string, over: Partial<Insert> = {}): Insert {
  return {
    id: nextId('ins'), slot, pluginId, label,
    bypass: false, latencySamples: 0, params: {}, sidechainSource: null,
    ...over,
  };
}

export function setInsert(session: DawSession, trackId: TrackId, insert: Insert): DawSession {
  if (insert.slot < 0 || insert.slot >= INSERT_SLOTS) return session;
  return updateTrack(session, trackId, (t) => ({
    ...t,
    inserts: [...t.inserts.filter((i) => i.slot !== insert.slot), insert].sort((a, b) => a.slot - b.slot),
  }));
}

export function removeInsert(session: DawSession, trackId: TrackId, slot: number): DawSession {
  return updateTrack(session, trackId, (t) => ({
    ...t, inserts: t.inserts.filter((i) => i.slot !== slot),
  }));
}

export function createSend(slot: number, target: BusId, over: Partial<Send> = {}): Send {
  return {
    id: nextId('snd'), slot, target,
    levelDb: -Infinity, pan: 0, preFader: false, mute: false,
    ...over,
  };
}

export function setSend(session: DawSession, trackId: TrackId, send: Send): DawSession {
  if (send.slot < 0 || send.slot >= SEND_SLOTS) return session;
  return updateTrack(session, trackId, (t) => ({
    ...t,
    sends: [...t.sends.filter((s) => s.slot !== send.slot), send].sort((a, b) => a.slot - b.slot),
  }));
}

export function removeSend(session: DawSession, trackId: TrackId, slot: number): DawSession {
  return updateTrack(session, trackId, (t) => ({
    ...t, sends: t.sends.filter((s) => s.slot !== slot),
  }));
}

export function setOutput(session: DawSession, trackId: TrackId, output: OutputTarget): DawSession {
  return updateTrack(session, trackId, (t) => ({ ...t, output }));
}

// ── Files ─────────────────────────────────────────────────────────────────────

export function addFile(session: DawSession, file: AudioFileRef): DawSession {
  if (session.files.some((f) => f.id === file.id)) return session;
  return { ...session, files: [...session.files, file] };
}

// ── Groups ────────────────────────────────────────────────────────────────────

export function createGroup(name: string, symbol: string, memberIds: TrackId[]): GroupDef {
  return {
    id: nextId('grp'), name, symbol, memberIds, enabled: true,
    linkVolume: true, linkMute: true, linkSolo: true, linkPan: false,
  };
}

export function addGroup(session: DawSession, group: GroupDef): DawSession {
  return {
    ...session,
    groups: [...session.groups, group],
    tracks: session.tracks.map((t) =>
      group.memberIds.includes(t.id) && !t.groupIds.includes(group.id)
        ? { ...t, groupIds: [...t.groupIds, group.id] }
        : t),
  };
}

export function removeGroup(session: DawSession, groupId: string): DawSession {
  return {
    ...session,
    groups: session.groups.filter((g) => g.id !== groupId),
    tracks: session.tracks.map((t) =>
      t.groupIds.includes(groupId) ? { ...t, groupIds: t.groupIds.filter((g) => g !== groupId) } : t),
  };
}

// ── Chord track ───────────────────────────────────────────────────────────────

export function setChordTrack(session: DawSession, events: ChordEvent[]): DawSession {
  return { ...session, chordTrack: [...events].sort((a, b) => a.timeSec - b.timeSec) };
}

export function addChordEvent(session: DawSession, timeSec: number, chord: ChordSymbol): DawSession {
  const events = session.chordTrack.filter((e) => Math.abs(e.timeSec - timeSec) > 1e-6);
  return setChordTrack(session, [...events, { id: nextId('chord'), timeSec, chord }]);
}

export function removeChordEvent(session: DawSession, id: string): DawSession {
  return { ...session, chordTrack: session.chordTrack.filter((e) => e.id !== id) };
}

// ── Automation lanes ──────────────────────────────────────────────────────────

export function addLane(session: DawSession, trackId: TrackId, lane: AutomationLane): DawSession {
  return updateTrack(session, trackId, (t) => ({ ...t, automation: [...t.automation, lane] }));
}

export function updateLane(
  session: DawSession, trackId: TrackId, laneId: string, fn: (l: AutomationLane) => AutomationLane,
): DawSession {
  return updateTrack(session, trackId, (t) => ({
    ...t,
    automation: t.automation.map((l) => (l.id === laneId ? fn(l) : l)),
  }));
}
