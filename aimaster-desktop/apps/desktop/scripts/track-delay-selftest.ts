/**
 * track-delay-selftest — moving one track in time, and hearing it move.
 *
 * Track Delay is a number that is easy to store and easy to store WITHOUT
 * connecting to anything: a field in the inspector, a tooltip, and audio that
 * comes out exactly where it always did.  So most of this file renders the
 * mixer offline and MEASURES where the click landed, sample by sample.  A
 * test that only checks `track.delayMs === 20` would pass on a build where
 * the engine never reads it.
 *
 * The properties that matter:
 *
 *   • +20 ms puts the sound 20 ms later.  Not "later" — 960 samples later at
 *     48 kHz, on both signs, and nothing else moves with it.
 *   • A negative delay at the top of the timeline CUTS the head rather than
 *     sliding the clip late.  There is no time before zero; pretending
 *     otherwise turns an alignment nudge into a silent 30 ms flam.
 *   • A bus refuses a negative delay and says what to do instead.  It has no
 *     events to re-schedule and no sound yet to move.
 *   • The song gets longer.  A track pushed 200 ms late must not lose its
 *     tail off the end of every bounce.
 *
 * Run: pnpm --filter @aimaster/desktop test:track-delay
 */

import { OfflineAudioContext } from 'node-web-audio-api';

// renderSession reads OfflineAudioContext off globalThis (the browser has it).
(globalThis as unknown as { OfflineAudioContext: unknown }).OfflineAudioContext = OfflineAudioContext;

import {
  addFile, addTrack, createBus, createClip, createMidiPart, createSend, createSession,
  createTrack, findTrack, sessionEndSec, setSend, updateClip, updateClips, updateTrack,
} from '../src/renderer/daw/model/session-ops.js';
import { createNote, resetNoteIds } from '../src/renderer/daw/model/midi.js';
import { resetIds } from '../src/renderer/daw/model/ids.js';
import { analyzeBuffer, clearAudioCache } from '../src/renderer/daw/engine/audio-cache.js';
import { renderSession, renderTrack } from '../src/renderer/daw/engine/offline-render.js';
import {
  MAX_TRACK_DELAY_MS, delayMechanism, scheduleShiftSec, signalDelaySec, trackDelayMs,
} from '../src/renderer/daw/model/track-delay.js';
import {
  canDelay, clearTrackDelay, delayProblems, delayedTracks, describeDelay, describeDelays,
  nudgeTrackDelay, setTrackDelay,
} from '../src/renderer/daw/edit/track-delay-ops.js';
import { deserializeDawSession, serializeDawSession } from '../src/renderer/daw/model/session-io.js';
import type { DawSession, Track } from '../src/renderer/daw/model/types.js';

const SR = 48_000;

const results: { name: string; pass: boolean }[] = [];
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve().then(fn)
    .then(() => { results.push({ name, pass: true }); console.log(`[PASS] ${name}`); })
    .catch((e: unknown) => {
      results.push({ name, pass: false });
      console.log(`[FAIL] ${name} — ${e instanceof Error ? e.message : String(e)}`);
    });
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }
function eq(a: unknown, b: unknown, m: string): void {
  if (a !== b) throw new Error(`${m} — got ${String(a)}, want ${String(b)}`);
}
function close(a: number, b: number, m: string, tol: number): void {
  if (!(Math.abs(a - b) <= tol)) throw new Error(`${m} — got ${a}, want ${b} ±${tol}`);
}

/** First sample whose magnitude crosses the threshold — where the sound is. */
function onsetIndex(data: Float32Array, threshold = 0.05): number {
  for (let i = 0; i < data.length; i++) if (Math.abs(data[i] ?? 0) > threshold) return i;
  return -1;
}
function peak(data: Float32Array, from = 0, to = data.length): number {
  let p = 0;
  for (let i = from; i < to; i++) p = Math.max(p, Math.abs(data[i] ?? 0));
  return p;
}

/** A single 64-sample click at t=0, then silence — an alignment ruler. */
function makeClickFile(fileId: string, seconds: number): void {
  const ctx = new OfflineAudioContext(2, Math.floor(SR * seconds), SR);
  const buffer = ctx.createBuffer(2, Math.floor(SR * seconds), SR);
  for (let c = 0; c < 2; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < 64; i++) data[i] = 1 - i / 64;
  }
  analyzeBuffer(fileId, buffer as unknown as AudioBuffer);
}

function clickSession(startSec: number): { session: DawSession; trackId: string } {
  resetIds();
  let session = createSession('Delay Test', SR);
  const track = createTrack('Click', 'audio');
  session = addTrack(session, track);
  session = addFile(session, {
    id: 'click', path: '/virtual/click.wav', name: 'click',
    durationSec: 1, sampleRate: SR, channels: 2,
  });
  session = updateClips(session, track.id, () => [
    createClip('click', 'click', { startSec, offsetSec: 0, durationSec: 0.5 }),
  ]);
  return { session, trackId: track.id };
}

const render = (session: DawSession, seconds: number): Promise<AudioBuffer> =>
  renderSession(session, { startSec: 0, endSec: seconds }, { sampleRate: SR, tailSec: 0 });

const delayOf = (session: DawSession, trackId: string): number =>
  trackDelayMs(findTrack(session, trackId)!);

async function main(): Promise<void> {
  clearAudioCache();
  makeClickFile('click', 1);

  // ── Reading the value ───────────────────────────────────────────────────

  await check('a track saved before Track Delay existed reads 0, not NaN', () => {
    const { session, trackId } = clickSession(0.2);
    const track = findTrack(session, trackId)!;
    assert(!('delayMs' in track) || track.delayMs === undefined, 'the fixture has no delay field');
    eq(trackDelayMs(track), 0, 'and it reads as no delay');
    eq(scheduleShiftSec(track), 0, 'shifting nothing');
    // Through a real save/load round trip, which is how such a track arrives.
    const parsed = deserializeDawSession(serializeDawSession(session));
    assert(parsed.ok, 'the session loads');
    if (parsed.ok) eq(trackDelayMs(parsed.session.tracks[1]!), 0, 'still no delay after loading');
  });

  await check('rubbish in the field reads as no delay', () => {
    const bad = { kind: 'audio', name: 'X', delayMs: NaN } as unknown as Track;
    eq(trackDelayMs(bad), 0, 'NaN');
    eq(trackDelayMs({ ...bad, delayMs: 99999 } as Track), MAX_TRACK_DELAY_MS, 'over the cap');
    eq(trackDelayMs({ ...bad, delayMs: -99999 } as Track), -MAX_TRACK_DELAY_MS, 'under it');
  });

  await check('the mechanism follows the kind, because physics does', () => {
    const of = (kind: Track['kind']): string => delayMechanism(createTrack('t', kind));
    eq(of('audio'), 'events', 'audio owns clips');
    eq(of('instrument'), 'events', 'so does an instrument track');
    eq(of('aux'), 'signal', 'a bus can only be held back');
    eq(of('master'), 'signal', 'so can the master');
    eq(of('vca'), 'none', 'a VCA carries no signal');
    eq(of('folder'), 'none', 'nor does a folder');
  });

  // ── Setting it ──────────────────────────────────────────────────────────

  await check('a bus refuses to be pulled early, and says what to do instead', () => {
    resetIds();
    let s = createSession('bus', SR);
    const bus = createBus('Drum Bus');
    s = { ...s, buses: [bus] };
    const aux = createTrack('Drum Bus', 'aux', { input: bus.id, output: { kind: 'master' } });
    s = addTrack(s, aux);

    const early = setTrackDelay(s, aux.id, -20);
    eq(early.applied, false, 'refused');
    assert(early.reason?.includes('들어오는 트랙'), `and points somewhere useful: ${early.reason}`);
    eq(early.session, s, 'and nothing changed');

    const late = setTrackDelay(s, aux.id, 20);
    eq(late.applied, true, 'but holding it back is fine');
    close(signalDelaySec(findTrack(late.session, aux.id)!), 0.02, 'and it reaches the delay line', 1e-9);
    eq(scheduleShiftSec(findTrack(late.session, aux.id)!), 0, 'not the scheduler');
  });

  await check('a VCA has nothing to delay', () => {
    resetIds();
    let s = createSession('vca', SR);
    const vca = createTrack('Drums VCA', 'vca');
    s = addTrack(s, vca);
    const r = setTrackDelay(s, vca.id, 10);
    eq(r.applied, false, 'refused');
    assert(r.reason?.includes('신호'), `for the right reason: ${r.reason}`);
    eq(canDelay(vca, 0).ok, false, 'even zero is meaningless here');
  });

  await check('the value is clamped and rounded to a tenth of a millisecond', () => {
    const { session, trackId } = clickSession(0.2);
    eq(delayOf(setTrackDelay(session, trackId, 12.3456).session, trackId), 12.3, 'rounded');
    eq(delayOf(setTrackDelay(session, trackId, 9999).session, trackId), MAX_TRACK_DELAY_MS, 'capped');
    eq(delayOf(setTrackDelay(session, trackId, -9999).session, trackId), -MAX_TRACK_DELAY_MS, 'both ways');
  });

  await check('nudging accumulates and stops at the cap', () => {
    const { session, trackId } = clickSession(0.2);
    let s = session;
    for (let i = 0; i < 4; i++) s = nudgeTrackDelay(s, trackId, -5).session;
    eq(delayOf(s, trackId), -20, 'four nudges of 5 ms');
    for (let i = 0; i < 200; i++) s = nudgeTrackDelay(s, trackId, -10).session;
    eq(delayOf(s, trackId), -MAX_TRACK_DELAY_MS, 'and it stops rather than running away');
    eq(delayOf(clearTrackDelay(s, trackId).session, trackId), 0, 'clearing puts it back');
  });

  await check('the readout says which way, not just how much', () => {
    assert(describeDelay(12).includes('늦게'), describeDelay(12));
    assert(describeDelay(-12).includes('먼저'), describeDelay(-12));
    eq(describeDelay(0), '0 ms', 'and zero is just zero');
    const { session, trackId } = clickSession(0.2);
    eq(describeDelays(session), '트랙 딜레이 없음', 'nothing set');
    const s = setTrackDelay(session, trackId, -9).session;
    eq(delayedTracks(s).length, 1, 'one track carries one');
    assert(describeDelays(s).includes('Click'), describeDelays(s));
  });

  // ── What it costs ───────────────────────────────────────────────────────

  await check('a negative delay that runs out of timeline says so', () => {
    const { session, trackId } = clickSession(0.01);
    eq(delayProblems(session).length, 0, 'nothing wrong yet');
    const s = setTrackDelay(session, trackId, -30).session;
    const problems = delayProblems(s);
    eq(problems.length, 1, 'one problem');
    assert(problems[0]!.includes('Click'), `naming the track: ${problems[0]}`);
    assert(problems[0]!.includes('20 ms'), `and the amount lost: ${problems[0]}`);
    // Push the clip past the delay and the problem goes away on its own.
    const moved = updateClips(s, trackId, (clips) => clips.map((c) => ({ ...c, startSec: 1 })));
    eq(delayProblems(moved).length, 0, 'a clip with room to move loses nothing');
  });

  await check('the song ends when the last sound stops, not the last rectangle', () => {
    const { session, trackId } = clickSession(1);
    close(sessionEndSec(session), 1.5, 'the clip ends at 1.5 s', 1e-9);
    const late = setTrackDelay(session, trackId, 200).session;
    close(sessionEndSec(late), 1.7, 'and 200 ms later when the track is', 1e-9);
    const early = setTrackDelay(session, trackId, -200).session;
    close(sessionEndSec(early), 1.3, 'and earlier when it is pulled forward', 1e-9);
  });

  // ── Rendered audio ──────────────────────────────────────────────────────

  const clickAt = async (delayMs: number, startSec = 0.2): Promise<number> => {
    const { session, trackId } = clickSession(startSec);
    const s = delayMs === 0 ? session : setTrackDelay(session, trackId, delayMs).session;
    const out = await render(s, 1);
    return onsetIndex(out.getChannelData(0), 0.2);
  };

  await check('+20 ms puts the click 960 samples later — measured, not assumed', async () => {
    const dry = await clickAt(0);
    close(dry, Math.round(0.2 * SR), 'the undelayed click is where the clip is', 8);
    const late = await clickAt(20);
    close(late - dry, Math.round(0.02 * SR), '20 ms at 48 kHz is 960 samples', 8);
  });

  await check('a negative delay really plays early', async () => {
    const dry = await clickAt(0);
    const early = await clickAt(-80);
    close(early - dry, -Math.round(0.08 * SR), '80 ms earlier', 8);
    assert(early > 0, 'and it is still on the timeline');
  });

  await check('pulled past the start, the head is LOST — the clip does not slide late', async () => {
    // The click lives in the first 64 samples of the file.  A clip that
    // starts 10 ms in, pulled 80 ms early, has 70 ms of nothing to give: the
    // right answer is that the click is gone, not that it plays at 0 anyway.
    const { session, trackId } = clickSession(0.01);
    const s = setTrackDelay(session, trackId, -80).session;
    const out = await render(s, 1);
    const data = out.getChannelData(0);
    assert(peak(data) < 0.02, `nothing should be left of the click, peak ${peak(data)}`);
    // And the model warned about exactly this before it was rendered.
    assert(delayProblems(s).length === 1, 'and it was reported, not silent');
  });

  await check('only the delayed track moves', async () => {
    const { session, trackId } = clickSession(0.2);
    // A second click track, undelayed, at a different spot.
    const other = createTrack('Other', 'audio');
    let s = addTrack(session, other);
    s = updateClips(s, other.id, () => [
      createClip('click', 'click2', { startSec: 0.6, offsetSec: 0, durationSec: 0.2 }),
    ]);
    s = setTrackDelay(s, trackId, 50).session;

    const out = await render(s, 1);
    const data = out.getChannelData(0);
    // Two clicks: the delayed one at 250 ms, the other still at 600 ms.
    const first = onsetIndex(data, 0.2);
    close(first, Math.round(0.25 * SR), 'the delayed track moved', 8);
    const secondFrom = first + 128;
    let secondIdx = -1;
    for (let i = secondFrom; i < data.length; i++) {
      if (Math.abs(data[i] ?? 0) > 0.2) { secondIdx = i; break; }
    }
    close(secondIdx, Math.round(0.6 * SR), 'and the other one did not', 8);
  });

  await check('a MIDI note moves with its track', async () => {
    resetIds(); resetNoteIds();
    let s = createSession('midi', SR);
    const track = createTrack('Synth', 'instrument');
    s = addTrack(s, track);
    const part = createMidiPart('Part', { startSec: 0.2, durationSec: 2 });
    s = updateClips(s, track.id, () => [part]);
    s = updateClip(s, track.id, part.id, (c) => ({
      ...c, notes: [createNote({ startBeat: 0, durationBeat: 0.5, velocity: 1 })],
    }));

    const dryOut = await render(s, 1.2);
    const dry = onsetIndex(dryOut.getChannelData(0), 0.02);
    assert(dry > 0, 'the note sounds at all');

    const shifted = setTrackDelay(s, track.id, 120).session;
    const lateOut = await render(shifted, 1.2);
    const late = onsetIndex(lateOut.getChannelData(0), 0.02);
    close(late - dry, Math.round(0.12 * SR), 'the note is 120 ms later', 64);
  });

  await check('the delay is milliseconds, not beats — it does not scale with tempo', () => {
    // The clock is read at the note's real position and the shift added in
    // seconds afterwards.  If it went through the clock instead, 100 ms would
    // become "however long 100 ms was at the old tempo" and a track aligned at
    // 60 BPM would drift the moment the song sped up.
    return (async () => {
      const at = async (bpm: number, delayMs: number): Promise<number> => {
        resetIds(); resetNoteIds();
        let s = createSession('musical', SR);
        s = { ...s, tempoBpm: bpm };
        const track = createTrack('Synth', 'instrument');
        s = addTrack(s, track);
        const part = createMidiPart('Part', { startSec: 0, durationSec: 4 });
        s = updateClips(s, track.id, () => [part]);
        s = updateClip(s, track.id, part.id, (c) => ({
          ...c, notes: [createNote({ startBeat: 1, durationBeat: 0.5, velocity: 1 })],
        }));
        if (delayMs !== 0) s = setTrackDelay(s, track.id, delayMs).session;
        const out = await render(s, 2);
        return onsetIndex(out.getChannelData(0), 0.02);
      };
      const slowDelta = (await at(60, 100)) - (await at(60, 0));
      const fastDelta = (await at(150, 100)) - (await at(150, 0));
      close(slowDelta, Math.round(0.1 * SR), '100 ms at 60 BPM', 64);
      close(fastDelta, Math.round(0.1 * SR), 'and the same 100 ms at 150 BPM', 64);
    })();
  });

  await check('a bus delay reaches the audio through the delay line', async () => {
    const { session, trackId } = clickSession(0.2);
    const bus = createBus('FX Bus');
    let s: DawSession = { ...session, buses: [bus] };
    const aux = createTrack('FX Return', 'aux', { input: bus.id, output: { kind: 'master' } });
    s = addTrack(s, aux);
    s = setSend(s, trackId, createSend(0, bus.id, { levelDb: 0, preFader: false }));
    // Mute the dry path so only the return is measured.
    s = updateTrack(s, trackId, (t) => ({ ...t, output: { kind: 'none' } }));

    const dryOut = await render(s, 1);
    const dry = onsetIndex(dryOut.getChannelData(0), 0.2);
    close(dry, Math.round(0.2 * SR), 'the return arrives with the clip', 16);

    const delayed = setTrackDelay(s, aux.id, 30).session;
    const out = await render(delayed, 1);
    const late = onsetIndex(out.getChannelData(0), 0.2);
    close(late - dry, Math.round(0.03 * SR), 'and 30 ms later once the bus is delayed', 16);
  });

  await check('freezing a delayed track does not bake the delay in twice', async () => {
    // renderTrack is what Freeze and Commit write to disk.  The track keeps
    // its delay afterwards, so the render must NOT already contain it —
    // otherwise a 50 ms nudge becomes 100 ms the moment you freeze.
    const { session, trackId } = clickSession(0.2);
    const dry = await renderTrack(session, trackId, { sampleRate: SR, tailSec: 0 });
    const dryAt = onsetIndex(dry.getChannelData(0), 0.2);

    const delayed = setTrackDelay(session, trackId, 50).session;
    const baked = await renderTrack(delayed, trackId, { sampleRate: SR, tailSec: 0 });
    eq(onsetIndex(baked.getChannelData(0), 0.2), dryAt,
      'the frozen file is the channel, not the channel moved');
    // And the delay is still on the track, so playback applies it once.
    eq(trackDelayMs(findTrack(delayed, trackId)!), 50, 'the nudge survives the freeze');
  });

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} passed${passed === results.length ? '' : `, ${results.length - passed} FAILED`}`);
  if (passed !== results.length) process.exit(1);
}

void main();
