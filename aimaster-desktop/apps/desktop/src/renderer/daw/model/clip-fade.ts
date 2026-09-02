// Fades you can grab, the way every DAW with a mouse does it.
//
// The corner of a clip is a handle.  Pull it inward and the audio ramps in
// over that distance; pull it back out and the ramp goes away.  Nothing about
// that needs a dialog, a menu or a selection first, which is why it is the
// gesture Cubase, Pro Tools, Logic and Live all settled on.
//
// The model already had `fadeIn`/`fadeOut`, `fadeCurve` to shape them and the
// drawing to show them.  What it did not have was any way to MAKE one with the
// mouse — `setFades` had no callers and the only path in was a keyboard
// shortcut that fades to the play head.  So the fades were visible, playable,
// bounced and warped, and unreachable.
//
// Pure, so the geometry and the limits are tested without a canvas.

import { clipEnd } from './session-ops.js';
import type { Clip, Fade, FadeShape } from './types.js';

/** How close to a corner counts as grabbing its handle, in pixels. */
export const FADE_HANDLE_PX = 12;

/**
 * The top strip a handle lives in, as a fraction of the lane height.
 *
 * Only the top: the lower part of a clip stays free for dragging the clip
 * itself, so reaching for a fade cannot move the audio by accident.
 */
export const FADE_HANDLE_BAND = 0.4;

export type FadeSide = 'in' | 'out';

export const FADE_SHAPES: readonly FadeShape[] = ['linear', 'equalPower', 'sCurve'];

export const FADE_SHAPE_LABEL: Record<FadeShape, string> = {
  linear: '직선',
  equalPower: '등파워',
  sCurve: 'S 커브',
};

/**
 * The longest a fade may be.
 *
 * The two fades share the clip: together they can cover it exactly, and no
 * more.  Letting them overlap would mean a sample being ramped down by one and
 * up by the other, which is not a crossfade — it is just quieter.
 */
export function maxFadeSec(clip: Clip, side: FadeSide): number {
  const other = side === 'in' ? clip.fadeOut.durationSec : clip.fadeIn.durationSec;
  return Math.max(0, clip.durationSec - Math.max(0, other));
}

/** A fade length clamped to what this clip can hold. */
export function clampFadeSec(clip: Clip, side: FadeSide, seconds: number): number {
  if (!Number.isFinite(seconds)) return 0;
  return Math.max(0, Math.min(maxFadeSec(clip, side), seconds));
}

/**
 * Which fade handle is under the pointer, or null.
 *
 * `xSec` is where the pointer is on the timeline and `yFrac` how far down the
 * lane it sits, 0 at the top.  A clip narrower than two handles gives the one
 * the pointer is nearer, so a very short clip is still fadeable rather than
 * having two handles fighting over the same pixels.
 */
export function fadeHandleAt(
  clip: Clip, xSec: number, yFrac: number, pxPerSec: number,
): FadeSide | null {
  if (yFrac < 0 || yFrac > FADE_HANDLE_BAND) return null;
  if (pxPerSec <= 0) return null;
  const reachSec = FADE_HANDLE_PX / pxPerSec;
  const end = clipEnd(clip);
  if (xSec < clip.startSec - reachSec || xSec > end + reachSec) return null;

  // The handle sits at the END of the fade once there is one — that is the
  // part you pull — and at the corner while there is not.
  const inAt = clip.startSec + clip.fadeIn.durationSec;
  const outAt = end - clip.fadeOut.durationSec;
  const dIn = Math.abs(xSec - inAt);
  const dOut = Math.abs(xSec - outAt);
  if (dIn > reachSec && dOut > reachSec) return null;
  if (dIn <= reachSec && dOut <= reachSec) return dIn <= dOut ? 'in' : 'out';
  return dIn <= reachSec ? 'in' : 'out';
}

/**
 * The handle under the pointer across a whole lane, and whose it is.
 *
 * Asking `clipAt` first does not work: the fade-out handle sits exactly ON the
 * clip's end, and `clipAt` treats the end as outside — so the one pixel the
 * corner actually occupies fell through to the range tool.  `fadeHandleAt`
 * already tolerates a handle's reach beyond the edge, so the search goes
 * through it directly.
 *
 * Later clips win a tie, because that is what is drawn on top.
 */
export function fadeHandleOn(
  clips: readonly Clip[], xSec: number, yFrac: number, pxPerSec: number,
): { clip: Clip; side: FadeSide } | null {
  let found: { clip: Clip; side: FadeSide } | null = null;
  for (const clip of clips) {
    const side = fadeHandleAt(clip, xSec, yFrac, pxPerSec);
    if (side) found = { clip, side };
  }
  return found;
}

/** The fade a drag to `xSec` asks for, clamped to the clip. */
export function fadeFromDrag(clip: Clip, side: FadeSide, xSec: number): number {
  const raw = side === 'in' ? xSec - clip.startSec : clipEnd(clip) - xSec;
  return clampFadeSec(clip, side, raw);
}

/** Whether the pointer is inside the drawn fade — where a shape change lands. */
export function fadeRegionAt(clip: Clip, xSec: number, yFrac: number): FadeSide | null {
  if (yFrac < 0 || yFrac > 1) return null;
  const end = clipEnd(clip);
  if (clip.fadeIn.durationSec > 0
    && xSec >= clip.startSec && xSec <= clip.startSec + clip.fadeIn.durationSec) return 'in';
  if (clip.fadeOut.durationSec > 0
    && xSec >= end - clip.fadeOut.durationSec && xSec <= end) return 'out';
  return null;
}

/** The clip with one of its fades set. */
export function withFade(clip: Clip, side: FadeSide, fade: Fade): Clip {
  return side === 'in' ? { ...clip, fadeIn: fade } : { ...clip, fadeOut: fade };
}

/** The fade on a side, whichever side that is. */
export function fadeOn(clip: Clip, side: FadeSide): Fade {
  return side === 'in' ? clip.fadeIn : clip.fadeOut;
}
