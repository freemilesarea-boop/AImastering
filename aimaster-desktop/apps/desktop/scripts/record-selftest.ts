/**
 * record-selftest — recording: the plan, the passes, the tape, the takes.
 *
 * The capture itself needs a microphone, so what is provable here is the part
 * that decides what the capture MEANS:
 *
 *   Pre-roll and count-in are different things, and the plan says so.
 *   Punch is a window with an end; open recording is the same plan without one.
 *   A loop pass is a take — one continuous tape cut at the wrap points.
 *   Committing writes ONE file and points every take clip into it.
 *
 * Run: pnpm --filter @aimaster/desktop test:record
 */

import {
  DEFAULT_RECORD_SETTINGS, beatSeconds, countInSeconds, planRecording, plannedDuration,
  describePlan, loopPasses, armedTracks, setRecordArm, clearRecordArm, canRecord,
  takeName, passClipName, wouldOverlap, MIN_PASS_SEC,
  type RecordSettings,
} from '../src/renderer/daw/model/recording.js';
import { RecordBuffer } from '../src/renderer/daw/engine/record-buffer.js';
import { commitRecording, type AudioWriter } from '../src/renderer/daw/edit/record-actions.js';
import {
  addTrack, createClip, createSession, createTrack, findTrack, trackClips, updateClips,
} from '../src/renderer/daw/model/session-ops.js';
import { activePlaylist } from '../src/renderer/daw/model/session-ops.js';
import { resetIds } from '../src/renderer/daw/model/ids.js';
import {
  DEFAULT_INPUT_REF, describeInput, hasInputAssignment, inputRefFor, refreshHint,
  resolveTrackInput, trackInputRef,
} from '../src/renderer/daw/model/track-input.js';
import {
  assignInputDevice, clearTrackInput, describeAssignments, inputFor, planInputs,
  rememberResolved, setTrackInputChannels,
} from '../src/renderer/daw/edit/track-input-ops.js';
import { serializeDawSession, deserializeDawSession } from '../src/renderer/daw/model/session-io.js';
import type { DawSession, Track } from '../src/renderer/daw/model/types.js';

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }
function eq<T>(a: T, b: T, m: string): void {
  if (a !== b) throw new Error(`${m} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}
function close(a: number, b: number, m: string, tol = 1e-9): void {
  if (Math.abs(a - b) > tol) throw new Error(`${m} — got ${a}, want ${b} ±${tol}`);
}

const SR = 48000;

function settings(over: Partial<RecordSettings> = {}): RecordSettings {
  return { ...DEFAULT_RECORD_SETTINGS, ...over };
}

function sessionWithTrack(name = 'Vox'): { session: DawSession; track: Track } {
  resetIds();
  const base = createSession('record test');
  const track = createTrack(name, 'audio');
  return { session: addTrack(base, track), track };
}

/** A ramp, so a slice can be identified by the value it starts at. */
function ramp(seconds: number, sampleRate = SR): Float32Array {
  const out = new Float32Array(Math.round(seconds * sampleRate));
  for (let i = 0; i < out.length; i++) out[i] = i / sampleRate;
  return out;
}

// ── The plan ──────────────────────────────────────────────────────────────────

check('a bare plan records from the play head, open-ended', () => {
  const { session } = sessionWithTrack();
  const plan = planRecording(session, settings({ preRollSec: 0 }), 4);
  close(plan.recordStartSec, 4, 'starts at the play head', 1e-9);
  eq(plan.recordEndSec, null, 'and runs until stopped');
  close(plan.transportStartSec, 4, 'transport starts with it', 1e-9);
  close(plan.countInSec, 0, 'no clicks', 1e-9);
  eq(plannedDuration(plan), null, 'no planned length');
  eq(plan.loop, null, 'no loop');
});

check('pre-roll rolls the tape early without moving the punch', () => {
  const { session } = sessionWithTrack();
  const plan = planRecording(session, settings({ preRollSec: 2 }), 10);
  close(plan.recordStartSec, 10, 'the recording still starts at 10 s', 1e-9);
  close(plan.transportStartSec, 8, 'but the transport starts at 8', 1e-9);
  close(plan.preRollSec, 2, 'two seconds of run-up', 1e-9);
});

check('pre-roll is clamped by the start of the timeline', () => {
  const { session } = sessionWithTrack();
  const plan = planRecording(session, settings({ preRollSec: 5 }), 1.5);
  close(plan.transportStartSec, 0, 'cannot roll before zero', 1e-9);
  close(plan.preRollSec, 1.5, 'so the player gets what is left', 1e-9);
  close(plan.recordStartSec, 1.5, 'the punch does not move', 1e-9);
});

check('count-in is bars of clicks, not transport time', () => {
  const { session } = sessionWithTrack();
  close(countInSeconds(1, 120, 4), 2, 'one bar at 120 in 4/4', 1e-9);
  close(countInSeconds(2, 90, 3), 4, 'two bars of 3/4 at 90', 1e-9);
  close(countInSeconds(0, 120, 4), 0, 'no bars, no clicks', 1e-9);
  close(beatSeconds(120), 0.5, 'a beat at 120', 1e-12);

  const plan = planRecording(session, settings({ countInBars: 2, preRollSec: 0 }), 6);
  close(plan.countInSec, 4, 'two bars at 120 in 4/4', 1e-9);
  // The clicks happen BEFORE the transport moves, so they shift nothing.
  close(plan.transportStartSec, 6, 'the transport still starts at 6', 1e-9);
  close(plan.recordStartSec, 6, 'and so does the recording', 1e-9);
});

check('punch gives the recording an end', () => {
  const { session } = sessionWithTrack();
  const plan = planRecording(session, settings({
    punchEnabled: true, punchStartSec: 12, punchEndSec: 20, preRollSec: 2,
  }), 0);
  close(plan.recordStartSec, 12, 'punch in', 1e-9);
  close(plan.recordEndSec ?? 0, 20, 'punch out', 1e-9);
  close(plan.transportStartSec, 10, 'pre-roll ahead of the punch', 1e-9);
  close(plannedDuration(plan) ?? 0, 8, 'eight seconds planned', 1e-9);
  // The play head is ignored while punching — the punch IS the location.
  const moved = planRecording(session, settings({
    punchEnabled: true, punchStartSec: 12, punchEndSec: 20, preRollSec: 0,
  }), 99);
  close(moved.recordStartSec, 12, 'the play head does not override the punch', 1e-9);
});

check('a punch range given backwards is still a range', () => {
  const { session } = sessionWithTrack();
  const plan = planRecording(session, settings({
    punchEnabled: true, punchStartSec: 20, punchEndSec: 12,
  }), 0);
  close(plan.recordStartSec, 12, 'normalised start', 1e-9);
  close(plan.recordEndSec ?? 0, 20, 'normalised end', 1e-9);
});

check('an empty punch range is not a punch', () => {
  const { session } = sessionWithTrack();
  const plan = planRecording(session, settings({
    punchEnabled: true, punchStartSec: 5, punchEndSec: 5,
  }), 3);
  close(plan.recordStartSec, 3, 'falls back to the play head', 1e-9);
  eq(plan.recordEndSec, null, 'and stays open-ended');
});

check('the plan describes itself', () => {
  const { session } = sessionWithTrack();
  const plan = planRecording(session, settings({
    countInBars: 1, preRollSec: 2, punchEnabled: true, punchStartSec: 8, punchEndSec: 16,
  }), 0, { startSec: 4, endSec: 12 });
  const text = describePlan(plan);
  assert(text.includes('카운트인'), 'mentions the count-in');
  assert(text.includes('프리롤'), 'mentions the pre-roll');
  assert(text.includes('펀치'), 'mentions the punch');
  assert(text.includes('루프'), 'mentions the loop');
});

// ── Loop passes ───────────────────────────────────────────────────────────────

check('without a loop the whole capture is one take', () => {
  const passes = loopPasses(4, 10, null);
  eq(passes.length, 1, 'one pass');
  close(passes[0]?.timelineStartSec ?? 0, 4, 'placed where recording started', 1e-9);
  close(passes[0]?.captureFromSec ?? -1, 0, 'from the top of the tape', 1e-9);
  close(passes[0]?.captureToSec ?? 0, 10, 'to the end of it', 1e-9);
  eq(loopPasses(4, 0, null).length, 0, 'an empty capture has no passes');
});

check('a loop cuts the tape into one take per cycle', () => {
  // Loop 8–16 s (8 s cycle), recording started at the loop top, 24 s captured.
  const passes = loopPasses(8, 24, { startSec: 8, endSec: 16 });
  eq(passes.length, 3, 'three full cycles');
  passes.forEach((p, i) => {
    close(p.captureFromSec, i * 8, `pass ${i} starts at ${i * 8} s of tape`, 1e-9);
    close(p.captureToSec, (i + 1) * 8, `pass ${i} ends at ${(i + 1) * 8}`, 1e-9);
    close(p.timelineStartSec, 8, `pass ${i} sits at the loop start`, 1e-9);
  });
});

check('recording that starts mid-loop gives a short first pass', () => {
  // Punched in at 12 with the loop 8–16: the first pass is only 4 s long,
  // and every pass after it is a full cycle from the loop top.
  const passes = loopPasses(12, 20, { startSec: 8, endSec: 16 });
  eq(passes.length, 3, 'a partial pass plus two full ones');
  close(passes[0]?.captureToSec ?? 0, 4, 'first pass is 4 s of tape', 1e-9);
  close(passes[0]?.timelineStartSec ?? 0, 12, 'and belongs where the punch was', 1e-9);
  close(passes[1]?.captureFromSec ?? 0, 4, 'second pass follows it on the tape', 1e-9);
  close(passes[1]?.timelineStartSec ?? 0, 8, 'but sits at the loop start', 1e-9);
  close(passes[2]?.captureToSec ?? 0, 20, 'the last pass is truncated to the tape', 1e-9);
});

check('a sliver at the end is not a take', () => {
  // 16.05 s over an 8 s loop: two full passes plus 50 ms of nothing.
  const passes = loopPasses(8, 16.05, { startSec: 8, endSec: 16 });
  eq(passes.length, 2, `a ${MIN_PASS_SEC * 1000} ms tail is dropped`);
  // But a first pass is always kept, however short — it is what was played.
  const tiny = loopPasses(15.99, 0.01, { startSec: 8, endSec: 16 });
  eq(tiny.length, 1, 'the first pass survives at any length');
});

check('a recording that starts after the loop ends is not looped', () => {
  const passes = loopPasses(30, 5, { startSec: 8, endSec: 16 });
  eq(passes.length, 1, 'one plain take');
  close(passes[0]?.timelineStartSec ?? 0, 30, 'where it was recorded', 1e-9);
});

// ── Arming ────────────────────────────────────────────────────────────────────

check('arming is per track, and several at once is the point', () => {
  const { session, track } = sessionWithTrack();
  const second = createTrack('Gtr', 'audio');
  const two = addTrack(session, second);

  const armed = setRecordArm(two, track.id, true);
  eq(armedTracks(armed).length, 1, 'one armed');
  eq(armedTracks(armed)[0]?.id, track.id, 'the right one');

  const both = setRecordArm(armed, second.id, true);
  eq(armedTracks(both).length, 2, 'two armed');
  // Multi-track detail lives in multitrack-selftest; here it just has to be
  // true that two armed tracks are a take rather than a refusal.
  eq(canRecord(both, settings(), { audioOpen: [track.id, second.id] }).ok, true,
    'and both roll together');

  const cleared = clearRecordArm(both);
  eq(armedTracks(cleared).length, 0, 'cleared');
  eq(clearRecordArm(cleared), cleared, 'clearing nothing changes nothing');
});

check('recording refuses when it cannot do the right thing', () => {
  const { session, track } = sessionWithTrack();
  eq(canRecord(session, settings()).ok, false, 'nothing armed');
  assert(canRecord(session, settings()).reason?.includes('무장'), 'and says to arm a track');

  const armed = setRecordArm(session, track.id, true);
  eq(canRecord(armed, settings(), { audioOpen: [track.id] }).ok, true,
    'one armed audio track with its input open is enough');
  const noInput = canRecord(armed, settings(), { audioOpen: [] });
  eq(noInput.ok, false, 'without an input it is refused');
  assert(noInput.reason?.includes('Vox'), `naming the track — ${noInput.reason}`);

  const punchless = canRecord(
    armed, settings({ punchEnabled: true, punchStartSec: 4, punchEndSec: 4 }),
    { audioOpen: [track.id] });
  eq(punchless.ok, false, 'punch with no range');
  assert(punchless.reason?.includes('펀치'), 'and says why');

  // An instrument track records MIDI, and says so when no keyboard is open —
  // the readiness check is the same gate for both kinds of take.
  const instrument = addTrack(createSession('s'), createTrack('Synth', 'instrument'));
  const armedInstrument = setRecordArm(instrument, instrument.tracks[0]?.id ?? '', true);
  eq(canRecord(armedInstrument, settings(), { midiOpen: true }).ok, true,
    'an instrument track with a keyboard open can record');
  const noKeyboard = canRecord(armedInstrument, settings(), { midiOpen: false });
  eq(noKeyboard.ok, false, 'without one it is refused');
  assert(noKeyboard.reason?.includes('MIDI'), 'and says which input is missing');
});

check('takes are named like a tape op would', () => {
  const { session, track } = sessionWithTrack('Vox');
  const found = findTrack(session, track.id)!;
  eq(takeName(found), 'Vox.02', 'the second lane');
  eq(passClipName('Vox', { index: 0, captureFromSec: 0, captureToSec: 1, timelineStartSec: 0 }, 1),
    'Vox', 'a single take just uses the track name');
  eq(passClipName('Vox', { index: 2, captureFromSec: 0, captureToSec: 1, timelineStartSec: 0 }, 4),
    'Vox take 3', 'a loop pass is numbered');
});

check('overlap with the active take is detectable before recording', () => {
  const { session, track } = sessionWithTrack();
  const withClip = updateClips(session, track.id, () => [
    createClip('f', 'existing', { startSec: 4, durationSec: 4 }),
  ]);
  const found = findTrack(withClip, track.id)!;
  assert(wouldOverlap(found, 6, 10), 'overlapping range');
  assert(!wouldOverlap(found, 8, 12), 'a range that starts at the clip end is clear');
  assert(!wouldOverlap(found, 0, 4), 'and so is one that ends at its start');
});

// ── The tape ──────────────────────────────────────────────────────────────────

check('the record buffer concatenates chunks in order', () => {
  const buffer = new RecordBuffer(SR, 2);
  assert(buffer.isEmpty, 'starts empty');
  buffer.push([Float32Array.from([1, 2, 3]), Float32Array.from([-1, -2, -3])]);
  buffer.push([Float32Array.from([4, 5]), Float32Array.from([-4, -5])]);
  eq(buffer.frameCount, 5, 'five frames');
  close(buffer.durationSec, 5 / SR, 'duration follows the frame count', 1e-12);

  const [left, right] = buffer.toChannels();
  eq(Array.from(left ?? []).join(','), '1,2,3,4,5', 'left');
  eq(Array.from(right ?? []).join(','), '-1,-2,-3,-4,-5', 'right');

  buffer.clear();
  assert(buffer.isEmpty, 'cleared');
});

check('a mono capture from a stereo chunk keeps one channel', () => {
  const buffer = new RecordBuffer(SR, 1);
  buffer.push([Float32Array.from([1, 2]), Float32Array.from([9, 9])]);
  eq(buffer.toChannels().length, 1, 'one channel out');
  eq(Array.from(buffer.toChannels()[0] ?? []).join(','), '1,2', 'the first one');
});

check('a stereo capture from a mono chunk duplicates it', () => {
  const buffer = new RecordBuffer(SR, 2);
  buffer.push([Float32Array.from([1, 2])]);
  const [left, right] = buffer.toChannels();
  eq(Array.from(left ?? []).join(','), '1,2', 'left');
  eq(Array.from(right ?? []).join(','), '1,2', 'right is a copy, not silence');
});

check('the buffer can hand back a time slice', () => {
  const buffer = new RecordBuffer(SR, 1);
  buffer.push([ramp(1)]);
  const middle = buffer.slice(0.25, 0.5);
  eq(middle[0]?.length, Math.round(0.25 * SR), 'a quarter second');
  close(middle[0]?.[0] ?? -1, 0.25, 'starting at 0.25', 1e-6);
  const clamped = buffer.slice(0.9, 5);
  eq(clamped[0]?.length, Math.round(0.1 * SR), 'clamped to what was recorded');
});

// ── Commit ────────────────────────────────────────────────────────────────────

/** Captures what would be written, so the test never touches disk or IPC. */
function fakeWriter(): { writer: AudioWriter; calls: { channels: Float32Array[]; name: string }[] } {
  const calls: { channels: Float32Array[]; name: string }[] = [];
  const writer: AudioWriter = async (channels, _sampleRate, name) => {
    calls.push({ channels: channels.map((c) => Float32Array.from(c)), name });
    return `/tmp/${name}-${calls.length}.wav`;
  };
  return { writer, calls };
}

async function commitTest(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}

// ── Per-track input, saved with the project ───────────────────────────────────
//
// The assignment used to live in a Zustand map keyed by track id, which meant
// it lasted exactly as long as the window.  Saving it is not just moving the
// map: a MediaDevices id is issued by the browser, scoped to one machine, and
// rotates.  What travels is the NAME.

const DEVICES = [
  { id: 'dev-a', label: 'Scarlett 18i20' },
  { id: 'dev-b', label: 'Built-in Microphone' },
];

function withInput(name: string, ref: Parameters<typeof inputRefFor>[0], channels: 1 | 2 = 1) {
  const { session, track } = sessionWithTrack(name);
  return { session: assignInputDevice(session, track.id, ref, channels), track };
}

check('an assignment is stored by NAME, with the id only as a hint', () => {
  const { session, track } = withInput('Vox', DEVICES[0]!);
  const ref = trackInputRef(findTrack(session, track.id)!);
  eq(ref.deviceLabel, 'Scarlett 18i20', 'the name travels');
  eq(ref.deviceId, 'dev-a', 'and the id comes along as a hint');
  eq(describeInput(ref), 'Scarlett 18i20 · 모노', 'and reads back');
});

check('a track from before this existed reads as the system default', () => {
  const { session, track } = sessionWithTrack('Vox');
  const raw = findTrack(session, track.id)!;
  assert(raw.recordInput === undefined, 'the fixture has no assignment');
  eq(trackInputRef(raw).deviceLabel, null, 'no device');
  eq(hasInputAssignment(raw), false, 'and nothing to report');
  eq(resolveTrackInput(DEFAULT_INPUT_REF, DEVICES).kind, 'default', 'which is not a failure');
});

check('the saved id is used when the device still calls itself the same thing', () => {
  const { session, track } = withInput('Vox', DEVICES[0]!);
  const r = inputFor(session, track.id, DEVICES);
  eq(r.kind, 'id', 'found by id');
  eq(r.deviceId, 'dev-a', 'the right one');
  eq(r.reason, null, 'nothing to say');
});

check('an id that has been reissued to a DIFFERENT box is not trusted', () => {
  // Browsers hand the same id to whatever is plugged into that port next.
  // Taking it because the number matches is how a vocal ends up recorded
  // through a guitar DI.
  const { session, track } = withInput('Vox', DEVICES[0]!);
  const rotated = [{ id: 'dev-a', label: 'Some Other Interface' }];
  const r = inputFor(session, track.id, rotated);
  eq(r.kind, 'missing', 'the id is not enough');
  assert(r.reason?.includes('Scarlett'), `and it names what it wanted: ${r.reason}`);
});

check('the same interface after a reboot is found by name', () => {
  const { session, track } = withInput('Vox', DEVICES[0]!);
  const newIds = [{ id: 'dev-zz', label: 'Scarlett 18i20' }];
  const r = inputFor(session, track.id, newIds);
  eq(r.kind, 'label', 'found by name');
  eq(r.deviceId, 'dev-zz', 'with the id it has today');
  eq(r.reason, null, 'and this is normal, not a problem');
});

check('a device that is not here falls back to the default AND says so', () => {
  const { session, track } = withInput('Vox', DEVICES[0]!);
  const r = inputFor(session, track.id, [DEVICES[1]!]);
  eq(r.kind, 'missing', 'not found');
  eq(r.deviceId, null, 'the system default is used');
  assert(r.reason?.includes('Scarlett 18i20'), `named: ${r.reason}`);
  assert(r.reason?.includes('기본 입력'), `and what happened instead: ${r.reason}`);
});

check('the refreshed hint is written back only when the name did the finding', () => {
  const { session, track } = withInput('Vox', DEVICES[0]!);
  const newIds = [{ id: 'dev-zz', label: 'Scarlett 18i20' }];
  const found = inputFor(session, track.id, newIds);
  const after = rememberResolved(session, track.id, found);
  eq(trackInputRef(findTrack(after, track.id)!).deviceId, 'dev-zz', 'the hint is fresh');
  eq(trackInputRef(findTrack(after, track.id)!).deviceLabel, 'Scarlett 18i20', 'the name is untouched');
  // Found by id, or not found at all: nothing to rewrite.
  const byId = inputFor(session, track.id, DEVICES);
  eq(rememberResolved(session, track.id, byId), session, 'no write when the id was right');
  eq(refreshHint(trackInputRef(findTrack(session, track.id)!), byId).deviceId, 'dev-a', 'unchanged');
});

check('channel count is part of the assignment and survives a device change', () => {
  const { session, track } = withInput('Drums', DEVICES[0]!, 2);
  eq(trackInputRef(findTrack(session, track.id)!).channels, 2, 'stereo');
  const moved = assignInputDevice(session, track.id, DEVICES[1]!);
  eq(trackInputRef(findTrack(moved, track.id)!).channels, 2, 'still stereo on the new device');
  const mono = setTrackInputChannels(moved, track.id, 1);
  eq(trackInputRef(findTrack(mono, track.id)!).channels, 1, 'and can be changed on its own');
  eq(inputFor(mono, track.id, DEVICES).channels, 1, 'which the resolver carries through');
});

check('clearing puts a track back on the default', () => {
  const { session, track } = withInput('Vox', DEVICES[0]!);
  const cleared = clearTrackInput(session, track.id);
  eq(hasInputAssignment(findTrack(cleared, track.id)!), false, 'nothing assigned');
  eq(inputFor(cleared, track.id, DEVICES).kind, 'default', 'and that is the default');
});

check('setting the same thing twice does not touch the session', () => {
  const { session, track } = withInput('Vox', DEVICES[0]!);
  eq(assignInputDevice(session, track.id, DEVICES[0]!), session, 'same object back');
});

check('the assignment survives a save and a load', () => {
  const { session, track } = withInput('Vox', DEVICES[0]!, 2);
  const parsed = deserializeDawSession(serializeDawSession(session));
  assert(parsed.ok, 'the session loads');
  if (!parsed.ok) return;
  const ref = trackInputRef(parsed.session.tracks.find((t) => t.id === track.id)!);
  eq(ref.deviceLabel, 'Scarlett 18i20', 'the device name came back');
  eq(ref.channels, 2, 'and the channel count');
});

check('the plan covers every armed AUDIO track, and names what is missing', () => {
  resetIds();
  let s = createSession('band');
  const vox = createTrack('Vox', 'audio');
  const gtr = createTrack('Gtr', 'audio');
  const keys = createTrack('Keys', 'instrument');
  s = addTrack(addTrack(addTrack(s, vox), gtr), keys);
  s = assignInputDevice(s, vox.id, DEVICES[0]!);
  s = assignInputDevice(s, gtr.id, { id: 'gone', label: 'Old Preamp' });
  for (const id of [vox.id, gtr.id, keys.id]) s = setRecordArm(s, id, true);

  const plan = planInputs(s, DEVICES);
  eq(plan.items.length, 2, 'the MIDI track is not an input problem');
  eq(plan.items.map((i) => i.trackName).join(','), 'Vox,Gtr', 'both audio tracks');
  eq(plan.problems.length, 1, 'one problem');
  assert(plan.problems[0]?.includes('Gtr') && plan.problems[0]?.includes('Old Preamp'),
    `naming the track and the device: ${plan.problems[0]}`);
  eq(plan.items[0]!.resolution.deviceId, 'dev-a', 'and the one that resolved got its device');
});

check('the read-out lists what each track is on', () => {
  resetIds();
  let s = createSession('band');
  const vox = createTrack('Vox', 'audio');
  s = addTrack(s, vox);
  eq(describeAssignments(s), '입력 지정 없음', 'nothing yet');
  s = assignInputDevice(s, vox.id, DEVICES[0]!, 2);
  assert(describeAssignments(s).includes('Vox ← Scarlett 18i20 · 스테레오'), describeAssignments(s));
});

async function run(): Promise<void> {
  await commitTest('committing a plain take adds one lane and one clip', async () => {
    const { session, track } = sessionWithTrack('Vox');
    const armed = setRecordArm(session, track.id, true);
    const plan = planRecording(armed, settings({ preRollSec: 0 }), 4);
    const { writer, calls } = fakeWriter();

    const result = await commitRecording(
      armed, track.id, { channels: [ramp(3)], sampleRate: SR }, plan, settings(), writer);

    eq(result.takes, 1, 'one take');
    eq(calls.length, 1, 'one file written');
    eq(calls[0]?.channels[0]?.length, Math.round(3 * SR), 'the whole tape');

    const written = findTrack(result.session, track.id)!;
    eq(written.playlists.length, 2, 'the original lane plus the take');
    eq(written.activePlaylistId, result.activePlaylistId, 'the new take is active');
    const clips = activePlaylist(written)?.clips ?? [];
    eq(clips.length, 1, 'one clip');
    close(clips[0]?.startSec ?? 0, 4, 'placed at the record point', 1e-9);
    close(clips[0]?.durationSec ?? 0, 3, 'three seconds long', 1e-9);
    eq(clips[0]?.fileId, result.file.id, 'pointing at the written file');
  });

  await commitTest('the pre-roll is written but not kept', async () => {
    const { session, track } = sessionWithTrack();
    const plan = planRecording(setRecordArm(session, track.id, true), settings({ preRollSec: 2 }), 10);
    const { writer, calls } = fakeWriter();

    // 5 s of tape: 2 s of pre-roll then 3 s of take.  The ramp makes the cut
    // point visible in the samples themselves.
    const result = await commitRecording(
      session, track.id, { channels: [ramp(5)], sampleRate: SR }, plan, settings(), writer);

    const written = calls[0]?.channels[0];
    eq(written?.length, Math.round(3 * SR), 'only the take was written');
    close(written?.[0] ?? -1, 2, 'starting exactly where the pre-roll ended', 1e-6);

    const clips = activePlaylist(findTrack(result.session, track.id)!)?.clips ?? [];
    close(clips[0]?.startSec ?? 0, 10, 'the clip sits at the record point, not the transport start', 1e-9);
  });

  await commitTest('punch-out trims the tail even if the tape ran long', async () => {
    const { session, track } = sessionWithTrack();
    const punch = settings({ punchEnabled: true, punchStartSec: 4, punchEndSec: 8, preRollSec: 1 });
    const plan = planRecording(session, punch, 0);
    const { writer, calls } = fakeWriter();

    // 8 s captured: 1 s pre-roll, 4 s of punch, and 3 s the tick loop let run
    // past the punch-out before it stopped.
    await commitRecording(session, track.id, { channels: [ramp(8)], sampleRate: SR }, plan, punch, writer);
    eq(calls[0]?.channels[0]?.length, Math.round(4 * SR), 'exactly the punch window');
    close(calls[0]?.channels[0]?.[0] ?? -1, 1, 'starting after the pre-roll', 1e-6);
  });

  await commitTest('loop recording lays one lane per pass, all from one file', async () => {
    const { session, track } = sessionWithTrack('Vox');
    const loopSettings = settings({ preRollSec: 0, loopTakes: true });
    const plan = planRecording(session, loopSettings, 8, { startSec: 8, endSec: 16 });
    const { writer, calls } = fakeWriter();

    // Three passes through an 8 s loop.
    const result = await commitRecording(
      session, track.id, { channels: [ramp(24)], sampleRate: SR }, plan, loopSettings, writer);

    eq(result.takes, 3, 'three takes');
    eq(calls.length, 1, 'ONE file — takes are offsets into it, not copies');

    const written = findTrack(result.session, track.id)!;
    eq(written.playlists.length, 4, 'the original lane plus three takes');
    written.playlists.slice(1).forEach((lane, i) => {
      const clip = lane.clips[0];
      assert(!!clip, `lane ${i} has a clip`);
      close(clip!.startSec, 8, `take ${i + 1} sits at the loop start`);
      close(clip!.offsetSec, i * 8, `take ${i + 1} reads from ${i * 8} s of the file`, 1e-9);
      close(clip!.durationSec, 8, `take ${i + 1} is one cycle long`, 1e-9);
      eq(clip!.fileId, result.file.id, 'same file');
    });
    // The last pass is the one the player just finished.
    eq(written.activePlaylistId, written.playlists[written.playlists.length - 1]?.id,
      'the newest take is left active');
  });

  await commitTest('loop takes off records the loop as one continuous take', async () => {
    const { session, track } = sessionWithTrack();
    const flat = settings({ preRollSec: 0, loopTakes: false });
    const plan = planRecording(session, flat, 8, { startSec: 8, endSec: 16 });
    const { writer } = fakeWriter();
    const result = await commitRecording(
      session, track.id, { channels: [ramp(24)], sampleRate: SR }, plan, flat, writer);
    eq(result.takes, 1, 'one take');
    const clips = activePlaylist(findTrack(result.session, track.id)!)?.clips ?? [];
    close(clips[0]?.durationSec ?? 0, 24, 'all 24 seconds in one clip', 1e-9);
  });

  await commitTest('an empty tape is refused rather than written', async () => {
    const { session, track } = sessionWithTrack();
    const plan = planRecording(session, settings({ preRollSec: 0 }), 0);
    const { writer, calls } = fakeWriter();
    let threw = false;
    try {
      await commitRecording(session, track.id, { channels: [new Float32Array(0)], sampleRate: SR },
        plan, settings(), writer);
    } catch { threw = true; }
    assert(threw, 'nothing recorded is an error, not an empty clip');
    eq(calls.length, 0, 'and nothing was written');
  });

  await commitTest('a tape that is all pre-roll is refused', async () => {
    const { session, track } = sessionWithTrack();
    const plan = planRecording(session, settings({ preRollSec: 2 }), 10);
    const { writer } = fakeWriter();
    let threw = false;
    try {
      await commitRecording(session, track.id, { channels: [ramp(1.5)], sampleRate: SR },
        plan, settings(), writer);
    } catch { threw = true; }
    assert(threw, 'stopping during the pre-roll leaves nothing to keep');
  });

  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  console.log('\n=== Recording: plan · passes · tape · takes ===');
  for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
  if (failed > 0) process.exit(1);
}

void run();
