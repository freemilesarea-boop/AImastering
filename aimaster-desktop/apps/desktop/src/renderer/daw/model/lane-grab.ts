// What a press on a track lane means.
//
// One place, because the answer depends on four things at once — is there a
// clip, where in its height, how near its corner, how near its gain line —
// and every caller (the mouse, the cursor, the tests) has to agree on all
// four.  Reading it in the component is how the cursor ends up promising one
// thing and the click doing another.
//
// The order is the rule:
//
//   1. THE CORNER is a fade.  It sits ON the clip that owns it, so looking
//      the clip up first would mean a fade could never be grabbed.
//   2. THE GAIN LINE is the gain.  Pro Tools' clip gain: grab the line and
//      ride it, which is faster than a keyboard step for the thing it is
//      usually used on — one loud word, one AI-generated pop.
//   3. THE LOWER HALF is a marquee, clip or no clip.  Before this a selection
//      box could only be started on empty lane, so a dense arrangement had
//      nowhere to start one.
//   4. WHAT IS LEFT — the upper half of a clip — moves it.

import { clipEnd } from './session-ops.js';
import { fadeHandleOn, type FadeSide } from './clip-fade.js';
import { CLIP_GAIN_MAX_DB, CLIP_GAIN_MIN_DB } from '../edit/clip-edit.js';
import type { Clip } from './types.js';

/**
 * Where the lower half of a clip starts, as a fraction of the lane height.
 *
 * Half, not a thin strip: a band you have to aim for is a band that gets
 * missed, and both halves of a 96 px lane are a comfortable target.
 */
export const MARQUEE_BAND = 0.5;

/**
 * Decibels from the centre line to the top of the lane.
 *
 * The clip gain model allows −60 dB, which no lane is tall enough to draw.
 * The DRAWN span is what the mouse gets, so what you grab is what you see;
 * the quieter end of the range stays reachable from the keyboard.
 */
export const GAIN_SPAN_DB = 24;

/** How near the line counts as on it. */
export const GAIN_HANDLE_PX = 7;

/** Pixels kept clear at the top and bottom so the line never sits on an edge. */
const GAIN_MARGIN_PX = 10;

function gainReach(heightPx: number): number {
  return Math.max(1, heightPx / 2 - GAIN_MARGIN_PX);
}

/** Where a clip's gain line is drawn, in pixels from the top of the lane. */
export function gainLineY(gainDb: number, heightPx: number): number {
  const held = Math.max(-GAIN_SPAN_DB, Math.min(GAIN_SPAN_DB, gainDb));
  return heightPx / 2 - (held / GAIN_SPAN_DB) * gainReach(heightPx);
}

/** The gain a pointer at this height is asking for, held to the model's range. */
export function gainFromY(y: number, heightPx: number): number {
  const db = ((heightPx / 2 - y) / gainReach(heightPx)) * GAIN_SPAN_DB;
  return Math.max(CLIP_GAIN_MIN_DB, Math.min(CLIP_GAIN_MAX_DB, db));
}

export type LaneGrab =
  | { kind: 'marquee' }
  | { kind: 'fade'; clip: Clip; side: FadeSide }
  | { kind: 'gain'; clip: Clip }
  | { kind: 'move'; clip: Clip };

export function laneGrab(
  clips: readonly Clip[], xSec: number, yFrac: number, pxPerSec: number, heightPx: number,
): LaneGrab {
  const handle = fadeHandleOn(clips, xSec, yFrac, pxPerSec);
  if (handle) return { kind: 'fade', clip: handle.clip, side: handle.side };

  const clip = clips.find((c) => xSec >= c.startSec && xSec < clipEnd(c));
  if (clip && heightPx > 0) {
    const y = yFrac * heightPx;
    if (Math.abs(y - gainLineY(clip.gainDb, heightPx)) <= GAIN_HANDLE_PX) {
      return { kind: 'gain', clip };
    }
  }
  if (yFrac >= MARQUEE_BAND) return { kind: 'marquee' };
  return clip ? { kind: 'move', clip } : { kind: 'marquee' };
}
