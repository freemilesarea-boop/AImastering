/**
 * hardware-io-selftest.ts — plugging in a real interface.
 *
 * Two things stood between this app and a studio interface, and both are the
 * kind that sound fine while being wrong:
 *
 *   • The recorder asked for `channelCount: 1` or `2`, so an eight-input
 *     interface handed back inputs 1/2 and the microphone in input 5 was
 *     unreachable.  Worse than unreachable: arming a track set to input 5
 *     recorded input 1 and gave no sign of it.
 *   • Nothing compensated the round trip, so every overdub landed late by the
 *     input plus output delay.  Consistent, so it compounds — three overdubs
 *     deep and the take is a long way from where it was played.
 *
 * The tests that matter are therefore about the cases that fail QUIETLY: a
 * pair that runs off the end of the device, a measurement taken on a hot
 * input, a correction the capture had no audio for.
 *
 * Run via:  pnpm --filter @aimaster/desktop test:hardware-io
 */

import {
  DEFAULT_PATCH, MAX_INPUT_CHANNELS, clampDeviceChannels, clampPatch, describeDevice,
  describePatch, patchChannels, patchIsValid, patchOptions, requiredChannels,
  streamWidthFor, type InputPatch,
} from '../src/renderer/daw/model/input-channels.js';
import {
  CALIBRATION_AGREE_SEC, LATENCY_LABELS, MAX_LATENCY_SEC, NO_LATENCY,
  agreeLoopback, activeLatency, clampLatency,
  compensateOffset, describeLatency, latencyFromContext, measureLoopback,
  captureShortfall, reportedLatency,
} from '../src/renderer/daw/model/input-latency.js';

import {
  DEFAULT_INPUT_REF, describeInput, refPatch, resolveTrackInput, trackInputRef,
} from '../src/renderer/daw/model/track-input.js';
import {
  assignInputDevice, setTrackInputPatch,
} from '../src/renderer/daw/edit/track-input-ops.js';
import { DEFAULT_RECORD_SETTINGS, settingsLatency } from '../src/renderer/daw/model/recording.js';
import { addTrack, createSession, createTrack, findTrack } from '../src/renderer/daw/model/session-ops.js';
import { resetIds } from '../src/renderer/daw/model/ids.js';

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }
function near(a: number, b: number, eps: number, m: string): void {
  if (!(Math.abs(a - b) <= eps)) throw new Error(`${m} — ${a} vs ${b}`);
}

// ── Which input ─────────────────────────────────────────────────────────────

check('a patch names the socket the way the box does', () => {
  assert(describePatch({ firstChannel: 0, channels: 1 }) === '입력 1', '0-based inside, 1-based out');
  assert(describePatch({ firstChannel: 4, channels: 1 }) === '입력 5', 'channel 4 is input 5');
  assert(describePatch({ firstChannel: 2, channels: 2 }) === '입력 3/4', 'a pair');
});

check('the stream is opened wide enough to reach the patch', () => {
  assert(requiredChannels({ firstChannel: 0, channels: 1 }) === 1, 'input 1 needs one channel');
  assert(requiredChannels({ firstChannel: 4, channels: 1 }) === 5, 'input 5 needs five');
  assert(requiredChannels({ firstChannel: 6, channels: 2 }) === 8, 'inputs 7/8 need eight');
});

check('the channels read are the ones the patch names', () => {
  assert(patchChannels({ firstChannel: 4, channels: 1 }).join() === '4', 'one channel');
  assert(patchChannels({ firstChannel: 2, channels: 2 }).join() === '2,3', 'and the next one for a pair');
});

check('a pair that runs off the end becomes MONO, it does not slide down', () => {
  // Somebody set inputs 7/8 and the device turned out to have 7.  Sliding the
  // pair to 6/7 records a different microphone and sounds completely fine
  // doing it, which is why it must not happen.
  const held = clampPatch({ firstChannel: 6, channels: 2 }, 7);
  assert(held.firstChannel === 6, `still input 7 — got ${held.firstChannel}`);
  assert(held.channels === 1, `as mono — got ${held.channels}`);
});

check('a patch past the end is pulled to the last real input', () => {
  const held = clampPatch({ firstChannel: 9, channels: 1 }, 2);
  assert(held.firstChannel === 1, `a 2-in device has no input 10 — got ${held.firstChannel}`);
  assert(!patchIsValid({ firstChannel: 9, channels: 1 }, 2), 'and the caller can ask first');
  assert(patchIsValid({ firstChannel: 1, channels: 1 }, 2), 'a real one is valid');
});

check('a device that reports nonsense is held to something openable', () => {
  assert(clampDeviceChannels(undefined) === 1, 'no answer means one');
  assert(clampDeviceChannels(0) === 1, 'nor zero');
  assert(clampDeviceChannels(-4) === 1, 'nor negative');
  assert(clampDeviceChannels(1e6) === MAX_INPUT_CHANNELS, 'nor a million');
  assert(clampDeviceChannels(8) === 8, 'a real number survives');
});

check('the picker offers every input and the natural pairs', () => {
  const options = patchOptions(8);
  const mono = options.filter((o) => o.channels === 1);
  const pairs = options.filter((o) => o.channels === 2);
  assert(mono.length === 8, `eight mono inputs, got ${mono.length}`);
  // 1/2, 3/4, 5/6, 7/8 — not 2/3, which no interface is wired for and which
  // would double the list with entries nobody picks.
  assert(pairs.map((p) => p.firstChannel).join() === '0,2,4,6', pairs.map((p) => p.firstChannel).join());
  assert(patchOptions(1).length === 1, 'a mono device offers one thing');
});

check('one stream is opened at the widest patch anybody needs', () => {
  // Opening a stream per armed track makes the browser ask for the device
  // several times, and on the interfaces that allow it each stream gets its
  // own clock — which is how two tracks recorded together drift apart.
  const armed: InputPatch[] = [
    { firstChannel: 0, channels: 1 },
    { firstChannel: 6, channels: 2 },
    { firstChannel: 2, channels: 1 },
  ];
  assert(streamWidthFor(armed) === 8, `eight, got ${streamWidthFor(armed)}`);
  assert(streamWidthFor([]) === 1, 'nothing armed still opens something');
  assert(DEFAULT_PATCH.firstChannel === 0 && DEFAULT_PATCH.channels === 1, 'the default is input 1 mono');
});

check('a wide device is described as one', () => {
  assert(describeDevice('Scarlett 18i20', 18).includes('18'), describeDevice('Scarlett 18i20', 18));
  assert(!describeDevice('MacBook Mic', 2).includes('입력 2개'), 'a stereo device needs no explaining');
});

// ── When it arrives ─────────────────────────────────────────────────────────

check('the reported latency is the two numbers the browser will give', () => {
  near(reportedLatency({ baseLatency: 0.005, outputLatency: 0.012 }), 0.017, 1e-9, 'summed');
  assert(reportedLatency(null) === 0, 'no context, no claim');
  assert(reportedLatency({}) === 0, 'a context that says nothing');
  assert(reportedLatency({ baseLatency: NaN, outputLatency: 0.01 }) === 0.01, 'NaN is not a number to add');
});

check('a context with a latency produces a reported config; one without produces none', () => {
  const from = latencyFromContext({ baseLatency: 0.005, outputLatency: 0.01 });
  assert(from.source === 'reported', from.source);
  assert(from.enabled, 'and it is on');
  assert(latencyFromContext({}).source === 'none', 'nothing to report');
  assert(describeLatency(from).includes('보통 이보다 깁니다'),
    'and it says out loud that it is an underestimate');
});

check('an absurd latency is refused rather than applied', () => {
  assert(clampLatency(9) === MAX_LATENCY_SEC, `a nine-second round trip is a mistake`);
  assert(clampLatency(-1) === 0, 'nor a negative one');
  assert(clampLatency(NaN) === 0, 'nor NaN');
  assert(clampLatency(0.012) === 0.012, 'a real one survives');
});

check('disabling keeps the number but stops applying it', () => {
  const config = { seconds: 0.02, source: 'measured' as const, enabled: false };
  assert(activeLatency(config) === 0, 'nothing applied');
  assert(config.seconds === 0.02, 'but the measurement is still there for A/B');
  assert(describeLatency(config).includes('보정 꺼짐'), describeLatency(config));
  assert(activeLatency({ ...config, enabled: true }) === 0.02, 'and it comes back');
});

check('the correction reads FURTHER INTO the capture, never before it', () => {
  // Pulling the clip's start earlier would push a take recorded at the top of
  // the song before zero, where there is no timeline to put it on.
  near(compensateOffset(0.5, 0.02), 0.52, 1e-9, 'the read point moves later');
  near(compensateOffset(0, 0.02), 0.02, 1e-9, 'even with no pre-roll');
  assert(compensateOffset(0, 0.02) >= 0, 'and never negative');
});

check('a take the capture ran out of is reported short, not silently clipped', () => {
  // 1 s pre-roll, 20 ms round trip, a 4 s take.  The recorder kept running for
  // 5.5 s, so the window (1.02 → 5.02) is comfortably inside it.
  near(captureShortfall(1.02, 4, 5.5), 0, 1e-9, 'plenty of tail');
  // The same take, but the capture stopped the instant the transport did.  The
  // window now ends 20 ms past the last sample, and that IS the missing tail —
  // exactly the round trip, because that is what moved the window.
  near(captureShortfall(1.02, 4, 5.0), 0.02, 1e-9, 'short by the round trip');
  // A capture that stopped early loses more than the correction did.
  near(captureShortfall(1.02, 4, 3.0), 2.02, 1e-9, 'short by the whole missing end');
  near(captureShortfall(0, 0, 0), 0, 1e-9, 'nothing wanted, nothing missing');
});

check('the labels name where a number came from', () => {
  assert(LATENCY_LABELS.measured.includes('측정'), LATENCY_LABELS.measured);
  assert(LATENCY_LABELS.reported.includes('추정'), 'an estimate is called an estimate');
  assert(describeLatency(NO_LATENCY).includes('늦게 들어옵니다'),
    'and no compensation says what that costs');
});

// ── Calibration ─────────────────────────────────────────────────────────────

/** Silence, then a click at `atSec`. */
function loopback(atSec: number, sampleRate = 48_000, level = 0.8, lengthSec = 0.3): Float32Array {
  const out = new Float32Array(Math.round(lengthSec * sampleRate));
  const at = Math.round(atSec * sampleRate);
  for (let i = 0; i < 32 && at + i < out.length; i++) out[at + i] = level * (1 - i / 32);
  return out;
}

check('a loopback click is found where it actually is', () => {
  for (const ms of [3, 12, 47, 120]) {
    const found = measureLoopback(loopback(ms / 1000), 48_000);
    assert(found !== null, `${ms} ms click was found`);
    near(found as number, ms / 1000, 0.0005, `${ms} ms`);
  }
});

check('no click at all returns null, not a confident zero', () => {
  const silence = new Float32Array(48_000 * 0.3);
  assert(measureLoopback(silence, 48_000) === null, 'the cable is not plugged in');
  assert(measureLoopback(new Float32Array(0), 48_000) === null, 'nothing captured');
  assert(measureLoopback(loopback(0.01), 0) === null, 'no sample rate');
});

check('a click quieter than the threshold is not found', () => {
  // −40 dB is below the −30 dB threshold: reporting it would mean measuring
  // the room instead of the click.
  const quiet = loopback(0.02, 48_000, 0.01);
  assert(measureLoopback(quiet, 48_000) === null, 'too quiet to be the click');
  assert(measureLoopback(quiet, 48_000, { thresholdDb: -60 }) !== null,
    'and a caller who knows can lower the bar');
});

check('a hot input reports "cannot tell" rather than zero latency', () => {
  // Noise above the threshold from the first sample.  Without the floor check
  // the very first sample crosses and the answer is a confident 0 ms, which
  // would then be applied and shift nothing — silently doing nothing while
  // claiming to be calibrated.
  const hot = new Float32Array(48_000 * 0.2);
  for (let i = 0; i < hot.length; i++) hot[i] = (Math.random() * 2 - 1) * 0.5;
  assert(measureLoopback(hot, 48_000) === null, 'the level is wrong, and it says so');
});

check('a click past the search window is not reported', () => {
  const late = loopback(MAX_LATENCY_SEC + 0.1, 48_000, 0.8, MAX_LATENCY_SEC + 0.2);
  assert(measureLoopback(late, 48_000) === null, 'past anything a real device does');
});

check('the search starts where the click was played', () => {
  // Play at 0.1 s, arrives 0.02 s later.  Measured against the PLAY time, the
  // answer is 20 ms; against the buffer start it would be 120.
  const captured = loopback(0.12);
  near(measureLoopback(captured, 48_000, { playedAtSec: 0.1 }) as number, 0.02, 0.0005,
    'the delay is from the click, not from the buffer');
});


// ── The socket, saved with the project ──────────────────────────────────────

const SCARLETT = { id: 'dev-a', label: 'Scarlett 18i20', channels: 18 };
const BUILT_IN = { id: 'dev-b', label: 'Built-in Microphone', channels: 1 };

function trackOn(patch: InputPatch, device = SCARLETT) {
  resetIds();
  let session = createSession('band');
  const track = createTrack('Kick', 'audio');
  session = addTrack(session, track);
  session = assignInputDevice(session, track.id, device, patch);
  return { session, trackId: track.id };
}

check('the socket is a project fact — it saves with the session', () => {
  const { session, trackId } = trackOn({ firstChannel: 4, channels: 1 });
  const ref = trackInputRef(findTrack(session, trackId)!);
  assert(ref.firstChannel === 4, `input 5, got ${ref.firstChannel + 1}`);
  assert(ref.deviceLabel === 'Scarlett 18i20', 'and still by name');
  assert(describeInput(ref).includes('입력 5'), describeInput(ref));
});

check('a session saved before multi-channel input reads as input 1', () => {
  resetIds();
  let session = createSession('old');
  const track = createTrack('Vox', 'audio');
  session = addTrack(session, track);
  // Exactly the shape the old code wrote: no firstChannel at all.
  const legacy = { ...findTrack(session, track.id)!, recordInput: {
    deviceLabel: 'Scarlett 18i20', deviceId: 'dev-a', channels: 1 as const,
  } };
  const ref = trackInputRef(legacy);
  assert(ref.firstChannel === 0, 'input 1, which is what it recorded');
  assert(!describeInput(ref).includes('입력'), `and not named: ${describeInput(ref)}`);
});

check('changing the socket keeps the device', () => {
  const { session, trackId } = trackOn({ firstChannel: 0, channels: 1 });
  const moved = setTrackInputPatch(session, trackId, { firstChannel: 2, channels: 2 });
  const ref = trackInputRef(findTrack(moved, trackId)!);
  assert(ref.firstChannel === 2 && ref.channels === 2, describeInput(ref));
  assert(ref.deviceLabel === 'Scarlett 18i20', 'the box did not change');
});

check('a socket is held inside a width the device actually reports', () => {
  const wanted = { ...DEFAULT_INPUT_REF, deviceLabel: 'Built-in Microphone',
    deviceId: 'dev-b', firstChannel: 4, channels: 1 as const };
  const found = resolveTrackInput(wanted, [BUILT_IN]);
  assert(found.patch.firstChannel === 0, 'a one-input device has no input 5');
});

check('a width the browser will not report is left to the open stream', () => {
  // No `channels` — which is what `enumerateDevices` says before permission,
  // and most of the time after it too.
  const silent = { id: 'dev-c', label: 'Some Interface' };
  const wanted = { ...DEFAULT_INPUT_REF, deviceLabel: 'Some Interface',
    deviceId: 'dev-c', firstChannel: 6, channels: 2 as const };
  const found = resolveTrackInput(wanted, [silent]);
  assert(found.patch.firstChannel === 6 && found.patch.channels === 2,
    'passed through, not clamped against a number nobody gave');
});

check('the socket is NOT carried over to the fallback device', () => {
  // The interface is unplugged.  "Input 5" was said about IT.
  const wanted = { ...DEFAULT_INPUT_REF, deviceLabel: 'Scarlett 18i20',
    deviceId: 'dev-a', firstChannel: 4, channels: 1 as const };
  const found = resolveTrackInput(wanted, [BUILT_IN]);
  assert(found.kind === 'missing', found.kind);
  assert(found.patch.firstChannel === 0,
    `the default input has no input 5, got ${found.patch.firstChannel + 1}`);
  assert(found.reason !== null, 'and it is said out loud');
});

check('refPatch is the socket half of an assignment', () => {
  const ref = { ...DEFAULT_INPUT_REF, firstChannel: 2, channels: 2 as const };
  const patch = refPatch(ref);
  assert(patch.firstChannel === 2 && patch.channels === 2, describePatch(patch));
});

// ── The correction the settings actually apply ──────────────────────────────

check('the settings decide how much comes off a take', () => {
  const base = { ...DEFAULT_RECORD_SETTINGS, latencySec: 0.02, latencySource: 'measured' as const };
  near(settingsLatency(base), 0.02, 1e-9, 'applied');
  near(settingsLatency({ ...base, latencyEnabled: false }), 0, 1e-9, 'and off means off');
  near(settingsLatency({ ...base, latencySec: 9 }), MAX_LATENCY_SEC, 1e-9,
    'an absurd number is still refused here');
  near(settingsLatency(DEFAULT_RECORD_SETTINGS), 0, 1e-9,
    'a fresh session compensates nothing until it has a number');
});

check('two clicks that agree are believed', () => {
  const both = agreeLoopback([0.0204, 0.0208]);
  near(both as number, 0.0206, 1e-9, 'and averaged');
});

check('two clicks that disagree are refused, not averaged', () => {
  // What an unplugged input gives: the first pass finds the room, the second
  // finds it somewhere else.  Averaging those two would be a fabricated number
  // with no signal behind it.
  assert(agreeLoopback([0.02, 0.24]) === null, 'far apart is not a measurement');
  assert(agreeLoopback([0.02, 0.02 + CALIBRATION_AGREE_SEC * 2]) === null,
    'and the tolerance is a boundary, not a suggestion');
});

check('a pass that found nothing sinks the whole calibration', () => {
  assert(agreeLoopback([0.02, null]) === null, 'one silent pass is a refusal');
  assert(agreeLoopback([null, null]) === null, 'and so are two');
  assert(agreeLoopback([]) === null, 'and no passes at all');
});

// ─────────────────────────────────────────────────────────────────────────────

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log('\n=== Hardware I/O: interface inputs and round-trip latency ===');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
if (failed > 0) process.exit(1);
