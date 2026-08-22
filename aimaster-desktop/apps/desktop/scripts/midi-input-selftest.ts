/**
 * midi-input-selftest — the keyboard path: bytes → events → notes → takes.
 *
 * A keyboard cannot be plugged into a test, so what is provable here is
 * everything between the wire and the session, which is where the bugs are:
 *
 *   A note is a PAIR, and the awkward pairs are the real ones — the same key
 *   struck twice before either release, a key still down when the tape stops,
 *   a key released under the pedal.
 *   The wheel belongs to what is sounding, on that channel, and to nothing else.
 *   What is not recorded is REPORTED, not silently dropped.
 *   The take is cut exactly like an audio take: pre-roll gone, punch honoured,
 *   one playlist per loop pass.
 *
 * Run: pnpm --filter @aimaster/desktop test:midi-input
 */

import {
  MIN_NOTE_SEC, PEDAL_DOWN_THRESHOLD, SUSTAIN_CC, TIMBRE_CC,
  bendRangeFor, captureNotes, describeCapture, isNoteMessage, looksLikeMpeStream,
  parseMidiMessage, type CaptureEvent,
} from '../src/renderer/daw/model/midi-capture.js';
import {
  MidiInputHandle, MidiTimebase, type MidiPortLike,
} from '../src/renderer/daw/engine/midi-input.js';
import {
  commitMidiRecording, hasPerformance, trimNotes,
} from '../src/renderer/daw/edit/midi-record-actions.js';
import {
  DEFAULT_RECORD_SETTINGS, armedSplit, canRecord, planRecording, setRecordArm,
  trackRecordKind, type RecordSettings,
} from '../src/renderer/daw/model/recording.js';
import {
  addTrack, createSession, createTrack, findTrack,
} from '../src/renderer/daw/model/session-ops.js';
import { findExpression, noteEndBeat, resetNoteIds, to7bit } from '../src/renderer/daw/model/midi.js';
import { resetIds } from '../src/renderer/daw/model/ids.js';
import { partClock } from '../src/renderer/daw/model/note-time.js';
import { defaultTempoMap } from '../src/renderer/daw/model/tempo-map.js';

/**
 * The tape's frame, at 60 BPM.
 *
 * Notes come out of the capture in beats.  Sixty BPM makes one beat exactly
 * one second, so every timing below can be read as the seconds the player's
 * hands actually moved in — which is what these tests are about — while
 * still exercising the real seconds→beats conversion.
 */
const TAPE = partClock(defaultTempoMap(60), 0);
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

// ── Event helpers ─────────────────────────────────────────────────────────────

const on = (timeSec: number, pitch: number, velocity = 100, channel = 0): CaptureEvent =>
  ({ kind: 'noteOn', timeSec, channel, pitch, velocity: velocity / 127 });
const off = (timeSec: number, pitch: number, channel = 0): CaptureEvent =>
  ({ kind: 'noteOff', timeSec, channel, pitch, velocity: 64 / 127 });
const cc = (timeSec: number, controller: number, value: number, channel = 0): CaptureEvent =>
  ({ kind: 'cc', timeSec, channel, controller, value: value / 127 });
const bend = (timeSec: number, value: number, channel = 0): CaptureEvent =>
  ({ kind: 'pitchBend', timeSec, channel, value });

function settings(over: Partial<RecordSettings> = {}): RecordSettings {
  return { ...DEFAULT_RECORD_SETTINGS, ...over };
}

function sessionWithInstrument(name = 'Keys'): { session: DawSession; track: Track } {
  resetIds();
  resetNoteIds();
  const base = createSession('midi record test');
  const track = createTrack(name, 'instrument');
  return { session: addTrack(base, track), track };
}

// ── 1. Parsing ────────────────────────────────────────────────────────────────

check('note-on carries pitch, velocity and channel', () => {
  const event = parseMidiMessage([0x93, 60, 100], 1.5);
  assert(event?.kind === 'noteOn', 'a 0x9n status is a note-on');
  if (event?.kind !== 'noteOn') return;
  eq(event.pitch, 60, 'pitch');
  eq(event.channel, 3, 'channel comes from the low nibble');
  close(event.velocity, 100 / 127, 'velocity is normalised', 1e-12);
  close(event.timeSec, 1.5, 'the stamp is carried through', 1e-12);
});

check('note-on at velocity 0 is a note-off', () => {
  const event = parseMidiMessage([0x90, 60, 0], 0);
  eq(event?.kind, 'noteOff', 'every keyboard made since the eighties sends this');
});

check('0x80 is a note-off and keeps its release velocity', () => {
  const event = parseMidiMessage([0x80, 64, 30], 0);
  assert(event?.kind === 'noteOff', 'note-off');
  if (event?.kind !== 'noteOff') return;
  close(event.velocity, 30 / 127, 'release velocity');
});

check('pitch bend is 14-bit, LSB first', () => {
  const centre = parseMidiMessage([0xe0, 0x00, 0x40], 0);   // 8192
  assert(centre?.kind === 'pitchBend', 'bend');
  if (centre?.kind !== 'pitchBend') return;
  close(centre.value, 0, 'centre is zero', 1e-12);

  const up = parseMidiMessage([0xe0, 0x7f, 0x7f], 0);       // 16383
  if (up?.kind !== 'pitchBend') throw new Error('bend');
  assert(up.value > 0.99, `full up is +1, got ${up.value}`);

  const down = parseMidiMessage([0xe0, 0x00, 0x00], 0);
  if (down?.kind !== 'pitchBend') throw new Error('bend');
  close(down.value, -1, 'full down is −1', 1e-12);
});

check('CC, channel pressure and poly pressure all parse', () => {
  const control = parseMidiMessage([0xb1, 74, 127], 0);
  assert(control?.kind === 'cc' && control.controller === 74 && control.channel === 1, 'cc');
  const mono = parseMidiMessage([0xd0, 64], 0);
  assert(mono?.kind === 'channelPressure', 'channel pressure is a two-byte message');
  const poly = parseMidiMessage([0xa0, 60, 90], 0);
  assert(poly?.kind === 'polyPressure' && poly.pitch === 60, 'poly pressure');
});

check('clock, sysex, program change and junk are ignored', () => {
  eq(parseMidiMessage([0xf8], 0), null, 'timing clock');
  eq(parseMidiMessage([0xfe], 0), null, 'active sensing');
  eq(parseMidiMessage([0xf0, 0x7e, 0xf7], 0), null, 'sysex');
  eq(parseMidiMessage([0xc0, 5], 0), null, 'program change changes no note');
  eq(parseMidiMessage([0x40, 60, 100], 0), null, 'a data byte is not a status byte');
  eq(parseMidiMessage([0x90], 0), null, 'a truncated note-on is not a note');
});

check('isNoteMessage picks out the two that make sound', () => {
  assert(isNoteMessage(on(0, 60)), 'note-on');
  assert(isNoteMessage(off(1, 60)), 'note-off');
  assert(!isNoteMessage(cc(0, 1, 64)), 'a controller is not a note');
});

// ── 2. Pairing ────────────────────────────────────────────────────────────────

check('an on/off pair becomes one note of the right length', () => {
  const result = captureNotes([on(1, 60, 100), off(2.5, 60)], { endSec: 4, clock: TAPE });
  eq(result.notes.length, 1, 'one note');
  const note = result.notes[0];
  if (!note) throw new Error('note');
  eq(note.pitch, 60, 'pitch');
  close(note.startBeat, 1, 'start');
  close(note.durationBeat, 1.5, 'length');
  close(note.velocity, 100 / 127, 'velocity survives');
  eq(result.heldAtEnd, 0, 'nothing was cut off');
});

check('the same key struck twice before either release is two notes', () => {
  // A trill on a sticky key, or two controllers on one channel.  Pairing by
  // pitch alone would merge these into one long note.
  const result = captureNotes(
    [on(0, 60), on(0.5, 60), off(1, 60), off(1.5, 60)], { endSec: 3, clock: TAPE });
  eq(result.notes.length, 2, 'two presses, two notes');
  const [first, second] = result.notes;
  if (!first || !second) throw new Error('notes');
  close(first.startBeat, 0, 'first starts first');
  close(first.durationBeat, 1, 'FIFO: the older press takes the earlier release');
  close(second.startBeat, 0.5, 'second starts second');
  close(second.durationBeat, 1, 'and takes the later one');
});

check('a note-off with nothing down is dropped, not turned into a note', () => {
  const result = captureNotes([off(1, 60), on(2, 60), off(3, 60)], { endSec: 4, clock: TAPE });
  eq(result.notes.length, 1, 'only the real note');
  close(result.notes[0]?.startBeat ?? -1, 2, 'and it is the second one');
});

check('a key still down when the tape stops is closed, not lost', () => {
  const result = captureNotes([on(1, 60), on(1.1, 64)], { endSec: 3, clock: TAPE });
  eq(result.notes.length, 2, 'the last chord of a take is not thrown away');
  eq(result.heldAtEnd, 2, 'and it is reported as cut');
  close(result.notes[0]?.durationBeat ?? 0, 2, 'closed at the end of the take');
});

check('events past the end of the take are ignored', () => {
  const result = captureNotes([on(1, 60), off(1.5, 60), on(9, 72), off(9.5, 72)], { endSec: 3, clock: TAPE });
  eq(result.notes.length, 1, 'only what was inside the window');
  eq(result.notes[0]?.pitch, 60, 'the one inside');
});

check('a flicker shorter than the floor is dropped and counted', () => {
  const result = captureNotes([on(1, 60), off(1 + MIN_NOTE_SEC / 2, 60)], { endSec: 3, clock: TAPE });
  eq(result.notes.length, 0, 'not a note');
  eq(result.tooShort, 1, 'but it is reported rather than vanishing');
});

check('events arriving out of order are sorted before pairing', () => {
  const result = captureNotes([off(2, 60), on(1, 60)], { endSec: 3, clock: TAPE });
  eq(result.notes.length, 1, 'a late-delivered note-on still pairs');
  close(result.notes[0]?.durationBeat ?? 0, 1, 'with the right length');
});

// ── 3. The pedal ──────────────────────────────────────────────────────────────

check('a note released under the pedal ends when the pedal lifts', () => {
  const result = captureNotes([
    cc(0.5, SUSTAIN_CC, 127),
    on(1, 60), off(1.2, 60),
    cc(3, SUSTAIN_CC, 0),
  ], { endSec: 5, clock: TAPE });
  eq(result.notes.length, 1, 'one note');
  close(result.notes[0]?.durationBeat ?? 0, 2, 'held from 1s to the pedal-up at 3s');
  eq(result.heldAtEnd, 0, 'the pedal ended it, not the tape');
});

check('the pedal threshold is half — a half-pedal counts as down', () => {
  const down = Math.ceil(PEDAL_DOWN_THRESHOLD * 127);
  const result = captureNotes([
    cc(0, SUSTAIN_CC, down), on(1, 60), off(1.2, 60), cc(2, SUSTAIN_CC, 0),
  ], { endSec: 4, clock: TAPE });
  close(result.notes[0]?.durationBeat ?? 0, 1, 'held to the pedal-up');
});

check('the pedal still down at the end closes its notes at the end', () => {
  const result = captureNotes([
    cc(0, SUSTAIN_CC, 127), on(1, 60), off(1.2, 60),
  ], { endSec: 4, clock: TAPE });
  eq(result.notes.length, 1, 'the note survives');
  close(result.notes[0]?.durationBeat ?? 0, 3, 'closed by the end of the take');
  eq(result.heldAtEnd, 1, 'and reported as cut');
});

check('re-pressing a key the pedal is holding starts a NEW note', () => {
  const result = captureNotes([
    cc(0, SUSTAIN_CC, 127),
    on(1, 60), off(1.2, 60),
    on(2, 60), off(2.2, 60),
    cc(3, SUSTAIN_CC, 0),
  ], { endSec: 5, clock: TAPE });
  eq(result.notes.length, 2, 'two strikes are two notes, both sustained');
  close(result.notes[0]?.startBeat ?? -1, 1, 'first strike');
  close(result.notes[1]?.startBeat ?? -1, 2, 'second strike');
  for (const note of result.notes) close(noteEndBeat(note), 3, 'both end at the pedal-up');
});

check('with the pedal setting off, CC64 is reported as unrecorded instead', () => {
  const events = [cc(0, SUSTAIN_CC, 127), on(1, 60), off(1.2, 60)];
  const held = captureNotes(events, { endSec: 4, sustainPedal: true, clock: TAPE });
  const plain = captureNotes(events, { endSec: 4, sustainPedal: false, clock: TAPE });
  close(held.notes[0]?.durationBeat ?? 0, 3, 'honoured: the note is held');
  close(plain.notes[0]?.durationBeat ?? 0, 0.2, 'ignored: the note is as played');
  assert(!held.ignoredCc.includes(SUSTAIN_CC), 'an honoured pedal is not "ignored"');
  assert(plain.ignoredCc.includes(SUSTAIN_CC), 'an unhonoured one is reported');
});

// ── 4. Expression ─────────────────────────────────────────────────────────────

check('the wheel bends every note sounding on that channel', () => {
  const result = captureNotes([
    on(1, 60), on(1, 64), on(1, 67),
    bend(1.5, 0.5),
    off(2, 60), off(2, 64), off(2, 67),
  ], { endSec: 3, clock: TAPE });
  eq(result.notes.length, 3, 'a triad');
  for (const note of result.notes) {
    const curve = findExpression(note, { kind: 'pitchBend' });
    assert(curve !== undefined, `${note.pitch} got the bend`);
    const last = curve?.points[curve.points.length - 1];
    close(last?.value ?? 0, 0.5, 'to the value that was sent');
    close(last?.timeBeat ?? -1, 0.5, 'in the note’s own time frame');
  }
});

check('a bend on another channel does not reach the note', () => {
  const result = captureNotes(
    [on(1, 60, 100, 0), bend(1.5, 0.9, 5), off(2, 60, 0)], { endSec: 3, clock: TAPE });
  const note = result.notes[0];
  if (!note) throw new Error('note');
  eq(findExpression(note, { kind: 'pitchBend' }), undefined, 'channels are separate');
});

check('a curve that starts mid-note is anchored at its neutral first', () => {
  const result = captureNotes([on(1, 60), bend(1.5, 0.5), off(2, 60)], { endSec: 3, clock: TAPE });
  const curve = findExpression(result.notes[0]!, { kind: 'pitchBend' });
  const first = curve?.points[0];
  close(first?.timeBeat ?? -1, 0, 'the curve starts at the note start');
  close(first?.value ?? -1, 0, 'centred, so the bend ramps up instead of jumping');
});

check('CC74 is timbre; the mod wheel is reported unrecorded', () => {
  const result = captureNotes([
    on(1, 60), cc(1.2, TIMBRE_CC, 127), cc(1.3, 1, 64), off(2, 60),
  ], { endSec: 3, clock: TAPE });
  const note = result.notes[0];
  if (!note) throw new Error('note');
  assert(findExpression(note, { kind: 'timbre' }) !== undefined, 'CC74 plays back, so it is kept');
  eq(result.ignoredCc.join(','), '1', 'CC1 has nowhere to go and says so');
});

check('aftertouch lands on the sounding note', () => {
  const result = captureNotes([
    on(1, 60), { kind: 'channelPressure', timeSec: 1.4, channel: 0, value: 0.8 }, off(2, 60),
  ], { endSec: 3, clock: TAPE });
  const curve = findExpression(result.notes[0]!, { kind: 'pressure' });
  assert(curve !== undefined, 'pressure is captured');
  close(curve?.points[curve.points.length - 1]?.value ?? 0, 0.8, 'at the value sent');
});

check('a note the pedal is holding still receives the wheel', () => {
  const result = captureNotes([
    cc(0, SUSTAIN_CC, 127), on(1, 60), off(1.2, 60), bend(2, -0.4), cc(3, SUSTAIN_CC, 0),
  ], { endSec: 4, clock: TAPE });
  const curve = findExpression(result.notes[0]!, { kind: 'pitchBend' });
  assert(curve !== undefined, 'it is still sounding, so it still bends');
  close(curve?.points[curve.points.length - 1]?.value ?? 0, -0.4, 'value');
});

check('expression can be turned off entirely', () => {
  const result = captureNotes(
    [on(1, 60), bend(1.5, 0.5), off(2, 60)], { endSec: 3, expression: false, clock: TAPE });
  eq(result.notes[0]?.expression.length, 0, 'no curves recorded');
});

check('MPE is detected from spread channels with per-channel bend', () => {
  const mpe: CaptureEvent[] = [];
  for (let ch = 1; ch <= 4; ch++) {
    mpe.push(on(1, 60 + ch, 100, ch), bend(1.2, 0.1 * ch, ch), off(2, 60 + ch, ch));
  }
  assert(looksLikeMpeStream(mpe), 'four member channels, each bent');
  assert(!looksLikeMpeStream([on(1, 60), bend(1.2, 0.3), off(2, 60)]), 'one channel is not MPE');
  eq(bendRangeFor(true), 48, 'MPE assumes ±48');
  eq(bendRangeFor(false), 2, 'a keyboard assumes ±2');
});

check('describeCapture says what landed and what did not', () => {
  const result = captureNotes([
    on(1, 60), cc(1.1, 1, 90), on(1.2, 64),
    off(1.2 + MIN_NOTE_SEC / 3, 64),
  ], { endSec: 3, clock: TAPE });
  const text = describeCapture(result);
  assert(text.includes('1음'), `note count is stated — ${text}`);
  assert(text.includes('CC 1'), `the dropped controller is named — ${text}`);
  assert(text.includes('끊김'), `the note cut by the end is stated — ${text}`);
});

// ── 5. The wire ───────────────────────────────────────────────────────────────

function fakePort(id: string, name: string): MidiPortLike & { send: (b: number[], t: number) => void } {
  const port: MidiPortLike & { send: (b: number[], t: number) => void } = {
    id, name, onmidimessage: null,
    send: (bytes, timeStamp) => port.onmidimessage?.({ data: new Uint8Array(bytes), timeStamp }),
  };
  return port;
}

check('a handle parses what its ports deliver and stamps it', () => {
  const port = fakePort('p1', 'Keystation');
  const handle = new MidiInputHandle([port]);
  handle.timebase = new MidiTimebase(1000, 5, 5, 0);   // perf 1000ms ↔ tape 0
  const seen: CaptureEvent[] = [];
  handle.onMessage((event) => seen.push(event));

  port.send([0x90, 60, 100], 1500);
  port.send([0xf8], 1600);                             // clock, ignored
  port.send([0x80, 60, 0], 3000);

  eq(seen.length, 2, 'two note messages, no clock');
  close(seen[0]?.timeSec ?? -1, 0.5, 'stamped 500 ms after the anchor', 1e-12);
  close(seen[1]?.timeSec ?? -1, 2, 'and 2 s after it', 1e-12);
  eq(handle.deviceCount, 1, 'one port');
  eq(handle.deviceNames[0], 'Keystation', 'named');
});

check('an unstamped message falls back to the caller’s clock', () => {
  const port = fakePort('p1', 'Pad');
  const handle = new MidiInputHandle([port]);
  handle.timebase = new MidiTimebase(1000, 5, 5, 0);
  handle.fallbackSec = () => 7.25;
  const seen: CaptureEvent[] = [];
  handle.onMessage((event) => seen.push(event));
  port.send([0x90, 60, 100], 0);
  close(seen[0]?.timeSec ?? -1, 7.25, 'zero is not a usable stamp', 1e-12);
});

check('closing a handle unhooks the port and stops the listeners', () => {
  const port = fakePort('p1', 'Keys');
  const handle = new MidiInputHandle([port]);
  let count = 0;
  handle.onMessage(() => { count += 1; });
  port.send([0x90, 60, 100], 0);
  handle.close();
  eq(port.onmidimessage, null, 'the hook is removed, not left dangling');
  port.send([0x90, 62, 100], 0);
  eq(count, 1, 'nothing arrives after close');
  eq(handle.deviceCount, 0, 'and the handle owns nothing');
});

check('two ports feed one listener — a keyboard and a pedal box', () => {
  const keys = fakePort('a', 'Keys');
  const pedal = fakePort('b', 'Pedal');
  const handle = new MidiInputHandle([keys, pedal]);
  handle.fallbackSec = () => 0;
  const seen: CaptureEvent[] = [];
  handle.onMessage((event) => seen.push(event));
  keys.send([0x90, 60, 100], 0);
  pedal.send([0xb0, SUSTAIN_CC, 127], 0);
  eq(seen.length, 2, 'both reach the take');
  eq(handle.deviceCount, 2, 'both are open');
});

check('the timebase is linear in both directions', () => {
  // Anchor: perf 2000 ms is context 10 s; the transport was at 4 s when the
  // context read 8 s.
  const base = new MidiTimebase(2000, 10, 8, 4);
  close(base.transportSec(2000), 6, 'the anchor instant', 1e-12);
  close(base.transportSec(3000), 7, 'a second later is a second later', 1e-12);
  close(base.transportSec(1500), 5.5, 'and it runs backwards too', 1e-12);
  close(base.transportSecAtContext(8), 4, 'the context origin maps to the transport origin', 1e-12);
});

// ── 6. Readiness ──────────────────────────────────────────────────────────────

check('an instrument track can now be armed for MIDI', () => {
  const { session, track } = sessionWithInstrument();
  const armed = setRecordArm(session, track.id, true);
  eq(trackRecordKind(track), 'midi', 'an instrument track records MIDI');
  eq(armedSplit(armed).midi.length, 1, 'and lands on the MIDI side of the split');
  const ready = canRecord(armed, settings(), { midiOpen: true });
  assert(ready.ok, `it is allowed — ${ready.reason ?? ''}`);
});

check('with no MIDI input open the button says why', () => {
  const { session, track } = sessionWithInstrument();
  const armed = setRecordArm(session, track.id, true);
  const ready = canRecord(armed, settings(), { midiOpen: false });
  assert(!ready.ok, 'refused');
  assert((ready.reason ?? '').includes('MIDI'), `and names the reason — ${ready.reason}`);
});

check('audio and instrument tracks roll together in one pass', () => {
  resetIds();
  let session = createSession('mixed');
  const audio = createTrack('Vox', 'audio');
  const keys = createTrack('Keys', 'instrument');
  session = addTrack(addTrack(session, audio), keys);
  session = setRecordArm(setRecordArm(session, audio.id, true), keys.id, true);
  const split = armedSplit(session);
  eq(split.audio.length, 1, 'the microphone');
  eq(split.midi.length, 1, 'and the keyboard');
  const ready = canRecord(session, settings(), { midiOpen: true, audioOpen: [audio.id] });
  assert(ready.ok, `a band take is allowed — ${ready.reason ?? ''}`);
});

check('an audio track still records audio', () => {
  resetIds();
  const session = createSession('audio');
  const track = createTrack('Vox', 'audio');
  const armed = setRecordArm(addTrack(session, track), track.id, true);
  eq(trackRecordKind(track), 'audio', 'unchanged');
  assert(canRecord(armed, settings(), { audioOpen: [track.id] }).ok, 'and still allowed');
});

// ── 7. Commit ─────────────────────────────────────────────────────────────────

check('the pre-roll is discarded and the take is rebased', () => {
  const { session, track } = sessionWithInstrument();
  const plan = planRecording(session, settings({ preRollSec: 2 }), 10);
  eq(plan.preRollSec, 2, 'two seconds of run-up');
  // Played at tape 1 s (during the pre-roll) and tape 3 s (one second in).
  const captured = captureNotes([on(1, 60), off(1.5, 60), on(3, 64), off(4, 64)], { endSec: 6, clock: TAPE });
  const result = commitMidiRecording(
    session, track.id, { notes: captured.notes, tapeSec: 6, clock: TAPE }, plan, settings());

  eq(result.takes, 1, 'one take');
  const laid = findTrack(result.session, track.id);
  const part = laid?.playlists[laid.playlists.length - 1]?.clips[0];
  assert(part?.kind === 'midi', 'a MIDI part, not an audio clip');
  eq(part?.notes.length, 1, 'the pre-roll noodle is gone');
  close(part?.notes[0]?.startBeat ?? -1, 1, 'and the kept note is one second into the part');
  close(part?.startSec ?? -1, 10, 'the part sits at the punch point');
});

check('a note held across the punch is trimmed, not dropped', () => {
  const { session, track } = sessionWithInstrument();
  const plan = planRecording(session, settings({ preRollSec: 2 }), 10);
  // A pad struck in the pre-roll and still down two seconds into the take.
  const captured = captureNotes([on(0.5, 48), bend(1, 0.25), off(4, 48)], { endSec: 6, clock: TAPE });
  const result = commitMidiRecording(
    session, track.id, { notes: captured.notes, tapeSec: 6, clock: TAPE }, plan, settings());
  const laid = findTrack(result.session, track.id);
  const note = laid?.playlists[laid.playlists.length - 1]?.clips[0]?.notes[0];
  assert(note !== undefined, 'the pad is kept');
  close(note?.startBeat ?? -1, 0, 'from the punch');
  close(note?.durationBeat ?? -1, 2, 'for what is left of it');
  const curve = findExpression(note!, { kind: 'pitchBend' });
  const pinned = curve?.points[0];
  close(pinned?.timeBeat ?? -1, 0, 'the bend made before the punch is pinned to the start');
  close(pinned?.value ?? -1, 0.25, 'at the value it was already at, so nothing jumps');
});

check('a punch-out truncates the take', () => {
  const { session, track } = sessionWithInstrument();
  const plan = planRecording(session, settings({
    preRollSec: 0, punchEnabled: true, punchStartSec: 4, punchEndSec: 8,
  }), 0);
  const captured = captureNotes([on(1, 60), off(2, 60), on(5, 64), off(6, 64)], { endSec: 10, clock: TAPE });
  const result = commitMidiRecording(
    session, track.id, { notes: captured.notes, tapeSec: 10, clock: TAPE }, plan, settings());
  const laid = findTrack(result.session, track.id);
  const part = laid?.playlists[laid.playlists.length - 1]?.clips[0];
  eq(part?.notes.length, 1, 'only what was inside the punch');
  close(part?.notes[0]?.startBeat ?? -1, 1, 'rebased onto the punch-in');
  eq(result.notes, 1, 'and the count agrees');
});

check('each loop pass becomes its own take lane', () => {
  const { session, track } = sessionWithInstrument();
  const plan = planRecording(
    session, settings({ preRollSec: 0 }), 0, { startSec: 0, endSec: 2 });
  // Three passes through a two-second loop, one note each.
  const captured = captureNotes([
    on(0.5, 60), off(1, 60), on(2.5, 62), off(3, 62), on(4.5, 64), off(5, 64),
  ], { endSec: 6, clock: TAPE });
  const result = commitMidiRecording(
    session, track.id, { notes: captured.notes, tapeSec: 6, clock: TAPE }, plan, settings());

  eq(result.takes, 3, 'three passes, three takes');
  const laid = findTrack(result.session, track.id);
  const lanes = laid?.playlists.slice(-3) ?? [];
  const pitches = lanes.map((l) => l.clips[0]?.notes[0]?.pitch);
  eq(pitches.join(','), '60,62,64', 'one note per pass, in order');
  for (const lane of lanes) {
    close(lane.clips[0]?.notes[0]?.startBeat ?? -1, 0.5, 'each note sits at the same place in its pass');
    close(lane.clips[0]?.startSec ?? -1, 0, 'and every pass starts at the loop start');
  }
  eq(result.activePlaylistId, lanes[lanes.length - 1]?.id, 'the last pass is left active');
});

check('loop takes off keeps the performance as one continuous part', () => {
  const { session, track } = sessionWithInstrument();
  const plan = planRecording(
    session, settings({ preRollSec: 0 }), 0, { startSec: 0, endSec: 2 });
  const captured = captureNotes([on(0.5, 60), off(1, 60), on(2.5, 62), off(3, 62)], { endSec: 4, clock: TAPE });
  const result = commitMidiRecording(
    session, track.id, { notes: captured.notes, tapeSec: 4, clock: TAPE }, plan, settings({ loopTakes: false }));
  eq(result.takes, 1, 'one take');
  eq(result.notes, 2, 'holding both notes');
});

check('a take with no notes is an error, not an empty part', () => {
  const { session, track } = sessionWithInstrument();
  const plan = planRecording(session, settings({ preRollSec: 0 }), 0);
  let threw = false;
  try {
    commitMidiRecording(session, track.id, { notes: [], tapeSec: 4, clock: TAPE }, plan, settings());
  } catch { threw = true; }
  assert(threw, 'a player who did not play does not get a part');
  assert(!hasPerformance({ notes: [], tapeSec: 4, clock: TAPE }), 'and the caller can tell in advance');
});

check('a take that is all pre-roll is refused', () => {
  const { session, track } = sessionWithInstrument();
  const plan = planRecording(session, settings({ preRollSec: 2 }), 10);
  const captured = captureNotes([on(0.5, 60), off(1, 60)], { endSec: 1.5, clock: TAPE });
  let threw = false;
  try {
    commitMidiRecording(
      session, track.id, { notes: captured.notes, tapeSec: 1.5, clock: TAPE }, plan, settings());
  } catch { threw = true; }
  assert(threw, 'stopping during the run-up leaves nothing to keep');
});

check('committing never disturbs what is already on the track', () => {
  const { session, track } = sessionWithInstrument();
  const before = findTrack(session, track.id)?.playlists.length ?? 0;
  const plan = planRecording(session, settings({ preRollSec: 0 }), 0);
  const captured = captureNotes([on(0.5, 60), off(1, 60)], { endSec: 2, clock: TAPE });
  const result = commitMidiRecording(
    session, track.id, { notes: captured.notes, tapeSec: 2, clock: TAPE }, plan, settings());
  const after = findTrack(result.session, track.id)?.playlists.length ?? 0;
  eq(after, before + 1, 'takes stack, they never overwrite');
  eq(findTrack(session, track.id)?.playlists.length, before, 'and the input session is untouched');
});

check('trimNotes keeps only what overlaps the window', () => {
  const captured = captureNotes([
    on(0, 60), off(0.5, 60),      // entirely before
    on(1, 62), off(3, 62),        // straddles the front
    on(4, 64), off(4.5, 64),      // inside
    on(9, 67), off(9.5, 67),      // entirely after
  ], { endSec: 12, clock: TAPE });
  const kept = trimNotes(captured.notes, 2, 6);
  eq(kept.length, 2, 'two survive');
  eq(kept.map((n) => n.pitch).join(','), '62,64', 'the straddler and the inside one');
  close(kept[0]?.startBeat ?? -1, 0, 'the straddler starts at the window');
  close(kept[0]?.durationBeat ?? -1, 1, 'and keeps only its remainder');
});

check('a MIDI part carries the bend range the stream implied', () => {
  const { session, track } = sessionWithInstrument();
  const plan = planRecording(session, settings({ preRollSec: 0 }), 0);
  const captured = captureNotes([on(0.5, 60), off(1, 60)], { endSec: 2, clock: TAPE });
  const result = commitMidiRecording(session, track.id, {
    notes: captured.notes, tapeSec: 2, clock: TAPE,
    config: { bendRangeSemitones: bendRangeFor(true), mpe: true },
  }, plan, settings());
  const laid = findTrack(result.session, track.id);
  const part = laid?.playlists[laid.playlists.length - 1]?.clips[0];
  eq(part?.midiConfig.bendRangeSemitones, 48, 'so the instrument bends by the right amount');
  eq(part?.midiConfig.mpe, true, 'and the part knows it is MPE');
});

// ── 8. Round trip ─────────────────────────────────────────────────────────────

check('a played phrase survives bytes → events → notes → part intact', () => {
  const { session, track } = sessionWithInstrument();
  const port = fakePort('p', 'Keys');
  const handle = new MidiInputHandle([port]);
  handle.timebase = new MidiTimebase(0, 0, 0, 0);      // perf ms = tape seconds × 1000
  const events: CaptureEvent[] = [];
  handle.onMessage((event) => events.push(event));

  // A rising triad, pedalled, with a bend under the last note.
  port.send([0xb0, SUSTAIN_CC, 127], 400);
  port.send([0x90, 60, to7bit(0.8)], 500);
  port.send([0x80, 60, 64], 700);
  port.send([0x90, 64, to7bit(0.7)], 900);
  port.send([0x80, 64, 64], 1100);
  port.send([0x90, 67, to7bit(0.9)], 1300);
  port.send([0xe0, 0x00, 0x60], 1600);                 // bend up a quarter
  port.send([0x80, 67, 64], 1800);
  port.send([0xb0, SUSTAIN_CC, 0], 2000);

  const captured = captureNotes(events, { endSec: 2.5, clock: TAPE });
  eq(captured.notes.length, 3, 'three notes');
  for (const note of captured.notes) close(noteEndBeat(note), 2, 'all three ride the pedal to 2 s');
  close(captured.notes[0]?.velocity ?? 0, to7bit(0.8) / 127, 'velocity survived the 7-bit round trip');
  const curve = findExpression(captured.notes[2]!, { kind: 'pitchBend' });
  assert(curve !== undefined, 'the bend reached the top note');
  assert(findExpression(captured.notes[0]!, { kind: 'pitchBend' })?.points.length === 2,
    'and the pedalled notes below it, which were still sounding');

  const plan = planRecording(session, settings({ preRollSec: 0 }), 8);
  const result = commitMidiRecording(
    session, track.id, { notes: captured.notes, tapeSec: 2.5, clock: TAPE }, plan, settings());
  eq(result.notes, 3, 'all three landed in the part');
  const laid = findTrack(result.session, track.id);
  const part = laid?.playlists[laid.playlists.length - 1]?.clips[0];
  close(part?.startSec ?? -1, 8, 'at the playhead');
  close(part?.notes[0]?.startBeat ?? -1, 0.5, 'with the phrase’s own timing intact');
  handle.close();
});

// ── Report ────────────────────────────────────────────────────────────────────

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log('\n=== MIDI input: bytes · events · notes · takes ===');
for (const r of results) {
  console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
}
console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
if (failed > 0) process.exit(1);
