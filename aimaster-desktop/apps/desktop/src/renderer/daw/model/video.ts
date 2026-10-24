// The video track — scoring to picture.
//
// A session gets at most ONE video, and that is a decision rather than a
// limitation.  Every DAW that scores to picture has one picture; a second
// video track would need its own viewer, its own sync policy and its own
// answer to "which one is the timecode from", and none of those questions
// have a musical answer.
//
// Two things in here are worth reading before the code:
//
// THE VIDEO IS NOT IN THE AUDIO GRAPH.  It is an HTMLVideoElement that
// follows the transport, muted.  Its audio, if you want it, is imported as a
// normal audio track — which means it is trimmed, faded, metered and bounced
// like everything else, instead of being a second sound path with none of
// that.  A `<video>` whose audio is audible would also be a second clock, and
// this file exists to make sure there is only one.
//
// FRAMES ARE NOT SECONDS.  A hit point is on a FRAME, and the frame rate is
// almost never a whole number: 23.976, 29.97, 59.94.  So the timecode here is
// real SMPTE, drop-frame included, because a spotting session that reads two
// seconds off at the ten-minute mark is worse than one with no timecode at all.

import type { DawSession } from './types.js';
import { formatTimecode } from './timecode.js';

export interface VideoRef {
  id: string;
  path: string;
  name: string;
  /** Where the picture starts on the timeline. */
  startSec: number;
  /** How far into the FILE that start is — the trim handle. */
  offsetSec: number;
  durationSec: number;
  /** Frames per second, as measured by ffprobe.  23.976 and 29.97 are real. */
  fps: number;
  /**
   * The timecode the first frame of the FILE reads.
   *
   * Post houses deliver with the reel starting at 01:00:00:00, not zero, and a
   * spotting note that says "the door slams at 01:02:14:07" is unusable if the
   * app insists the file starts at zero.
   */
  startTimecodeSec: number;
  width: number;
  height: number;
}

export function videoOf(session: DawSession): VideoRef | null {
  const raw = (session as { video?: VideoRef | null }).video;
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.path !== 'string' || !Number.isFinite(raw.durationSec)) return null;
  return raw;
}

export function withVideo(session: DawSession, video: VideoRef | null): DawSession {
  return { ...session, video } as DawSession;
}

// ── Frame rates ───────────────────────────────────────────────────────────────

export interface FrameRate {
  /** The rate a user says out loud. */
  label: string;
  /** The rate frames actually arrive at. */
  fps: number;
  /**
   * Whether timecode at this rate drops frame NUMBERS to stay near wall clock.
   *
   * Only 29.97 and 59.94 do, and only by convention — 23.976 runs at the same
   * kind of pulldown and is always counted non-drop.
   */
  dropFrame: boolean;
}

export const FRAME_RATES: readonly FrameRate[] = [
  { label: '23.976', fps: 24000 / 1001, dropFrame: false },
  { label: '24',     fps: 24,           dropFrame: false },
  { label: '25',     fps: 25,           dropFrame: false },
  { label: '29.97 DF', fps: 30000 / 1001, dropFrame: true },
  { label: '29.97 NDF', fps: 30000 / 1001, dropFrame: false },
  { label: '30',     fps: 30,           dropFrame: false },
  { label: '50',     fps: 50,           dropFrame: false },
  { label: '59.94 DF', fps: 60000 / 1001, dropFrame: true },
  { label: '60',     fps: 60,           dropFrame: false },
];

/** The nearest standard rate to what ffprobe reported. */
export function nearestFrameRate(fps: number): FrameRate {
  let best = FRAME_RATES[2] as FrameRate;   // 25 — a defensible default
  let bestGap = Infinity;
  for (const rate of FRAME_RATES) {
    // Between the DF and NDF entries for the same rate, prefer DF: a 29.97
    // file that is really NDF costs the user one dropdown; the reverse costs
    // them a spotting session that reads wrong late in the reel.
    const gap = Math.abs(rate.fps - fps);
    if (gap < bestGap - 1e-9) { bestGap = gap; best = rate; }
  }
  return best;
}

// ── SMPTE timecode ────────────────────────────────────────────────────────────
//
// In `model/timecode.ts`, which imports nothing, so the main process can use
// the same rules — see that file's header for what happened when it didn't.
// Re-exported here because this is where the rest of the app looks for them.
export {
  formatTimecode, frameSec, parseTimecode, snapToFrame,
} from './timecode.js';
// NOT `frameAt`: nothing in the app calls it, and re-exporting it from here
// would have made the dead-exports ratchet read it as reached.  It keeps its
// line in `test-only-exports.txt`, under its new path.

// ── Placing the picture ───────────────────────────────────────────────────────

/**
 * Where inside the FILE the timeline is pointing, or null when the picture is
 * not on screen at that moment.
 *
 * Returning null rather than clamping matters: clamping would freeze the last
 * frame over the end credits and make it look like the video is still running.
 */
export function videoTimeAt(video: VideoRef, timelineSec: number): number | null {
  const into = timelineSec - video.startSec + video.offsetSec;
  // The lower bound is the TRIM, not zero.  A picture whose head has been
  // trimmed does not exist before its start on the timeline, and reading
  // from zero would show the frames that were trimmed off — playing back
  // the part of the reel the user explicitly cut.
  if (into < video.offsetSec || into > video.durationSec) return null;
  return into;
}

/** Where the picture occupies the timeline: start, and where it runs out. */
export function videoSpan(video: VideoRef): { startSec: number; endSec: number } {
  return {
    startSec: video.startSec,
    endSec: video.startSec + Math.max(0, video.durationSec - video.offsetSec),
  };
}

/** The timeline moment a file position lands on — the inverse. */
export function timelineTimeAt(video: VideoRef, fileSec: number): number {
  return fileSec - video.offsetSec + video.startSec;
}

/** The picture's timecode at a moment on the timeline. */
export function timecodeAt(
  video: VideoRef, timelineSec: number, dropFrame = false,
): string {
  const into = videoTimeAt(video, timelineSec);
  if (into === null) return '--:--:--:--';
  return formatTimecode(video.startTimecodeSec + into, video.fps, dropFrame);
}

/** `1920×1080 · 23.976 · 2:14` — one line for the header. */
export function describeVideo(video: VideoRef): string {
  const rate = nearestFrameRate(video.fps);
  const m = Math.floor(video.durationSec / 60);
  const s = Math.floor(video.durationSec - m * 60);
  return `${video.width}×${video.height} · ${rate.label} · ${m}:${String(s).padStart(2, '0')}`;
}
