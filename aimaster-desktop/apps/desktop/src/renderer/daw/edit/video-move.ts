// Moving the picture on the timeline — spotting the reel.
//
// The picture arrives at timeline zero because that is the only place an
// import can put it without guessing, and it is almost never where it goes.
// A reel starts at 01:00:00:00, the music starts eight bars in, the cut you
// are scoring is forty seconds into the file.  Until the picture can be
// slid, every hit point is measured against a coincidence.
//
// Three operations, and they are genuinely different things:
//
//   MOVE     where the picture sits on the timeline.  The film does not
//            change; where it happens does.
//   TRIM     which frame of the FILE is at the picture's start.  Where it
//            sits does not change; what plays there does.
//   SPOT     "this timecode is at this moment" — solved for the position
//            that makes it true.  This is how a reel is actually placed:
//            nobody types a number of seconds, they read a burn-in.
//
// And one rule under all of them: EVERYTHING LANDS ON A FRAME.  A picture at
// an arbitrary second shows the wrong frame for up to a frame's worth of
// time, and every hit point measured from it inherits the error.  At 23.976
// that is 42 ms, which is audible on a door slam.

import { frameSec, snapToFrame, videoOf, videoSpan, withVideo } from '../model/video.js';
import type { VideoRef } from '../model/video.js';
import type { DawSession } from '../model/types.js';

export interface VideoMoveResult {
  session: DawSession;
  /** False when nothing changed — `reason` says why, or is null for a no-op. */
  applied: boolean;
  reason: string | null;
  /** Where the picture starts afterwards, for the read-out. */
  startSec: number;
}

const unchanged = (session: DawSession, reason: string | null): VideoMoveResult => ({
  session, applied: false, reason, startSec: videoOf(session)?.startSec ?? 0,
});

function write(session: DawSession, video: VideoRef, next: Partial<VideoRef>): VideoMoveResult {
  const merged = { ...video, ...next };
  if (merged.startSec === video.startSec && merged.offsetSec === video.offsetSec) {
    return unchanged(session, null);
  }
  return {
    session: withVideo(session, merged),
    applied: true,
    reason: null,
    startSec: merged.startSec,
  };
}

/**
 * Put the picture's start at `startSec`.
 *
 * Snapped to the frame grid measured from timeline zero, so a hit point that
 * reads 00:01:14:07 is the same instant whether you got there through the
 * picture or through the timecode field.
 */
export function moveVideoTo(session: DawSession, startSec: number): VideoMoveResult {
  const video = videoOf(session);
  if (!video) return unchanged(session, '픽처가 없습니다');
  if (!Number.isFinite(startSec)) return unchanged(session, '위치가 올바르지 않습니다');

  const snapped = snapToFrame(startSec, video.fps);
  if (snapped < 0) {
    // Going further back is not a smaller number — it is a trim, because the
    // frames before timeline zero cannot be reached at all.
    return unchanged(session,
      `0 보다 앞으로는 갈 수 없습니다 — ${Math.abs(snapped).toFixed(2)}초만큼 앞을 잘라내려면 헤드 트림을 쓰세요`);
  }
  return write(session, video, { startSec: snapped });
}

/** Slide the picture by whole frames — the only nudge that means anything. */
export function nudgeVideoFrames(session: DawSession, frames: number): VideoMoveResult {
  const video = videoOf(session);
  if (!video) return unchanged(session, '픽처가 없습니다');
  return moveVideoTo(session, video.startSec + frames * frameSec(video.fps));
}

/**
 * Trim the head: choose which frame of the file sits at the picture's start.
 *
 * The picture does not move.  Trimming and moving are separate on purpose —
 * doing both at once is how you lose track of which one put the sync out.
 */
export function trimVideoHead(session: DawSession, offsetSec: number): VideoMoveResult {
  const video = videoOf(session);
  if (!video) return unchanged(session, '픽처가 없습니다');
  if (!Number.isFinite(offsetSec)) return unchanged(session, '트림 값이 올바르지 않습니다');

  const frame = frameSec(video.fps);
  const limit = Math.max(0, video.durationSec - frame);
  const snapped = Math.max(0, Math.min(limit, snapToFrame(offsetSec, video.fps)));
  if (offsetSec > limit + frame * 0.5) {
    return unchanged(session, '파일보다 더 잘라낼 수는 없습니다');
  }
  return write(session, video, { offsetSec: snapped });
}

export function nudgeVideoTrim(session: DawSession, frames: number): VideoMoveResult {
  const video = videoOf(session);
  if (!video) return unchanged(session, '픽처가 없습니다');
  return trimVideoHead(session, video.offsetSec + frames * frameSec(video.fps));
}

/**
 * Spot the reel: make `timecodeSec` land on `timelineSec`.
 *
 * `timecodeSec` is a position on the picture's own timecode clock — what the
 * burn-in reads — not a position in the file.  Solving for the placement is
 * the whole operation, and it is the one a spotting session actually does.
 */
export function spotVideoTimecode(
  session: DawSession, timecodeSec: number, timelineSec: number,
): VideoMoveResult {
  const video = videoOf(session);
  if (!video) return unchanged(session, '픽처가 없습니다');
  if (!Number.isFinite(timecodeSec) || !Number.isFinite(timelineSec)) {
    return unchanged(session, '타임코드를 읽을 수 없습니다');
  }
  const into = timecodeSec - video.startTimecodeSec;
  if (into < 0 || into > video.durationSec) {
    return unchanged(session, '그 타임코드는 이 픽처 안에 없습니다');
  }
  // videoTimeAt: into = timelineSec − startSec + offsetSec
  const startSec = timelineSec - into + video.offsetSec;
  const result = moveVideoTo(session, startSec);
  if (!result.applied && result.reason) {
    return unchanged(session,
      `그 타임코드를 거기에 두면 픽처가 타임라인 0 보다 앞으로 갑니다 — ${result.reason}`);
  }
  return result;
}

/** Put the start of the picture at the play head. */
export function spotVideoToPlayhead(session: DawSession, playheadSec: number): VideoMoveResult {
  return moveVideoTo(session, playheadSec);
}

export function resetVideoPosition(session: DawSession): VideoMoveResult {
  const video = videoOf(session);
  if (!video) return unchanged(session, '픽처가 없습니다');
  return write(session, video, { startSec: 0, offsetSec: 0 });
}

// ── Reading it back ───────────────────────────────────────────────────────────

/** How far the picture has been moved, in frames — the honest unit. */
export function videoOffsetFrames(session: DawSession): number {
  const video = videoOf(session);
  if (!video) return 0;
  return Math.round(video.startSec * video.fps);
}

export function describeVideoPosition(session: DawSession): string {
  const video = videoOf(session);
  if (!video) return '픽처 없음';
  const span = videoSpan(video);
  const at = (sec: number): string => {
    const m = Math.floor(sec / 60);
    const s = sec - m * 60;
    return `${m}:${s.toFixed(2).padStart(5, '0')}`;
  };
  const trim = video.offsetSec > 0
    ? ` · 헤드 ${Math.round(video.offsetSec * video.fps)}프레임 잘림`
    : '';
  return `${at(span.startSec)} ~ ${at(span.endSec)}${trim}`;
}
