// transport-view — pure geometry for the transport lane.
//
// Kept out of the component so the zoom / range math can be unit-tested
// without a DOM.

export interface TimeWindow { startSec: number; endSec: number }

/**
 * The slice of the timeline visible at the current horizontal zoom, centred
 * on the play head and clamped inside [0, duration].
 */
export function visibleWindow(durationSec: number, positionSec: number, zoomH: number): TimeWindow {
  if (!(durationSec > 0)) return { startSec: 0, endSec: 0 };
  const span = durationSec / Math.max(1, zoomH);
  let start = positionSec - span / 2;
  if (start < 0) start = 0;
  if (start + span > durationSec) start = Math.max(0, durationSec - span);
  return { startSec: start, endSec: start + span };
}

/** Fraction (0..1) of the visible window a time sits at — may fall outside. */
export function ratioInWindow(sec: number, view: TimeWindow): number {
  const span = view.endSec - view.startSec;
  if (!(span > 0)) return 0;
  return (sec - view.startSec) / span;
}

/** Inverse of `ratioInWindow`, clamped to the window. */
export function timeAtRatio(ratio: number, view: TimeWindow): number {
  const clamped = Math.min(1, Math.max(0, ratio));
  return view.startSec + clamped * (view.endSec - view.startSec);
}
