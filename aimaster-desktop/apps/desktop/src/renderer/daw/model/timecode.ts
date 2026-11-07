// SMPTE timecode — seconds to frames and back, drop-frame included.
//
// Its own module, with NO imports, because the main process needs it too and
// cannot have the session model: `videoHandlers.ts` probes a file's start
// timecode, and when it carried its own copy of this conversion that copy
// accepted the drop-frame marker and then counted non-drop, putting a reel
// starting at `01:00:00;00` 3.6 seconds out.  Importing it from
// `model/video.ts` instead pulled `DawSession` — and through it the plugin
// types, which speak `AudioNode` — into a tsconfig with no DOM lib.
//
// Nothing in here knows what a session or a track is, so both processes can
// have the same rules rather than two readings of them.

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

// No `frameAt(timeSec, fps)` — "which frame number is this time" — any more.
// Nothing in the app ever asked: the timeline nudges by `frameSec` and snaps
// with `snapToFrame`, and the only caller it ever had was its own test, which
// is what `test-only-exports.txt` had recorded about it before this module
// existed.  Moving it here made the ratchet say so out loud, and the list's
// own rule is to wire an export up or take it out.

/** One frame, in seconds — the smallest meaningful nudge against picture. */
export function frameSec(fps: number): number {
  return fps > 0 ? 1 / fps : 0;
}
