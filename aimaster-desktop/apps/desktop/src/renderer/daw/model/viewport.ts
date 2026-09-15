// What the arrange window is looking at — zoom, scroll and the ruler's ticks.
//
// Pure, because all three are the same kind of arithmetic and all three are
// easy to get subtly wrong in a way nothing catches: a fit that puts the
// selection half off-screen, a follow that jitters at the edge, a ruler whose
// labels are a frame out at one zoom and right at every other.
//
// The component owns the pixels; this owns what the pixels should be.

import { formatPosition, type SpotContext, type TimeFormat } from './spot-time.js';
import { gridLines, type TempoMap } from './tempo-map.js';

/** Matches the store's own clamp, so a computed zoom cannot be refused. */
export const MIN_PX_PER_SEC = 4;
export const MAX_PX_PER_SEC = 2000;

export interface Viewport {
  scrollSec: number;
  pxPerSec: number;
  widthPx: number;
}

export interface ViewChange {
  scrollSec: number;
  pxPerSec: number;
}

const clampZoom = (v: number): number => Math.max(MIN_PX_PER_SEC, Math.min(MAX_PX_PER_SEC, v));

/**
 * Frame a time range in the window.
 *
 * The margin is on purpose and it is not decoration: a selection zoomed to
 * exactly the window edges has its own handles half off-screen, so the first
 * thing you want to do after zooming to it — grab an edge — is the one thing
 * you cannot.  Six per cent either side is about a fade handle's width at any
 * zoom worth being at.
 */
export function fitRange(
  startSec: number, endSec: number, widthPx: number, marginFrac = 0.06,
): ViewChange | null {
  if (!(widthPx > 0)) return null;
  const length = endSec - startSec;
  if (!(length > 1e-6)) return null;
  const margin = Math.max(0, Math.min(0.4, marginFrac));
  const pxPerSec = clampZoom((widthPx * (1 - margin * 2)) / length);
  // Centre what was asked for, rather than putting it at the left edge with
  // the margin only on one side.
  const visible = widthPx / pxPerSec;
  return { pxPerSec, scrollSec: Math.max(0, startSec - (visible - length) / 2) };
}

/**
 * Where to scroll so the play head stays visible, or null to leave it alone.
 *
 * Pages rather than centres.  A view that keeps the head in the middle moves
 * on every frame, which makes the waveform impossible to read while it plays;
 * every DAW jumps a page when the head reaches the far side and then sits
 * still until it gets there again.  The head lands at a tenth in, so there is
 * a moment of past on screen and nearly a full page of future.
 */
export function followScrollSec(view: Viewport, playheadSec: number): number | null {
  if (!(view.widthPx > 0) || !(view.pxPerSec > 0)) return null;
  const visible = view.widthPx / view.pxPerSec;
  const trigger = view.scrollSec + visible * 0.9;
  // Behind the window (after a rewind) is just as much "off screen" as ahead.
  // No "did it actually move" check.  Both branches only fire when the head
  // is outside the window, and a head outside the window is always more than
  // a tenth of a page from where a page would put it — so the equality it
  // would test can never hold.  Breaking it changed no test, which is how it
  // was found; a branch nothing can reach is worse than no branch.
  if (playheadSec < view.scrollSec || playheadSec >= trigger) {
    return Math.max(0, playheadSec - visible * 0.1);
  }
  return null;
}

// ── The ruler ─────────────────────────────────────────────────────────────────

export interface RulerTick {
  sec: number;
  /** Drawn brighter and labelled; the rest are hairlines. */
  major: boolean;
  label: string | null;
}

/**
 * Steps a clock is allowed to count in.
 *
 * Hand-written rather than a decade ladder because time is not decimal past a
 * second: 15 and 30 belong on a seconds ruler and 20 and 50 do not, and a
 * ruler that counts in 20-second steps is one nobody can read a timecode off.
 */
const TIME_STEPS_SEC = [
  0.01, 0.02, 0.05, 0.1, 0.2, 0.5,
  1, 2, 5, 10, 15, 30,
  60, 120, 300, 600, 900, 1800, 3600,
];

/** The smallest step whose labels will not collide at this zoom. */
export function timeStepSec(pxPerSec: number, minLabelPx = 70): number {
  const wanted = minLabelPx / Math.max(1e-6, pxPerSec);
  for (const step of TIME_STEPS_SEC) if (step >= wanted) return step;
  return TIME_STEPS_SEC[TIME_STEPS_SEC.length - 1]!;
}

/**
 * The ruler's ticks for a format.
 *
 * Bars and beats delegate to the tempo map — a bar is not a fixed number of
 * seconds once there is a tempo change, and drawing it as one is how a ruler
 * ends up disagreeing with the grid the clips snap to.  The three clock
 * formats share one even-step generator, because they differ only in how a
 * number is written.
 */
export function rulerTicks(
  format: TimeFormat, view: Viewport, ctx: SpotContext, map: TempoMap, tempoBpm = 120,
): RulerTick[] {
  const endSec = view.scrollSec + view.widthPx / Math.max(1, view.pxPerSec);
  if (format === 'barsBeats') {
    // Beat lines appear once a bar is wide enough to hold them — measured at
    // the session's own tempo, because a bar at 60 BPM is twice the width of
    // one at 120 and a fixed guess would show them at the wrong zoom in half
    // the sessions.
    const barWidthPx = 4 * (60 / Math.max(1, tempoBpm)) * view.pxPerSec;
    return gridLines(map, view.scrollSec, endSec, { beats: barWidthPx > 90, maxLines: 400 })
      .map((line) => ({
        sec: line.sec,
        major: line.isBar,
        label: line.isBar ? String(line.bar) : null,
      }));
  }

  const step = timeStepSec(view.pxPerSec);
  const out: RulerTick[] = [];
  const first = Math.floor(view.scrollSec / step) * step;
  for (let i = 0, sec = first; sec <= endSec && i < 400; i++, sec = first + step * i) {
    if (sec < 0) continue;
    out.push({ sec, major: true, label: formatPosition(sec, format, ctx) });
  }
  return out;
}
