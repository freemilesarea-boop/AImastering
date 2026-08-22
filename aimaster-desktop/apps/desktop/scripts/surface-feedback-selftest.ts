/**
 * surface-feedback-selftest — sending the session back to the desk.
 *
 * A control surface with no feedback is a set of knobs that lie: the fader
 * sits where you left it while the track sits somewhere else, and the mute
 * button is dark on a muted track.
 *
 * The hazard the whole design is shaped around is the LOOP.  Send a fader
 * position out, the motor moves, the motor sends the position back in, that
 * sets the parameter, which sends it out again.  So the centrepiece here is a
 * closed circuit: a fake desk wired input-to-output through the real code,
 * run until it either settles or does not.
 *
 * Run: pnpm --filter @aimaster/desktop test:surface-feedback
 */

import {
  blackout, encodeFeedback, feedbackDiff, feedbackLevel, noteSent, quantise,
  resetSnapshot, DARK_TRANSPORT,
  type SurfaceSnapshot, type TransportLights,
} from '../src/renderer/daw/model/surface-feedback.js';
import {
  applyBinding, createBinding, sourceKey, INITIAL_BINDING_STATE,
  type BindingState, type ControlBinding, type ControlMessage, type ControlSource,
} from '../src/renderer/daw/model/control-surface.js';
import {
  applyControl, currentValueOf, rangeOf,
} from '../src/renderer/daw/edit/control-surface-actions.js';
import {
  addTrack, createSession, createTrack, findTrack, updateTrack,
} from '../src/renderer/daw/model/session-ops.js';
import { resetIds } from '../src/renderer/daw/model/ids.js';
import { SurfaceFeedback, FEEDBACK_INTERVAL_MS } from '../src/renderer/daw/engine/surface-feedback.js';
import type { DawSession } from '../src/renderer/daw/model/types.js';

const results: { name: string; pass: boolean }[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true }); console.log(`[PASS] ${name}`); }
  catch (err) {
    results.push({ name, pass: false });
    console.log(`[FAIL] ${name} — ${err instanceof Error ? err.message : String(err)}`);
  }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function eq(a: unknown, b: unknown, msg: string): void {
  if (a !== b) throw new Error(`${msg} — got ${String(a)}, want ${String(b)}`);
}
function close(a: number, b: number, msg: string, tol = 1e-9): void {
  if (!(Math.abs(a - b) <= tol)) throw new Error(`${msg} — got ${a}, want ${b} ±${tol}`);
}

/** A desk that records what it was sent, and can be told to echo it back. */
class FakeDesk {
  readonly sent: number[][] = [];
  failNext = false;
  send(bytes: number[]): void {
    if (this.failNext) { this.failNext = false; throw new Error('port gone'); }
    this.sent.push([...bytes]);
  }
  get last(): number[] | undefined { return this.sent[this.sent.length - 1]; }
  clear(): void { this.sent.length = 0; }
}

function sessionWith(): { session: DawSession; trackId: string } {
  resetIds();
  let session = createSession('surface', 48000);
  const track = createTrack('Vox', 'audio');
  session = addTrack(session, track);
  return { session, trackId: track.id };
}

const FADER: ControlSource = { kind: 'cc', channel: 0, controller: 7 };
const BUTTON: ControlSource = { kind: 'note', channel: 0, pitch: 16 };

function faderBinding(trackId: string): ControlBinding {
  return createBinding('b-fader', FADER,
    { kind: 'param', trackId, target: { kind: 'volume' } },
    { mode: 'absolute', takeover: 'jump' });
}

function inputs(
  session: DawSession,
  bindings: readonly ControlBinding[],
  lights: TransportLights = DARK_TRANSPORT,
) {
  return { bindings, session, lights, valueOf: currentValueOf, rangeOf, keyOf: sourceKey };
}

// ── Encoding ──────────────────────────────────────────────────────────────────

check('a CC carries the value, a note carries the lamp, a bend carries 14 bits', () => {
  eq(JSON.stringify(encodeFeedback(FADER, 100)), '[176,7,100]', 'CC on channel 1');
  // Note-on with velocity zero rather than note-off: every surface reads that
  // as "lamp off", and some read nothing else.
  eq(JSON.stringify(encodeFeedback(BUTTON, 0)), '[144,16,0]', 'lamp off is note-on 0');
  eq(JSON.stringify(encodeFeedback(BUTTON, 127)), '[144,16,127]', 'lamp on');
  const bend = encodeFeedback({ kind: 'pitchBend', channel: 3 }, 8192)!;
  eq(bend[0], 0xe3, 'bend on channel 4');
  eq(bend[1]! | (bend[2]! << 7), 8192, 'and the 14-bit value survives the split');
});

check('an omni binding is addressed on channel 1 rather than not at all', () => {
  // Omni is a RECEIVE-side idea; there is no "any channel" to send on.  The
  // alternative to picking one is no feedback for the commonest setup there is.
  const bytes = encodeFeedback({ kind: 'cc', channel: null, controller: 7 }, 64)!;
  eq(bytes[0], 0xb0, 'channel 1');
});

check('quantising is 7-bit for CC and 14-bit for bend', () => {
  eq(quantise(FADER, 1), 127, 'full');
  eq(quantise(FADER, 0), 0, 'off');
  eq(quantise(FADER, 0.5), 64, 'middle');
  eq(quantise({ kind: 'pitchBend', channel: 0 }, 1), 16383, 'bend is finer');
  eq(quantise(FADER, 5), 127, 'and out of range is clamped, not wrapped');
  eq(quantise(FADER, -3), 0, 'both ways');
});

// ── What a control should show ────────────────────────────────────────────────

check('a fader shows where the parameter is in its own range', () => {
  const { session, trackId } = sessionWith();
  const binding = faderBinding(trackId);
  const range = rangeOf(session, binding.action);
  // Volume runs from silence to +6, and 0 dB is not the middle of that.
  const atZero = feedbackLevel(binding, binding.action, 0, range, DARK_TRANSPORT)!;
  const atTop = feedbackLevel(binding, binding.action, range.max, range, DARK_TRANSPORT)!;
  const atBottom = feedbackLevel(binding, binding.action, range.min, range, DARK_TRANSPORT)!;
  close(atTop, 1, 'the top of the range is the top of the fader');
  close(atBottom, 0, 'and the bottom is the bottom');
  assert(atZero > 0 && atZero < 1, `unity sits inside — ${atZero}`);
});

check('an inverted binding is inverted on the way out too', () => {
  const { session, trackId } = sessionWith();
  const binding = { ...faderBinding(trackId), invert: true };
  const range = rangeOf(session, binding.action);
  const level = feedbackLevel(binding, binding.action, range.max, range, DARK_TRANSPORT)!;
  close(level, 0, 'a fader wired upside down reads upside down both ways');
});

check('an encoder is told nothing, because it has no position', () => {
  const { session, trackId } = sessionWith();
  const binding = { ...faderBinding(trackId), mode: 'relative' as const };
  const range = rangeOf(session, binding.action);
  eq(feedbackLevel(binding, binding.action, 0, range, DARK_TRANSPORT), null,
    'an endless encoder never claimed a position');
});

check('transport lamps light for states, and not for momentary buttons', () => {
  const lit: TransportLights = { playing: true, recording: false, loop: true };
  const make = (command: 'play' | 'stop' | 'record' | 'rewind' | 'toggleLoop'): ControlBinding =>
    createBinding(`t-${command}`, BUTTON, { kind: 'transport', command }, { mode: 'trigger' });
  const range = { min: 0, max: 1, stepped: true };
  const level = (command: Parameters<typeof make>[0]): number | null => {
    const b = make(command);
    return feedbackLevel(b, b.action, 0, range, lit);
  };
  eq(level('play'), 1, 'playing');
  eq(level('toggleLoop'), 1, 'looping');
  eq(level('record'), 0, 'not recording');
  // Stop and rewind are momentary — a lamp for them would only have to be
  // turned off again, and the desk cannot be wrong about a state that is not one.
  eq(level('stop'), null, 'stop has no state to be wrong about');
  eq(level('rewind'), null, 'nor rewind');
});

check('a mute button lights on a muted track', () => {
  const { session, trackId } = sessionWith();
  const binding = createBinding('b-mute', BUTTON,
    { kind: 'trackSwitch', trackId, what: 'mute' }, { mode: 'toggle' });
  const range = rangeOf(session, binding.action);
  eq(feedbackLevel(binding, binding.action, 0, range, DARK_TRANSPORT), 0, 'dark while open');
  const muted = updateTrack(session, trackId, (t) => ({ ...t, mute: true }));
  const value = currentValueOf(muted, binding.action);
  eq(feedbackLevel(binding, binding.action, value, range, DARK_TRANSPORT), 1, 'lit while muted');
});

// ── The diff ──────────────────────────────────────────────────────────────────

check('nothing is sent that the desk is already showing', () => {
  const { session, trackId } = sessionWith();
  const bindings = [faderBinding(trackId)];
  const shown: SurfaceSnapshot = new Map();

  const first = feedbackDiff(inputs(session, bindings), shown);
  eq(first.length, 1, 'the first push says everything');
  noteSent(shown, first);

  eq(feedbackDiff(inputs(session, bindings), shown).length, 0, 'the second says nothing');

  const moved = updateTrack(session, trackId, (t) => ({ ...t, volumeDb: -12 }));
  const after = feedbackDiff(inputs(moved, bindings), shown);
  eq(after.length, 1, 'and a real change says it again');
});

check('a change too small for the wire to carry is not sent', () => {
  // The parameter is a float and the wire is 7 bits.  Comparing in the
  // parameter's units would send a message the desk cannot represent, every
  // frame, for a fader being ridden by the mouse.
  const { session, trackId } = sessionWith();
  const shown: SurfaceSnapshot = new Map();
  const bindings = [faderBinding(trackId)];
  noteSent(shown, feedbackDiff(inputs(session, bindings), shown));

  const range = rangeOf(session, { kind: 'param', trackId, target: { kind: 'volume' } });
  const oneStep = (range.max - range.min) / 127;
  const nudged = updateTrack(session, trackId, (t) => ({ ...t, volumeDb: t.volumeDb + oneStep / 8 }));
  eq(feedbackDiff(inputs(nudged, bindings), shown).length, 0, 'an eighth of a step is not a message');

  const real = updateTrack(session, trackId, (t) => ({ ...t, volumeDb: t.volumeDb + oneStep * 2 }));
  eq(feedbackDiff(inputs(real, bindings), shown).length, 1, 'two steps is');
});

check('two bindings on one control produce one message, not two fighting', () => {
  const { session, trackId } = sessionWith();
  const shown: SurfaceSnapshot = new Map();
  const first = faderBinding(trackId);
  const second = createBinding('b-second', FADER,
    { kind: 'param', trackId, target: { kind: 'pan' } }, { mode: 'absolute' });
  const messages = feedbackDiff(inputs(session, [first, second]), shown);
  eq(messages.length, 1, 'one lamp, one message');
  eq(messages[0]?.bindingId, 'b-fader', 'and the first binding wins, as the table reports');
});

check('a reset makes everything be sent again', () => {
  const { session, trackId } = sessionWith();
  const shown: SurfaceSnapshot = new Map();
  const bindings = [faderBinding(trackId)];
  noteSent(shown, feedbackDiff(inputs(session, bindings), shown));
  eq(feedbackDiff(inputs(session, bindings), shown).length, 0, 'quiet');
  resetSnapshot(shown);
  eq(feedbackDiff(inputs(session, bindings), shown).length, 1,
    'and loud again after a bank switch');
});

check('blackout darkens every addressable control', () => {
  const { session, trackId } = sessionWith();
  const encoder = { ...createBinding('b-enc', { kind: 'cc', channel: 0, controller: 20 },
    { kind: 'param', trackId, target: { kind: 'pan' } }, { mode: 'relative' }) };
  const messages = blackout([faderBinding(trackId), encoder], sourceKey);
  eq(messages.length, 1, 'the encoder has no lamp to darken');
  eq(messages[0]?.raw, 0, 'and the fader goes to the bottom');
  void session;
});

// ── The loop ──────────────────────────────────────────────────────────────────

check('the feedback loop closes instead of running away', () => {
  // The circuit: session → feedback → desk → back in → session.  Wired to
  // itself and cranked, this either settles or it does not.
  const { session, trackId } = sessionWith();
  const binding = faderBinding(trackId);
  const desk = new FakeDesk();
  const driver = new SurfaceFeedback();
  driver.attach(desk);

  let current: DawSession = session;
  let state: BindingState = INITIAL_BINDING_STATE;
  let now = 0;
  const echoes: number[] = [];

  for (let round = 0; round < 40; round++) {
    now += FEEDBACK_INTERVAL_MS;
    const sent = driver.push(current, [binding], DARK_TRANSPORT, now);
    if (sent.length === 0) break;
    // The desk moves its motor and reports the new position straight back.
    for (const message of sent) {
      echoes.push(message.raw);
      const incoming: ControlMessage = {
        kind: 'cc', channel: 0, number: 7, raw: message.raw, pressed: true,
      };
      const outcome = applyControl(current, binding, incoming, state);
      state = outcome.state;
      current = outcome.session;
    }
  }

  // One send, one echo, and then silence: the echo lands on the same MIDI
  // byte, so the next diff has nothing to say.
  assert(echoes.length <= 2, `the loop closes — ${echoes.length} rounds: ${echoes.join(',')}`);
  assert(driver.stats.sent <= 2, `and the wire stays quiet — ${driver.stats.sent} messages`);
});

check('an echo does not walk the parameter down over time', () => {
  // The slow-drift version of the same bug: each round trip quantises, and a
  // value that is re-quantised from its own quantisation creeps.
  const { session, trackId } = sessionWith();
  const binding = faderBinding(trackId);
  const desk = new FakeDesk();
  const driver = new SurfaceFeedback();
  driver.attach(desk);

  let current = updateTrack(session, trackId, (t) => ({ ...t, volumeDb: -7.3 }));
  const started = findTrack(current, trackId)!.volumeDb;
  let state: BindingState = INITIAL_BINDING_STATE;
  let now = 0;

  for (let round = 0; round < 25; round++) {
    now += FEEDBACK_INTERVAL_MS;
    const sent = driver.push(current, [binding], DARK_TRANSPORT, now);
    for (const message of sent) {
      const outcome = applyControl(current, binding, {
        kind: 'cc', channel: 0, number: 7, raw: message.raw, pressed: true,
      }, state);
      state = outcome.state;
      current = outcome.session;
    }
  }

  const ended = findTrack(current, trackId)!.volumeDb;
  const range = rangeOf(current, binding.action);
  const step = (range.max - range.min) / 127;
  // One quantisation is unavoidable when a 7-bit desk takes over a control;
  // the failure being tested for is TWENTY-FIVE of them stacking up.
  assert(Math.abs(ended - started) <= step * 1.001,
    `no drift — ${started.toFixed(3)} → ${ended.toFixed(3)} dB, one step is ${step.toFixed(3)}`);
});

// ── The driver ────────────────────────────────────────────────────────────────

check('pushes are paced, so a ridden fader does not flood the wire', () => {
  const { session, trackId } = sessionWith();
  const binding = faderBinding(trackId);
  const desk = new FakeDesk();
  const driver = new SurfaceFeedback();
  driver.attach(desk);

  driver.push(session, [binding], DARK_TRANSPORT, 1000);
  eq(desk.sent.length, 1, 'the first goes');

  // A fader being dragged changes the session every frame.
  let current = session;
  for (let i = 1; i <= 10; i++) {
    current = updateTrack(current, trackId, (t) => ({ ...t, volumeDb: -20 + i }));
    driver.push(current, [binding], DARK_TRANSPORT, 1000 + i);   // 1 ms apart
  }
  eq(desk.sent.length, 1, 'and the rest are inside the interval');

  driver.push(current, [binding], DARK_TRANSPORT, 1000 + FEEDBACK_INTERVAL_MS + 1);
  eq(desk.sent.length, 2, 'until enough time has passed');
});

check('a forced push ignores the pacing — for a bank switch', () => {
  const { session, trackId } = sessionWith();
  const desk = new FakeDesk();
  const driver = new SurfaceFeedback();
  driver.attach(desk);
  driver.push(session, [faderBinding(trackId)], DARK_TRANSPORT, 0);
  desk.clear();
  driver.invalidate();
  driver.push(session, [faderBinding(trackId)], DARK_TRANSPORT, 1, true);
  eq(desk.sent.length, 1, 'the controls did not change value, they changed meaning');
});

check('a send that throws is retried, not recorded as delivered', () => {
  // A desk unplugged mid-session throws.  Recording the message as shown
  // would leave that control stale until its value happened to move again.
  const { session, trackId } = sessionWith();
  const binding = faderBinding(trackId);
  const desk = new FakeDesk();
  const driver = new SurfaceFeedback();
  driver.attach(desk);

  desk.failNext = true;
  eq(driver.push(session, [binding], DARK_TRANSPORT, 0).length, 0, 'nothing got through');
  eq(driver.stats.failed, 1, 'and it is counted');

  const delivered = driver.push(session, [binding], DARK_TRANSPORT, FEEDBACK_INTERVAL_MS + 1);
  eq(delivered.length, 1, 'so the next push says it again');
  eq(desk.sent.length, 1, 'and this time the desk has it');
});

check('with no port attached nothing is sent and nothing throws', () => {
  const { session, trackId } = sessionWith();
  const driver = new SurfaceFeedback();
  eq(driver.attached, false, 'no desk');
  eq(driver.push(session, [faderBinding(trackId)], DARK_TRANSPORT, 0).length, 0, 'and no messages');
  eq(driver.clear([faderBinding(trackId)]).length, 0, 'not even a blackout');
});

check('attaching a port forgets what the old one was showing', () => {
  const { session, trackId } = sessionWith();
  const binding = faderBinding(trackId);
  const first = new FakeDesk();
  const driver = new SurfaceFeedback();
  driver.attach(first);
  driver.push(session, [binding], DARK_TRANSPORT, 0);
  eq(first.sent.length, 1, 'the first desk was told');

  const second = new FakeDesk();
  driver.attach(second);
  driver.push(session, [binding], DARK_TRANSPORT, FEEDBACK_INTERVAL_MS + 1);
  eq(second.sent.length, 1, 'and so is the second — it powered up showing nothing');
});

check('pickup still works while feedback is on', () => {
  // Feedback moves the desk to the parameter, which is exactly the condition
  // pickup is waiting for — so the first physical touch must engage rather
  // than sit there refusing.
  const { session, trackId } = sessionWith();
  const binding = { ...faderBinding(trackId), takeover: 'pickup' as const };
  const range = rangeOf(session, binding.action);
  const shown: SurfaceSnapshot = new Map();
  const sent = feedbackDiff(inputs(session, [binding]), shown);
  eq(sent.length, 1, 'the desk is told where the parameter is');

  // The fader is now sitting at exactly that byte; the player nudges it.
  const outcome = applyBinding(binding, {
    kind: 'cc', channel: 0, number: 7, raw: sent[0]!.raw, pressed: true,
  }, INITIAL_BINDING_STATE, currentValueOf(session, binding.action), range);
  eq(outcome.kind, 'value', 'and it takes over immediately, having already caught up');
});

const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} passed${passed === results.length ? '' : `, ${results.length - passed} FAILED`}`);
if (passed !== results.length) process.exit(1);
