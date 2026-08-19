/**
 * daw-engine-selftest — PROVES the DAW mixer graph renders real audio.
 *
 * The model tests (daw-selftest) verify what the session says; this one
 * verifies what comes out of the speakers.  It renders the actual
 * MixerEngine + ClipPlayer through node-web-audio-api's OfflineAudioContext —
 * the same code path Bounce / Freeze / Commit use in the app — and measures
 * the result: clip gain, fader, mute, solo, pan, sends (pre and post fader),
 * aux returns, insert bypass, sidechain ducking, fades, and delay
 * compensation alignment.
 *
 * Run: pnpm --filter @aimaster/desktop test:daw-engine
 */

import { OfflineAudioContext } from 'node-web-audio-api';

// renderSession reads OfflineAudioContext off globalThis (the browser has it).
(globalThis as unknown as { OfflineAudioContext: unknown }).OfflineAudioContext = OfflineAudioContext;

import {
  addFile, addTrack, createBus, createClip, createInsert, createMidiPart, createSend,
  createSession, createTrack, findTrack, setInsert, setSend, updateClips, updateTrack,
} from '../src/renderer/daw/model/session-ops.js';
import { createNote, from7bit, resetNoteIds, setExpression } from '../src/renderer/daw/model/midi.js';
import {
  linearGraph, addParallelBranch, addSend, createNode, deviceOrder, layout,
} from '../src/renderer/daw/model/device-graph.js';
import { buildRack, rackNode, setRackMacro } from '../src/renderer/daw/model/racks.js';
import { resetIds } from '../src/renderer/daw/model/ids.js';
import { setVolumeDb, toggleMute, toggleSolo } from '../src/renderer/daw/model/mixer-math.js';
import {
  analyzeBuffer, cacheSize, clearAudioCache, getCached, getMeta, preloadAll, transientsFor,
} from '../src/renderer/daw/engine/audio-cache.js';
import { renderSession } from '../src/renderer/daw/engine/offline-render.js';
import { defaultParams } from '../src/renderer/daw/engine/plugins.js';
import type { DawSession } from '../src/renderer/daw/model/types.js';

const SR = 48_000;

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => { results.push({ name, pass: true, detail: '' }); })
    .catch((e: unknown) => {
      results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) });
    });
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }
function close(a: number, b: number, m: string, tol: number): void {
  if (Math.abs(a - b) > tol) throw new Error(`${m} — got ${a.toFixed(5)}, want ${b.toFixed(5)} ±${tol}`);
}

function rms(data: Float32Array, from = 0, to = data.length): number {
  let sum = 0;
  let n = 0;
  for (let i = from; i < to; i++) { const v = data[i] ?? 0; sum += v * v; n++; }
  return n > 0 ? Math.sqrt(sum / n) : 0;
}
function channelRms(buffer: AudioBuffer, channel: number, from = 0, to = buffer.length): number {
  return rms(buffer.getChannelData(channel), from, to);
}
/** First sample index whose magnitude crosses `threshold`. */
function onsetIndex(data: Float32Array, threshold = 0.05): number {
  for (let i = 0; i < data.length; i++) if (Math.abs(data[i] ?? 0) > threshold) return i;
  return -1;
}

// ── Test material ─────────────────────────────────────────────────────────────

/** A steady sine, registered in the decode cache under `fileId`. */
function makeToneFile(fileId: string, freq: number, amp: number, seconds: number): void {
  const ctx = new OfflineAudioContext(2, Math.floor(SR * seconds), SR);
  const buffer = ctx.createBuffer(2, Math.floor(SR * seconds), SR);
  for (let c = 0; c < 2; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i++) data[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  }
  analyzeBuffer(fileId, buffer as unknown as AudioBuffer);
}

/** A single click at t=0 followed by silence — for alignment measurements. */
function makeClickFile(fileId: string, seconds: number): void {
  const ctx = new OfflineAudioContext(2, Math.floor(SR * seconds), SR);
  const buffer = ctx.createBuffer(2, Math.floor(SR * seconds), SR);
  for (let c = 0; c < 2; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < 64; i++) data[i] = 1 - i / 64;
  }
  analyzeBuffer(fileId, buffer as unknown as AudioBuffer);
}

/** Session with one audio track playing `fileId` from 0 for `seconds`. */
function oneTrackSession(fileId: string, seconds: number): { session: DawSession; trackId: string } {
  resetIds();
  let session = createSession('Engine Test', SR);
  const track = createTrack('Tone', 'audio');
  session = addTrack(session, track);
  session = addFile(session, {
    id: fileId, path: `/virtual/${fileId}.wav`, name: fileId,
    durationSec: seconds, sampleRate: SR, channels: 2,
  });
  session = updateClips(session, track.id, () => [
    createClip(fileId, 'tone', { startSec: 0, offsetSec: 0, durationSec: seconds }),
  ]);
  return { session, trackId: track.id };
}

const render = (session: DawSession, seconds: number): Promise<AudioBuffer> =>
  renderSession(session, { startSec: 0, endSec: seconds }, { sampleRate: SR, tailSec: 0 });

// ── Tests ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  clearAudioCache();
  makeToneFile('tone', 440, 0.5, 1);
  makeClickFile('click', 1);

  // Baseline: a 0.5-amplitude sine renders at 0.5/√2 RMS.
  let baseline = 0;
  await check('a clip renders at its source level', async () => {
    const { session } = oneTrackSession('tone', 1);
    const out = await render(session, 1);
    baseline = channelRms(out, 0);
    close(baseline, 0.5 / Math.SQRT2, 'unity gain RMS', 0.01);
  });

  await check('clip gain scales the audio before the fader', async () => {
    const { session, trackId } = oneTrackSession('tone', 1);
    const quieter = updateClips(session, trackId, (clips) =>
      clips.map((c) => ({ ...c, gainDb: -6 })));
    const out = await render(quieter, 1);
    close(channelRms(out, 0), baseline * 0.5012, 'clip gain −6 dB', 0.01);
  });

  await check('the channel fader scales the audio', async () => {
    const { session, trackId } = oneTrackSession('tone', 1);
    const out = await render(setVolumeDb(session, trackId, -6), 1);
    close(channelRms(out, 0), baseline * 0.5012, 'fader −6 dB', 0.01);
  });

  await check('mute silences the channel', async () => {
    const { session, trackId } = oneTrackSession('tone', 1);
    const out = await render(toggleMute(session, trackId), 1);
    close(channelRms(out, 0), 0, 'muted', 1e-6);
  });

  await check('solo on another track silences this one', async () => {
    const { session, trackId } = oneTrackSession('tone', 1);
    let s = addTrack(session, createTrack('Other', 'audio'));
    const other = s.tracks.find((t) => t.name === 'Other')!;
    s = toggleSolo(s, other.id);
    const out = await render(s, 1);
    close(channelRms(out, 0), 0, 'non-soloed track is muted', 1e-6);

    const soloed = toggleSolo(toggleSolo(s, other.id), trackId);
    const out2 = await render(soloed, 1);
    assert(channelRms(out2, 0) > baseline * 0.9, 'the soloed track still plays');
  });

  await check('pan sweeps the signal between the channels', async () => {
    const { session, trackId } = oneTrackSession('tone', 1);
    const left = updateTrack(session, trackId, (t) => ({ ...t, pan: -1 }));
    const out = await render(left, 1);
    assert(channelRms(out, 0) > baseline * 1.3, 'hard left boosts L by the pan law');
    close(channelRms(out, 1), 0, 'hard left silences R', 1e-4);
  });

  await check('a post-fader send feeds an aux return', async () => {
    const { session, trackId } = oneTrackSession('tone', 1);
    const bus = createBus('FX Bus');
    let s: DawSession = { ...session, buses: [bus] };
    const aux = createTrack('FX Return', 'aux', { input: bus.id, output: { kind: 'master' } });
    s = addTrack(s, aux);
    s = setSend(s, trackId, createSend(0, bus.id, { levelDb: 0, preFader: false }));
    const out = await render(s, 1);
    // Direct + parallel return ≈ double the amplitude.
    close(channelRms(out, 0), baseline * 2, 'send doubles the level', 0.05);
  });

  await check('a pre-fader send survives the fader being pulled down', async () => {
    const { session, trackId } = oneTrackSession('tone', 1);
    const bus = createBus('Cue');
    let s: DawSession = { ...session, buses: [bus] };
    s = addTrack(s, createTrack('Cue Return', 'aux', { input: bus.id, output: { kind: 'master' } }));
    s = setSend(s, trackId, createSend(0, bus.id, { levelDb: 0, preFader: true }));
    s = setVolumeDb(s, trackId, -60);       // channel fader all the way down

    const out = await render(s, 1);
    close(channelRms(out, 0), baseline, 'pre-fader send is unaffected by the fader', 0.05);

    // The same send post-fader disappears with the fader.
    const post = setSend(s, trackId, { ...findTrack(s, trackId)!.sends[0]!, preFader: false });
    const outPost = await render(post, 1);
    assert(channelRms(outPost, 0) < baseline * 0.01, 'post-fader send follows the fader down');
  });

  await check('an insert changes the audio and bypass restores it', async () => {
    const { session, trackId } = oneTrackSession('tone', 1);
    const params = { ...defaultParams('trim'), gainDb: -12 };
    const withTrim = setInsert(session, trackId, createInsert(0, 'trim', 'Trim', { params }));
    const out = await render(withTrim, 1);
    close(channelRms(out, 0), baseline * 0.2512, 'trim −12 dB', 0.02);

    const bypassed = setInsert(withTrim, trackId, {
      ...findTrack(withTrim, trackId)!.inserts[0]!, bypass: true,
    });
    const outBypass = await render(bypassed, 1);
    close(channelRms(outBypass, 0), baseline, 'bypass is unity', 0.02);
  });

  await check('the sidechain compressor ducks from its key input', async () => {
    // Tone track + a key track that is silent for the first half and loud
    // after; the tone must duck only in the second half.
    resetIds();
    clearAudioCache();
    makeToneFile('tone', 440, 0.5, 2);
    const keyCtx = new OfflineAudioContext(2, SR * 2, SR);
    const keyBuffer = keyCtx.createBuffer(2, SR * 2, SR);
    for (let c = 0; c < 2; c++) {
      const data = keyBuffer.getChannelData(c);
      for (let i = SR; i < data.length; i++) data[i] = Math.sin((2 * Math.PI * 100 * i) / SR);
    }
    analyzeBuffer('key', keyBuffer as unknown as AudioBuffer);

    let s = createSession('SC', SR);
    const bus = createBus('Key Bus');
    s = { ...s, buses: [bus] };
    const music = createTrack('Music', 'audio');
    const key = createTrack('Key', 'audio', { output: { kind: 'bus', busId: bus.id } });
    s = addTrack(s, music);
    s = addTrack(s, key);
    s = addFile(s, { id: 'tone', path: '/v/tone.wav', name: 'tone', durationSec: 2, sampleRate: SR, channels: 2 });
    s = addFile(s, { id: 'key',  path: '/v/key.wav',  name: 'key',  durationSec: 2, sampleRate: SR, channels: 2 });
    s = updateClips(s, music.id, () => [createClip('tone', 'tone', { durationSec: 2 })]);
    s = updateClips(s, key.id,   () => [createClip('key', 'key', { durationSec: 2 })]);
    s = setInsert(s, music.id, createInsert(0, 'comp', 'Comp', {
      params: { ...defaultParams('comp'), thresholdDb: -30, ratio: 8, attackMs: 5, releaseMs: 50 },
      sidechainSource: bus.id,
    }));

    const out = await render(s, 2);
    const before = channelRms(out, 0, Math.floor(SR * 0.3), Math.floor(SR * 0.9));
    const after  = channelRms(out, 0, Math.floor(SR * 1.3), Math.floor(SR * 1.9));
    assert(after < before * 0.8, `key input ducks the music — before ${before.toFixed(3)}, after ${after.toFixed(3)}`);
    assert(before > 0.05, 'music plays before the key arrives');
  });

  await check('fades ramp the clip edges', async () => {
    clearAudioCache();
    makeToneFile('tone', 440, 0.5, 1);
    const { session, trackId } = oneTrackSession('tone', 1);
    const faded = updateClips(session, trackId, (clips) => clips.map((c) => ({
      ...c,
      fadeIn:  { durationSec: 0.4, shape: 'linear' as const },
      fadeOut: { durationSec: 0.4, shape: 'linear' as const },
    })));
    const out = await render(faded, 1);
    const head = channelRms(out, 0, 0, Math.floor(SR * 0.05));
    const mid  = channelRms(out, 0, Math.floor(SR * 0.45), Math.floor(SR * 0.55));
    const tail = channelRms(out, 0, Math.floor(SR * 0.95), SR);
    assert(head < mid * 0.35, `fade in — head ${head.toFixed(3)} vs mid ${mid.toFixed(3)}`);
    assert(tail < mid * 0.35, `fade out — tail ${tail.toFixed(3)} vs mid ${mid.toFixed(3)}`);
  });

  await check('delay compensation realigns a look-ahead insert', async () => {
    clearAudioCache();
    makeClickFile('click', 1);
    resetIds();
    // Two tracks with the same click: one hard left with a look-ahead
    // limiter, one hard right with nothing.  With ADC on, both clicks must
    // land on the same sample.
    let s = createSession('ADC', SR);
    s = addFile(s, { id: 'click', path: '/v/click.wav', name: 'click', durationSec: 1, sampleRate: SR, channels: 2 });
    const withPlugin = createTrack('L', 'audio', { pan: -1 });
    const clean = createTrack('R', 'audio', { pan: 1 });
    s = addTrack(s, withPlugin);
    s = addTrack(s, clean);
    for (const t of [withPlugin, clean]) {
      s = updateClips(s, t.id, () => [createClip('click', 'click', { startSec: 0.1, durationSec: 0.5 })]);
    }
    const limiterParams = { ...defaultParams('limiter'), lookaheadMs: 5, ceilingDb: 0 };
    s = setInsert(s, withPlugin.id, createInsert(0, 'limiter', 'Limiter', { params: limiterParams }));

    const compensated = await render(s, 1);
    const lOn = onsetIndex(compensated.getChannelData(0));
    const rOn = onsetIndex(compensated.getChannelData(1));
    assert(lOn >= 0 && rOn >= 0, `both clicks rendered (L=${lOn}, R=${rOn})`);
    assert(Math.abs(lOn - rOn) <= 8, `ADC aligns the paths — L=${lOn}, R=${rOn}`);

    const off = await render({ ...s, delayCompensation: false }, 1);
    const lOff = onsetIndex(off.getChannelData(0));
    const rOff = onsetIndex(off.getChannelData(1));
    const expected = Math.round(0.005 * SR);
    assert(lOff - rOff > expected * 0.5,
      `without ADC the plugin path is late by ~${expected} samples — got ${lOff - rOff}`);
  });

  // ── MIDI ────────────────────────────────────────────────────────────────

  /** Session with one instrument track holding a MIDI part. */
  function midiSession(notes: Parameters<typeof createNote>[0][]): DawSession {
    resetIds();
    resetNoteIds();
    let s = createSession('MIDI', SR);
    const track = createTrack('Synth', 'instrument');
    s = addTrack(s, track);
    s = updateClips(s, track.id, () => [createMidiPart('Part', {
      startSec: 0,
      durationSec: 2,
      notes: notes.map((n) => createNote(n)),
    })]);
    return s;
  }

  /** Energy at a frequency, via the Goertzel algorithm. */
  function energyAt(data: Float32Array, freq: number, from: number, to: number): number {
    const n = to - from;
    if (n <= 0) return 0;
    const k = (2 * Math.PI * freq) / SR;
    const c = 2 * Math.cos(k);
    let s0 = 0; let s1 = 0; let s2 = 0;
    for (let i = from; i < to; i++) { s0 = (data[i] ?? 0) + c * s1 - s2; s2 = s1; s1 = s0; }
    return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - c * s1 * s2)) / n;
  }

  await check('a MIDI part renders audio through its instrument', async () => {
    const s = midiSession([{ pitch: 69, startSec: 0.1, durationSec: 0.8, velocity: from7bit(110) }]);
    const out = await render(s, 2);
    const silence = channelRms(out, 0, 0, Math.floor(SR * 0.05));
    const sounding = channelRms(out, 0, Math.floor(SR * 0.3), Math.floor(SR * 0.8));
    assert(silence < 0.001, `silent before the note — ${silence.toFixed(5)}`);
    assert(sounding > 0.01, `the note is audible — ${sounding.toFixed(5)}`);
  });

  await check('note velocity scales the rendered level', async () => {
    const loud = await render(midiSession([
      { pitch: 60, startSec: 0, durationSec: 1, velocity: from7bit(127) }]), 1.5);
    const soft = await render(midiSession([
      { pitch: 60, startSec: 0, durationSec: 1, velocity: from7bit(30) }]), 1.5);
    const loudRms = channelRms(loud, 0, Math.floor(SR * 0.2), Math.floor(SR * 0.8));
    const softRms = channelRms(soft, 0, Math.floor(SR * 0.2), Math.floor(SR * 0.8));
    assert(loudRms > softRms * 1.8, `velocity matters — ${loudRms.toFixed(4)} vs ${softRms.toFixed(4)}`);
  });

  await check('a muted note renders nothing', async () => {
    const s = midiSession([{ pitch: 60, startSec: 0, durationSec: 1, muted: true }]);
    const out = await render(s, 1.5);
    close(channelRms(out, 0), 0, 'silent', 1e-5);
  });

  await check('per-note pitch bend actually bends that note', async () => {
    // A3 (440 Hz) with a full upward bend over the note, ±2 semitones →
    // it should end near 493.9 Hz (B3).
    resetIds();
    resetNoteIds();
    let s = createSession('MPE', SR);
    const track = createTrack('Synth', 'instrument');
    s = addTrack(s, track);
    const bent = setExpression(
      createNote({ pitch: 69, startSec: 0, durationSec: 1.5, velocity: from7bit(110) }),
      { target: { kind: 'pitchBend' }, points: [{ timeSec: 0, value: 0 }, { timeSec: 1.5, value: 1 }] },
    );
    s = updateClips(s, track.id, () => [createMidiPart('Part', {
      startSec: 0, durationSec: 2, notes: [bent],
      midiConfig: { bendRangeSemitones: 2, mpe: true },
    })]);

    const out = await render(s, 2);
    const data = out.getChannelData(0);
    const head = { from: Math.floor(SR * 0.05), to: Math.floor(SR * 0.25) };
    const tail = { from: Math.floor(SR * 1.2), to: Math.floor(SR * 1.45) };

    const startAt440 = energyAt(data, 440, head.from, head.to);
    const startAt494 = energyAt(data, 493.88, head.from, head.to);
    const endAt440 = energyAt(data, 440, tail.from, tail.to);
    const endAt494 = energyAt(data, 493.88, tail.from, tail.to);

    assert(startAt440 > startAt494, `starts at A3 — ${startAt440.toFixed(5)} vs ${startAt494.toFixed(5)}`);
    assert(endAt494 > endAt440, `ends bent up to B3 — ${endAt494.toFixed(5)} vs ${endAt440.toFixed(5)}`);
  });

  await check('a MIDI track obeys the fader and mute like any other channel', async () => {
    const base = midiSession([{ pitch: 60, startSec: 0, durationSec: 1, velocity: from7bit(110) }]);
    const trackId = base.tracks.find((t) => t.kind === 'instrument')!.id;
    const full = await render(base, 1.5);
    const quiet = await render(setVolumeDb(base, trackId, -12), 1.5);
    const muted = await render(toggleMute(base, trackId), 1.5);
    const fullRms = channelRms(full, 0, 0, Math.floor(SR * 1.2));
    close(channelRms(quiet, 0, 0, Math.floor(SR * 1.2)), fullRms * 0.2512, 'fader −12 dB', 0.01);
    close(channelRms(muted, 0), 0, 'muted', 1e-6);
  });

  // ── Macro rack processors ───────────────────────────────────────────────

  await check('saturation adds harmonics that were not in the source', async () => {
    clearAudioCache();
    // A pure sine has no harmonics; saturation must create them.
    const ctx = new OfflineAudioContext(2, SR, SR);
    const buffer = ctx.createBuffer(2, SR, SR);
    for (let c = 0; c < 2; c++) {
      const data = buffer.getChannelData(c);
      for (let i = 0; i < data.length; i++) data[i] = 0.6 * Math.sin((2 * Math.PI * 300 * i) / SR);
    }
    analyzeBuffer('sine', buffer as unknown as AudioBuffer);

    resetIds();
    let s = createSession('Sat', SR);
    const track = createTrack('Sine', 'audio');
    s = addTrack(s, track);
    s = addFile(s, { id: 'sine', path: '/v/sine.wav', name: 'sine', durationSec: 1, sampleRate: SR, channels: 2 });
    s = updateClips(s, track.id, () => [createClip('sine', 'sine', { durationSec: 1 })]);

    const clean = await render(s, 1);
    const driven = await render(setInsert(s, track.id, createInsert(0, 'saturation', 'Sat', {
      params: { driveDb: 18, mix: 1, bias: 0 },
    })), 1);

    const window = { from: Math.floor(SR * 0.2), to: Math.floor(SR * 0.8) };
    const cleanThird = energyAt(clean.getChannelData(0), 900, window.from, window.to);
    const drivenThird = energyAt(driven.getChannelData(0), 900, window.from, window.to);
    assert(drivenThird > cleanThird * 8,
      `third harmonic appears — ${cleanThird.toExponential(2)} → ${drivenThird.toExponential(2)}`);
  });

  await check('the stereo widener widens and narrows the side signal', async () => {
    clearAudioCache();
    // Pure side information: L = −R.
    const ctx = new OfflineAudioContext(2, SR, SR);
    const buffer = ctx.createBuffer(2, SR, SR);
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);
    for (let i = 0; i < left.length; i++) {
      const v = 0.4 * Math.sin((2 * Math.PI * 1000 * i) / SR);
      left[i] = v;
      right[i] = -v;
    }
    analyzeBuffer('side', buffer as unknown as AudioBuffer);

    resetIds();
    let s = createSession('Width', SR);
    const track = createTrack('Side', 'audio');
    s = addTrack(s, track);
    s = addFile(s, { id: 'side', path: '/v/side.wav', name: 'side', durationSec: 1, sampleRate: SR, channels: 2 });
    s = updateClips(s, track.id, () => [createClip('side', 'side', { durationSec: 1 })]);

    const unity = await render(setInsert(s, track.id, createInsert(0, 'widener', 'W', {
      params: { width: 1, lowMonoHz: 20 },
    })), 1);
    const wide = await render(setInsert(s, track.id, createInsert(0, 'widener', 'W', {
      params: { width: 1.8, lowMonoHz: 20 },
    })), 1);
    const narrow = await render(setInsert(s, track.id, createInsert(0, 'widener', 'W', {
      params: { width: 0, lowMonoHz: 20 },
    })), 1);

    const from = Math.floor(SR * 0.2);
    const to = Math.floor(SR * 0.8);
    const unityRms = channelRms(unity, 0, from, to);
    assert(channelRms(wide, 0, from, to) > unityRms * 1.5, 'wider is louder on a side-only signal');
    assert(channelRms(narrow, 0, from, to) < unityRms * 0.15, 'width 0 collapses it to mono');
  });

  await check('a macro rack changes the sound and bypasses cleanly', async () => {
    clearAudioCache();
    makeToneFile('tone', 300, 0.4, 1);
    resetIds();
    let s = createSession('Macro', SR);
    const track = createTrack('Tone', 'audio');
    s = addTrack(s, track);
    s = addFile(s, { id: 'tone', path: '/v/tone.wav', name: 'tone', durationSec: 1, sampleRate: SR, channels: 2 });
    s = updateClips(s, track.id, () => [createClip('tone', 'tone', { durationSec: 1 })]);

    const off = await render(s, 1);
    const withMacros = await render(updateTrack(s, track.id, (t) => ({
      ...t,
      macros: { enabled: true, values: { warmth: 0.8, loudness: 0.6 }, overrides: {} },
    })), 1);

    const from = Math.floor(SR * 0.2);
    const to = Math.floor(SR * 0.8);
    const offRms = channelRms(off, 0, from, to);
    const onRms = channelRms(withMacros, 0, from, to);
    assert(Math.abs(onRms - offRms) > offRms * 0.05,
      `the rack audibly changes the signal — ${offRms.toFixed(4)} → ${onRms.toFixed(4)}`);

    // A rack with every macro at zero must be transparent.
    const neutral = await render(updateTrack(s, track.id, (t) => ({
      ...t,
      macros: { enabled: true, values: {}, overrides: {} },
    })), 1);
    close(channelRms(neutral, 0, from, to), offRms, 'an untouched rack is transparent', 0.002);
  });

  // ── Device Chain ────────────────────────────────────────────────────────

  await check('a parallel branch in the device chain actually sums back in', async () => {
    clearAudioCache();
    makeToneFile('tone', 440, 0.4, 1);
    resetIds();
    let s = createSession('Chain', SR);
    const track = createTrack('Tone', 'audio');
    s = addTrack(s, track);
    s = addFile(s, { id: 'tone', path: '/v/tone.wav', name: 'tone', durationSec: 1, sampleRate: SR, channels: 2 });
    s = updateClips(s, track.id, () => [createClip('tone', 'tone', { durationSec: 1 })]);

    // INPUT → TRIM → OUTPUT, then a unity-gain parallel branch alongside TRIM.
    const straight = linearGraph([{ pluginId: 'trim', label: 'TRIM', params: { gainDb: 0 } }]);
    const trim = deviceOrder(straight).find((n) => n.label === 'TRIM')!;
    const input = straight.nodes.find((n) => n.kind === 'input')!;
    const output = straight.nodes.find((n) => n.kind === 'output')!;
    const parallel = layout(addParallelBranch(straight, input.id, output.id, createNode({
      kind: 'device', pluginId: 'trim', label: 'PARALLEL', params: { gainDb: 0 },
    }), 0));

    const direct = await render(updateTrack(s, track.id, (t) => ({ ...t, deviceGraph: straight })), 1);
    const summed = await render(updateTrack(s, track.id, (t) => ({ ...t, deviceGraph: parallel })), 1);

    const from = Math.floor(SR * 0.2);
    const to = Math.floor(SR * 0.8);
    const directRms = channelRms(direct, 0, from, to);
    const summedRms = channelRms(summed, 0, from, to);
    close(summedRms, directRms * 2, 'two unity paths sum to double', 0.02);
    void trim;

    // Blending the branch 6 dB down lands halfway between.
    const blended = layout(addParallelBranch(straight, input.id, output.id, createNode({
      kind: 'device', pluginId: 'trim', label: 'PARALLEL', params: { gainDb: 0 },
    }), -6));
    const blendedOut = await render(updateTrack(s, track.id, (t) => ({ ...t, deviceGraph: blended })), 1);
    close(channelRms(blendedOut, 0, from, to), directRms * 1.5012, 'branch blended at −6 dB', 0.02);
  });

  await check('a send node taps the chain without leaving it', async () => {
    clearAudioCache();
    makeToneFile('tone', 440, 0.4, 1);
    resetIds();
    let s = createSession('Send', SR);
    const bus = createBus('FX');
    s = { ...s, buses: [bus] };
    const track = createTrack('Tone', 'audio');
    s = addTrack(s, track);
    s = addTrack(s, createTrack('FX Return', 'aux', { input: bus.id, output: { kind: 'master' } }));
    s = addFile(s, { id: 'tone', path: '/v/tone.wav', name: 'tone', durationSec: 1, sampleRate: SR, channels: 2 });
    s = updateClips(s, track.id, () => [createClip('tone', 'tone', { durationSec: 1 })]);

    const base = linearGraph([{ pluginId: 'trim', label: 'TRIM', params: { gainDb: 0 } }]);
    const trim = deviceOrder(base).find((n) => n.label === 'TRIM')!;
    const withSend = layout(addSend(base, trim.id, bus.id, 'REVERB SEND', 0));

    const dry = await render(updateTrack(s, track.id, (t) => ({ ...t, deviceGraph: base })), 1);
    const sent = await render(updateTrack(s, track.id, (t) => ({ ...t, deviceGraph: withSend })), 1);

    const from = Math.floor(SR * 0.2);
    const to = Math.floor(SR * 0.8);
    // The main path is unchanged; the send adds the return on top.
    assert(channelRms(sent, 0, from, to) > channelRms(dry, 0, from, to) * 1.5,
      'the return is audible');
  });

  await check('a rack renders its inner chain and its macros do something', async () => {
    clearAudioCache();
    makeToneFile('tone', 300, 0.4, 1);
    resetIds();
    let s = createSession('Rack', SR);
    const track = createTrack('Tone', 'audio');
    s = addTrack(s, track);
    s = addFile(s, { id: 'tone', path: '/v/tone.wav', name: 'tone', durationSec: 1, sampleRate: SR, channels: 2 });
    s = updateClips(s, track.id, () => [createClip('tone', 'tone', { durationSec: 1 })]);

    const rack = buildRack('loui-vocal')!;
    const graph = layout({
      nodes: [
        createNode({ kind: 'input', id: 'dev-input', label: 'INPUT' }),
        rackNode(rack, 1),
        createNode({ kind: 'output', id: 'dev-output', label: 'OUTPUT' }),
      ],
      edges: [],
    });
    const rackId = graph.nodes.find((n) => n.kind === 'rack')!.id;
    const wired = {
      ...graph,
      edges: [
        { id: 'e1', from: 'dev-input', to: rackId, gainDb: 0 },
        { id: 'e2', from: rackId, to: 'dev-output', gainDb: 0 },
      ],
    };

    const quiet = await render(updateTrack(s, track.id, (t) => ({
      ...t, deviceGraph: wired, racks: [rack],
    })), 1);

    // BODY drives saturation + compression; turning it up must change the sound.
    const body = rack.macros.find((m) => m.name === 'BODY')!;
    const loud = await render(updateTrack(s, track.id, (t) => ({
      ...t, deviceGraph: wired, racks: [setRackMacro(rack, body.id, 1)],
    })), 1);

    const from = Math.floor(SR * 0.2);
    const to = Math.floor(SR * 0.8);
    const quietRms = channelRms(quiet, 0, from, to);
    const loudRms = channelRms(loud, 0, from, to);
    assert(quietRms > 0.01, 'the rack passes audio');
    assert(Math.abs(loudRms - quietRms) > quietRms * 0.05,
      `BODY changes the sound — ${quietRms.toFixed(4)} → ${loudRms.toFixed(4)}`);
  });

  // ── Decode memory ─────────────────────────────────────────────────────────
  // Twenty songs decoded in parallel is a multi-gigabyte spike; the renderer
  // is killed and the window shows nothing but its own background colour.

  await check('files are decoded one at a time, never all at once', async () => {
    clearAudioCache();
    const real = new OfflineAudioContext(1, 128, SR) as unknown as BaseAudioContext;

    const originalFetch = globalThis.fetch;
    (globalThis as { fetch: unknown }).fetch = async () => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(16),
    });

    let inFlight = 0;
    let peak = 0;
    const fakeCtx = {
      decodeAudioData: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return real.createBuffer(1, 1024, SR);
      },
    } as unknown as BaseAudioContext;

    try {
      const files = Array.from({ length: 8 }, (_, i) => ({ id: `seq${i}`, path: `/tmp/s${i}.wav` }));
      await preloadAll(fakeCtx, files);
      assert(peak === 1, `one decode in flight at a time — peaked at ${peak}`);
      assert(cacheSize() === 8, `all eight landed — cache holds ${cacheSize()}`);
    } finally {
      (globalThis as { fetch: unknown }).fetch = originalFetch;
    }
  });

  await check('a waveform survives its buffer being evicted', async () => {
    clearAudioCache();
    const ctx = new OfflineAudioContext(1, 128, SR);

    // A recognisable file, then enough others to push it out of the cache.
    // Silence, then a note starting a third of the way in: one unambiguous
    // onset to remember, and a peak envelope with something in it.
    const first = ctx.createBuffer(1, SR, SR);
    const data = first.getChannelData(0);
    const onsetAt = Math.floor(SR / 3);
    for (let i = onsetAt; i < data.length; i++) {
      data[i] = Math.sin((2 * Math.PI * 220 * i) / SR) * 0.9;
    }
    analyzeBuffer('keepme', first as unknown as AudioBuffer);

    const onsets = transientsFor('keepme').length;
    assert(onsets > 0, 'the click was detected before eviction');

    for (let i = 0; i < 14; i++) {
      analyzeBuffer(`filler${i}`, ctx.createBuffer(1, 1024, SR) as unknown as AudioBuffer);
    }

    assert(getCached('keepme') === undefined, 'the buffer itself was evicted');
    const meta = getMeta('keepme');
    assert(meta !== undefined, 'but the metadata stayed');
    close(meta!.durationSec, 1, 'the duration is still known', 0.001);
    assert(meta!.peaks.some((v) => v > 0.5), 'the peak envelope is still drawable');
    assert(transientsFor('keepme').length === onsets,
      'and Tab to Transient still finds the same marks');
  });

  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  console.log('\n=== DAW engine — OfflineAudioContext render proof ===');
  for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
  if (failed > 0) process.exit(1);
}

void main();
