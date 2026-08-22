// The timeline clipboard — copy, cut, paste.
//
// The editing verbs that were already here could separate a range, clear it,
// trim to it and duplicate it in place.  What none of them could do is move
// a passage somewhere ELSE, which is the first thing anybody tries.
//
// Four decisions carry this file.
//
// CLIPS ARE CROPPED AND REBASED.  What goes on the clipboard is not "these
// clip objects" but "what was sounding in this range": a clip that starts
// before the selection is copied from the selection's edge, at the right
// offset into its source file.  Copy the middle of a take and you get the
// middle of the take, not the whole take with instructions.
//
// EMPTY LANES ARE KEPT.  A range copied across four tracks makes four lanes
// even when track 2 was silent.  Dropping the empty one would shift every
// lane after it onto the wrong target, and the result — a bass line pasted
// onto the vocal track — is the kind of wrong that is hard to see and easy to
// build on.
//
// THE FILES COME ALONG.  A clip is a reference to an `AudioFileRef` by id, so
// a clipboard of bare clips pasted into another session points at nothing.
// The refs travel with the clips and paste re-adds the ones the target does
// not have.
//
// IDS ARE REGENERATED ON PASTE, NOT ON COPY.  Copy once, paste five times,
// five distinct clips — and the clipboard itself stays a value that can be
// pasted again.

import { clipEnd, sortClips, trackClips, updateClips, findTrack } from '../model/session-ops.js';
import { EMPTY_SELECTION, hasRange, selectionLength, trimClipEnd, trimClipStart, type TimeSelection } from './clip-edit.js';
import { nextId } from '../model/ids.js';
import type { AudioFileRef, Clip, DawSession, TrackId } from '../model/types.js';

const EPS = 1e-6;

/** One source track's worth of the copied range.  May be empty. */
export interface ClipboardLane {
  /** Clips in LOCAL time — 0 is the start of the copied range. */
  clips: Clip[];
  /** What the lane was called, for the paste report. */
  sourceName: string;
}

export interface EditClipboard {
  lanes: ClipboardLane[];
  lengthSec: number;
  /** Every file the clips reference, so a paste elsewhere is not dangling. */
  files: AudioFileRef[];
  /** Where it came from — lets "paste in place" land back on the same tracks. */
  sourceTrackIds: TrackId[];
}

export function isEmptyClipboard(clipboard: EditClipboard | null): boolean {
  return !clipboard || clipboard.lanes.every((lane) => lane.clips.length === 0);
}

// ── Copy ──────────────────────────────────────────────────────────────────────

/**
 * Crop one clip to a range and rebase it so the range starts at zero.
 *
 * `offsetSec` moves with the crop — that is what makes a partial copy play the
 * right part of the file rather than the beginning of it.
 */
function cropToRange(clip: Clip, startSec: number, endSec: number): Clip | null {
  if (clipEnd(clip) <= startSec + EPS || clip.startSec >= endSec - EPS) return null;
  let out = clip;
  if (out.startSec < startSec) out = trimClipStart(out, startSec);
  if (clipEnd(out) > endSec) out = trimClipEnd(out, endSec);
  if (out.durationSec <= EPS) return null;
  return { ...out, startSec: out.startSec - startSec };
}

/**
 * What is sounding in the selection, as a value.
 *
 * Returns null for a selection with no range rather than an empty clipboard,
 * so a stray Cmd+C on a click (not a drag) leaves whatever was already copied
 * alone instead of silently emptying it.
 */
export function copyRange(session: DawSession, sel: TimeSelection): EditClipboard | null {
  if (!hasRange(sel)) return null;

  const lanes: ClipboardLane[] = [];
  const fileIds = new Set<string>();

  for (const trackId of sel.trackIds) {
    const track = findTrack(session, trackId);
    const clips: Clip[] = [];
    if (track) {
      for (const clip of sortClips(trackClips(track))) {
        const cropped = cropToRange(clip, sel.startSec, sel.endSec);
        if (!cropped) continue;
        clips.push(cropped);
        if (cropped.fileId) fileIds.add(cropped.fileId);
      }
    }
    // Pushed even when empty — see the header.
    lanes.push({ clips, sourceName: track?.name ?? '트랙' });
  }

  return {
    lanes,
    lengthSec: selectionLength(sel),
    files: session.files.filter((f) => fileIds.has(f.id)),
    sourceTrackIds: [...sel.trackIds],
  };
}

// ── Ripple ────────────────────────────────────────────────────────────────────

/**
 * Push everything at or after `fromSec` by `deltaSec` on the named tracks.
 *
 * Shared by paste-insert and insert-silence because they are the same edit
 * seen from two sides: one puts audio in the hole it opens, the other leaves
 * it empty.  A clip STRADDLING the point is split first — stretching it would
 * change how it sounds, and moving it whole would leave a gap in the wrong
 * place.
 *
 * A NEGATIVE delta closes a gap instead, and there splitting would be wrong:
 * the back half would slide left into the front half.  Closing a gap is only
 * meaningful once the caller has emptied it, so a straddling clip is left
 * alone and the caller keeps responsibility for having made room.
 */
export function rippleTracks(
  session: DawSession, trackIds: readonly TrackId[], fromSec: number, deltaSec: number,
): DawSession {
  if (deltaSec === 0) return session;
  let out = session;
  for (const trackId of trackIds) {
    out = updateClips(out, trackId, (clips) => {
      const next: Clip[] = [];
      for (const clip of sortClips(clips)) {
        // Straddles the splice: cut it there, keep the front, move the back.
        if (deltaSec > 0 && fromSec > clip.startSec + EPS && fromSec < clipEnd(clip) - EPS) {
          const frontLength = fromSec - clip.startSec;
          next.push({ ...clip, durationSec: frontLength, id: clip.id });
          next.push({
            ...clip,
            id: nextId('clip'),
            startSec: Math.max(0, fromSec + deltaSec),
            offsetSec: clip.offsetSec + frontLength,
            durationSec: clip.durationSec - frontLength,
          });
          continue;
        }
        next.push(clip.startSec >= fromSec - EPS
          ? { ...clip, startSec: Math.max(0, clip.startSec + deltaSec) }
          : clip);
      }
      return next;
    });
  }
  return out;
}

/**
 * Open a silent gap.
 *
 * The counterpart to `clearRange(ripple)`, which closes one.  Every DAW has
 * both and having only the closing half is what makes "I need four more bars
 * here" impossible.
 */
export function insertSilence(
  session: DawSession, trackIds: readonly TrackId[], atSec: number, lengthSec: number,
): DawSession {
  if (lengthSec <= 0) return session;
  return rippleTracks(session, trackIds, Math.max(0, atSec), lengthSec);
}

// ── Paste ─────────────────────────────────────────────────────────────────────

export type PasteMode = 'overwrite' | 'insert';

export interface PasteResult {
  session: DawSession;
  /** Where the pasted material now sits, ready to be the new selection. */
  selection: TimeSelection;
  /** Lanes that had nowhere to go, and anything else worth saying. */
  problems: string[];
}

/**
 * Put the clipboard down at `atSec` on `targetTrackIds`.
 *
 * `overwrite` clears the landing range first — a paste that layered on top of
 * what was there would be a mix, not a paste.  `insert` ripples everything at
 * or after the point to the right and drops the material into the gap, so
 * nothing is lost.
 *
 * Lanes map onto targets in order.  Fewer targets than lanes is REPORTED
 * rather than silently truncated: quietly dropping the third of four tracks
 * is exactly the kind of loss nobody notices until the bounce.
 */
export function pasteAt(
  session: DawSession,
  clipboard: EditClipboard,
  atSec: number,
  targetTrackIds: readonly TrackId[],
  mode: PasteMode = 'overwrite',
): PasteResult {
  const problems: string[] = [];
  const start = Math.max(0, atSec);
  const end = start + clipboard.lengthSec;

  const targets = targetTrackIds.filter((id) => findTrack(session, id));
  if (targets.length === 0) {
    return {
      session,
      selection: EMPTY_SELECTION,
      problems: ['붙여넣을 트랙이 없습니다 — 트랙을 먼저 고르세요'],
    };
  }
  if (clipboard.lanes.length > targets.length) {
    const missed = clipboard.lanes.slice(targets.length).map((l) => l.sourceName);
    problems.push(`트랙이 모자라 ${missed.length}개를 붙이지 못했습니다: ${missed.slice(0, 3).join(', ')}`);
  }

  // The files first, or the pasted clips reference nothing.  Only the ones
  // this session does not already have — re-adding would duplicate the entry
  // and confuse the decode cache, which is keyed by id.
  let out = session;
  const have = new Set(session.files.map((f) => f.id));
  const incoming = clipboard.files.filter((f) => !have.has(f.id));
  if (incoming.length > 0) out = { ...out, files: [...out.files, ...incoming] };

  const used = targets.slice(0, clipboard.lanes.length);

  if (mode === 'insert') {
    out = rippleTracks(out, used, start, clipboard.lengthSec);
  } else {
    out = clearLanding(out, used, start, end);
  }

  clipboard.lanes.forEach((lane, index) => {
    const trackId = used[index];
    if (!trackId) return;
    if (lane.clips.length === 0) return;
    out = updateClips(out, trackId, (clips) => sortClips([
      ...clips,
      ...lane.clips.map((clip) => ({
        ...clip,
        // New identity per paste, so five pastes are five clips.
        id: nextId('clip'),
        startSec: clip.startSec + start,
      })),
    ]));
  });

  return {
    session: out,
    selection: { startSec: start, endSec: end, trackIds: [...used] },
    problems,
  };
}

/**
 * Make room for an overwrite paste.
 *
 * Written here rather than reusing `clearRange` because that one refuses a
 * zero-length selection and takes a `TimeSelection`; this is the same idea
 * with the ripple deliberately off.
 */
function clearLanding(
  session: DawSession, trackIds: readonly TrackId[], startSec: number, endSec: number,
): DawSession {
  if (endSec - startSec <= EPS) return session;
  let out = session;
  for (const trackId of trackIds) {
    out = updateClips(out, trackId, (clips) => {
      const next: Clip[] = [];
      for (const clip of sortClips(clips)) {
        if (clipEnd(clip) <= startSec + EPS || clip.startSec >= endSec - EPS) {
          next.push(clip);
          continue;
        }
        // Head that survives on the left.
        if (clip.startSec < startSec - EPS) {
          next.push(trimClipEnd(clip, startSec));
        }
        // Tail that survives on the right — a new id, because it is a new clip.
        if (clipEnd(clip) > endSec + EPS) {
          next.push({ ...trimClipStart(clip, endSec), id: nextId('clip') });
        }
      }
      return next;
    });
  }
  return out;
}

// ── Cut ───────────────────────────────────────────────────────────────────────

export interface CutResult {
  session: DawSession;
  clipboard: EditClipboard | null;
}

/**
 * Copy, then remove.
 *
 * `ripple` closes the gap the way `clearRange` does, which is what makes
 * cut-then-paste-insert a move rather than a copy plus a hole.
 */
export function cutRange(
  session: DawSession, sel: TimeSelection, ripple = false,
): CutResult {
  const clipboard = copyRange(session, sel);
  if (!clipboard) return { session, clipboard: null };
  const cleared = clearLanding(session, sel.trackIds, sel.startSec, sel.endSec);
  const out = ripple
    ? rippleTracks(cleared, sel.trackIds, sel.endSec, -selectionLength(sel))
    : cleared;
  return { session: out, clipboard };
}

// ── Describing ────────────────────────────────────────────────────────────────

/** `3 트랙 · 4.0초` — what is on the clipboard, for the status line. */
export function describeClipboard(clipboard: EditClipboard | null): string {
  if (isEmptyClipboard(clipboard)) return '복사된 것 없음';
  const lanes = clipboard!.lanes.filter((l) => l.clips.length > 0).length;
  return `${lanes} 트랙 · ${clipboard!.lengthSec.toFixed(1)}초`;
}

/** The clips a paste would produce, without pasting — for a preview. */
export function pastedClipCount(clipboard: EditClipboard | null): number {
  if (!clipboard) return 0;
  return clipboard.lanes.reduce((n, lane) => n + lane.clips.length, 0);
}
