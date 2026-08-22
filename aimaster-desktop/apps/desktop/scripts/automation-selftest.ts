/**
 * automation-selftest — the five modes, and what they actually write.
 *
 * Automation is the one part of a mixer where doing nothing looks identical to
 * doing the right thing: a lane that was never written and a lane that was
 * written with the value it already had draw the same line.  The difference
 * only shows up at the edges — what happened to the automation BEFORE the
 * pass, and what happens AFTER you let go — and that is exactly what separates
 * touch from latch from write.
 *
 * So this file does not check that a pass "wrote something".  It reconstructs
 * a fader ride sample by sample, commits it, and then reads the lane back at
 * specific times to ask:
 *
 *   did the move land where I made it
 *   did the automation on either side of it survive
 *   did the fader come back on release (touch) or stay up (latch)
 *   did trim keep the shape underneath and move it
 *   did a pass in write mode disarm itself afterwards
 *
 * All of it against the same `pointValueAt` the engine reads with, so a lane
 * that passes here is a lane that plays back the same way.
 *
 * Run:  pnpm --filter @aimaster/desktop test:automation
 */

import {
  findLane, insertPoint, laneKey, movePoint, nearestPoint, pointValueAt,
  removePointAt, targetKey, thinPoints,
} from '../src/renderer/daw/model/automation.js';
import {
  availableTargets, clampToRange, describeTarget, ensureLane, isPlayable,
  laneRange, setLaneVisible, setStaticValue, staticValue, visibleLanes,
} from '../src/renderer/daw/edit/automation-lanes.js';
import {
  beginGesture, commitGesture, demoteWriteModes, isFinished, laneValueAt,
  releaseGesture, sampleGesture,
} from '../src/renderer/daw/edit/automation-record.js';
import {
  anyLiveAutomation, clearLiveAutomation, isLiveAutomation, setLiveAutomation,
} from '../src/renderer/daw/engine/automation-live.js';
import {
  createSend, createSession, createTrack, setSend, updateLane,
} from '../src/renderer/daw/model/session-ops.js';
import type {
  AutomationMode, AutomationTarget, DawSession, TrackId,
} from '../src/renderer/daw/model/types.js';

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }
function near(a: number, b: number, tol: number, what: string): void {
  assert(Math.abs(a - b) <= tol, `${what}: expected ${b}, got ${a.toFixed(3)}`);
}

const VOLUME: AutomationTarget = { kind: 'volume' };
const PAN: AutomationTarget = { kind: 'pan' };

/** A session with one audio track, at a known fader position. */
function fixture(volumeDb = 0): { session: DawSession; trackId: TrackId } {
  let session = createSession('automation');
  const track = createTrack('Vox', 'audio');
  session = { ...session, tracks: [...session.tracks, { ...track, volumeDb }] };
  return { session, trackId: track.id };
}

/**
 * Ride a fader.
 *
 * Exactly what the store does at runtime: create the lane before the hand
 * moves anything, then one sample per frame, then release.  Returns the
 * session with the pass committed.
 */
function ride(
  session: DawSession, trackId: TrackId, target: AutomationTarget, mode: AutomationMode,
  samples: Array<[number, number]>,
  options: { releaseAtSec?: number; passEndSec?: number } = {},
): DawSession {
  let next = ensureLane(session, trackId, target, mode).session;
  const track = next.tracks.find((t) => t.id === trackId)!;
  const start = samples[0]![0];
  const base = laneValueAt(next, trackId, target, start);

  let gesture = beginGesture(trackId, target, mode, start, staticValue(track, target), base);
  for (const [timeSec, value] of samples) {
    gesture = sampleGesture(gesture, timeSec, value);
    next = setStaticValue(next, trackId, target, value);
  }

  const releaseAt = options.releaseAtSec ?? samples[samples.length - 1]![0];
  gesture = releaseGesture(gesture, releaseAt);
  const end = isFinished(gesture) ? gesture.lastSec : (options.passEndSec ?? releaseAt);
  return commitGesture(next, gesture, end);
}

/** The lane's value at a time, the way the engine reads it. */
function read(session: DawSession, trackId: TrackId, target: AutomationTarget, at: number): number {
  return laneValueAt(session, trackId, target, at);
}

// ── Addressing ──────────────────────────────────────────────────────────────

check('a target has one name, whatever asks for it', () => {
  assert(targetKey({ kind: 'volume' }) === 'volume', 'volume');
  assert(targetKey({ kind: 'sendLevel', sendId: 's1' }) === 'sendLevel:s1', 'sends carry their id');
  assert(targetKey({ kind: 'sendLevel', sendId: 's2' }) !== targetKey({ kind: 'sendLevel', sendId: 's1' }),
    'two sends are two lanes');
  assert(targetKey({ kind: 'plugin', insertId: 'i1', paramId: 'mix' }) === 'plugin:i1:mix',
    'a plugin lane is a device and a parameter');
  assert(laneKey('t1', VOLUME) !== laneKey('t2', VOLUME), 'and the track is part of the address');
});

check('only the targets the engine plays are offered', () => {
  // The rule this file exists to protect: a lane that draws and does not play
  // is worse than no lane, because you would spend an afternoon on it.
  const { session, trackId } = fixture();
  const withSend = setSend(session, trackId,
    createSend(0, session.buses[0]?.id ?? 'bus', { levelDb: -12 }));
  const track = withSend.tracks.find((t) => t.id === trackId)!;
  const targets = availableTargets(track);

  assert(targets.some((t) => t.kind === 'volume'), 'volume');
  assert(targets.some((t) => t.kind === 'pan'), 'pan');
  assert(targets.some((t) => t.kind === 'sendLevel'), 'send level');
  for (const target of targets) {
    assert(isPlayable(target), `${targetKey(target)} is reproduced by the player`);
  }
  assert(!targets.some((t) => t.kind === 'plugin' || t.kind === 'mute' || t.kind === 'sendPan'),
    'and nothing the scheduler would ignore');
});

check('every lane knows its own scale', () => {
  const { session, trackId } = fixture();
  const track = session.tracks.find((t) => t.id === trackId)!;
  const volume = laneRange(track, VOLUME);
  assert(volume.min === -60 && volume.max === 12 && volume.unit === 'dB', 'volume is decibels');
  assert(volume.neutral === 0, 'and its nothing is unity');
  const pan = laneRange(track, PAN);
  assert(pan.min === -1 && pan.max === 1 && pan.neutral === 0, 'pan is centre-out');
  assert(clampToRange(volume, 99) === 12 && clampToRange(volume, -999) === -60, 'clamped both ends');
  assert(describeTarget(track, VOLUME).length > 0, 'and it has a name to show');
});

// ── Reading a lane ──────────────────────────────────────────────────────────

check('a lane reads flat past both ends, like the player', () => {
  const points = [{ timeSec: 1, value: -6 }, { timeSec: 3, value: 0 }];
  near(pointValueAt(points, 0, 99), -6, 1e-9, 'before the first point');
  near(pointValueAt(points, 2, 99), -3, 1e-9, 'interpolated between');
  near(pointValueAt(points, 9, 99), 0, 1e-9, 'after the last point');
  near(pointValueAt([], 5, 42), 42, 1e-9, 'an empty lane is its static value');
});

// ── Touch ───────────────────────────────────────────────────────────────────

check('touch writes the move and gives the lane back', () => {
  const { session, trackId } = fixture(-3);
  // An existing ride: −12 dB throughout the second half.
  let start = ensureLane(session, trackId, VOLUME).session;
  const laneId = findLane(start.tracks.find((t) => t.id === trackId)!.automation, VOLUME)!.id;
  start = updateLane(start, trackId, laneId, (l) => ({
    ...l,
    mode: 'touch',
    points: [{ timeSec: 0, value: -12 }, { timeSec: 20, value: -12 }],
  }));

  const after = ride(start, trackId, VOLUME, 'touch', [
    [4, -12], [4.5, -8], [5, -4], [5.5, -2], [6, -2],
  ]);

  near(read(after, trackId, VOLUME, 5), -4, 0.6, 'the move landed where it was made');
  near(read(after, trackId, VOLUME, 2), -12, 0.01, 'automation before the pass survived');
  // Touch ramps back over its return time, so read well clear of the release.
  near(read(after, trackId, VOLUME, 12), -12, 0.01, 'and the lane came back afterwards');
});

check('touch on a fresh lane returns to where the fader was', () => {
  const { session, trackId } = fixture(-6);
  const after = ride(session, trackId, VOLUME, 'touch', [
    [2, -6], [2.5, 0], [3, 3], [3.5, 3],
  ]);
  near(read(after, trackId, VOLUME, 3), 3, 0.5, 'the top of the ride is there');
  near(read(after, trackId, VOLUME, 0.5), -6, 0.01, 'before it, the fader position');
  near(read(after, trackId, VOLUME, 10), -6, 0.01, 'and after it, back to the fader position');
});

// ── Latch ───────────────────────────────────────────────────────────────────

check('latch keeps writing after the hand comes off', () => {
  const { session, trackId } = fixture(0);
  // Held up to +4 by t=3, released at 3, transport runs to 12.
  const after = ride(session, trackId, VOLUME, 'latch', [
    [2, 0], [2.5, 2], [3, 4],
  ], { releaseAtSec: 3, passEndSec: 12 });

  near(read(after, trackId, VOLUME, 3), 4, 0.3, 'the value where the hand left it');
  near(read(after, trackId, VOLUME, 8), 4, 0.3, 'is still there five seconds later');
  near(read(after, trackId, VOLUME, 12), 4, 0.3, 'and at the end of the pass');
  near(read(after, trackId, VOLUME, 1), 0, 0.01, 'before the pass, untouched');
});

check('the difference between touch and latch is measurable', () => {
  // Same ride, same times, two modes.  If these came out the same, one of the
  // two modes would not exist.
  const { session, trackId } = fixture(0);
  const samples: Array<[number, number]> = [[2, 0], [2.5, 3], [3, 6]];
  const touched = ride(session, trackId, VOLUME, 'touch', samples,
    { releaseAtSec: 3, passEndSec: 12 });
  const latched = ride(session, trackId, VOLUME, 'latch', samples,
    { releaseAtSec: 3, passEndSec: 12 });

  near(read(touched, trackId, VOLUME, 10), 0, 0.01, 'touch let go');
  near(read(latched, trackId, VOLUME, 10), 6, 0.3, 'latch did not');
});

// ── Write ───────────────────────────────────────────────────────────────────

check('write runs to the end of the pass and then disarms itself', () => {
  const { session, trackId } = fixture(0);
  let start = ensureLane(session, trackId, VOLUME, 'write').session;
  const laneId = findLane(start.tracks.find((t) => t.id === trackId)!.automation, VOLUME)!.id;
  start = updateLane(start, trackId, laneId, (l) => ({
    ...l, points: [{ timeSec: 0, value: -20 }, { timeSec: 30, value: -20 }],
  }));

  const after = ride(start, trackId, VOLUME, 'write', [
    [0, 0], [1, -2], [2, -4],
  ], { releaseAtSec: 2, passEndSec: 10 });
  near(read(after, trackId, VOLUME, 1), -2, 0.3, 'the pass is what the lane says now');
  near(read(after, trackId, VOLUME, 8), -4, 0.3, 'all the way to the end of it');

  // The safety every desk has: one forgotten selector must not erase the next
  // pass as well.
  const disarmed = demoteWriteModes(after, [trackId]);
  const lane = findLane(disarmed.tracks.find((t) => t.id === trackId)!.automation, VOLUME)!;
  assert(lane.mode === 'touch', `write steps down to touch, got ${lane.mode}`);
  const twice = demoteWriteModes(disarmed, [trackId]);
  assert(twice === disarmed, 'and doing it again changes nothing');
});

// ── Trim ────────────────────────────────────────────────────────────────────

check('trim moves the shape it finds instead of replacing it', () => {
  const { session, trackId } = fixture(0);
  let start = ensureLane(session, trackId, VOLUME, 'trim').session;
  const laneId = findLane(start.tracks.find((t) => t.id === trackId)!.automation, VOLUME)!.id;
  // A ramp underneath: −10 dB rising to −2 dB across the range being trimmed.
  start = updateLane(start, trackId, laneId, (l) => ({
    ...l,
    points: [
      { timeSec: 0, value: -10 }, { timeSec: 2, value: -10 },
      { timeSec: 6, value: -2 }, { timeSec: 20, value: -2 },
    ],
  }));

  // The fader is parked 3 dB above where the lane had it, and held there.
  const before2 = read(start, trackId, VOLUME, 2);
  const before5 = read(start, trackId, VOLUME, 5);
  const after = ride(start, trackId, VOLUME, 'trim', [
    [2, before2 + 3], [3.5, before2 + 3], [5, before2 + 3],
  ], { releaseAtSec: 5, passEndSec: 5 });

  near(read(after, trackId, VOLUME, 2), before2 + 3, 0.3, 'the start of the range moved up 3 dB');
  near(read(after, trackId, VOLUME, 5), before5 + 3, 0.4, 'and so did the end');
  assert(read(after, trackId, VOLUME, 5) > read(after, trackId, VOLUME, 2) + 2,
    'the ramp underneath is still a ramp, not flattened');
  near(read(after, trackId, VOLUME, 0.5), -10, 0.01, 'outside the range, nothing moved');
});

// ── The gesture itself ──────────────────────────────────────────────────────

check('samples that arrive out of order do not fold the lane', () => {
  // A loop wrapping round mid-pass produces exactly this.
  let g = beginGesture('t', VOLUME, 'touch', 1, 0, 0);
  g = sampleGesture(g, 1.2, -2);
  g = sampleGesture(g, 1.4, -4);
  g = sampleGesture(g, 0.3, -8);      // backwards
  g = sampleGesture(g, 1.6, -6);
  for (let i = 1; i < g.points.length; i++) {
    assert(g.points[i]!.timeSec >= g.points[i - 1]!.timeSec, `point ${i} is not before ${i - 1}`);
  }
  assert(g.points[g.points.length - 1]!.timeSec === 1.6, 'and the pass carried on');
  assert(g.points.some((p) => p.value === -8), 'the backwards value replaced the last, not the list');
});

check('a held fader becomes breakpoints, not sixty per second', () => {
  // Two hundred samples of a straight ramp are two breakpoints.
  const raw = Array.from({ length: 200 }, (_, i) => ({
    timeSec: i / 60, value: -20 + (i / 199) * 20,
  }));
  const thinned = thinPoints(raw, 0.15);
  assert(thinned.length < 8, `a ramp thins to a handful (${thinned.length})`);
  for (const p of raw) {
    near(pointValueAt(thinned, p.timeSec, 0), p.value, 0.2, `t=${p.timeSec.toFixed(2)} still reads right`);
  }
});

check('release ends the pass for touch and not for the others', () => {
  for (const mode of ['touch', 'latch', 'write', 'trim'] as const) {
    let g = beginGesture('t', VOLUME, mode, 0, 0, 0);
    g = sampleGesture(g, 1, -6);
    g = releaseGesture(g, 1.2);
    assert(!g.held, `${mode}: the hand is off`);
    assert(isFinished(g) === (mode === 'touch'), `${mode}: finished === touch`);
  }
});

check('a pass in read mode writes nothing', () => {
  // Not enforced here but at the store's door; what this checks is that the
  // lane is untouched when nobody commits a gesture to it.
  const { session, trackId } = fixture(-4);
  const opened = ensureLane(session, trackId, VOLUME, 'read').session;
  const moved = setStaticValue(opened, trackId, VOLUME, 2);
  const lane = findLane(moved.tracks.find((t) => t.id === trackId)!.automation, VOLUME)!;
  assert(lane.points.length === 1 && lane.points[0]!.value === -4,
    'the lane still holds the value it was opened with');
  assert(moved.tracks.find((t) => t.id === trackId)!.volumeDb === 2, 'and the fader moved');
});

// ── Lanes as objects ────────────────────────────────────────────────────────

check('a new lane starts at the control, not at zero', () => {
  const { session, trackId } = fixture(-8);
  const { session: opened, laneId } = ensureLane(session, trackId, VOLUME);
  const lane = findLane(opened.tracks.find((t) => t.id === trackId)!.automation, VOLUME)!;
  assert(lane.id === laneId, 'the id comes back');
  assert(lane.points.length === 1, 'one point');
  near(lane.points[0]!.value, -8, 1e-9, 'holding the fader position');
  assert(lane.visible, 'and it is showing');

  const again = ensureLane(opened, trackId, VOLUME);
  assert(again.session === opened, 'asking twice does not make a second lane');
});

check('folding a lane away keeps its automation', () => {
  const { session, trackId } = fixture(0);
  const ridden = ride(session, trackId, VOLUME, 'touch', [[1, 0], [2, -6], [3, -6]]);
  const before = findLane(ridden.tracks.find((t) => t.id === trackId)!.automation, VOLUME)!;
  const hidden = setLaneVisible(ridden, trackId, VOLUME, false);
  const after = findLane(hidden.tracks.find((t) => t.id === trackId)!.automation, VOLUME)!;
  assert(!after.visible, 'folded away');
  assert(after.points.length === before.points.length, 'with every breakpoint still on it');
  assert(visibleLanes(hidden.tracks.find((t) => t.id === trackId)!).length === 0, 'and out of the list');

  const shown = setLaneVisible(hidden, trackId, VOLUME, true);
  assert(visibleLanes(shown.tracks.find((t) => t.id === trackId)!).length === 1, 'it comes back');
});

// ── Editing by hand ─────────────────────────────────────────────────────────

check('a breakpoint can be added, moved and deleted', () => {
  const { session, trackId } = fixture(0);
  const opened = ensureLane(session, trackId, VOLUME).session;
  const laneId = findLane(opened.tracks.find((t) => t.id === trackId)!.automation, VOLUME)!.id;

  let s = updateLane(opened, trackId, laneId, (l) => insertPoint(l, { timeSec: 4, value: -9 }));
  let lane = findLane(s.tracks.find((t) => t.id === trackId)!.automation, VOLUME)!;
  assert(lane.points.length === 2, 'added');
  near(read(s, trackId, VOLUME, 4), -9, 1e-9, 'and it reads there');

  const index = lane.points.findIndex((p) => p.timeSec === 4);
  s = updateLane(s, trackId, laneId, (l) => movePoint(l, index, 6, -3));
  lane = findLane(s.tracks.find((t) => t.id === trackId)!.automation, VOLUME)!;
  near(lane.points[index]!.timeSec, 6, 1e-9, 'moved in time');
  near(lane.points[index]!.value, -3, 1e-9, 'and in value');

  s = updateLane(s, trackId, laneId, (l) => removePointAt(l, index));
  lane = findLane(s.tracks.find((t) => t.id === trackId)!.automation, VOLUME)!;
  assert(lane.points.length === 1, 'deleted');
});

check('a dragged breakpoint cannot pass its neighbours', () => {
  const { session, trackId } = fixture(0);
  const opened = ensureLane(session, trackId, VOLUME).session;
  const laneId = findLane(opened.tracks.find((t) => t.id === trackId)!.automation, VOLUME)!.id;
  let s = opened;
  for (const t of [2, 4, 6]) {
    s = updateLane(s, trackId, laneId, (l) => insertPoint(l, { timeSec: t, value: 0 }));
  }
  const lane = findLane(s.tracks.find((t) => t.id === trackId)!.automation, VOLUME)!;
  const middle = lane.points.findIndex((p) => p.timeSec === 4);

  // Dragged far past the point on its left.
  const dragged = movePoint(lane, middle, -5, 0);
  assert(dragged.points[middle]!.timeSec > dragged.points[middle - 1]!.timeSec,
    'it stops just short on the left');
  const right = movePoint(lane, middle, 99, 0);
  assert(right.points[middle]!.timeSec < right.points[middle + 1]!.timeSec,
    'and on the right');
  for (let i = 1; i < right.points.length; i++) {
    assert(right.points[i]!.timeSec >= right.points[i - 1]!.timeSec, 'still sorted');
  }
});

check('the pointer finds the breakpoint it is over, and only that one', () => {
  const points = [
    { timeSec: 1, value: 0 }, { timeSec: 2, value: -6 }, { timeSec: 3, value: -12 },
  ];
  assert(nearestPoint(points, 2.02, -6.1, 0.1, 0.5) === 1, 'the one under the pointer');
  assert(nearestPoint(points, 2.02, 0, 0.1, 0.5) === -1, 'right time, wrong height — nothing');
  assert(nearestPoint(points, 5, -6, 0.1, 0.5) === -1, 'nowhere near — nothing');
  assert(nearestPoint([], 1, 0, 1, 1) === -1, 'an empty lane has nothing to hit');
});

// ── The hand beats the lane ─────────────────────────────────────────────────

check('a lane being recorded is flagged for the scheduler', () => {
  clearLiveAutomation();
  assert(!anyLiveAutomation(), 'nothing live to start with');
  assert(!isLiveAutomation(laneKey('t1', VOLUME)), 'and no key is');

  setLiveAutomation([laneKey('t1', VOLUME)]);
  assert(isLiveAutomation(laneKey('t1', VOLUME)), 'the one being written is live');
  assert(!isLiveAutomation(laneKey('t1', PAN)), 'its neighbours are not');
  assert(!isLiveAutomation(laneKey('t2', VOLUME)), 'nor the same control on another track');

  setLiveAutomation([]);
  assert(!anyLiveAutomation(), 'and the pass ending clears it');
  // An offline bounce has no hands on it, so every lane must play.
  assert(!isLiveAutomation(laneKey('t1', VOLUME)), 'a render sees no live lanes');
});

// ── The whole thing, twice over ─────────────────────────────────────────────

check('two passes on one lane compose instead of erasing', () => {
  const { session, trackId } = fixture(0);
  const first = ride(session, trackId, VOLUME, 'touch', [[1, 0], [1.5, -8], [2, -8], [2.5, 0]]);
  const second = ride(first, trackId, VOLUME, 'touch', [[6, 0], [6.5, 5], [7, 5], [7.5, 0]]);

  near(read(second, trackId, VOLUME, 1.75), -8, 0.6, 'the first move is still there');
  near(read(second, trackId, VOLUME, 6.75), 5, 0.6, 'and the second one too');
  near(read(second, trackId, VOLUME, 4), 0, 0.1, 'with the fader position in between');
});

check('a pass on one track leaves the others alone', () => {
  let session = createSession('two');
  const a = createTrack('A', 'audio');
  const b = createTrack('B', 'audio');
  session = { ...session, tracks: [...session.tracks, a, b] };

  const after = ride(session, a.id, VOLUME, 'touch', [[1, 0], [2, -10], [3, -10]]);
  const other = after.tracks.find((t) => t.id === b.id)!;
  assert(other.automation.length === 0, 'the other track has no lane');
  assert(other.volumeDb === b.volumeDb, 'and its fader did not move');
});

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log('\n=== Automation — lanes, modes, gestures ===');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
if (failed > 0) process.exit(1);
