// Play-head navigation — the Tab key.
//
// Tab moves to the next edit point on the selected tracks.  With Tab to
// Transient armed, the attacks inside the audio count as edit points too,
// which is how you land exactly on a snare hit without zooming in.
//
// Pure: the caller supplies the transient times per file (from the cache) so
// this module can be tested with synthetic data.

import { clipEnd, findTrack, trackClips } from '../model/session-ops.js';
import type { DawSession, FileId, TrackId } from '../model/types.js';
import { mergeMarks, nextAfter, prevBefore } from './transient.js';

export type TransientLookup = (fileId: FileId) => readonly number[];

/**
 * Every edit point on these tracks, in timeline seconds:
 * clip starts and ends, plus (optionally) transients mapped from file time
 * into timeline time through each clip's offset.
 */
export function editPoints(
  session: DawSession,
  trackIds: readonly TrackId[],
  tabToTransient: boolean,
  transients: TransientLookup,
): number[] {
  const boundaries: number[] = [];
  const attacks: number[] = [];

  for (const trackId of trackIds) {
    const track = findTrack(session, trackId);
    if (!track) continue;
    for (const clip of trackClips(track)) {
      boundaries.push(clip.startSec, clipEnd(clip));
      if (!tabToTransient) continue;
      for (const t of transients(clip.fileId)) {
        // File time → timeline time; keep only what this clip actually plays.
        const rel = t - clip.offsetSec;
        if (rel < 0 || rel > clip.durationSec) continue;
        attacks.push(clip.startSec + rel);
      }
    }
  }
  return mergeMarks(boundaries, attacks);
}

export interface TabResult {
  timeSec: number;
  /** What we landed on — shown in the toolbar readout. */
  kind: 'edit-point' | 'session-start' | 'session-end';
}

/** Next edit point after `fromSec`, or the session end when there is none. */
export function tabForward(points: readonly number[], fromSec: number, sessionEnd: number): TabResult {
  const next = nextAfter(points, fromSec);
  if (next !== null) return { timeSec: next, kind: 'edit-point' };
  return { timeSec: Math.max(fromSec, sessionEnd), kind: 'session-end' };
}

/** Previous edit point before `fromSec`, or 0. */
export function tabBackward(points: readonly number[], fromSec: number): TabResult {
  const prev = prevBefore(points, fromSec);
  if (prev !== null) return { timeSec: prev, kind: 'edit-point' };
  return { timeSec: 0, kind: 'session-start' };
}

/**
 * Extend the selection to the next edit point (Shift+Tab-style range
 * building) instead of moving the play head.
 */
export function extendToNextPoint(
  points: readonly number[], selection: { startSec: number; endSec: number }, direction: 1 | -1,
): { startSec: number; endSec: number } {
  if (direction === 1) {
    const next = nextAfter(points, selection.endSec);
    return next === null ? selection : { startSec: selection.startSec, endSec: next };
  }
  const prev = prevBefore(points, selection.startSec);
  return prev === null ? selection : { startSec: prev, endSec: selection.endSec };
}
