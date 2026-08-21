/**
 * control-surface-selftest — a physical knob wired to the session.
 *
 * A desk cannot be plugged into a test, so what is provable here is everything
 * between the message and the mix — and that is where the awkwardness of real
 * controllers lives:
 *
 *   PICKUP.  A fader at 0 and a track at −6 dB must not jump when brushed.
 *   The control does nothing until it CROSSES the value, and then it has it.
 *
 *   ENCODERS.  "Three clicks left" arrives in one of two encodings that look
 *   identical on the wire.  Both are read, and reading the wrong one turns the
 *   knob the wrong way at speed.
 *
 *   BUTTONS SEND TWO MESSAGES.  A toggle that acts on the release too fires
 *   twice and lands back where it started.
 *
 *   THE MAPPING IS DATA.  Hand-editable, copied between machines, corrupted.
 *   It is normalised on the way in, and a file for a track that no longer
 *   exists does nothing rather than throwing.
 *
 * Run: pnpm --filter @aimaster/desktop test:control-surface
 */

import {
  DEFAULT_RELATIVE_STEP, INITIAL_BINDING_STATE,
  applyBinding, bindingFor, conflictsIn, createBinding, describeSource, matchesSource,
  modeFor, normalised, relativeClicks, sourceKey, sourceOf,
  type ControlBinding, type ControlMessage, type ValueRange,
} from '../src/renderer/daw/model/control-surface.js';
import {
  applyControl, currentValueOf, rangeOf, toControlMessage,
} from '../src/renderer/daw/edit/control-surface-actions.js';
import {
  EXPORT_KIND, clearBindings, describeImport, exportSurface, importSurface,
  listBindings, putBinding, removeBinding, setSurfaceStore, storedConflicts,
  updateBinding, type SurfaceStore,
} from '../src/renderer/daw/engine/control-surface-store.js';
import {
  addTrack, createSend, createSession, createTrack, findTrack, setSend,
} from '../src/renderer/daw/model/session-ops.js';
import { setVolumeDb } from '../src/renderer/daw/model/mixer-math.js';
import { resetIds } from '../src/renderer/daw/model/ids.js';
import type { CaptureEvent } from '../src/renderer/daw/model/midi-capture.js';
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

// ── Fixtures ──────────────────────────────────────────────────────────────────

const cc = (controller: number, raw: number, channel = 0): ControlMessage =>
  ({ kind: 'cc', channel, number: controller, raw, pressed: raw > 0 });
const note = (pitch: number, raw: number, pressed: boolean, channel = 0): ControlMessage =>
  ({ kind: 'note', channel, number: pitch, raw, pressed });

const DB: ValueRange = { min: -60, max: 12 };

function memoryStore(seed: Record<string, string> = {}): SurfaceStore {
  const data: Record<string, string> = { ...seed };
  return { getItem: (k) => data[k] ?? null, setItem: (k, v) => { data[k] = v; } };
}

function fresh(): void {
  setSurfaceStore(memoryStore());
  clearBindings();
}

function sessionWithTrack(name = 'Vox'): { session: DawSession; track: Track } {
  resetIds();
  const base = createSession('surface test');
  const track = createTrack(name, 'audio');
  return { session: addTrack(base, track), track };
}

function faderBinding(over: Partial<ControlBinding> = {}): ControlBinding {
  return createBinding('map-1', { kind: 'cc', channel: null, controller: 7 },
    { kind: 'transport', command: 'play' }, { mode: 'absolute', ...over });
}

// ── 1. Identity and matching ──────────────────────────────────────────────────

check('a source has a stable key, and omni is spelled out', () => {
  eq(sourceKey({ kind: 'cc', channel: 2, controller: 7 }), 'cc:2:7', 'cc on a channel');
  eq(sourceKey({ kind: 'cc', channel: null, controller: 7 }), 'cc:*:7', 'cc omni');
  eq(sourceKey({ kind: 'note', channel: 0, pitch: 36 }), 'note:0:36', 'note');
  eq(sourceKey({ kind: 'pitchBend', channel: null }), 'bend:*', 'bend');
  assert(describeSource({ kind: 'cc', channel: 2, controller: 7 }).includes('채널 3'),
    'channels are printed one-based, the way the hardware labels them');
});

check('a channel-pinned source only matches its channel', () => {
  const pinned = { kind: 'cc' as const, channel: 2, controller: 7 };
  assert(matchesSource(pinned, cc(7, 64, 2)), 'its own channel');
  assert(!matchesSource(pinned, cc(7, 64, 3)), 'not another');
  const omni = { kind: 'cc' as const, channel: null, controller: 7 };
  assert(matchesSource(omni, cc(7, 64, 9)), 'omni takes any channel');
  assert(!matchesSource(omni, cc(8, 64, 9)), 'but not another controller');
});

check('a pinned binding beats an omni one on the same control', () => {
  const omni = faderBinding();
  const pinned = { ...faderBinding(), id: 'map-2', source: { kind: 'cc' as const, channel: 3, controller: 7 } };
  eq(bindingFor([omni, pinned], cc(7, 64, 3))?.id, 'map-2', 'the specific one wins');
  eq(bindingFor([omni, pinned], cc(7, 64, 5))?.id, 'map-1', 'and omni catches the rest');
  eq(bindingFor([omni, pinned], cc(9, 64, 3)), undefined, 'an unmapped control matches nothing');
});

check('two bindings on one control are reported, not resolved', () => {
  const a = faderBinding();
  const b = { ...faderBinding(), id: 'map-2' };
  const clashes = conflictsIn([a, b]);
  eq(clashes.length, 1, 'one clash');
  eq(clashes[0]?.bindings.length, 2, 'naming both');
  eq(conflictsIn([a]).length, 0, 'and a clean map has none');
});

// ── 2. Reading a message ──────────────────────────────────────────────────────

check('a message normalises over its own span', () => {
  close(normalised(cc(7, 0)), 0, 'bottom');
  close(normalised(cc(7, 127)), 1, 'top');
  close(normalised(cc(7, 64)), 64 / 127, 'middle');
  close(normalised({ kind: 'pitchBend', channel: 0, number: 0, raw: 16383, pressed: true }), 1,
    'a bend is 14-bit, not 7');
});

check('both encoder encodings are read, and they disagree on purpose', () => {
  // Signed bit: 0x41 is one click DOWN.  Two's complement: 0x41 is 65 → −63.
  eq(relativeClicks(0x01, 'signedBit'), 1, 'one up');
  eq(relativeClicks(0x41, 'signedBit'), -1, 'one down');
  eq(relativeClicks(0x03, 'signedBit'), 3, 'three up');
  eq(relativeClicks(0x43, 'signedBit'), -3, 'three down');

  eq(relativeClicks(1, 'twosComplement'), 1, 'one up');
  eq(relativeClicks(127, 'twosComplement'), -1, 'one down');
  eq(relativeClicks(63, 'twosComplement'), 63, 'the top of the up range');
  eq(relativeClicks(65, 'twosComplement'), -63, 'and of the down range');

  // Zero is the one value neither encoding can express as a turn.
  eq(relativeClicks(0, 'signedBit'), 0, 'no turn');
  eq(relativeClicks(0, 'twosComplement'), 0, 'no turn');
});

// ── 3. Pickup — the reason a surface is usable ───────────────────────────────

check('a fader below the value does nothing until it crosses', () => {
  const binding = faderBinding({ takeover: 'pickup' });
  // The track is at 0 dB (raw 0.833 of −60…12); the fader is at the bottom.
  let state = INITIAL_BINDING_STATE;

  const low = applyBinding(binding, cc(7, 10), state, 0, DB);
  eq(low.kind, 'ignored', 'a fader at the bottom does not drag the track down');
  assert(low.kind === 'ignored' && low.reason === 'pickup', 'and says why');
  state = low.state;

  const nearer = applyBinding(binding, cc(7, 90), state, 0, DB);
  eq(nearer.kind, 'ignored', 'still below the value');
  state = nearer.state;

  // 0 dB is at (0 − −60) / 72 = 0.8333 → CC 105.8.  Crossing it engages.
  const crossed = applyBinding(binding, cc(7, 110), state, 0, DB);
  eq(crossed.kind, 'value', 'crossing takes over');
  assert(crossed.kind === 'value' && crossed.value > 0, 'and lands where the fader is');
  state = crossed.state;
  assert(state.engaged, 'from now on it has the parameter');

  // Once engaged, everything moves — including going back down.
  const after = applyBinding(binding, cc(7, 10), state, 0, DB);
  eq(after.kind, 'value', 'no second handshake');
  assert(after.kind === 'value' && after.value < -50, 'it really goes down now');
});

check('jump takes the parameter the instant it is touched', () => {
  const binding = faderBinding({ takeover: 'jump' });
  const result = applyBinding(binding, cc(7, 0), INITIAL_BINDING_STATE, 0, DB);
  eq(result.kind, 'value', 'no waiting');
  close((result as { value: number }).value, -60, 'straight to the bottom');
});

check('a fader that is already where the value is engages immediately', () => {
  const binding = faderBinding({ takeover: 'pickup' });
  // −24 dB sits at (−24 + 60) / 72 = 0.5 → CC 63.5.
  const result = applyBinding(binding, cc(7, 64), INITIAL_BINDING_STATE, -24, DB);
  eq(result.kind, 'value', 'the first message is already a match');
});

check('invert reverses the travel', () => {
  const binding = faderBinding({ takeover: 'jump', invert: true });
  const bottom = applyBinding(binding, cc(7, 0), INITIAL_BINDING_STATE, 0, DB);
  close((bottom as { value: number }).value, 12, 'the bottom of the fader is the top of the range');
  const top = applyBinding(binding, cc(7, 127), INITIAL_BINDING_STATE, 0, DB);
  close((top as { value: number }).value, -60, 'and vice versa');
});

// ── 4. Encoders and buttons ───────────────────────────────────────────────────

check('an encoder adds to what is there and never needs pickup', () => {
  const binding = faderBinding({ mode: 'relative', relativeStep: DEFAULT_RELATIVE_STEP });
  const up = applyBinding(binding, cc(7, 0x01), INITIAL_BINDING_STATE, -24, DB);
  eq(up.kind, 'value', 'a click always lands');
  close((up as { value: number }).value, -24 + 72 * DEFAULT_RELATIVE_STEP, 'one click of the range');

  const down = applyBinding(binding, cc(7, 0x43), INITIAL_BINDING_STATE, -24, DB);
  close((down as { value: number }).value, -24 - 3 * 72 * DEFAULT_RELATIVE_STEP, 'three clicks down');

  const still = applyBinding(binding, cc(7, 0), INITIAL_BINDING_STATE, -24, DB);
  eq(still.kind, 'ignored', 'a message that is not a turn does nothing');
});

check('an encoder is clamped at both ends of the range', () => {
  const binding = faderBinding({ mode: 'relative', relativeStep: 0.5 });
  const over = applyBinding(binding, cc(7, 0x0f), INITIAL_BINDING_STATE, 0, DB);
  close((over as { value: number }).value, 12, 'cannot be turned past the top');
  const under = applyBinding(binding, cc(7, 0x4f), INITIAL_BINDING_STATE, 0, DB);
  close((under as { value: number }).value, -60, 'nor past the bottom');
});

check('a button acts on the press and ignores the release', () => {
  const toggle = faderBinding({ mode: 'toggle' });
  const range: ValueRange = { min: 0, max: 1, stepped: true };

  const press = applyBinding(toggle, note(36, 100, true), INITIAL_BINDING_STATE, 0, range);
  eq(press.kind, 'value', 'the press flips it');
  eq((press as { value: number }).value, 1, 'on');

  const release = applyBinding(toggle, note(36, 0, false), INITIAL_BINDING_STATE, 1, range);
  eq(release.kind, 'ignored', 'the release does not flip it back');
  assert(release.kind === 'ignored' && release.reason === 'release', 'and says why');

  const again = applyBinding(toggle, note(36, 100, true), INITIAL_BINDING_STATE, 1, range);
  eq((again as { value: number }).value, 0, 'a second press turns it off');
});

check('a trigger button fires once per press', () => {
  const trigger = faderBinding({ mode: 'trigger' });
  const range: ValueRange = { min: 0, max: 1 };
  eq(applyBinding(trigger, note(36, 100, true), INITIAL_BINDING_STATE, 0, range).kind, 'trigger',
    'the press fires');
  eq(applyBinding(trigger, note(36, 0, false), INITIAL_BINDING_STATE, 0, range).kind, 'ignored',
    'the release does not');
});

// ── 5. Learning ───────────────────────────────────────────────────────────────

check('learning reads the source and guesses the mode from the action', () => {
  const source = sourceOf(cc(74, 90, 5), true);
  eq(sourceKey(source), 'cc:*:74', 'omni by default — most desks use one channel');
  eq(sourceKey(sourceOf(cc(74, 90, 5), false)), 'cc:5:74', 'or pinned when asked');

  const param = { kind: 'param' as const, trackId: 't', target: { kind: 'volume' as const } };
  eq(modeFor(cc(74, 90), param), 'absolute', 'a CC on a parameter is a fader');
  eq(modeFor(note(36, 100, true), param), 'toggle', 'a note is a button, even on a parameter');
  eq(modeFor(cc(74, 90), { kind: 'transport', command: 'play' }), 'trigger',
    'the action decides first');
  eq(modeFor(cc(74, 90), { kind: 'trackSwitch', trackId: 't', what: 'mute' }), 'toggle',
    'a switch is a toggle whatever moved');
});

check('a new binding starts in pickup, because a jumping desk gets unplugged', () => {
  const binding = createBinding('x', { kind: 'cc', channel: null, controller: 7 },
    { kind: 'transport', command: 'play' });
  eq(binding.takeover, 'pickup', 'pickup');
  eq(binding.invert, false, 'not inverted');
  eq(binding.relative, 'signedBit', 'the commoner encoding');
});

// ── 6. Into the session ───────────────────────────────────────────────────────

check('a MIDI event becomes a surface message, or nothing', () => {
  const control = toControlMessage(
    { kind: 'cc', timeSec: 0, channel: 2, controller: 7, value: 100 / 127 });
  eq(control?.kind, 'cc', 'a controller');
  eq(control?.number, 7, 'its number');
  eq(control?.raw, 100, 'its value, back in sevens');

  const on = toControlMessage(
    { kind: 'noteOn', timeSec: 0, channel: 0, pitch: 36, velocity: 1 });
  assert(on?.pressed === true, 'a note-on is a press');
  const off = toControlMessage(
    { kind: 'noteOff', timeSec: 0, channel: 0, pitch: 36, velocity: 0.5 });
  assert(off?.pressed === false, 'a note-off is a release, and is KEPT so a toggle can ignore it');

  const pressure: CaptureEvent = { kind: 'channelPressure', timeSec: 0, channel: 0, value: 0.5 };
  eq(toControlMessage(pressure), null, 'aftertouch is not a control surface message');
});

check('a fader really moves the track volume', () => {
  const { session, track } = sessionWithTrack();
  const at0 = setVolumeDb(session, track.id, 0);
  const binding = createBinding('m', { kind: 'cc', channel: null, controller: 7 },
    { kind: 'param', trackId: track.id, target: { kind: 'volume' } },
    { mode: 'absolute', takeover: 'jump' });

  const outcome = applyControl(at0, binding, cc(7, 127), INITIAL_BINDING_STATE);
  eq(outcome.ignored, null, 'it moved');
  close(findTrack(outcome.session, track.id)?.volumeDb ?? -999, 12, 'to the top of the fader range');

  const down = applyControl(outcome.session, binding, cc(7, 0), outcome.state);
  close(findTrack(down.session, track.id)?.volumeDb ?? 999, -60, 'and back to the bottom');
});

check('a send level fader finds its own send', () => {
  const { session, track } = sessionWithTrack();
  const withSend = setSend(session, track.id, createSend(0, 'bus-1', { levelDb: 0 }));
  const send = findTrack(withSend, track.id)?.sends[0];
  assert(send !== undefined, 'the send exists');
  if (!send) return;

  const binding = createBinding('m', { kind: 'cc', channel: null, controller: 20 },
    { kind: 'param', trackId: track.id, target: { kind: 'sendLevel', sendId: send.id } },
    { mode: 'absolute', takeover: 'jump' });
  const outcome = applyControl(withSend, binding, cc(20, 127), INITIAL_BINDING_STATE);
  const moved = findTrack(outcome.session, track.id)?.sends[0];
  close(moved?.levelDb ?? -999, 12, 'the send went to the top, and nothing else did');
  close(findTrack(outcome.session, track.id)?.volumeDb ?? -999, 0, 'the fader stayed put');
});

check('a button toggles mute, once per press', () => {
  const { session, track } = sessionWithTrack();
  const binding = createBinding('m', { kind: 'note', channel: null, pitch: 36 },
    { kind: 'trackSwitch', trackId: track.id, what: 'mute' }, { mode: 'toggle' });

  const pressed = applyControl(session, binding, note(36, 100, true), INITIAL_BINDING_STATE);
  eq(findTrack(pressed.session, track.id)?.mute, true, 'muted');

  const released = applyControl(pressed.session, binding, note(36, 0, false), pressed.state);
  eq(findTrack(released.session, track.id)?.mute, true, 'the release changes nothing');
  eq(released.ignored, 'release', 'and says so');

  const again = applyControl(released.session, binding, note(36, 100, true), released.state);
  eq(findTrack(again.session, track.id)?.mute, false, 'the next press unmutes');
});

check('a transport button hands back a command rather than editing', () => {
  const { session } = sessionWithTrack();
  const binding = createBinding('m', { kind: 'note', channel: null, pitch: 40 },
    { kind: 'transport', command: 'play' }, { mode: 'trigger' });
  const outcome = applyControl(session, binding, note(40, 100, true), INITIAL_BINDING_STATE);
  eq(outcome.command, 'play', 'the command comes out');
  eq(outcome.session, session, 'and the session is untouched');
});

check('a binding pointing at a deleted track does nothing, and says which', () => {
  const { session } = sessionWithTrack();
  const binding = createBinding('m', { kind: 'cc', channel: null, controller: 7 },
    { kind: 'param', trackId: 'gone', target: { kind: 'volume' } },
    { mode: 'absolute', takeover: 'jump' });
  const outcome = applyControl(session, binding, cc(7, 127), INITIAL_BINDING_STATE);
  eq(outcome.ignored, 'missing', 'reported rather than thrown');
  eq(outcome.session, session, 'and nothing changed');
});

check('the range and the current value come from the same place the lane draws', () => {
  const { session, track } = sessionWithTrack();
  const at6 = setVolumeDb(session, track.id, -6);
  const action = { kind: 'param' as const, trackId: track.id, target: { kind: 'volume' as const } };
  close(currentValueOf(at6, action), -6, 'the value the fader reads');
  const range = rangeOf(at6, action);
  eq(range.min, -60, 'the bottom of a volume lane');
  eq(range.max, 12, 'and its top');

  const missing = { kind: 'param' as const, trackId: 'gone', target: { kind: 'volume' as const } };
  eq(currentValueOf(at6, missing), 0, 'a missing track reads zero rather than throwing');
});

// ── 7. The mapping is data ────────────────────────────────────────────────────

check('a saved binding survives a read back', () => {
  fresh();
  const binding = faderBinding({ label: '페이더 1' });
  assert(putBinding(binding).ok, 'saved');
  const back = listBindings()[0];
  eq(back?.id, 'map-1', 'the same binding');
  eq(back?.label, '페이더 1', 'with its label');
  eq(back?.takeover, 'pickup', 'and its settings');
});

check('learning a control that is already mapped replaces it', () => {
  fresh();
  putBinding(faderBinding());
  putBinding({ ...faderBinding(), id: 'map-2',
    action: { kind: 'transport', command: 'stop' } });
  eq(listBindings().length, 1, 'one binding on one control, not two');
  eq(listBindings()[0]?.id, 'map-2', 'and it is the new one');
  eq(storedConflicts().length, 0, 'so there is nothing to conflict');
});

check('a binding can be edited without being re-learned', () => {
  fresh();
  putBinding(faderBinding());
  assert(updateBinding('map-1', { invert: true, takeover: 'jump' }).ok, 'edited');
  const back = listBindings()[0];
  eq(back?.invert, true, 'inverted');
  eq(back?.takeover, 'jump', 'and jumping');
  eq(sourceKey(back!.source), 'cc:*:7', 'still on the same control');
  assert(!updateBinding('nope', { invert: true }).ok, 'editing something gone is refused');
});

check('delete removes exactly one', () => {
  fresh();
  putBinding(faderBinding());
  putBinding({ ...faderBinding(), id: 'map-2',
    source: { kind: 'cc', channel: null, controller: 8 } });
  assert(removeBinding('map-1'), 'removed');
  eq(listBindings().length, 1, 'one left');
  assert(!removeBinding('map-1'), 'removing it again does nothing and says so');
});

check('a corrupted store reads as empty instead of throwing', () => {
  setSurfaceStore(memoryStore({ 'loui.daw.control-surface': '{ not json' }));
  eq(listBindings().length, 0, 'no bindings');
  setSurfaceStore(memoryStore({
    'loui.daw.control-surface': JSON.stringify({ bindings: [{ id: 'x' }, null, 7] }),
  }));
  eq(listBindings().length, 0, 'malformed entries are filtered one by one');
});

check('a hand-edited binding is filled in rather than trusted', () => {
  setSurfaceStore(memoryStore({
    'loui.daw.control-surface': JSON.stringify({
      version: 1, enabled: true, deviceId: null,
      bindings: [{
        id: 'hand', mode: 'absolute',
        source: { kind: 'cc', channel: null, controller: 7 },
        action: { kind: 'transport', command: 'play' },
        // Everything else missing, and relativeStep nonsense.
        relativeStep: -5,
      }],
    }),
  }));
  const back = listBindings()[0];
  eq(back?.takeover, 'pickup', 'the safe default');
  eq(back?.invert, false, 'not inverted');
  eq(back?.relative, 'signedBit', 'a real encoding');
  assert((back?.relativeStep ?? 0) > 0, 'and a step that can actually move something');
});

check('a store that refuses to write reports failure rather than lying', () => {
  setSurfaceStore({
    getItem: () => null,
    setItem: () => { throw new Error('quota exceeded'); },
  });
  const result = putBinding(faderBinding());
  assert(!result.ok, 'the save is reported as failed');
  assert((result.ok ? '' : result.reason).includes('저장'), 'with a reason');
});

// ── 8. Files ──────────────────────────────────────────────────────────────────

check('export then import round trips a whole desk', () => {
  fresh();
  putBinding(faderBinding({ label: '페이더 1' }));
  putBinding({ ...faderBinding(), id: 'map-2', label: '노브 2',
    source: { kind: 'cc', channel: null, controller: 8 } });
  const file = exportSurface();
  eq((JSON.parse(file) as { kind: string }).kind, EXPORT_KIND, 'the file says what it is');

  fresh();
  const report = importSurface(file);
  eq(report.added, 2, 'both came back');
  eq(report.replaced, 0, 'nothing to replace');
  eq(listBindings().map((b) => b.label).sort().join(','), '노브 2,페이더 1', 'with their labels');
});

check('importing over a mapped control REPLACES it, and says how many', () => {
  fresh();
  putBinding(faderBinding({ label: '옛날' }));
  const file = exportSurface();
  // Same control, different action, coming in from a file.
  fresh();
  putBinding(faderBinding({ label: '지금',
    action: { kind: 'transport', command: 'stop' } }));
  const report = importSurface(file);
  eq(report.replaced, 1, 'one replaced');
  eq(report.added, 0, 'nothing added');
  eq(listBindings().length, 1, 'still one thing on that fader');
  eq(listBindings()[0]?.label, '옛날', 'the file won, because it is the newer statement');
  assert(describeImport(report).includes('교체'), 'and the summary says so');
});

check('someone else’s JSON is refused rather than half-imported', () => {
  fresh();
  eq(importSurface(JSON.stringify({ kind: 'some.other.app', bindings: [] })).added, 0,
    'a different kind is refused');
  eq(importSurface('{{{').added, 0, 'broken JSON adds nothing');
  eq(importSurface(JSON.stringify({ hello: 'world' })).added, 0, 'and neither does a stray object');
  eq(listBindings().length, 0, 'nothing landed');
});

// ── Report ────────────────────────────────────────────────────────────────────

setSurfaceStore(null);
const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log('\n=== Control surface: pickup · encoders · buttons · files ===');
for (const r of results) {
  console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
}
console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
if (failed > 0) process.exit(1);
