// clip-pool.ts — every file the session holds, and what became of it.
//
// Pro Tools calls it the Clip List, Cubase the Pool.  The job is the same: a
// session accumulates files, and after an hour of editing nobody can answer
// the questions that matter about them.  Which of these forty takes am I
// actually using?  Where did this one come from?  Why is the project folder
// 8 GB when the song is three minutes long?
//
// The answers are all derivable from the session — no bookkeeping, no second
// list to keep in step with the first.  That is the whole design: this module
// READS, and the only thing it changes is removing files nothing points at.
//
// Two facts a pool has to get right, because they are the ones people act on:
//
//   • USED vs UNUSED.  A file with no clip referencing it is dead weight, and
//     "delete unused" is the button that makes a session portable.  Counting
//     only the ACTIVE playlist would call a file unused when an alternate take
//     still needs it — and deleting that is unrecoverable.
//   • MISSING.  A file the session references that is not on disk any more.
//     The pool cannot check the filesystem itself (it is pure), so it takes
//     the set of paths the caller found and reports the difference.

import type { Clip, DawSession, FileId, TrackId } from './types.js';
import { trackClips } from './session-ops.js';

/** Where one clip that uses a file lives. */
export interface PoolUse {
  trackId: TrackId;
  trackName: string;
  clipId: string;
  clipName: string;
  startSec: number;
  /** False when the clip is on an alternate playlist rather than the live one. */
  active: boolean;
}

export interface PoolEntry {
  fileId: FileId;
  name: string;
  path: string;
  durationSec: number;
  sampleRate: number;
  channels: number;
  /** Every clip pointing at this file, across every playlist. */
  uses: PoolUse[];
  /** Uses on the ACTIVE playlist — what you hear right now. */
  activeUses: number;
  /** Total seconds of this file the session actually plays. */
  usedSec: number;
  /** True when nothing at all references it. */
  unused: boolean;
  /** True when the caller says the path is not on disk. */
  missing: boolean;
}

export interface PoolOptions {
  /**
   * Paths the caller has confirmed exist.  Absent means "do not know", and
   * nothing is reported missing — an empty set would otherwise claim every
   * file is gone the moment a caller forgot to pass it.
   */
  existingPaths?: ReadonlySet<string>;
}

/**
 * Every file in the session, with what uses it.
 *
 * Walks EVERY playlist, not just the active one: a take you comped away from
 * still needs its file, and calling it unused is how somebody deletes the
 * vocal they were going to go back to.
 */
export function buildPool(session: DawSession, options: PoolOptions = {}): PoolEntry[] {
  const uses = new Map<FileId, PoolUse[]>();

  for (const track of session.tracks) {
    const activeId = track.activePlaylistId;
    for (const playlist of track.playlists) {
      const active = playlist.id === activeId;
      for (const clip of playlist.clips) {
        if (clip.kind !== 'audio') continue;
        const list = uses.get(clip.fileId) ?? [];
        list.push({
          trackId: track.id,
          trackName: track.name,
          clipId: clip.id,
          clipName: clip.name,
          startSec: clip.startSec,
          active,
        });
        uses.set(clip.fileId, list);
      }
    }
  }

  return session.files.map((file) => {
    const list = (uses.get(file.id) ?? []).sort((a, b) => a.startSec - b.startSec);
    const activeUses = list.filter((u) => u.active).length;
    return {
      fileId: file.id,
      name: file.name,
      path: file.path,
      durationSec: file.durationSec,
      sampleRate: file.sampleRate,
      channels: file.channels,
      uses: list,
      activeUses,
      usedSec: usedSecondsOf(session, file.id),
      unused: list.length === 0,
      missing: options.existingPaths ? !options.existingPaths.has(file.path) : false,
    };
  });
}

/**
 * How much of a file the session plays, counting overlaps once.
 *
 * Summing clip durations would double-count a phrase used twice, and the
 * number people want is "how much of this file matters" — for deciding what a
 * consolidate would save.
 */
function usedSecondsOf(session: DawSession, fileId: FileId): number {
  const spans: Array<[number, number]> = [];
  for (const track of session.tracks) {
    for (const playlist of track.playlists) {
      for (const clip of playlist.clips) {
        if (clip.kind !== 'audio' || clip.fileId !== fileId) continue;
        spans.push([clip.offsetSec, clip.offsetSec + clip.durationSec]);
      }
    }
  }
  if (spans.length === 0) return 0;
  spans.sort((a, b) => a[0] - b[0]);
  let total = 0;
  let [start, end] = spans[0] as [number, number];
  for (let i = 1; i < spans.length; i++) {
    const [s, e] = spans[i] as [number, number];
    if (s <= end) end = Math.max(end, e);
    else { total += end - start; start = s; end = e; }
  }
  return total + (end - start);
}

// ── Searching and sorting ───────────────────────────────────────────────────

export type PoolSort = 'name' | 'duration' | 'uses' | 'unused-first';

export type PoolFilter = 'all' | 'used' | 'unused' | 'missing';

export const POOL_FILTER_LABELS: Record<PoolFilter, string> = {
  all: '전체', used: '쓰는 것', unused: '안 쓰는 것', missing: '없어진 파일',
};

/**
 * Filter and sort the pool.
 *
 * The search matches the file name AND the names of the clips made from it,
 * because people remember "the one I called chorus double" more often than
 * they remember `audio_04_bounced.wav`.
 */
export function queryPool(
  entries: readonly PoolEntry[],
  { search = '', filter = 'all' as PoolFilter, sort = 'name' as PoolSort } = {},
): PoolEntry[] {
  const needle = search.trim().toLowerCase();
  const matched = entries.filter((e) => {
    if (filter === 'used' && e.unused) return false;
    if (filter === 'unused' && !e.unused) return false;
    if (filter === 'missing' && !e.missing) return false;
    if (needle === '') return true;
    return e.name.toLowerCase().includes(needle)
      || e.path.toLowerCase().includes(needle)
      || e.uses.some((u) => u.clipName.toLowerCase().includes(needle)
                         || u.trackName.toLowerCase().includes(needle));
  });

  const byName = (a: PoolEntry, b: PoolEntry): number => a.name.localeCompare(b.name);
  return [...matched].sort((a, b) => {
    switch (sort) {
      case 'duration':     return b.durationSec - a.durationSec || byName(a, b);
      case 'uses':         return b.uses.length - a.uses.length || byName(a, b);
      // Unused first is what you sort by when you are about to clean up.
      case 'unused-first': return Number(b.unused) - Number(a.unused) || byName(a, b);
      default:             return byName(a, b);
    }
  });
}

// ── Cleaning up ─────────────────────────────────────────────────────────────

export interface PoolSummary {
  files: number;
  unused: number;
  missing: number;
  /** Total length of every file, used or not. */
  totalSec: number;
  /** Total length of the files nothing references. */
  unusedSec: number;
}

export function summarisePool(entries: readonly PoolEntry[]): PoolSummary {
  let unused = 0, missing = 0, totalSec = 0, unusedSec = 0;
  for (const e of entries) {
    totalSec += e.durationSec;
    if (e.unused) { unused++; unusedSec += e.durationSec; }
    if (e.missing) missing++;
  }
  return { files: entries.length, unused, missing, totalSec, unusedSec };
}

/**
 * Drop files nothing references.
 *
 * Recomputes the pool rather than trusting a list handed in: the caller's
 * pool may have been built before an edit, and removing a file that has since
 * been used again breaks every clip made from it.  Cheap insurance against
 * the one mistake in this module that cannot be undone by hand.
 */
export function removeUnusedFiles(session: DawSession): DawSession {
  const dead = new Set(buildPool(session).filter((e) => e.unused).map((e) => e.fileId));
  if (dead.size === 0) return session;
  return { ...session, files: session.files.filter((f) => !dead.has(f.id)) };
}

/** The clips made from one file, for "show me where this is used". */
export function clipsOfFile(session: DawSession, fileId: FileId): Array<{ trackId: TrackId; clip: Clip }> {
  const out: Array<{ trackId: TrackId; clip: Clip }> = [];
  for (const track of session.tracks) {
    for (const clip of trackClips(track)) {
      if (clip.kind === 'audio' && clip.fileId === fileId) out.push({ trackId: track.id, clip });
    }
  }
  return out;
}

export function describePool(summary: PoolSummary): string {
  const mins = (s: number): string => `${Math.floor(s / 60)}분 ${Math.round(s % 60)}초`;
  const parts = [`파일 ${summary.files}개 · ${mins(summary.totalSec)}`];
  if (summary.unused > 0) parts.push(`안 쓰는 것 ${summary.unused}개 (${mins(summary.unusedSec)})`);
  if (summary.missing > 0) parts.push(`없어진 파일 ${summary.missing}개`);
  return parts.join(' · ');
}
