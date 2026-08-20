// Recording a move.
//
// A pass is: the transport is rolling, you take hold of a control, you move
// it, you let go.  What comes out has to be breakpoints on a lane — and which
// breakpoints depends entirely on the mode the track is in, which is the whole
// reason the five modes exist.
//
//   read    never writes.  A gesture in read mode is just moving the fader.
//   touch   writes while held, and hands the lane back afterwards.  The pass
//           is bracketed so the automation before and after it survives.
//   latch   writes from the first touch to the END OF THE PASS.  Letting go
//           does not stop it; stopping the transport does.
//   write   arms on play and writes the whole pass, touched or not.  It is the
//           destructive one, so it reverts to touch when the pass ends —
//           which is what every desk that has this mode does, for the reason
//           that one forgotten pass otherwise erases a whole mix.
//   trim    writes the lane PLUS your offset.  The shape underneath is kept
//           and the whole range moves with your hand.
//
// Everything here is pure.  The store holds the gesture and calls these; the
// arithmetic of what a mode means lives in one place and is tested directly.

import {
  pointValueAt, thinPoints, touchWrite, valueAt, writeRange,
} from '../model/automation.js';
import { findLane } from '../model/automation.js';
import {
  clampToRange, laneRange, setLanePoints, staticValue,
} from './automation-lanes.js';
import type {
  AutomationMode, AutomationPoint, AutomationTarget, DawSession, TrackId,
} from '../model/types.js';

/** One control, held, while the transport rolls. */
export interface AutomationGesture {
  trackId: TrackId;
  target: AutomationTarget;
  /**
   * The mode as it was when the pass began.
   *
   * Captured rather than read at commit time: changing the selector in the
   * middle of a pass must not retroactively reshape the move you already made.
   */
  mode: AutomationMode;
  /** Where the pass began — for latch and write, that is where writing starts. */
  startSec: number;
  /** Raw samples, in time order. */
  points: AutomationPoint[];
  /**
   * What the lane read at `startSec`, before the hand touched anything.
   * Trim needs it: your offset is measured from here.
   */
  baseValue: number;
  /** Still under the hand?  Latch and write keep writing after release. */
  held: boolean;
  /** The last time a sample was taken. */
  lastSec: number;
}

/** How close two samples have to be in time before the later one replaces it. */
const SAMPLE_MIN_GAP_SEC = 1e-4;

export function beginGesture(
  trackId: TrackId, target: AutomationTarget, mode: AutomationMode,
  atSec: number, value: number, baseValue: number,
): AutomationGesture {
  return {
    trackId,
    target,
    mode,
    startSec: Math.max(0, atSec),
    points: [{ timeSec: Math.max(0, atSec), value }],
    baseValue,
    held: true,
    lastSec: Math.max(0, atSec),
  };
}

/**
 * Add a sample.
 *
 * Samples arriving out of order are not an error — a loop wrapping round or a
 * seek during a pass both produce them — but they cannot go into the list,
 * because a lane is a sorted polyline and a backwards point would fold it.
 * The value replaces the last sample instead, so the control's position is
 * still current.
 */
export function sampleGesture(
  gesture: AutomationGesture, atSec: number, value: number,
): AutomationGesture {
  const t = Math.max(0, atSec);
  if (t <= gesture.lastSec + SAMPLE_MIN_GAP_SEC) {
    const points = gesture.points.slice(0, -1);
    points.push({ timeSec: gesture.lastSec, value });
    return { ...gesture, points };
  }
  return {
    ...gesture,
    points: [...gesture.points, { timeSec: t, value }],
    lastSec: t,
  };
}

/**
 * The hand came off the control.
 *
 * In touch mode that ends the pass.  In latch, write and trim it does not:
 * the value stays where it was left and keeps being written until the
 * transport stops, which is the entire difference between those modes.
 */
export function releaseGesture(
  gesture: AutomationGesture, atSec: number,
): AutomationGesture {
  const released = sampleGesture(gesture, atSec, lastValue(gesture));
  return { ...released, held: false };
}

/** True once nothing more will be written and the gesture can be committed. */
export function isFinished(gesture: AutomationGesture): boolean {
  return !gesture.held && gesture.mode === 'touch';
}

export function lastValue(gesture: AutomationGesture): number {
  return gesture.points[gesture.points.length - 1]?.value ?? gesture.baseValue;
}

/**
 * Write a finished gesture onto its lane.
 *
 * `endSec` is where the pass ended — the release for touch, the transport stop
 * for everything else.  The lane must already exist (the store creates it when
 * the gesture begins, so that its pre-gesture value is captured before the
 * hand moves anything); if it does not, there is nothing to anchor against and
 * the session comes back untouched.
 */
export function commitGesture(
  session: DawSession, gesture: AutomationGesture, endSec: number,
): DawSession {
  const track = session.tracks.find((t) => t.id === gesture.trackId);
  if (!track) return session;
  const lane = findLane(track.automation, gesture.target);
  if (!lane) return session;

  const range = laneRange(track, gesture.target);
  const fallback = staticValue(track, gesture.target);
  const stop = Math.max(gesture.startSec, endSec);

  // Everything that was recorded, clamped and reduced to the breakpoints that
  // reproduce the move.  A held fader samples sixty times a second; without
  // this a four-bar pass is a lane with two hundred points in it.
  const captured = thinPoints(
    gesture.points.map((p) => ({
      timeSec: p.timeSec,
      value: clampToRange(range, p.value),
    })),
    range.thinTolerance,
  );
  if (captured.length === 0) return session;

  const written = gesture.mode === 'trim'
    ? trimPoints(lane.points, captured, gesture.baseValue, fallback, range)
    : captured;

  if (gesture.mode === 'touch') {
    return setLanePoints(session, gesture.trackId, lane.id,
      touchWrite(lane, gesture.startSec, gesture.lastSec, written, fallback).points);
  }

  // Latch, write and trim all run to the end of the pass, so the last value
  // has to be extended there — otherwise the lane ramps back to whatever came
  // after, and a latched fader that was left up would slide down on its own.
  const tail = written[written.length - 1];
  const extended = tail && stop > tail.timeSec
    ? [...written, { timeSec: stop, value: tail.value }]
    : written;

  return setLanePoints(session, gesture.trackId, lane.id,
    writeRange(lane, gesture.startSec, stop, extended, fallback).points);
}

/**
 * Trim: the lane's own shape, moved by your offset.
 *
 * The offset at each sample is the hand's value minus what the lane read when
 * the pass began, and it is added to what the lane reads NOW at that time.  So
 * a fader parked 3 dB up lifts the whole range by 3 dB and keeps every move
 * that was already written in it — which is what trim is for.
 */
function trimPoints(
  lanePoints: readonly AutomationPoint[],
  captured: readonly AutomationPoint[],
  baseValue: number,
  fallback: number,
  range: ReturnType<typeof laneRange>,
): AutomationPoint[] {
  // The lane's own breakpoints inside the range have to be carried across too,
  // or trimming a shaped range would flatten it to the sample times.
  const from = captured[0]!.timeSec;
  const to = captured[captured.length - 1]!.timeSec;
  const times = new Set<number>(captured.map((p) => p.timeSec));
  for (const p of lanePoints) {
    if (p.timeSec >= from && p.timeSec <= to) times.add(p.timeSec);
  }

  return [...times].sort((a, b) => a - b).map((timeSec) => {
    const held = pointValueAt(captured, timeSec, baseValue);
    const underneath = pointValueAt(lanePoints, timeSec, fallback);
    return { timeSec, value: clampToRange(range, underneath + (held - baseValue)) };
  });
}

/**
 * What a lane reads at a time, for the UI.
 *
 * Wrapped here rather than called directly so that "off" means the same thing
 * everywhere: an off lane reads its static value, and the readout beside the
 * fader must agree with what the engine is doing.
 */
export function laneValueAt(
  session: DawSession, trackId: TrackId, target: AutomationTarget, timeSec: number,
): number {
  const track = session.tracks.find((t) => t.id === trackId);
  if (!track) return 0;
  const fallback = staticValue(track, target);
  const lane = findLane(track.automation, target);
  return lane ? valueAt(lane, timeSec, fallback) : fallback;
}

/**
 * After a destructive pass, write mode steps down to touch.
 *
 * Nobody leaves a desk in write on purpose, and the one time they forget, a
 * whole mix is erased by a pass that was meant to be a listen.  Every console
 * that has this mode does this; so does this one.
 */
export function demoteWriteModes(session: DawSession, trackIds: readonly TrackId[]): DawSession {
  const ids = new Set(trackIds);
  let changed = false;
  const tracks = session.tracks.map((track) => {
    if (!ids.has(track.id)) return track;
    if (!track.automation.some((lane) => lane.mode === 'write')) return track;
    changed = true;
    return {
      ...track,
      automation: track.automation.map((lane) => (
        lane.mode === 'write' ? { ...lane, mode: 'touch' as AutomationMode } : lane)),
    };
  });
  return changed ? { ...session, tracks } : session;
}
