// Spot — put a clip exactly where it is told, not where the mouse let go.
//
// Two things make this more than "set startSec".
//
//   THE ANCHOR.  "The gunshot lands at 01:02:14:07" is about the END of a
//   clip as often as the start — a sound effect is usually spotted by the
//   moment inside it that has to hit, and the only two moments this app can
//   name without inventing a sync-point model are its ends.  Spotting by the
//   end means the start goes where the arithmetic puts it, which may be
//   before zero.
//
//   BEFORE ZERO IS NOT A POSITION.  Clamping silently would put the clip at
//   the top of the song and let the user believe the cue is spotted.  So it
//   is refused with the amount by which it missed, which is the number they
//   need in order to fix it (move the picture, or trim the head).

import { clipEnd, findTrack, trackClips } from '../model/session-ops.js';
import { moveClip } from './clip-edit.js';
import type { Clip, ClipId, DawSession, TrackId } from '../model/types.js';

export type SpotAnchor = 'start' | 'end';

export function anchorLabel(anchor: SpotAnchor): string {
  return anchor === 'start' ? '클립 시작' : '클립 끝';
}

export interface SpotResult {
  session: DawSession;
  /** Where the clip's START ended up. */
  startSec: number;
  applied: boolean;
  reason: string | null;
}

export function findClip(
  session: DawSession, trackId: TrackId, clipId: ClipId,
): Clip | undefined {
  const track = findTrack(session, trackId);
  return track ? trackClips(track).find((c) => c.id === clipId) : undefined;
}

/** Where the clip's anchor currently sits — what the dialog opens showing. */
export function anchorSec(clip: Clip, anchor: SpotAnchor): number {
  return anchor === 'start' ? clip.startSec : clipEnd(clip);
}

/**
 * Put `anchor` of the clip at `targetSec`.
 *
 * Returns the session unchanged, with a reason, when that would place the
 * clip before the start of the timeline.
 */
export function spotClip(
  session: DawSession, trackId: TrackId, clipId: ClipId,
  targetSec: number, anchor: SpotAnchor = 'start',
): SpotResult {
  const clip = findClip(session, trackId, clipId);
  if (!clip) {
    return { session, startSec: 0, applied: false, reason: '클립을 찾을 수 없습니다' };
  }
  if (!Number.isFinite(targetSec)) {
    return { session, startSec: clip.startSec, applied: false, reason: '위치를 읽을 수 없습니다' };
  }

  const startSec = anchor === 'start' ? targetSec : targetSec - clip.durationSec;
  if (startSec < -1e-9) {
    const short = -startSec;
    return {
      session, startSec: clip.startSec, applied: false,
      reason: `${short.toFixed(3)}초만큼 타임라인 앞으로 넘어갑니다 — 그 자리에는 놓을 수 없습니다`,
    };
  }
  if (Math.abs(startSec - clip.startSec) < 1e-9) {
    return { session, startSec: clip.startSec, applied: false, reason: null };
  }

  return {
    session: moveClip(session, trackId, clipId, startSec),
    startSec,
    applied: true,
    reason: null,
  };
}

/**
 * Why this spot would be refused, or null when it would go through.
 *
 * The dialog asks this on every keystroke so the refusal is on screen BEFORE
 * the button is pressed — being told after committing that the cue does not
 * fit is the same information one gesture too late.
 */
export function spotProblem(
  clip: Clip, targetSec: number, anchor: SpotAnchor,
): string | null {
  if (!Number.isFinite(targetSec)) return '위치를 읽을 수 없습니다';
  const startSec = anchor === 'start' ? targetSec : targetSec - clip.durationSec;
  if (startSec < -1e-9) {
    return `${(-startSec).toFixed(3)}초만큼 타임라인 앞으로 넘어갑니다 — 그 자리에는 놓을 수 없습니다`;
  }
  return null;
}

/** How far this spot would move the clip — shown before it is committed. */
export function spotDeltaSec(
  clip: Clip, targetSec: number, anchor: SpotAnchor,
): number {
  return targetSec - anchorSec(clip, anchor);
}

export function describeDelta(deltaSec: number): string {
  if (Math.abs(deltaSec) < 5e-4) return '제자리';
  const ms = deltaSec * 1000;
  return Math.abs(ms) < 1000
    ? `${ms > 0 ? '+' : '−'}${Math.abs(ms).toFixed(0)} ms`
    : `${deltaSec > 0 ? '+' : '−'}${Math.abs(deltaSec).toFixed(3)} 초`;
}
