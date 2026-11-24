// 타임라인 휠 — zoom and scroll arithmetic, with no DOM in it.
//
// The arrange window had no wheel handling at all: the whole renderer carried
// four `onWheel` handlers and every one of them was on a knob.  So the two
// gestures a DAW user reaches for without thinking — Cmd/Ctrl + wheel to zoom,
// Shift + wheel to scroll sideways — did nothing, and the only way across a
// long song was the zoom buttons and the overview strip.
//
// The maths lives here rather than in the component for one reason: the
// anchored zoom is the part that can be subtly wrong, and "subtly wrong" here
// means the timeline creeps under the pointer while the user is at full zoom
// trying to place something precisely.  A pure function can be asked whether
// the time under the cursor really did not move.

import { clampPxPerSec } from '../../stores/dawStore.js';

/** The viewport the arrange window draws from. */
export interface WheelViewport {
  scrollSec: number;
  pxPerSec: number;
}

export interface WheelGesture {
  deltaX: number;
  deltaY: number;
  /** Cmd on macOS, Ctrl elsewhere — and Ctrl on macOS too, which also zooms. */
  zoomModifier: boolean;
  shiftKey: boolean;
  /** Pointer position inside the lane column, in CSS pixels from its left edge. */
  offsetPx: number;
}

export type WheelOutcome =
  /** The row scroller keeps it: a plain vertical wheel scrolls the track list. */
  | { kind: 'pass' }
  | { kind: 'zoom'; pxPerSec: number; scrollSec: number }
  | { kind: 'scroll'; scrollSec: number };

/**
 * How fast one wheel notch zooms.
 *
 * Exponential in the delta so a mouse notch (deltaY ≈ ±100) and a trackpad's
 * stream of small deltas are the same gesture at different sampling rates
 * rather than two behaviours.  0.0025 puts one notch at about 1.28×, which is
 * close to the 1.5× the toolbar buttons step by — a notch should feel like a
 * press, not like a jump.
 */
export const ZOOM_PER_WHEEL_PX = 0.0025;

export function wheelNav(view: WheelViewport, g: WheelGesture): WheelOutcome {
  if (g.zoomModifier) {
    // The time under the cursor, before anything changes.  This is the value
    // the whole function exists to preserve.
    const underCursor = view.scrollSec + g.offsetPx / view.pxPerSec;
    // Clamped with the STORE's clamp, not a local copy: the scroll below
    // divides by the zoom that will actually be in effect, and at the ends of
    // the range a private copy of the limits would divide by a zoom the store
    // refused — which is exactly when the anchor would drift.
    const pxPerSec = clampPxPerSec(view.pxPerSec * Math.exp(-g.deltaY * ZOOM_PER_WHEEL_PX));
    return {
      kind: 'zoom',
      pxPerSec,
      scrollSec: Math.max(0, underCursor - g.offsetPx / pxPerSec),
    };
  }
  if (g.shiftKey) {
    // A mouse wheel has no horizontal axis to offer and Shift is how it asks
    // for one; a trackpad that does have one gets to use it.
    const delta = g.deltaY !== 0 ? g.deltaY : g.deltaX;
    return { kind: 'scroll', scrollSec: Math.max(0, view.scrollSec + delta / view.pxPerSec) };
  }
  // A two-finger sideways swipe is a horizontal scroll with no modifier at
  // all.  Only when it is CLEARLY sideways: a mostly-vertical gesture with a
  // little horizontal drift must still scroll the track list, or a
  // forty-track session becomes unscrollable on a trackpad.
  if (Math.abs(g.deltaX) > Math.abs(g.deltaY)) {
    return { kind: 'scroll', scrollSec: Math.max(0, view.scrollSec + g.deltaX / view.pxPerSec) };
  }
  return { kind: 'pass' };
}
