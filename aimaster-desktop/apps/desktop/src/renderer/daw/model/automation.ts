// Automation — breakpoint lanes and the write modes that edit them.
//
// A lane is a sorted list of breakpoints.  Reading is linear interpolation
// with flat extrapolation past the ends (Pro Tools behaviour).  Writing is
// where the modes differ:
//
//   read   — never writes
//   touch  — writes only while the control is held, then returns to the
//            underlying pass by anchoring both edges of the touched range
//   latch  — writes from first touch to the end of the pass
//   write  — overwrites the whole pass
//   trim   — adds a relative delta to whatever is already there
//
// All functions are pure; the engine calls `valueAt` per block and the UI
// calls the writers on gesture end.

import type { AutomationLane, AutomationPoint, AutomationMode } from './types.js';
import { nextId } from './ids.js';

const EPS = 1e-9;

export function createLane(
  target: AutomationLane['target'],
  staticValue: number,
  mode: AutomationMode = 'read',
): AutomationLane {
  return {
    id: nextId('lane'),
    target,
    mode,
    points: [{ timeSec: 0, value: staticValue }],
    visible: false,
  };
}

export function sortPoints(points: AutomationPoint[]): AutomationPoint[] {
  return [...points].sort((a, b) => a.timeSec - b.timeSec);
}

/**
 * Lane value at a time.  `fallback` is the channel's static value, used when
 * the lane is empty or switched off.
 */
export function valueAt(lane: AutomationLane, timeSec: number, fallback: number): number {
  if (lane.mode === 'off') return fallback;
  return pointValueAt(lane.points, timeSec, fallback);
}

/** Breakpoint interpolation, independent of any lane wrapper. */
export function pointValueAt(
  points: readonly AutomationPoint[], timeSec: number, fallback: number,
): number {
  const pts = points;
  if (pts.length === 0) return fallback;
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (!first || !last) return fallback;
  if (timeSec <= first.timeSec) return first.value;
  if (timeSec >= last.timeSec) return last.value;

  // Binary search for the segment containing timeSec.
  let lo = 0;
  let hi = pts.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    const p = pts[mid];
    if (!p) break;
    if (p.timeSec <= timeSec) lo = mid; else hi = mid;
  }
  const a = pts[lo];
  const b = pts[hi];
  if (!a || !b) return fallback;
  const span = b.timeSec - a.timeSec;
  if (span <= EPS) return b.value;
  const t = (timeSec - a.timeSec) / span;
  return a.value + (b.value - a.value) * t;
}

/** Insert (or replace) a breakpoint.  Points closer than `snapSec` merge. */
export function insertPoint(
  lane: AutomationLane, point: AutomationPoint, snapSec = 1e-4,
): AutomationLane {
  const kept = lane.points.filter((p) => Math.abs(p.timeSec - point.timeSec) > snapSec);
  return { ...lane, points: sortPoints([...kept, point]) };
}

export function removePointsInRange(
  lane: AutomationLane, startSec: number, endSec: number,
): AutomationLane {
  const points = lane.points.filter((p) => p.timeSec < startSec - EPS || p.timeSec > endSec + EPS);
  return points.length === lane.points.length ? lane : { ...lane, points };
}

/**
 * Replace a range with new breakpoints.
 *
 * The anchors sit just OUTSIDE the range and hold the value the lane already
 * had there, so the automation before and after the pass is preserved exactly
 * and the written move starts at its own first value.  `edgeSec` is how wide
 * that boundary step is — 1 ms, small enough to be inaudible on a fader and
 * large enough that the two breakpoints never collapse onto each other.
 */
export const WRITE_EDGE_SEC = 0.001;

export function writeRange(
  lane: AutomationLane,
  startSec: number,
  endSec: number,
  written: AutomationPoint[],
  fallback: number,
  edgeSec = WRITE_EDGE_SEC,
): AutomationLane {
  if (endSec < startSec) return lane;
  const leftEdge  = Math.max(0, startSec - edgeSec);
  const rightEdge = endSec + edgeSec;
  const before = valueAt(lane, leftEdge, fallback);
  const after  = valueAt(lane, rightEdge, fallback);
  const outside = lane.points.filter((p) => p.timeSec < leftEdge - EPS || p.timeSec > rightEdge + EPS);
  const anchors: AutomationPoint[] = [
    { timeSec: leftEdge,  value: before },
    { timeSec: rightEdge, value: after },
  ];
  const inside = written.filter((p) => p.timeSec >= startSec - EPS && p.timeSec <= endSec + EPS);
  return { ...lane, points: sortPoints([...outside, anchors[0]!, ...inside, anchors[1]!]) };
}

/**
 * Touch: the written range is bracketed by the pre-existing value, so the
 * lane returns to the underlying automation on release.
 */
export function touchWrite(
  lane: AutomationLane, startSec: number, endSec: number,
  written: AutomationPoint[], fallback: number, returnSec = 0.15,
): AutomationLane {
  const returnTo = valueAt(lane, endSec + EPS, fallback);
  const withRamp: AutomationPoint[] = [
    ...written,
    { timeSec: endSec + returnSec, value: returnTo },
  ];
  return writeRange(lane, startSec, endSec + returnSec, withRamp, fallback);
}

/** Trim: shift every breakpoint in the range by a relative delta. */
export function trimRange(
  lane: AutomationLane, startSec: number, endSec: number, delta: number,
  clamp?: (v: number) => number,
): AutomationLane {
  const limit = clamp ?? ((v: number) => v);
  let touched = false;
  const points = lane.points.map((p) => {
    if (p.timeSec < startSec - EPS || p.timeSec > endSec + EPS) return p;
    touched = true;
    return { timeSec: p.timeSec, value: limit(p.value + delta) };
  });
  return touched ? { ...lane, points } : lane;
}

/** True when a mode writes during playback. */
export function isWritingMode(mode: AutomationMode): boolean {
  return mode === 'touch' || mode === 'latch' || mode === 'write' || mode === 'trim';
}

/**
 * Thin a recorded gesture down to breakpoints that reproduce it within
 * `toleranceValue` — a recorded fader move is 60 points/second otherwise.
 * (Ramer–Douglas–Peucker on the (time, value) polyline.)
 */
export function thinPoints(points: AutomationPoint[], toleranceValue: number): AutomationPoint[] {
  if (points.length <= 2) return [...points];
  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;

  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length > 0) {
    const segment = stack.pop();
    if (!segment) break;
    const [from, to] = segment;
    const a = points[from];
    const b = points[to];
    if (!a || !b || to - from < 2) continue;
    const span = b.timeSec - a.timeSec;
    let worst = 0;
    let worstIndex = -1;
    for (let i = from + 1; i < to; i++) {
      const p = points[i];
      if (!p) continue;
      const t = span <= EPS ? 0 : (p.timeSec - a.timeSec) / span;
      const projected = a.value + (b.value - a.value) * t;
      const err = Math.abs(p.value - projected);
      if (err > worst) { worst = err; worstIndex = i; }
    }
    if (worstIndex !== -1 && worst > toleranceValue) {
      keep[worstIndex] = true;
      stack.push([from, worstIndex], [worstIndex, to]);
    }
  }
  return points.filter((_, i) => keep[i]);
}
