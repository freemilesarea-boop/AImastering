// Track Stacks — folders that behave like one channel.
//
//   VOCALS            ← the stack
//    ├ Lead
//    ├ Double L
//    ├ Double R
//    ├ Harmony
//    └ Adlib
//
// Two kinds, matching the reference DAW:
//
//   • Folder stack   — organisation only.  Children keep their own outputs;
//     the folder's mute/solo/fader still govern them (like a VCA that also
//     collapses in the arrange window).
//   • Summing stack  — the folder OWNS a bus.  Children output into it and
//     the folder becomes a real channel, so one compressor on the stack
//     processes the whole group.  This is what makes a 40-track session
//     workable.
//
// Everything is pure and immutable, like the rest of the model.

import { addTrack, createBus, createTrack, findTrack, updateTrack } from './session-ops.js';
import type { BusDef, DawSession, Track, TrackId } from './types.js';

export type StackKind = 'folder' | 'summing';

export function isStack(track: Track): boolean {
  return track.kind === 'folder';
}

/** True for a stack that sums its children through a bus. */
export function isSummingStack(track: Track): boolean {
  return track.kind === 'folder' && track.input !== null;
}

/** Direct children of a stack, in session order. */
export function stackChildren(session: DawSession, folderId: TrackId): Track[] {
  return session.tracks.filter((t) => t.parentId === folderId);
}

/** Children, grandchildren and so on. */
export function stackDescendants(session: DawSession, folderId: TrackId): Track[] {
  const out: Track[] = [];
  const walk = (id: TrackId): void => {
    for (const child of stackChildren(session, id)) {
      out.push(child);
      if (child.kind === 'folder') walk(child.id);
    }
  };
  walk(folderId);
  return out;
}

/** Ancestor chain, nearest first.  Cycles are cut rather than followed. */
export function stackAncestors(session: DawSession, trackId: TrackId): Track[] {
  const out: Track[] = [];
  const seen = new Set<TrackId>([trackId]);
  let current = findTrack(session, trackId)?.parentId ?? null;
  while (current && !seen.has(current)) {
    const parent = findTrack(session, current);
    if (!parent) break;
    out.push(parent);
    seen.add(parent.id);
    current = parent.parentId;
  }
  return out;
}

export function stackDepth(session: DawSession, trackId: TrackId): number {
  return stackAncestors(session, trackId).length;
}

/** Would parenting `trackId` under `folderId` create a loop? */
export function wouldNest(session: DawSession, trackId: TrackId, folderId: TrackId): boolean {
  if (trackId === folderId) return true;
  return stackAncestors(session, folderId).some((t) => t.id === trackId);
}

// ── Creating ──────────────────────────────────────────────────────────────────

export interface CreateStackResult {
  session: DawSession;
  folderId: TrackId;
  busId: string | null;
}

/**
 * Wrap the given tracks in a stack.
 *
 * The folder is inserted where the topmost member was, so the arrangement
 * does not reshuffle under the user, and the members move directly beneath
 * it in their original order.
 */
export function createStack(
  session: DawSession, name: string, memberIds: readonly TrackId[], kind: StackKind = 'summing',
): CreateStackResult {
  const members = memberIds
    .map((id) => findTrack(session, id))
    .filter((t): t is Track => Boolean(t) && t!.kind !== 'master');
  if (members.length === 0) return { session, folderId: '', busId: null };

  let bus: BusDef | null = null;
  let next = session;

  if (kind === 'summing') {
    bus = createBus(`${name} Bus`);
    next = { ...next, buses: [...next.buses, bus] };
  }

  const folder = createTrack(name, 'folder', {
    input: bus ? bus.id : null,
    output: bus ? { kind: 'master' } : { kind: 'none' },
    color: members[0]?.color ?? '#6f6fd6',
  });

  // Where the first member sits today.
  const firstIndex = next.tracks.findIndex((t) => t.id === members[0]?.id);
  next = addTrack(next, folder, firstIndex === -1 ? undefined : firstIndex);

  // Re-parent, and for a summing stack point the members at the bus.
  for (const member of members) {
    next = updateTrack(next, member.id, (t) => ({
      ...t,
      parentId: folder.id,
      ...(bus ? { output: { kind: 'bus' as const, busId: bus.id } } : {}),
    }));
  }

  next = reorderStack(next, folder.id);
  return { session: next, folderId: folder.id, busId: bus?.id ?? null };
}

/** Move a stack's members so they sit directly under their folder. */
export function reorderStack(session: DawSession, folderId: TrackId): DawSession {
  const folderIndex = session.tracks.findIndex((t) => t.id === folderId);
  if (folderIndex === -1) return session;

  const descendants = stackDescendants(session, folderId);
  if (descendants.length === 0) return session;
  const descendantIds = new Set(descendants.map((t) => t.id));

  const rest = session.tracks.filter((t) => !descendantIds.has(t.id));
  const insertAt = rest.findIndex((t) => t.id === folderId) + 1;
  const tracks = [...rest.slice(0, insertAt), ...descendants, ...rest.slice(insertAt)];
  return { ...session, tracks };
}

/**
 * Dissolve a stack.  Children keep their audio: a summing stack's members go
 * back to the master so nothing goes silent when the bus disappears.
 */
export function unpackStack(session: DawSession, folderId: TrackId): DawSession {
  const folder = findTrack(session, folderId);
  if (!folder || folder.kind !== 'folder') return session;
  const children = stackChildren(session, folderId);

  let next = session;
  for (const child of children) {
    next = updateTrack(next, child.id, (t) => ({
      ...t,
      parentId: folder.parentId,
      ...(folder.input && t.output.kind === 'bus' && t.output.busId === folder.input
        ? { output: { kind: 'master' as const } }
        : {}),
    }));
  }
  return {
    ...next,
    tracks: next.tracks.filter((t) => t.id !== folderId),
    buses: folder.input ? next.buses.filter((b) => b.id !== folder.input) : next.buses,
  };
}

/** Move a track into a stack (or out of one when `folderId` is null). */
export function setParent(
  session: DawSession, trackId: TrackId, folderId: TrackId | null,
): DawSession {
  if (folderId && wouldNest(session, trackId, folderId)) return session;
  const folder = folderId ? findTrack(session, folderId) : null;
  let next = updateTrack(session, trackId, (t) => ({
    ...t,
    parentId: folderId,
    ...(folder?.input ? { output: { kind: 'bus' as const, busId: folder.input } } : {}),
  }));
  if (folderId) next = reorderStack(next, folderId);
  return next;
}

export function toggleCollapsed(session: DawSession, folderId: TrackId): DawSession {
  return updateTrack(session, folderId, (t) => ({ ...t, collapsed: !t.collapsed }));
}

// ── Visibility ────────────────────────────────────────────────────────────────

/** Is this track hidden because an ancestor stack is collapsed? */
export function isHidden(session: DawSession, trackId: TrackId): boolean {
  const track = session.tracks.find((t) => t.id === trackId);
  // Hidden by its own flag, or folded away inside a collapsed stack.  Two
  // different reasons for the same answer, and every caller wants both.
  if (track?.hidden === true) return true;
  return stackAncestors(session, trackId).some((a) => a.collapsed);
}

/**
 * Hide or show tracks.
 *
 * Never the master: a session with no master row is one where the mix bus
 * cannot be reached, and "where did my master go" is a support question
 * rather than a feature.
 */
export function setTracksHidden(
  session: DawSession, trackIds: readonly TrackId[], hidden: boolean,
): DawSession {
  const wanted = new Set(trackIds);
  return {
    ...session,
    tracks: session.tracks.map((t) => (
      wanted.has(t.id) && t.kind !== 'master' ? { ...t, hidden } : t
    )),
  };
}

/** Bring everything back — the way out of having hidden too much. */
export function showAllTracks(session: DawSession): DawSession {
  if (!session.tracks.some((t) => t.hidden === true)) return session;
  return { ...session, tracks: session.tracks.map((t) => ({ ...t, hidden: false })) };
}

/** How many rows are hidden by their own flag, for the toolbar readout. */
export function hiddenCount(session: DawSession): number {
  return session.tracks.filter((t) => t.hidden === true).length;
}

/** The rows the arrange window should draw, in order. */
export function visibleTracks(session: DawSession): Track[] {
  return session.tracks.filter((t) => !isHidden(session, t.id));
}

/**
 * Clips of a collapsed stack's children, for the merged overview a collapsed
 * folder row shows instead of an empty lane.
 */
export function collapsedOverviewClips(session: DawSession, folderId: TrackId): Array<{
  trackColor: string;
  startSec: number;
  endSec: number;
}> {
  const out: Array<{ trackColor: string; startSec: number; endSec: number }> = [];
  for (const child of stackDescendants(session, folderId)) {
    const playlist = child.playlists.find((p) => p.id === child.activePlaylistId);
    for (const clip of playlist?.clips ?? []) {
      out.push({
        trackColor: child.color,
        startSec: clip.startSec,
        endSec: clip.startSec + clip.durationSec,
      });
    }
  }
  return out.sort((a, b) => a.startSec - b.startSec);
}

/** Summary for a collapsed row: "5 tracks · 12 clips". */
export function stackSummary(session: DawSession, folderId: TrackId): string {
  const children = stackDescendants(session, folderId);
  const clips = children.reduce((sum, t) => {
    const playlist = t.playlists.find((p) => p.id === t.activePlaylistId);
    return sum + (playlist?.clips.length ?? 0);
  }, 0);
  return `${children.length}개 트랙 · ${clips}개 클립`;
}
