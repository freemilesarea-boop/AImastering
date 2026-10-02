/**
 * render-chunking-selftest — a bounce that does not get slower as it goes on.
 *
 * An offline render used to schedule the WHOLE session up front and render in
 * one go.  That left no moment for the player to reap a finished voice, and a
 * voice that is not reaped is not disconnected: an instrument's note is a
 * source into a filter into a gain, and a connected filter has a tail, so the
 * graph goes on processing every note that has ever sounded.
 *
 * Measured in the app, 256 notes all inside the first eight seconds:
 *
 *     render 8 s   2459 ms
 *     render 16 s  3269 ms
 *     render 24 s  4654 ms     ← 137 ms per second of SILENCE
 *
 * and a 24-track, 30-second bounce took four and a quarter minutes — a tenth
 * of real time.  Pausing the render on chunk boundaries and ticking the
 * player — the same look-ahead the live transport walks, which is also what
 * reaps — and reaping each voice at the end IT declares rather than four
 * seconds past the note, made it:
 *
 *     render 8 s   1353 ms
 *     render 16 s  1219 ms
 *     render 24 s  1279 ms     ← silence is free
 *
 * and the 24-track bounce 18.8 s — 1.6x real time against 0.1x, thirteen
 * times faster, with the rendered peak unchanged to four decimals (0.7387).
 * Checked against a render that never reaps, every instrument at its longest
 * tail: identical to −110 dB, so nothing is being cut short.
 *
 * What this file can hold, and what it cannot.  `node-web-audio-api` panics
 * on the second `suspend` of an offline render, so the chunked path is not
 * available here at all — `canPauseRenders` says no in Node and the whole
 * session is scheduled up front, which is what the other render tests
 * exercise.  What IS checkable without a host is the part that can be wrong
 * in this repo: the ORDER of the walk.  The numbers above are app
 * measurements and are quoted as such.
 *
 * Run:  pnpm --filter @aimaster/desktop test:render-chunking
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { OfflineAudioContext } from 'node-web-audio-api';
(globalThis as unknown as { OfflineAudioContext: unknown }).OfflineAudioContext = OfflineAudioContext;

import {
  pauseEveryChunk, type RenderPausing,
} from '../src/renderer/daw/engine/offline-render.js';
import { MixerEngine } from '../src/renderer/daw/engine/mixer-engine.js';
import { ClipPlayer, reapFinished } from '../src/renderer/daw/engine/clip-player.js';
import { analyzeBuffer } from '../src/renderer/daw/engine/audio-cache.js';
import {
  INSTRUMENTS, defaultInstrumentParams,
} from '../src/renderer/daw/engine/instruments.js';
import { createNote } from '../src/renderer/daw/model/midi.js';
import {
  addFile, addTrack, createClip, createSession, createTrack, updateClips,
} from '../src/renderer/daw/model/session-ops.js';
import { resetIds } from '../src/renderer/daw/model/ids.js';
import type { DawSession, Track } from '../src/renderer/daw/model/types.js';

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }
function eq<T>(a: T, b: T, m: string): void {
  if (a !== b) throw new Error(`${m} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}

/**
 * A renderer that only remembers what it was asked to do, and when.
 *
 * Once a resume finds no pause registered, every later pause resolves at
 * once — so a walk that lets the clock go too early FAILS the order check
 * instead of waiting for a boundary that will never come.  The first version
 * of this stub hung there, which is a worse way to find out; the second
 * treated the walk's own final resume, which legitimately has nothing
 * pending, as that same mistake.
 */
function stub(): { pausing: RenderPausing; log: string[] } {
  const log: string[] = [];
  let release: (() => void) | null = null;
  let loose = false;
  const pausing: RenderPausing = {
    suspend: (at) => {
      log.push(`suspend ${at.toFixed(2)}`);
      if (loose) return Promise.resolve();
      return new Promise<void>((done) => { release = done; });
    },
    resume: () => {
      const go = release;
      release = null;
      log.push('resume');
      if (!go) {
        // Correct at the END of a walk — the last chunk has no boundary after
        // it.  Wrong anywhere else, and from here every pause resolves at
        // once so the order check sees it rather than waiting for ever.
        loose = true;
        return;
      }
      // The clock runs on and arrives at the pause already registered.
      globalThis.setTimeout(go, 0);
    },
  };
  // The first pause is awaited before any resume, so it has to be released.
  globalThis.setTimeout(() => { const go = release; release = null; go?.(); }, 0);
  return { pausing, log };
}

const SR = 48_000;

/** A steady tone under a volume lane that falls 24 dB and comes back up. */
async function renderFade(seconds: number): Promise<Float32Array> {
  resetIds();
  let session: DawSession = createSession('fade', SR);
  const tr = createTrack('Tone', 'audio');
  session = addTrack(session, tr);
  session = addFile(session, {
    id: 'tone', path: '/virtual/tone.wav', name: 'tone',
    durationSec: seconds, sampleRate: SR, channels: 1,
  });
  session = updateClips(session, tr.id, () => [
    createClip('tone', 'audio', { startSec: 0, offsetSec: 0, durationSec: seconds }),
  ]);
  session = {
    ...session,
    tracks: session.tracks.map((t): Track => (t.id !== tr.id ? t : {
      ...t,
      automation: [{
        id: 'vol', target: { kind: 'volume' }, mode: 'read', visible: true,
        points: [
          { timeSec: 0, value: -24 },
          { timeSec: seconds, value: 0 },
        ],
      }],
    })),
  };

  const holder = new OfflineAudioContext(1, Math.round(SR * seconds), SR);
  const buf = holder.createBuffer(1, Math.round(SR * seconds), SR);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i += 1) d[i] = Math.sin((2 * Math.PI * 440 * i) / SR) * 0.4;
  analyzeBuffer('tone', buf as unknown as AudioBuffer);

  const ctx = new OfflineAudioContext(2, Math.round(SR * seconds), SR);
  const engine = new MixerEngine(
    ctx as unknown as BaseAudioContext, ctx.destination as unknown as AudioNode,
    { meters: false });
  engine.sync(session);
  const player = new ClipPlayer(engine);
  player.useResidentBuffers();
  player.scheduleAll(session, 0, seconds);
  return (await ctx.startRendering()).getChannelData(0);
}

/**
 * The same tone under a PAN lane whose far breakpoint is past the end of the
 * window being scheduled.  Rendered in two channels, because that is where a
 * pan is visible.
 */
async function renderPan(
  windowSec: number, laneEndSec: number,
): Promise<{ left: Float32Array; right: Float32Array }> {
  resetIds();
  let session: DawSession = createSession('pan', SR);
  const tr = createTrack('Tone', 'audio');
  session = addTrack(session, tr);
  session = addFile(session, {
    id: 'tone', path: '/virtual/tone.wav', name: 'tone',
    durationSec: laneEndSec, sampleRate: SR, channels: 1,
  });
  session = updateClips(session, tr.id, () => [
    createClip('tone', 'audio', { startSec: 0, offsetSec: 0, durationSec: laneEndSec }),
  ]);
  session = {
    ...session,
    tracks: session.tracks.map((t): Track => (t.id !== tr.id ? t : {
      ...t,
      automation: [{
        id: 'pan', target: { kind: 'pan' }, mode: 'read', visible: true,
        points: [
          { timeSec: 0, value: -1 },
          { timeSec: laneEndSec, value: 1 },
        ],
      }],
    })),
  };

  const holder = new OfflineAudioContext(1, Math.round(SR * laneEndSec), SR);
  const buf = holder.createBuffer(1, Math.round(SR * laneEndSec), SR);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i += 1) d[i] = Math.sin((2 * Math.PI * 440 * i) / SR) * 0.4;
  analyzeBuffer('tone', buf as unknown as AudioBuffer);

  const ctx = new OfflineAudioContext(2, Math.round(SR * windowSec), SR);
  const engine = new MixerEngine(
    ctx as unknown as BaseAudioContext, ctx.destination as unknown as AudioNode,
    { meters: false });
  engine.sync(session);
  const player = new ClipPlayer(engine);
  player.useResidentBuffers();
  player.scheduleAll(session, 0, windowSec);
  const out = await ctx.startRendering();
  return { left: out.getChannelData(0), right: out.getChannelData(1) };
}

function rmsAt(ch: Float32Array, atSec: number, windowSec = 0.05): number {
  const a = Math.max(0, Math.round((atSec - windowSec / 2) * SR));
  const b = Math.min(ch.length, Math.round((atSec + windowSec / 2) * SR));
  let sum = 0;
  for (let i = a; i < b; i += 1) sum += ch[i]! * ch[i]!;
  return Math.sqrt(sum / Math.max(1, b - a));
}

/**
 * The pan a stereo pair carries, read back out of it.  A `StereoPannerNode`
 * fed one channel puts `cos` of a quarter-turn in the left and `sin` in the
 * right, so the angle between the two levels IS the pan.
 */
function panAt(left: Float32Array, right: Float32Array, atSec: number): number {
  const l = rmsAt(left, atSec);
  const r = rmsAt(right, atSec);
  return Math.atan2(r, l) / (Math.PI / 4) - 1;
}

/**
 * Play one note on one instrument and watch the graph, not the parameters:
 * every `stop` any source is given, so the voice's REAL end is measured
 * rather than re-derived from the same arithmetic that produced the
 * declaration.
 */
function tailOf(id: string, knobs: 'default' | 'max'): { declared: number; lastStop: number } {
  const descriptor = INSTRUMENTS.find((i) => i.id === id);
  assert(descriptor, `no instrument ${id}`);
  const d = descriptor!;
  const ctx = new OfflineAudioContext(2, SR * 40, SR);
  let lastStop = Number.NEGATIVE_INFINITY;
  const protos = [
    Object.getPrototypeOf(ctx.createBufferSource()) as { stop: (at?: number) => void },
    Object.getPrototypeOf(ctx.createOscillator()) as { stop: (at?: number) => void },
  ];
  const originals = protos.map((pr) => pr.stop);
  protos.forEach((pr, i) => {
    pr.stop = function patched(this: unknown, at?: number): void {
      if (typeof at === 'number' && at > lastStop) lastStop = at;
      (originals[i] as (at?: number) => void).call(this, at);
    };
  });
  const params = { ...defaultInstrumentParams(d.id) };
  if (knobs === 'max') {
    for (const p of d.params) {
      // The knobs that lengthen a tail, at the far end of their travel.
      if (/release|decay|damper|ring|sustain|tail|size|time/i.test(`${p.id} ${p.name}`)) {
        params[p.id] = p.max;
      }
    }
  }
  const dest = ctx.createGain();
  dest.connect(ctx.destination);
  try {
    const voice = d.playNote({
      ctx: ctx as unknown as BaseAudioContext,
      destination: dest as unknown as AudioNode,
      note: createNote({ pitch: 48, startBeat: 0, durationBeat: 1, velocity: 1 }),
      config: { bendRangeSemitones: 2 } as never,
      when: 0,
      durationSec: 0.5,
      params,
    });
    return { declared: voice.endsAt, lastStop };
  } finally {
    protos.forEach((pr, i) => { pr.stop = originals[i]!; });
  }
}

async function main(): Promise<void> {
  await check('a render is paused on every chunk boundary inside it', async () => {
    const { pausing, log } = stub();
    let pauses = 0;
    await pauseEveryChunk(pausing, 7, 2, () => { pauses += 1; });
    // Boundaries strictly inside a 7 s render at 2 s: 2, 4, 6.
    eq(pauses, 3, 'pauses');
    const asked = log.filter((l) => l.startsWith('suspend'));
    eq(asked.join(' | '), 'suspend 2.00 | suspend 4.00 | suspend 6.00', 'boundaries');
  });

  await check('the next pause is registered before the clock is let go', async () => {
    // The whole reason the walk is written the way it is: resume first and
    // the render can run past a boundary that does not exist yet.
    const { pausing, log } = stub();
    await pauseEveryChunk(pausing, 7, 2, () => { /* nothing */ });
    // After the first pause arrives: suspend(4) then resume, never the other
    // way round.
    const order = log.join(' | ');
    assert(/suspend 2\.00 \| suspend 4\.00 \| resume \| suspend 6\.00 \| resume \| resume/.test(order),
      `the order was ${order}`);
  });

  await check('the work happens while the clock is stopped', async () => {
    const { pausing, log } = stub();
    await pauseEveryChunk(pausing, 5, 2, () => { log.push('tick'); });
    // Every tick sits between the pause that arrived and the resume that
    // follows it — never after a resume with no pause in between.
    const marks = log.filter((l) => l === 'tick' || l === 'resume');
    eq(marks.join(' '), 'tick resume tick resume', 'tick and resume alternate');
  });

  await check('a render shorter than one chunk is not paused at all', async () => {
    const { pausing, log } = stub();
    let pauses = 0;
    await pauseEveryChunk(pausing, 1.5, 2, () => { pauses += 1; });
    eq(pauses, 0, 'pauses');
    eq(log.length, 0, 'nothing was asked of the renderer');
  });

  await check('a boundary exactly at the end is not a pause', async () => {
    // Pausing at the last sample buys nothing and risks a pause that never
    // arrives.
    const { pausing } = stub();
    let pauses = 0;
    await pauseEveryChunk(pausing, 4, 2, () => { pauses += 1; });
    eq(pauses, 1, 'only the boundary at 2 s is inside a 4 s render');
  });

  await check('the render ticks the player at every boundary it stops at', async () => {
    // The point of stopping at all.  Only a host that can really pause a
    // render exercises this, and Node is not one — so it is read off the
    // source, which is also where it would be deleted.
    const src = fs.readFileSync(path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '../src/renderer/daw/engine/offline-render.ts'), 'utf8');
    const chunked = src.slice(src.indexOf('async function renderChunked'));
    assert(/pauseEveryChunk\([^)]*RENDER_CHUNK_SEC[\s\S]{0,200}?player\.tick\(/.test(chunked),
      'the chunked render does not tick the player at its pauses');
    assert(/player\.scheduleAll\(/.test(src),
      'the whole-session path is gone — a host that cannot pause has nothing to fall back to');
    await Promise.resolve();
  });

  await check('a fade drawn in decibels is heard in decibels', async () => {
    // The lane is drawn in dB; `linearRampToValueAtTime` is linear in the
    // AudioParam's units, which for a fader is GAIN.  Those are different
    // curves between the breakpoints, and the difference is not subtle: a
    // line from −24 dB to 0 dB is −12 dB at its midpoint if it means what it
    // was drawn to mean, and −5.5 dB if a single gain ramp is used instead.
    //
    // This is also what made a whole-session render disagree with the live
    // preview of the same fade — the preview re-anchors to the lane every
    // 50 ms and so tracked the drawing, while the render laid down one gain
    // ramp.  Measured between a chunked render and a whole-session one before
    // the lanes were subdivided: a worst sample difference of 0.031 against
    // an RMS of 0.028; after: 2.6e-8, which is float32 rounding.
    const seconds = 4;
    const ch = await renderFade(seconds);
    const end = rmsAt(ch, seconds - 0.1);
    const mid = rmsAt(ch, seconds / 2);
    assert(end > 1e-4, 'the render is silent');
    const midDb = 20 * Math.log10(mid / end);
    assert(Math.abs(midDb - -12) < 1.2,
      `the midpoint of a −24 dB fade reads ${midDb.toFixed(2)} dB, not −12 `
      + '(a gain-linear ramp would read about −5.5)');
    console.log(`      (midpoint ${midDb.toFixed(2)} dB of a −24 dB fade)`);
  });

  await check('a lane whose next point is past the window still moves inside it', async () => {
    // A window only ever holds a slice of a lane, and the breakpoints it is
    // heading for are usually beyond its far edge: 50 ms live, two seconds in
    // a chunked render.  Scheduling only the breakpoints INSIDE the window
    // leaves the value pinned at the window's start until a later window
    // happens to contain one — a staircase whose tread is the window size.
    //
    // Here the whole lane is eight seconds of pan travel and the window is
    // the first two: there is no breakpoint inside it at all.  Measured in
    // the app on a three-track render with a pan sweep, a chunked render
    // against a whole-session one: worst sample difference 0.042 against an
    // RMS of 0.035 (+1.7 dB) with only the in-window points, and 4.5e-8
    // (−117.8 dB) once the next one is scheduled too.
    const { left, right } = await renderPan(2, 8);
    assert(rmsAt(left, 1.9) > 1e-3, 'the render is silent');
    // The drawing says −1 + 2 x (1.9 / 8) = −0.525 at 1.9 s.
    const pan = panAt(left, right, 1.9);
    assert(Math.abs(pan - -0.525) < 0.06,
      `the pan reads ${pan.toFixed(3)} at 1.9 s of a window ending at 2 s, not −0.525 `
      + '(scheduling only the in-window points holds it at −1.000)');
    // And it is travelling, not sitting at one value it reached early.
    const early = panAt(left, right, 0.2);
    assert(pan - early > 0.3,
      `the pan went from ${early.toFixed(3)} to ${pan.toFixed(3)} — that is not a sweep`);
    console.log(`      (pan ${early.toFixed(3)} at 0.2 s to ${pan.toFixed(3)} at 1.9 s)`);
  });

  await check('a finished voice is told to stop, not merely forgotten', async () => {
    // Why the pauses are worth anything at all.  Ticking the player is what
    // reaps, and reaping is what DISCONNECTS: an instrument's voice is a
    // source into a filter into a gain, and a connected filter has a tail, so
    // a voice that is dropped from the list without being stopped goes on
    // being processed for every block of the rest of the render.  That was
    // 137 ms of work per second of silence in the app.
    const stopped: string[] = [];
    const voice = (name: string, endsAt: number) => ({
      stop: (at: number) => { stopped.push(`${name}@${at}`); },
      endsAtCtxTime: endsAt,
      name,
    });
    const alive = reapFinished([voice('done', 3), voice('ringing', 9)], 5);
    eq(alive.map((v) => v.name).join(','), 'ringing', 'which voices were kept');
    eq(stopped.join(','), 'done@5', 'which voices were stopped, and when');

    // A voice already stopped by its own source must not take the reap down
    // with it — the rest of the list still has to be dropped.
    const thrower = {
      stop: () => { throw new Error('already stopped'); },
      endsAtCtxTime: 1,
      name: 'twice',
    };
    eq(reapFinished([thrower, voice('later', 9)], 5).map((v) => v.name).join(','),
      'later', 'a voice that refuses to stop twice still gets reaped');
    await Promise.resolve();
  });

  await check('every instrument declares the end it actually schedules', async () => {
    // The reap mark is the voice's own declaration, so the declaration is now
    // load-bearing in both directions: too early cuts a tail off mid-fade,
    // too late keeps a finished voice connected and the render slow again.
    //
    // It replaced a margin of four seconds past the written end of the note,
    // which was wrong both ways at once — measured across these nineteen
    // instruments with every tail knob at maximum, the longest tail runs
    // 4.02 s and the shortest 0.03 s, and a sampler zone states its release
    // in its own library file and can outlast any margin chosen here.
    const bad: string[] = [];
    for (const d of INSTRUMENTS) {
      for (const knobs of ['default', 'max'] as const) {
        const { declared, lastStop } = tailOf(d.id, knobs);
        if (!Number.isFinite(lastStop)) {
          // Nothing was scheduled — a sampler with no zone loaded.  Then the
          // voice is over where it began.
          if (declared > 0.05) bad.push(`${d.id}/${knobs} declares ${declared.toFixed(3)} with nothing sounding`);
          continue;
        }
        // A source is given its `stop` a little after the envelope has
        // reached zero; the declaration may sit at either.
        if (declared < lastStop - 0.05) {
          bad.push(`${d.id}/${knobs} declares ${declared.toFixed(3)} but a source runs to ${lastStop.toFixed(3)}`);
        }
        if (declared > lastStop + 0.1) {
          bad.push(`${d.id}/${knobs} declares ${declared.toFixed(3)}, ${(declared - lastStop).toFixed(3)} s after its last source stops`);
        }
      }
    }
    eq(bad.join('; '), '', 'instruments whose declared end does not match the graph');
    console.log(`      (${INSTRUMENTS.length} instruments, default and maximum tails)`);
    await Promise.resolve();
  });

  console.log('');
  for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  const bad = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - bad}/${results.length} passed${bad ? `, ${bad} FAILED` : ''}`);
  if (bad) process.exit(1);
}

void main();
