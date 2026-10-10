// Which channel strips are worth building — the Mix window's horizontal window.
//
// The mixer is a row of fixed-width strips in a horizontal scroller, and it
// used to build every one of them.  Measured in the production build, that is
// 113 DOM nodes a strip and 5.2 ms a track to put the window on screen:
//
//      8 tracks   48 ms
//     24 tracks  125 ms
//     48 tracks  248 ms      5687 DOM nodes
//
// A quarter of a second, on a session size nobody would call large, for a
// window switch — and all but a dozen of those strips are off the side of the
// screen while it happens.  The work is not React's: the click handler returns
// in 0.6 ms and a forced layout right after costs 0.1 ms, so what the frame is
// spending is the browser building and laying out five thousand nodes.
//
// So only the strips within the scroller get built, plus a few either side so
// a flick of the scrollbar has something already there.  The ones that are not
// built are replaced by two spacers of exactly their width, which is what
// keeps the scrollbar the length it was and the scroll position meaning what
// it meant.

/** Outer width of one strip, including its right border (`w-[124px]`). */
export const STRIP_PX = 124;

/**
 * Strips built either side of the viewport.
 *
 * Four, because the scrollbar is the fast way to move and a drag can cover a
 * strip's width between two frames.  It is a cheap insurance: four strips is
 * 452 nodes against the 5687 this exists to avoid.
 */
export const STRIP_OVERSCAN = 4;

export interface StripWindow {
  /** First strip to build, inclusive. */
  first: number;
  /** One past the last strip to build. */
  last: number;
  /** Pixels of empty space standing in for the strips before `first`. */
  padLeft: number;
  /** …and for the ones after `last`. */
  padRight: number;
}

/**
 * The strips a scroller at `scrollLeft` showing `viewportPx` needs built.
 *
 * Total-safe on purpose: a viewport that has not been measured yet, a scroll
 * position past the end, a negative from an elastic overscroll and an empty
 * session all have to produce a window rather than a NaN, because every one of
 * them happens on the frame a window is being mounted — which is the frame
 * this is here to make cheap.
 */
export function stripWindow(
  count: number,
  scrollLeft: number,
  viewportPx: number,
  stripPx: number = STRIP_PX,
  overscan: number = STRIP_OVERSCAN,
): StripWindow {
  const n = Math.max(0, Math.floor(count));
  const width = Math.max(1, Math.round(stripPx));
  if (n === 0) return { first: 0, last: 0, padLeft: 0, padRight: 0 };

  const left = Number.isFinite(scrollLeft) ? Math.max(0, scrollLeft) : 0;
  const view = Number.isFinite(viewportPx) ? Math.max(0, viewportPx) : 0;
  const pad = Math.max(0, Math.floor(overscan));

  const first = Math.min(n, Math.max(0, Math.floor(left / width) - pad));
  const last = Math.max(first, Math.min(n, Math.ceil((left + view) / width) + pad));
  return {
    first, last,
    padLeft: first * width,
    padRight: (n - last) * width,
  };
}
