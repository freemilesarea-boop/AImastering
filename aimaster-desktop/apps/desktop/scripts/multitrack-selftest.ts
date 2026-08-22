/**
 * multitrack-selftest — several tracks rolling at once.
 *
 * A band take is six microphones and a keyboard on the same transport.  What
 * has to be true about that, and is checked here:
 *
 *   THE TAKES LINE UP.  Every track's clip starts at the same timeline second,
 *   because they all came off the same tape zero.  A take that is right on
 *   track one and eight milliseconds late on track four is not a band take.
 *
 *   ONE UNDO STEP.  The whole pass is one edit — never a session that is half
 *   recorded between two presses of Cmd+Z.
 *
 *   ONE TRACK'S FAILURE IS NOT THE PASS'S.  An unplugged microphone on channel
 *   four keeps the five that worked, and is REPORTED by name.
 *
 *   THE READINESS CHECK NAMES THE TRACK.  With six armed, "an input is not
 *   open" tells you nothing about which one to go and look at.
 *
 * Run: pnpm --filter @aimaster/desktop test:multitrack
 */

import {
  DEFAULT_RECORD_SETTINGS, MAX_RECORD_TRACKS, armedSplit, armedTracks, canRecord,
  describeArmed, planRecording, setRecordArm, trackRecordKind,
  type RecordSettings,
} from '../src/renderer/daw/model/recording.js';
import {
  commitPass, describePass, passIsEmpty, type PassCapture,
} from '../src/renderer/daw/edit/record-pass.js';
import { captureNotes, type CaptureEvent } from '../src/renderer/daw/model/midi-capture.js';
import type { AudioWriter } from '../src/renderer/daw/edit/record-actions.js';
import {
  activePlaylist, addTrack, createSession, createTrack, findTrack, updateTrack,
} from '../src/renderer/daw/model/session-ops.js';
import { resetIds } from '../src/renderer/daw/model/ids.js';
import { resetNoteIds } from '../src/renderer/daw/model/midi.js';
import { partClock } from '../src/renderer/daw/model/note-time.js';
import { tempoMapOf } from '../src/renderer/daw/model/tempo-map.js';
import type { DawSession, Track, TrackId } from '../src/renderer/daw/model/types.js';

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
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

/** A ramp, so a slice can be identified by the value it starts at. */
function ramp(seconds: number, offset = 0): Float32Array {
  const out = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < out.length; i++) out[i] = offset + i / SR;
  return out;
}

function take(seconds: number, offset = 0): { channels: Float32Array[]; sampleRate: number } {
  return { channels: [ramp(seconds, offset)], sampleRate: SR };
}

/** A session with N audio tracks and M instrument tracks, all armed. */
function band(audioCount: number, midiCount = 0): { session: DawSession; tracks: Track[] } {
  resetIds();
  resetNoteIds();
  let session = createSession('band');
  const tracks: Track[] = [];
  for (let i = 0; i < audioCount; i++) {
    const track = createTrack(`Mic ${i + 1}`, 'audio');
    tracks.push(track);
    session = addTrack(session, track);
  }
  for (let i = 0; i < midiCount; i++) {
    const track = createTrack(`Keys ${i + 1}`, 'instrument');
    tracks.push(track);
    session = addTrack(session, track);
  }
  for (const track of tracks) session = setRecordArm(session, track.id, true);
  return { session, tracks };
}

function fakeWriter(): { writer: AudioWriter; calls: string[] } {
  const calls: string[] = [];
  const writer: AudioWriter = async (_channels, _rate, name) => {
    calls.push(name);
    return `/tmp/${name}-${calls.length}.wav`;
  };
  return { writer, calls };
}

async function run(): Promise<void> {
  const check = async (name: string, fn: () => void | Promise<void>): Promise<void> => {
    try { await fn(); results.push({ name, pass: true, detail: '' }); }
    catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
  };

  // ── 1. Arming ───────────────────────────────────────────────────────────

  await check('several tracks can be armed at once', () => {
    const { session, tracks } = band(4);
    eq(armedTracks(session).length, 4, 'four armed');
    const ready = canRecord(session, settings(), { audioOpen: tracks.map((t) => t.id) });
    assert(ready.ok, `and allowed — ${ready.reason ?? ''}`);
  });

  await check('audio and instrument tracks can now be armed together', () => {
    const { session, tracks } = band(2, 1);
    const split = armedSplit(session);
    eq(split.audio.length, 2, 'two microphones');
    eq(split.midi.length, 1, 'one keyboard');
    const ready = canRecord(session, settings(), {
      audioOpen: split.audio.map((t) => t.id), midiOpen: true,
    });
    assert(ready.ok, `a band take is allowed — ${ready.reason ?? ''}`);
    eq(trackRecordKind(tracks[0]!), 'audio', 'a microphone records audio');
    eq(trackRecordKind(tracks[2]!), 'midi', 'a keyboard records MIDI');
  });

  await check('the readiness check names the track whose input is missing', () => {
    const { session, tracks } = band(4);
    // Everything open except Mic 3.
    const open = tracks.filter((t) => t.name !== 'Mic 3').map((t) => t.id);
    const ready = canRecord(session, settings(), { audioOpen: open });
    assert(!ready.ok, 'refused');
    assert((ready.reason ?? '').includes('Mic 3'),
      `and says which one — got "${ready.reason}"`);
  });

  await check('two missing inputs are counted, not listed forever', () => {
    const { session, tracks } = band(5);
    const open = [tracks[0]!.id];
    const ready = canRecord(session, settings(), { audioOpen: open });
    assert(!ready.ok, 'refused');
    assert((ready.reason ?? '').includes('4개'), `counted — got "${ready.reason}"`);
  });

  await check('a frozen track among many is named', () => {
    const { session, tracks } = band(3);
    const frozen = updateTrack(session, tracks[1]!.id, (t) => ({ ...t, frozen: { fileId: 'frozen-f1', renderedInsertIds: [], frozenAt: 0 } }));
    const ready = canRecord(frozen, settings(), { audioOpen: tracks.map((t) => t.id) });
    assert(!ready.ok, 'refused');
    assert((ready.reason ?? '').includes('Mic 2'), `and named — got "${ready.reason}"`);
  });

  await check('there is a stated limit, and it refuses cleanly', () => {
    const { session, tracks } = band(MAX_RECORD_TRACKS + 1);
    const ready = canRecord(session, settings(), { audioOpen: tracks.map((t) => t.id) });
    assert(!ready.ok, 'refused');
    assert((ready.reason ?? '').includes(String(MAX_RECORD_TRACKS)),
      `stating the limit — got "${ready.reason}"`);

    const exact = band(MAX_RECORD_TRACKS);
    assert(canRecord(exact.session, settings(),
      { audioOpen: exact.tracks.map((t) => t.id) }).ok, 'and the limit itself is allowed');
  });

  await check('describeArmed says what the next take will capture', () => {
    eq(describeArmed(band(3).session), '오디오 3', 'microphones only');
    eq(describeArmed(band(0, 2).session), 'MIDI 2', 'keyboards only');
    eq(describeArmed(band(3, 1).session), '오디오 3 · MIDI 1', 'a band');
    eq(describeArmed(createSession('empty')), '', 'nothing armed');
  });

  // ── 2. The pass lands ───────────────────────────────────────────────────

  await check('three microphones become three takes in one session', async () => {
    const { session, tracks } = band(3);
    const plan = planRecording(session, settings({ preRollSec: 0 }), 12);
    const { writer, calls } = fakeWriter();
    const capture: PassCapture = {
      audio: new Map(tracks.map((t, i) => [t.id, take(4, i)])),
      midi: null,
      tapeSec: 4,
    };

    const result = await commitPass(session, capture, plan, settings(), writer);
    eq(result.audioTracks.length, 3, 'three tracks got takes');
    eq(result.takes, 3, 'three takes');
    eq(calls.length, 3, 'one file written per track — not one shared file');
    eq(result.problems.length, 0, 'and nothing went wrong');

    // The point of the whole feature: they line up.
    for (const track of tracks) {
      const laid = findTrack(result.session, track.id);
      const clip = activePlaylist(laid!)?.clips[0];
      assert(clip !== undefined, `${track.name} has a clip`);
      close(clip?.startSec ?? -1, 12, `${track.name} starts where the take started`);
      close(clip?.durationSec ?? -1, 4, `${track.name} is the same length`);
    }
  });

  await check('the pass is ONE session, not three half-applied ones', async () => {
    const { session, tracks } = band(3);
    const plan = planRecording(session, settings({ preRollSec: 0 }), 0);
    const { writer } = fakeWriter();
    const result = await commitPass(session, {
      audio: new Map(tracks.map((t) => [t.id, take(2)])), midi: null, tapeSec: 2,
    }, plan, settings(), writer);

    // Every track's take is present in the SAME returned session.
    for (const track of tracks) {
      const laid = findTrack(result.session, track.id);
      eq(laid?.playlists.length, 2, `${track.name} gained exactly one take lane`);
    }
    // And the input session is untouched, so undo goes back to before the take.
    for (const track of tracks) {
      eq(findTrack(session, track.id)?.playlists.length, 1, `${track.name} unchanged`);
    }
  });

  await check('takes are laid in session track order, not map order', async () => {
    const { session, tracks } = band(3);
    const plan = planRecording(session, settings({ preRollSec: 0 }), 0);
    const { writer, calls } = fakeWriter();
    // Hand the map over backwards.
    const reversed = new Map([...tracks].reverse().map((t) => [t.id, take(1)]));
    await commitPass(session, { audio: reversed, midi: null, tapeSec: 1 }, plan, settings(), writer);
    eq(calls.join(','), 'Mic 1-take,Mic 2-take,Mic 3-take',
      'so take lane numbers read the same way twice');
  });

  await check('a microphone that recorded nothing is reported by name', async () => {
    const { session, tracks } = band(3);
    const plan = planRecording(session, settings({ preRollSec: 0 }), 0);
    const { writer } = fakeWriter();
    // Mic 2's stream died — it is armed but has no tape.
    const audio = new Map([[tracks[0]!.id, take(2)], [tracks[2]!.id, take(2)]]);
    const result = await commitPass(session, { audio, midi: null, tapeSec: 2 }, plan, settings(), writer);

    eq(result.audioTracks.length, 2, 'the two that worked are committed');
    eq(result.problems.length, 1, 'one problem');
    assert(result.problems[0]?.includes('Mic 2'), `naming the silent one — ${result.problems[0]}`);
  });

  await check('one track failing to commit does not throw the pass away', async () => {
    const { session, tracks } = band(3);
    const plan = planRecording(session, settings({ preRollSec: 0 }), 0);
    let call = 0;
    const writer: AudioWriter = async (_c, _r, name) => {
      call += 1;
      if (call === 2) throw new Error('디스크가 가득 찼습니다');
      return `/tmp/${name}.wav`;
    };
    const result = await commitPass(session, {
      audio: new Map(tracks.map((t) => [t.id, take(2)])), midi: null, tapeSec: 2,
    }, plan, settings(), writer);

    eq(result.audioTracks.length, 2, 'the other two survive');
    eq(result.problems.length, 1, 'the failure is reported');
    assert(result.problems[0]?.includes('Mic 2'), `by name — ${result.problems[0]}`);
    assert(result.problems[0]?.includes('디스크'), 'with the reason');
  });

  await check('an empty pass is recognisable before anything is written', () => {
    assert(passIsEmpty({ audio: new Map(), midi: null, tapeSec: 3 }), 'nothing at all');
    assert(passIsEmpty({ audio: new Map(), midi: { events: [], trackIds: ['t'] }, tapeSec: 3 }),
      'a keyboard that was not played is also nothing');
    assert(!passIsEmpty({ audio: new Map([['t', take(1)]]), midi: null, tapeSec: 1 }),
      'one tape is not nothing');
  });

  // ── 3. The keyboard rides along ─────────────────────────────────────────

  const notesOf = (session: DawSession, trackId: TrackId): number => {
    const laid = findTrack(session, trackId);
    return activePlaylist(laid!)?.clips[0]?.notes.length ?? 0;
  };

  const phrase = (): CaptureEvent[] => [
    { kind: 'noteOn', timeSec: 0.5, channel: 0, pitch: 60, velocity: 0.8 },
    { kind: 'noteOff', timeSec: 1.0, channel: 0, pitch: 60, velocity: 0.5 },
    { kind: 'noteOn', timeSec: 1.2, channel: 0, pitch: 64, velocity: 0.7 },
    { kind: 'noteOff', timeSec: 1.8, channel: 0, pitch: 64, velocity: 0.5 },
  ];

  await check('one keyboard performance lands on every armed instrument track', async () => {
    const { session, tracks } = band(0, 3);
    const plan = planRecording(session, settings({ preRollSec: 0 }), 8);
    const { writer } = fakeWriter();
    const result = await commitPass(session, {
      audio: new Map(),
      midi: { events: phrase(), trackIds: tracks.map((t) => t.id) },
      tapeSec: 3,
    }, plan, settings(), writer);

    eq(result.midiTracks.length, 3, 'all three layered');
    for (const track of tracks) {
      eq(notesOf(result.session, track.id), 2, `${track.name} got the phrase`);
      const clip = activePlaylist(findTrack(result.session, track.id)!)?.clips[0];
      close(clip?.startSec ?? -1, 8, `${track.name} sits at the punch point`);
    }
    assert(result.midiCapture !== null, 'the capture is reported');
    eq(result.midiCapture?.notes.length, 2, 'two notes');
  });

  await check('microphones and a keyboard in the same pass, aligned', async () => {
    const { session, tracks } = band(2, 1);
    const audioTracks = tracks.slice(0, 2);
    const keyboard = tracks[2]!;
    const plan = planRecording(session, settings({ preRollSec: 1 }), 20);
    const { writer } = fakeWriter();

    const result = await commitPass(session, {
      // Three seconds of tape, one of which is pre-roll.
      audio: new Map(audioTracks.map((t) => [t.id, take(3)])),
      midi: { events: phrase(), trackIds: [keyboard.id] },
      tapeSec: 3,
    }, plan, settings(), writer);

    eq(result.audioTracks.length, 2, 'both microphones');
    eq(result.midiTracks.length, 1, 'and the keyboard');
    eq(result.problems.length, 0, 'nothing wrong');

    for (const track of audioTracks) {
      const clip = activePlaylist(findTrack(result.session, track.id)!)?.clips[0];
      close(clip?.startSec ?? -1, 20, `${track.name} starts at the punch`);
      close(clip?.durationSec ?? -1, 2, `${track.name} lost its one-second pre-roll`);
    }
    const part = activePlaylist(findTrack(result.session, keyboard.id)!)?.clips[0];
    close(part?.startSec ?? -1, 20, 'the keyboard part starts at the same second');
    // The note played at tape 1.2 s is 0.2 s into the take, since the first
    // second was pre-roll.  Same origin as the audio, therefore aligned.
    const second = part?.notes.find((n) => n.pitch === 64);
    close(second?.startBeat ?? -1, 0.4, 'and its notes sit where they were played');
  });

  await check('the pre-roll is dropped identically on every track', async () => {
    const { session, tracks } = band(3);
    const plan = planRecording(session, settings({ preRollSec: 2 }), 30);
    const { writer } = fakeWriter();
    const result = await commitPass(session, {
      audio: new Map(tracks.map((t) => [t.id, take(5)])), midi: null, tapeSec: 5,
    }, plan, settings(), writer);

    for (const track of tracks) {
      const clip = activePlaylist(findTrack(result.session, track.id)!)?.clips[0];
      close(clip?.startSec ?? -1, 30, `${track.name} starts at the punch, not two seconds early`);
      close(clip?.durationSec ?? -1, 3, `${track.name} kept three of its five seconds`);
      close(clip?.offsetSec ?? -1, 0, `${track.name} reads from the top of its kept file`);
    }
  });

  await check('loop passes cut every track at the same wrap points', async () => {
    const { session, tracks } = band(2);
    const plan = planRecording(
      session, settings({ preRollSec: 0 }), 0, { startSec: 0, endSec: 2 });
    const { writer } = fakeWriter();
    // Six seconds over a two-second loop = three passes.
    const result = await commitPass(session, {
      audio: new Map(tracks.map((t) => [t.id, take(6)])), midi: null, tapeSec: 6,
    }, plan, settings(), writer);

    eq(result.takes, 6, 'three passes on each of two tracks');
    for (const track of tracks) {
      const laid = findTrack(result.session, track.id);
      eq(laid?.playlists.length, 4, `${track.name} has its original lane plus three takes`);
      for (const lane of laid?.playlists.slice(-3) ?? []) {
        close(lane.clips[0]?.startSec ?? -1, 0, `${track.name} pass starts at the loop top`);
        close(lane.clips[0]?.durationSec ?? -1, 2, `${track.name} pass is one cycle`);
      }
    }
  });

  await check('describePass says what the pass actually laid down', async () => {
    const { session, tracks } = band(2, 1);
    const plan = planRecording(session, settings({ preRollSec: 0 }), 0);
    const { writer } = fakeWriter();
    const result = await commitPass(session, {
      audio: new Map(tracks.slice(0, 2).map((t) => [t.id, take(2)])),
      midi: { events: phrase(), trackIds: [tracks[2]!.id] },
      tapeSec: 2,
    }, plan, settings(), writer);
    const text = describePass(result);
    assert(text.includes('오디오 2트랙'), `audio counted — ${text}`);
    assert(text.includes('MIDI 1트랙'), `midi counted — ${text}`);

    eq(describePass({
      session, audioTracks: [], midiTracks: [], takes: 0, midiCapture: null, problems: [],
    }), '기록된 것이 없습니다', 'and an empty pass says so');
  });

  await check('a keyboard nobody played leaves the microphones alone', async () => {
    const { session, tracks } = band(2, 1);
    const plan = planRecording(session, settings({ preRollSec: 0 }), 0);
    const { writer } = fakeWriter();
    const result = await commitPass(session, {
      audio: new Map(tracks.slice(0, 2).map((t) => [t.id, take(2)])),
      midi: { events: [], trackIds: [tracks[2]!.id] },
      tapeSec: 2,
    }, plan, settings(), writer);

    eq(result.audioTracks.length, 2, 'the microphones committed');
    eq(result.midiTracks.length, 0, 'the empty keyboard did not');
    eq(result.problems.length, 1, 'and it is reported rather than silent');
    assert(result.problems[0]?.includes('Keys 1'), `by name — ${result.problems[0]}`);
  });

  await check('the MIDI capture is read once and shared by every armed track', async () => {
    // Two tracks must receive the SAME notes, not two independent parses that
    // could drift if the capture options were applied differently.
    const { session, tracks } = band(0, 2);
    const plan = planRecording(session, settings({ preRollSec: 0 }), 0);
    const { writer } = fakeWriter();
    const events = phrase();
    const result = await commitPass(session, {
      audio: new Map(), midi: { events, trackIds: tracks.map((t) => t.id) }, tapeSec: 3,
    }, plan, settings(), writer);

    const a = activePlaylist(findTrack(result.session, tracks[0]!.id)!)?.clips[0]?.notes ?? [];
    const b = activePlaylist(findTrack(result.session, tracks[1]!.id)!)?.clips[0]?.notes ?? [];
    eq(a.length, b.length, 'same count');
    for (let i = 0; i < a.length; i++) {
      eq(a[i]?.pitch, b[i]?.pitch, `note ${i} pitch`);
      close(a[i]?.startBeat ?? -1, b[i]?.startBeat ?? -2, `note ${i} start`);
      close(a[i]?.durationBeat ?? -1, b[i]?.durationBeat ?? -2, `note ${i} length`);
    }
    // And it matches what the shared parse produced.
    const direct = captureNotes(events, { endSec: 3, clock: partClock(tempoMapOf(result.session), 0) });
    eq(a.length, direct.notes.length, 'and it is the same parse the caller can reproduce');
  });

  // ── Report ──────────────────────────────────────────────────────────────

  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  console.log('\n=== Multi-track recording: arm · roll · commit as one ===');
  for (const r of results) {
    console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  }
  console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
  if (failed > 0) process.exit(1);
}

void run();
