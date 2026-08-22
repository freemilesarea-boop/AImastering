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

/** Frames per second COUNTED, which is not the same as frames per second. */
function nominalRate(fps: number): number {
  return Math.round(fps);
}

// ── SMPTE timecode ────────────────────────────────────────────────────────────

/**
 * Seconds → `HH:MM:SS:FF`.
 *
 * Non-drop is the easy case: a frame count divided out into fields at the
 * NOMINAL rate (30 for 29.97), which is why non-drop timecode slowly runs
 * ahead of the clock — an hour of 29.97 material reads 01:00:03:18.
 *
 * Drop-frame fixes that by skipping frame NUMBERS: the numbers 00 and 01 are
 * never used at the top of a minute, except every tenth minute.  Nothing is
 * dropped from the picture; only the labels move.  Over an hour that recovers
 * 108 frames, which is the 3.6 seconds non-drop was losing.
 */
export function formatTimecode(
  timeSec: number, fps: number, dropFrame = false,
): string {
  const nominal = nominalRate(fps);
  const negative = timeSec < 0;
  let frames = Math.round(Math.abs(timeSec) * fps);

  if (dropFrame) {
    // 2 frames per minute at 30-ish, 4 at 60-ish.
    const dropPerMinute = Math.round(nominal / 15);
    const framesPer10Min = Math.round(nominal * 60 * 10) - dropPerMinute * 9;
    const framesPerMin = Math.round(nominal * 60) - dropPerMinute;

    const tenMinBlocks = Math.floor(frames / framesPer10Min);
    const rest = frames % framesPer10Min;
    // `>` and not `>=`: the two frames at the very top of a ten-minute block
    // are inside the minute that does NOT drop, and counting them as dropped
    // shifts everything after by two frames.
    frames += dropPerMinute * 9 * tenMinBlocks;
    if (rest > dropPerMinute) {
      frames += dropPerMinute * Math.floor((rest - dropPerMinute) / framesPerMin);
    }
  }

  const ff = frames % nominal;
  const totalSeconds = Math.floor(frames / nominal);
  const ss = totalSeconds % 60;
  const mm = Math.floor(totalSeconds / 60) % 60;
  const hh = Math.floor(totalSeconds / 3600) % 24;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${negative ? '-' : ''}${pad(hh)}:${pad(mm)}:${pad(ss)}${dropFrame ? ';' : ':'}${pad(ff)}`;
}

/**
 * `HH:MM:SS:FF` → seconds, or null when it is not timecode.
 *
 * Accepts `;` or `.` before the frames as the drop-frame marker, which is what
 * every other tool writes, and tolerates a missing hours field.
 */
export function parseTimecode(text: string, fps: number): number | null {
  const trimmed = text.trim();
  const match = /^(?:(\d{1,2})[:;.])?(\d{1,2})[:;.](\d{1,2})[:;.](\d{1,2})$/.exec(trimmed);
  if (!match) return null;
  const [, h, m, s, f] = match;
  const hh = Number(h ?? 0);
  const mm = Number(m);
  const ss = Number(s);
  const ff = Number(f);
  const nominal = nominalRate(fps);
  if (mm > 59 || ss > 59 || ff >= nominal) return null;

  const dropFrame = /[;.]\d{1,2}$/.test(trimmed);
  let frames = ((hh * 60 + mm) * 60 + ss) * nominal + ff;
  if (dropFrame) {
    const dropPerMinute = Math.round(nominal / 15);
    const totalMinutes = hh * 60 + mm;
    frames -= dropPerMinute * (totalMinutes - Math.floor(totalMinutes / 10));
  }
  return frames / fps;
}

/** Snap a time to the nearest frame boundary — where a hit point can live. */
export function snapToFrame(timeSec: number, fps: number): number {
  if (!(fps > 0)) return timeSec;
  return Math.round(timeSec * fps) / fps;
}

export function frameAt(timeSec: number, fps: number): number {
  return Math.round(timeSec * fps);
}

/** One frame, in seconds — the smallest meaningful nudge against picture. */
export function frameSec(fps: number): number {
  return fps > 0 ? 1 / fps : 0;
}

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
