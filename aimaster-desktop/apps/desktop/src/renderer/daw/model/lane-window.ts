// Which track rows are worth building — the Edit window's vertical window.
//
// The same finding as the mixer's `strip-window.ts`, one window over: the
// timeline built every track row and every automation lane in the session,
// on screen or not.  Measured in the production build, clicking EDIT and
// waiting for the frame it appears on:
//
//      8 tracks    28 ms
//     24 tracks    53 ms
//     48 tracks    94 ms
//
// Linear again, at about 1.6 ms a track — but for a different reason, and the
// difference decides the fix.  A track row is only thirteen DOM nodes, so the
// cost is not the markup: it is that every row owns a CANVAS, and a canvas
// that exists is a canvas the browser allocates and paints.  At 927 × 96 a
// lane, forty-eight of them is four and a third million pixels a frame.
//
// So the rows outside the scroller are not built, and the space they took is
// held by two spacers.  Where the mixer's strips are all 124 px, these are
// not: a track carries its own height and an automation lane has its own, so
// the window walks the heights rather than dividing by one.
//
// The two columns — headers on the left, lanes on the right — take the SAME
// window. They are two renderings of one list, and the comment above
// `displayRows` in EditWindow says what happens when they fall out of step.

/**
 * Pixels built above and below the viewport.
 *
 * In pixels rather than rows, because rows are not one size: four rows of
 * automation lane is a third of the overscan four track rows would be.  240
 * covers a wheel notch either way, which is what a scroll does between two
 * frames.
 */
export const LANE_OVERSCAN_PX = 240;

export interface LaneWindow {
  /** First row to build, inclusive. */
  first: number;
  /** One past the last row to build. */
  last: number;
  /** Pixels of empty space standing in for the rows before `first`. */
  padTop: number;
  /** …and for the ones after `last`. */
  padBottom: number;
}

/**
 * The rows a scroller showing `viewportPx` from `top` needs built.
 *
 * `top` is measured from the first row, not from the top of the scroller:
 * the Edit window keeps four fixed lanes — sections, chords, pictures, tempo
 * — above the track list, and they are always built.  The caller subtracts
 * their height, which it knows from the rows' own offset.
 *
 * Total-safe, for the reason the mixer's is: an unmeasured viewport, a scroll
 * position past the end and an empty session all happen on the frame a window
 * is mounting, which is the frame this exists to make cheap.
 */
export function laneWindow(
  heights: readonly number[],
  top: number,
  viewportPx: number,
  overscanPx: number = LANE_OVERSCAN_PX,
): LaneWindow {
  const n = heights.length;
  if (n === 0) return { first: 0, last: 0, padTop: 0, padBottom: 0 };

  const px = (v: number): number => (Number.isFinite(v) && v > 0 ? v : 0);
  const pad = px(overscanPx);
  const from = Math.max(0, (Number.isFinite(top) ? top : 0)) - pad;
  const to = Math.max(0, (Number.isFinite(top) ? top : 0))
    + px(viewportPx) + pad;

  let first = n;
  let last = 0;
  let padTop = 0;
  let padBottom = 0;
  let y = 0;
  for (let i = 0; i < n; i++) {
    const h = px(heights[i] ?? 0);
    const bottom = y + h;
    // A zero-height row belongs to whichever side its edge falls on; it can
    // never be the thing that makes a window empty.
    if (bottom > from && y < to) {
      if (i < first) first = i;
      last = i + 1;
    } else if (last === 0) {
      padTop += h;
    } else {
      padBottom += h;
    }
    y = bottom;
  }
  if (first > last) first = last;
  return { first, last, padTop, padBottom };
}
