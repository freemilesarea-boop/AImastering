// Playlists, takes and comping.
//
// A track owns N playlists (take lanes); one is active and is what you hear.
// Comping is: pick a range from an alternate lane, drop it into the active
// lane, repeat until the performance is the best of every take.
//
// `compRange` is the whole feature in one pure function — it separates the
// target range, removes what was there, and drops in the source's audio
// trimmed to exactly that range.

import { activePlaylist, createPlaylist, sortClips, updateTrack, findTrack } from '../model/session-ops.js';
import { clipEnd } from '../model/session-ops.js';
import { nextId } from '../model/ids.js';
import type { Clip, DawSession, PlaylistId, Track, TrackId } from '../model/types.js';
import { trimClipStart, trimClipEnd, type TimeSelection, hasRange } from './clip-edit.js';

const EPS = 1e-6;

// ── Playlist management ───────────────────────────────────────────────────────

/** New empty take lane, named like Pro Tools' "Vox.02". */
export function addPlaylist(session: DawSession, trackId: TrackId, activate = true): DawSession {
  return updateTrack(session, trackId, (t) => {
    const index = t.playlists.length + 1;
    const playlist = createPlaylist(`${t.name}.${String(index).padStart(2, '0')}`);
    return {
      ...t,
      playlists: [...t.playlists, playlist],
      activePlaylistId: activate ? playlist.id : t.activePlaylistId,
    };
  });
}

/** Duplicate the active lane — the safe way to start comping. */
export function duplicatePlaylist(session: DawSession, trackId: TrackId): DawSession {
  return updateTrack(session, trackId, (t) => {
    const current = t.playlists.find((p) => p.id === t.activePlaylistId);
    if (!current) return t;
    const copy = {
      id: nextId('pl'),
      name: `${current.name}.dup`,
      clips: current.clips.map((c) => ({ ...c, id: nextId('clip') })),
    };
    return { ...t, playlists: [...t.playlists, copy], activePlaylistId: copy.id };
  });
}

export function setActivePlaylist(
  session: DawSession, trackId: TrackId, playlistId: PlaylistId,
): DawSession {
  return updateTrack(session, trackId, (t) =>
    (t.playlists.some((p) => p.id === playlistId) ? { ...t, activePlaylistId: playlistId } : t));
}

export function removePlaylist(
  session: DawSession, trackId: TrackId, playlistId: PlaylistId,
): DawSession {
  return updateTrack(session, trackId, (t) => {
    if (t.playlists.length <= 1) return t;                       // always keep one
    const playlists = t.playlists.filter((p) => p.id !== playlistId);
    const active = t.activePlaylistId === playlistId
      ? playlists[0]?.id ?? t.activePlaylistId
      : t.activePlaylistId;
    return { ...t, playlists, activePlaylistId: active };
  });
}

/** Step to the next / previous take lane (Ctrl+↑/↓ in Pro Tools). */
export function cyclePlaylist(session: DawSession, trackId: TrackId, direction: 1 | -1): DawSession {
  return updateTrack(session, trackId, (t) => {
    if (t.playlists.length < 2) return t;
    const index = t.playlists.findIndex((p) => p.id === t.activePlaylistId);
    const nextIndex = (index + direction + t.playlists.length) % t.playlists.length;
    const target = t.playlists[nextIndex];
    return target ? { ...t, activePlaylistId: target.id } : t;
  });
}

// ── Comping ───────────────────────────────────────────────────────────────────

/** The portion of `clips` inside [start, end], trimmed to those edges. */
export function sliceClips(clips: readonly Clip[], startSec: number, endSec: number): Clip[] {
  const out: Clip[] = [];
  for (const c of clips) {
    if (clipEnd(c) <= startSec + EPS || c.startSec >= endSec - EPS) continue;
    let piece: Clip = { ...c, id: nextId('clip') };
    if (piece.startSec < startSec) piece = trimClipStart(piece, startSec);
    if (clipEnd(piece) > endSec)   piece = trimClipEnd(piece, endSec);
    out.push(piece);
  }
  return out;
}

/**
 * Copy a range from `sourcePlaylistId` into the track's active playlist —
 * "Copy Selection to Main Playlist".  Whatever was in the range is replaced.
 */
export function compRange(
  session: DawSession,
  trackId: TrackId,
  sourcePlaylistId: PlaylistId,
  sel: TimeSelection,
): DawSession {
  if (!hasRange(sel)) return session;
  return updateTrack(session, trackId, (t) => {
    const source = t.playlists.find((p) => p.id === sourcePlaylistId);
    const target = activePlaylist(t);
    if (!source || !target || source.id === target.id) return t;

    const incoming = sliceClips(source.clips, sel.startSec, sel.endSec);
    if (incoming.length === 0 && !target.clips.some((c) => overlaps(c, sel))) return t;

    const kept: Clip[] = [];
    for (const c of target.clips) {
      if (!overlaps(c, sel)) { kept.push(c); continue; }
      // Keep the parts of the existing clip outside the comped range.
      if (c.startSec < sel.startSec) kept.push(trimClipEnd({ ...c }, sel.startSec));
      if (clipEnd(c) > sel.endSec)   kept.push(trimClipStart({ ...c, id: nextId('clip') }, sel.endSec));
    }

    return {
      ...t,
      playlists: t.playlists.map((p) =>
        (p.id === target.id ? { ...p, clips: sortClips([...kept, ...incoming]) } : p)),
    };
  });
}

function overlaps(c: Clip, sel: TimeSelection): boolean {
  return clipEnd(c) > sel.startSec + EPS && c.startSec < sel.endSec - EPS;
}

/** Take lanes other than the active one — what the Edit window shows expanded. */
export function alternateLanes(track: Track): Track['playlists'] {
  return track.playlists.filter((p) => p.id !== track.activePlaylistId);
}

/**
 * Flatten every alternate lane away once the comp is final, leaving only the
 * active playlist ("Commit comp").
 */
export function flattenComp(session: DawSession, trackId: TrackId): DawSession {
  return updateTrack(session, trackId, (t) => {
    const active = activePlaylist(t);
    if (!active || t.playlists.length === 1) return t;
    return { ...t, playlists: [active], activePlaylistId: active.id };
  });
}

/** Take count for the track header readout. */
export function takeCount(session: DawSession, trackId: TrackId): number {
  return findTrack(session, trackId)?.playlists.length ?? 0;
}
