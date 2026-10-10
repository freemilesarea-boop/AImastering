/**
 * send-pdc-selftest — delay compensation for the routes a channel actually has.
 *
 * `pathLatency` followed `track.output` and nothing else, so a SEND was
 * invisible to the whole compensation.  Measured on a channel sent to a bus
 * carrying a linear-phase EQ, the return came back 511 samples — 10.6 ms —
 * behind the channel's own dry signal, and switching compensation ON did not
 * close it: it delayed the entire channel by 511, and the send tap sits after
 * that delay, so the wet moved with it and stayed exactly as far behind.
 * Every parallel-compression and reverb send in the product combed, and the
 * more you blended the worse it got.
 *
 * Two more fell out of the same wrong assumption — that every channel is an
 * independent source:
 *
 *   · an AUX was delayed by (longest − its own path), and that delay lands in
 *     SERIES with everything flowing through it.  A kick with 96 samples of
 *     look-ahead through an aux with 192 arrived 384 samples late against a
 *     snare compensated to 288: the compensation was creating a 2 ms error
 *     rather than removing one.
 *   · the MASTER was delayed too — 288 samples of pure latency added to the
 *     whole mix, lining nothing up with anything.
 *
 * The checks below are RENDERED wherever a render can see it, because the
 * numbers agreeing is not the claim.  The claim is that a send comes back in
 * step, and the way to ask that is to send a channel an inverted copy of
 * itself and require silence.
 *
 * Run via:  pnpm --filter @aimaster/desktop test:send-pdc
 */

import { OfflineAudioContext } from 'node-web-audio-api';
(globalThis as unknown as { OfflineAudioContext: unknown }).OfflineAudioContext = OfflineAudioContext;

import {
  addFile, addTrack, createBus, createClip, createSend, createSession, createTrack,
  createInsert, findTrack, setInsert, setSend, updateClips, updateTrack,
} from '../src/renderer/daw/model/session-ops.js';
import { resetIds } from '../src/renderer/daw/model/ids.js';
import { analyzeBuffer, clearAudioCache } from '../src/renderer/daw/engine/audio-cache.js';
import { renderSession } from '../src/renderer/daw/engine/offline-render.js';
import { computeDelayCompensation, insertLatency, pathLatency } from '../src/renderer/daw/model/routing.js';
import { defaultParams } from '../src/renderer/daw/engine/plugins.js';
import type { DawSession, Track } from '../src/renderer/daw/model/types.js';

const SR = 48_000;
const CLICK = 0.25;          // well under the limiter's −1 dBFS ceiling

const results: { name: string; pass: boolean }[] = [];
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); results.push({ name, pass: true }); console.log(`[PASS] ${name}`); }
  catch (e) {
    results.push({ name, pass: false });
    console.log(`[FAIL] ${name} — ${e instanceof Error ? e.message : String(e)}`);
  }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }
function eq(a: unknown, b: unknown, m: string): void {
  if (a !== b) throw new Error(`${m} — got ${String(a)}, want ${String(b)}`);
}

/** A single 64-sample click at t=0 — an alignment ruler. */
function makeClick(fileId: string): void {
  const ctx = new OfflineAudioContext(2, SR, SR);
  const buffer = ctx.createBuffer(2, SR, SR);
  for (let c = 0; c < 2; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < 64; i++) data[i] = CLICK * (1 - i / 64);
  }
  analyzeBuffer(fileId, buffer as unknown as AudioBuffer);
}

function withClick(session: DawSession, track: Track): DawSession {
  let s = addFile(session, {
    id: 'click', path: '/virtual/click.wav', name: 'click',
    durationSec: 1, sampleRate: SR, channels: 2,
  });
  s = updateClips(s, track.id, () => [
    createClip('click', 'click', { startSec: 0, offsetSec: 0, durationSec: 0.5 }),
  ]);
  return s;
}

const render = (session: DawSession): Promise<AudioBuffer> =>
  renderSession(session, { startSec: 0, endSec: 0.2 }, { sampleRate: SR, tailSec: 0 });

function onset(data: Float32Array, threshold: number): number {
  for (let i = 0; i < data.length; i++) if (Math.abs(data[i] ?? 0) > threshold) return i;
  return -1;
}
function peak(data: Float32Array): number {
  let p = 0;
  for (let i = 0; i < data.length; i++) p = Math.max(p, Math.abs(data[i] ?? 0));
  return p;
}

const limiter = (slot: number, lookaheadMs: number) =>
  createInsert(slot, 'limiter', 'Limiter',
    { params: { ...defaultParams('limiter'), lookaheadMs } });
const invert = (slot: number) =>
  createInsert(slot, 'phase', 'Phase',
    { params: { ...defaultParams('phase'), invertL: 1, invertR: 1 } });

/**
 * A click, sent an inverted copy of itself through a latent bus.
 *
 * `lookaheadMs` on the return is the only thing that makes the two routes
 * differ, so whatever is left at the master is the misalignment and nothing
 * else.
 */
function cancellationSession(lookaheadMs: number): DawSession {
  resetIds();
  let s = createSession('Send PDC', SR);
  const bus = createBus('FX');
  s = { ...s, buses: [bus] };
  const dry = createTrack('Dry', 'audio', { output: { kind: 'master' } });
  const fx = createTrack('FX Return', 'aux', { input: bus.id, output: { kind: 'master' } });
  s = addTrack(s, dry); s = addTrack(s, fx);
  s = withClick(s, dry);
  s = setSend(s, dry.id, createSend(0, bus.id, { levelDb: 0, preFader: false }));
  if (lookaheadMs > 0) s = setInsert(s, fx.id, limiter(0, lookaheadMs));
  s = setInsert(s, fx.id, invert(1));
  return s;
}

async function main(): Promise<void> {
  clearAudioCache();
  makeClick('click');

  // ── The rendered claim ──────────────────────────────────────────────────

  await check('a send that returns an inverted copy cancels the channel', async () => {
    // With no latency anywhere the two routes are already level, so this
    // measures the fixture rather than the fix: if THIS does not cancel, the
    // send level, the send pan or the polarity is wrong and every number
    // below would be measuring the wrong thing.
    const flat = peak((await render(cancellationSession(0))).getChannelData(0));
    assert(flat < 1e-3, `a latency-free send leaves ${flat.toFixed(4)}`);
  });

  await check('a latent send return comes back in step with the dry', async () => {
    // 4 ms of look-ahead on the return, and nothing else different.  Before
    // the routes were aligned this left the whole click twice over, 192
    // samples apart — which is what a parallel-compression send did to every
    // transient it touched.
    const left = peak((await render(cancellationSession(4))).getChannelData(0));
    assert(left < 1e-3, `a 4 ms return leaves ${left.toFixed(4)} — the routes are ${left > 0.1 ? 'not aligned' : 'drifting'}`);
  });

  await check('the alignment holds at a look-ahead the delay line has to round', async () => {
    // 3.7 ms is 177.6 samples: the plugin rounds its declared latency and the
    // delay line is set in seconds, so this is where an off-by-one lives.
    const left = peak((await render(cancellationSession(3.7))).getChannelData(0));
    assert(left < 5e-3, `a 3.7 ms return leaves ${left.toFixed(4)}`);
  });

  await check('an aux carries no delay of its own', async () => {
    // Two clicks: one straight to the master, one through a bus and an aux
    // that costs 4 ms.  They have to land on the same sample.  The aux used
    // to be delayed by (longest − its own path), and that delay sits in
    // SERIES with everything flowing through it, so the routed click came out
    // 96 samples late — the compensation creating the error it exists to
    // remove.
    //
    // Read as two ONSETS rather than as a cancellation, and the reason is a
    // property of the OFFLINE RENDERER rather than of the app: here a
    // look-ahead limiter on a BUS-FED channel comes out mono-folded and 3 dB
    // down — a left-only click returns 0.0884 in BOTH channels instead of
    // 0.25 in one — so a cancellation check between a path that has one and a
    // path that does not would read that level difference as a misalignment
    // when the timing is exactly right.  Chromium, which is what the product
    // runs, returns 0.25 / 0.000 through the same session, so there is
    // nothing here to fix in the app and nothing a check could hold it to.
    // Muting, by contrast, changes nothing the compensation computes, so two
    // soloed renders are directly comparable.
    const base = (): DawSession => {
      resetIds();
      let s = createSession('Aux', SR);
      const bus = createBus('Drums');
      s = { ...s, buses: [bus] };
      const kick = createTrack('Kick', 'audio', { output: { kind: 'bus', busId: bus.id } });
      const snare = createTrack('Snare', 'audio', { output: { kind: 'master' } });
      const aux = createTrack('Drum Sum', 'aux', { input: bus.id, output: { kind: 'master' } });
      s = addTrack(s, kick); s = addTrack(s, snare); s = addTrack(s, aux);
      s = withClick(s, kick);
      s = updateClips(s, snare.id, () => [
        createClip('click', 'click', { startSec: 0, offsetSec: 0, durationSec: 0.5 }),
      ]);
      s = setInsert(s, kick.id, limiter(0, 2));      // 96 samples
      s = setInsert(s, aux.id, limiter(0, 4));       // 192 on top
      return s;
    };
    const solo = async (name: string): Promise<number> => {
      const s = base();
      const hushed: DawSession = {
        ...s,
        tracks: s.tracks.map((t) => (t.kind === 'audio' && t.name !== name ? { ...t, mute: true } : t)),
      };
      return onset((await render(hushed)).getChannelData(0), 0.01);
    };
    const routed = await solo('Kick');
    const direct = await solo('Snare');
    assert(routed > 0, 'the routed click has to arrive somewhere');
    eq(routed, direct, 'the routed click and the direct one land on the same sample');
  });

  await check('two sends of different lengths come back together', async () => {
    // The only rendered check that exercises the delay on a SEND rather than
    // on a main output.  One return costs 2 ms and the other 6, so the short
    // one owes the long one 192 samples; with no dry at the master the two
    // returns are the whole signal, and the FIRST thing to arrive says
    // whether the short one waited.  Aligned, nothing arrives before 288.
    // Unaligned, the 2 ms return turns up at 96 on its own.
    resetIds();
    let s = createSession('Two returns', SR);
    const a = createBus('A'), b = createBus('B');
    s = { ...s, buses: [a, b] };
    const dry = createTrack('Dry', 'audio', { output: { kind: 'none' } });
    const auxA = createTrack('A', 'aux', { input: a.id, output: { kind: 'master' } });
    const auxB = createTrack('B', 'aux', { input: b.id, output: { kind: 'master' } });
    s = addTrack(s, dry); s = addTrack(s, auxA); s = addTrack(s, auxB);
    s = withClick(s, dry);
    s = setSend(s, dry.id, createSend(0, a.id, { levelDb: 0, preFader: false }));
    s = setSend(s, dry.id, createSend(1, b.id, { levelDb: 0, preFader: false }));
    s = setInsert(s, auxA.id, limiter(0, 2));      // 96
    s = setInsert(s, auxB.id, limiter(0, 6));      // 288
    eq(onset((await render(s)).getChannelData(0), 0.01), 288,
      'the short return waits for the long one');
  });

  await check('the session costs exactly the latency it reports', async () => {
    // The master used to be delayed by (longest − its own path) as well, and
    // a delay on the sink is added to the whole mix and lines nothing up with
    // anything — 288 samples of pure latency in the case below, six
    // milliseconds on everything.  It is invisible to any check that compares
    // two paths with each other, so this one compares the arrival against the
    // number the compensation puts on screen.
    resetIds();
    let s = createSession('Total', SR);
    const bus = createBus('Drums');
    s = { ...s, buses: [bus] };
    const kick = createTrack('Kick', 'audio', { output: { kind: 'bus', busId: bus.id } });
    const aux = createTrack('Drum Sum', 'aux', { input: bus.id, output: { kind: 'master' } });
    s = addTrack(s, kick); s = addTrack(s, aux);
    s = withClick(s, kick);
    s = setInsert(s, kick.id, limiter(0, 2));
    s = setInsert(s, aux.id, limiter(0, 4));
    const reported = computeDelayCompensation(s).maxSamples;
    eq(reported, 288, 'what the Mix window shows');
    eq(onset((await render(s)).getChannelData(0), 0.01), reported,
      'and what the render actually costs');
  });

  await check('the compensation delays sources only', () => {
    resetIds();
    let s = createSession('Sources', SR);
    const bus = createBus('Drums');
    s = { ...s, buses: [bus] };
    const kick = createTrack('Kick', 'audio', { output: { kind: 'bus', busId: bus.id } });
    const snare = createTrack('Snare', 'audio', { output: { kind: 'master' } });
    const aux = createTrack('Drum Sum', 'aux', { input: bus.id, output: { kind: 'master' } });
    s = addTrack(s, kick); s = addTrack(s, snare); s = addTrack(s, aux);
    s = setInsert(s, kick.id, limiter(0, 2));
    s = setInsert(s, aux.id, limiter(0, 4));
    const master = s.tracks.find((t) => t.kind === 'master')!;
    const adc = computeDelayCompensation(s);
    eq(adc.maxSamples, 288, 'the longest path');
    eq(adc.perTrack.get(kick.id), 0, 'the longest source waits for nobody');
    eq(adc.perTrack.get(snare.id), 288, 'the snare waits for the kick and the aux');
    eq(adc.perTrack.get(aux.id), 0, 'a bus feeds the aux, so a delay there is in series');
    eq(adc.perTrack.get(master.id), 0, 'the master is the sink; a delay there is pure latency');
  });

  // ── The model ───────────────────────────────────────────────────────────

  await check('path latency takes a send when the send is the long way round', () => {
    resetIds();
    let s = createSession('Sends', SR);
    const bus = createBus('FX');
    s = { ...s, buses: [bus] };
    const dry = createTrack('Dry', 'audio', { output: { kind: 'master' } });
    const fx = createTrack('FX', 'aux', { input: bus.id, output: { kind: 'master' } });
    s = addTrack(s, dry); s = addTrack(s, fx);
    const send = createSend(0, bus.id, { levelDb: 0 });
    s = setSend(s, dry.id, send);
    s = setInsert(s, fx.id, limiter(0, 4));

    eq(insertLatency(findTrack(s, dry.id)!, SR), 0, 'the channel itself costs nothing');
    eq(pathLatency(s, dry.id), 192, 'but its send does');
    const adc = computeDelayCompensation(s);
    eq(adc.perOutput.get(dry.id), 192, 'so the dry output waits for the return');
    eq(adc.perSend.get(send.id), 0, 'and the long route waits for nobody');
  });

  await check('a muted send costs nothing', () => {
    resetIds();
    let s = createSession('Muted', SR);
    const bus = createBus('FX');
    s = { ...s, buses: [bus] };
    const dry = createTrack('Dry', 'audio', { output: { kind: 'master' } });
    const fx = createTrack('FX', 'aux', { input: bus.id, output: { kind: 'master' } });
    s = addTrack(s, dry); s = addTrack(s, fx);
    s = setSend(s, dry.id, createSend(0, bus.id, { levelDb: 0, mute: true }));
    s = setInsert(s, fx.id, limiter(0, 4));
    eq(pathLatency(s, dry.id), 0, 'a muted send is not a route');
    eq(computeDelayCompensation(s).perOutput.get(dry.id), 0, 'so the dry waits for nothing');
  });

  await check('a send into a bus nothing reads costs nothing', () => {
    resetIds();
    let s = createSession('Dead end', SR);
    const bus = createBus('FX');
    s = { ...s, buses: [bus] };
    const dry = createTrack('Dry', 'audio', { output: { kind: 'master' } });
    s = addTrack(s, dry);
    s = setSend(s, dry.id, createSend(0, bus.id, { levelDb: 0 }));
    eq(pathLatency(s, dry.id), 0, 'nothing reads the bus, so nothing comes back');
  });

  await check('the longest of several sends is the one the dry waits for', () => {
    resetIds();
    let s = createSession('Two sends', SR);
    const a = createBus('A'), b = createBus('B');
    s = { ...s, buses: [a, b] };
    const dry = createTrack('Dry', 'audio', { output: { kind: 'master' } });
    const auxA = createTrack('A', 'aux', { input: a.id, output: { kind: 'master' } });
    const auxB = createTrack('B', 'aux', { input: b.id, output: { kind: 'master' } });
    s = addTrack(s, dry); s = addTrack(s, auxA); s = addTrack(s, auxB);
    const sendA = createSend(0, a.id, { levelDb: 0 });
    const sendB = createSend(1, b.id, { levelDb: 0 });
    s = setSend(s, dry.id, sendA); s = setSend(s, dry.id, sendB);
    s = setInsert(s, auxA.id, limiter(0, 2));      // 96
    s = setInsert(s, auxB.id, limiter(0, 6));      // 288
    eq(pathLatency(s, dry.id), 288, 'the longer send wins');
    const adc = computeDelayCompensation(s);
    eq(adc.perOutput.get(dry.id), 288, 'the dry waits for the longer one');
    eq(adc.perSend.get(sendA.id), 192, 'and so does the shorter send');
    eq(adc.perSend.get(sendB.id), 0, 'the longest route waits for nobody');
  });

  await check('a device REMOVED from the return stops costing; a bypassed one does not', () => {
    resetIds();
    let s = createSession('Bypass', SR);
    const bus = createBus('FX');
    s = { ...s, buses: [bus] };
    const dry = createTrack('Dry', 'audio', { output: { kind: 'master' } });
    const fx = createTrack('FX', 'aux', { input: bus.id, output: { kind: 'master' } });
    s = addTrack(s, dry); s = addTrack(s, fx);
    s = setSend(s, dry.id, createSend(0, bus.id, { levelDb: 0 }));
    s = setInsert(s, fx.id, limiter(0, 4));
    eq(pathLatency(s, dry.id), 192, 'active');
    // Bypassing is not removing.  The device keeps delaying its dry path by
    // what it declares, so that switching it out compares processing rather
    // than timing — this line expected 0 and the graph disagreed with it.
    const off = setInsert(s, fx.id, { ...findTrack(s, fx.id)!.inserts[0]!, bypass: true });
    eq(pathLatency(off, dry.id), 192, 'bypassed — still in circuit');
    const gone = updateTrack(s, fx.id, (t) => ({ ...t, inserts: [] }));
    eq(pathLatency(gone, dry.id), 0, 'removed');
  });

  await check('switching the compensation off zeroes the route delays too', () => {
    resetIds();
    let s = createSession('Off', SR);
    const bus = createBus('FX');
    s = { ...s, buses: [bus] };
    const dry = createTrack('Dry', 'audio', { output: { kind: 'master' } });
    const fx = createTrack('FX', 'aux', { input: bus.id, output: { kind: 'master' } });
    s = addTrack(s, dry); s = addTrack(s, fx);
    const send = createSend(0, bus.id, { levelDb: 0 });
    s = setSend(s, dry.id, send);
    s = setInsert(s, fx.id, limiter(0, 4));
    const off = computeDelayCompensation({ ...s, delayCompensation: false });
    eq(off.maxSamples, 0, 'nothing reported');
    eq(off.perOutput.get(dry.id), 0, 'no route delay');
    eq(off.perSend.get(send.id), 0, 'none on the send either');
  });

  await check('a send that loops back to its own channel does not hang the walk', () => {
    resetIds();
    let s = createSession('Loop', SR);
    const bus = createBus('FX');
    s = { ...s, buses: [bus] };
    // An aux that reads the bus AND sends back into it — the classic feedback
    // routing.  Latency is reported separately from feedback, so this must
    // return rather than recurse.
    const fx = createTrack('FX', 'aux', { input: bus.id, output: { kind: 'master' } });
    s = addTrack(s, fx);
    s = setSend(s, fx.id, createSend(0, bus.id, { levelDb: 0 }));
    s = setInsert(s, fx.id, limiter(0, 4));
    eq(pathLatency(s, fx.id), 192, 'its own insert, and the loop cut');
  });

  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  if (failed > 0) process.exit(1);
}

void main();
