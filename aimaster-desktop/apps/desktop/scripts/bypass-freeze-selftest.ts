/**
 * bypass-freeze-selftest — the two places a track moved when it should not.
 *
 * Both are the same mistake in different clothes: a latency that exists in the
 * audio and not in the model, or the other way round.
 *
 * BYPASS.  `withBypass` has always said, in its own comment, that "bypassing a
 * look-ahead limiter does not shift the channel forward by its latency" — and
 * `insertLatencySamples` said `if (insert.bypass) return 0`.  Both halves
 * could not be right.  Measured, the limiter was the only device that had
 * built itself a bypass delay, so bypassing it left the channel 192 samples
 * behind a track beside it; bypassing a compressor, a linear-phase EQ or a
 * saturator moved the track 384, 511 or 128 samples the OTHER way, because
 * those had no bypass delay at all.  `rotary` had one that left out the
 * shaper's quantum, which is what a second copy of a number does.
 *
 * FREEZE.  `renderTrack` renders a channel through its own inserts, so the
 * file it writes begins with that channel's latency as leading silence — and
 * nothing took it off again.  The clip went back at the same start with the
 * inserts bypassed, so the frozen track played late by exactly its own
 * latency: 511 samples for a linear-phase EQ, 384 for a compressor, 128 for a
 * saturator, against a track that had been level with it a moment earlier.
 * Freeze is meant to change what the CPU does and nothing else.
 *
 * Everything below is RENDERED, because both of these are questions about
 * where a sound lands.
 *
 * Run via:  pnpm --filter @aimaster/desktop test:bypass-freeze
 */

import { OfflineAudioContext } from 'node-web-audio-api';
(globalThis as unknown as { OfflineAudioContext: unknown }).OfflineAudioContext = OfflineAudioContext;

import { readFileSync } from 'node:fs';

import {
  addFile, addTrack, createClip, createInsert, createSession, createTrack, findTrack,
  setInsert, updateClips, updateTrack,
} from '../src/renderer/daw/model/session-ops.js';
import { resetIds } from '../src/renderer/daw/model/ids.js';
import { analyzeBuffer, clearAudioCache } from '../src/renderer/daw/engine/audio-cache.js';
import { renderSession, renderTrack } from '../src/renderer/daw/engine/offline-render.js';
import { defaultParams, descriptorLatency, findPlugin } from '../src/renderer/daw/engine/plugins.js';
import { insertLatency, insertLatencySamples } from '../src/renderer/daw/model/routing.js';
import { chainLatency } from '../src/renderer/daw/engine/device-chain.js';
import { linearGraph, deviceOrder } from '../src/renderer/daw/model/device-graph.js';
import type { DawSession, Insert } from '../src/renderer/daw/model/types.js';

const SR = 48_000;
const CLICK = 0.25;

/** Devices with latency, one of each kind that was wrong in a different way. */
const LATENT: readonly [string, Record<string, number>][] = [
  ['limiter', { lookaheadMs: 4 }],   // the one device that HAD a bypass delay
  ['comp', {}],                      // a compressor's look-ahead
  ['linphase', {}],                  // an FIR's group delay
  ['saturation', {}],                // an oversampled shaper
  ['tape', {}],                      // transport plus shaper, added by hand
];

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

function makeClick(): void {
  const ctx = new OfflineAudioContext(2, SR, SR);
  const buffer = ctx.createBuffer(2, SR, SR);
  for (let c = 0; c < 2; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < 64; i++) data[i] = CLICK * (1 - i / 64);
  }
  analyzeBuffer('click', buffer as unknown as AudioBuffer);
}
function onset(data: Float32Array, threshold = 0.01): number {
  for (let i = 0; i < data.length; i++) if (Math.abs(data[i] ?? 0) > threshold) return i;
  return -1;
}
const clipOf = (fileId: string, durationSec: number) =>
  createClip(fileId, fileId, { startSec: 0, offsetSec: 0, durationSec });

/** One track with the device on it, one plain track beside it as the ruler. */
function pair(device: string, over: Record<string, number>, bypass: boolean):
{ session: DawSession; latent: string; plain: string } {
  resetIds();
  let s = createSession('bypass', SR);
  const latent = createTrack('Latent', 'audio', { output: { kind: 'master' } });
  const plain = createTrack('Plain', 'audio', { output: { kind: 'master' } });
  s = addTrack(s, latent); s = addTrack(s, plain);
  s = addFile(s, {
    id: 'click', path: '/virtual/click.wav', name: 'click',
    durationSec: 1, sampleRate: SR, channels: 2,
  });
  for (const t of [latent, plain]) s = updateClips(s, t.id, () => [clipOf('click', 0.5)]);
  s = setInsert(s, latent.id, createInsert(0, device, 'D',
    { params: { ...defaultParams(device), ...over }, bypass }));
  return { session: s, latent: latent.id, plain: plain.id };
}

/** Where one track's click lands, with everything else silent. */
async function landsAt(session: DawSession, keep: string): Promise<number> {
  const hushed: DawSession = {
    ...session,
    tracks: session.tracks.map((t) =>
      (t.kind === 'audio' && t.id !== keep ? { ...t, mute: true } : t)),
  };
  const out = await renderSession(hushed, { startSec: 0, endSec: 0.2 },
    { sampleRate: SR, tailSec: 0 });
  return onset(out.getChannelData(0));
}

async function main(): Promise<void> {
  clearAudioCache();
  makeClick();

  // ── Bypass ──────────────────────────────────────────────────────────────

  await check('a device that is switched in lands with the track beside it', async () => {
    // The control. If THIS drifts, everything below is measuring the wrong
    // thing and the numbers mean nothing.
    for (const [device, over] of LATENT) {
      const { session, latent, plain } = pair(device, over, false);
      eq(await landsAt(session, latent), await landsAt(session, plain),
        `${device}, switched in`);
    }
  });

  await check('and so does one that is switched out', async () => {
    for (const [device, over] of LATENT) {
      const { session, latent, plain } = pair(device, over, true);
      const a = await landsAt(session, latent);
      const b = await landsAt(session, plain);
      assert(a >= 0, `${device} rendered nothing at all`);
      eq(a, b, `${device}, bypassed`);
    }
  });

  await check('a bypassed device still reports what it costs', () => {
    for (const [device, over] of LATENT) {
      const descriptor = findPlugin(device)!;
      const params = { ...defaultParams(device), ...over };
      const insert: Insert = {
        ...createInsert(0, device, 'D', { params }), bypass: true,
      };
      const want = descriptorLatency(descriptor, params, SR);
      assert(want > 0, `${device} has no latency to report`);
      eq(insertLatencySamples(insert, SR), want, `${device} bypassed`);
    }
  });

  await check('an offline device costs nothing, switched in or out', () => {
    // It is force-bypassed in the realtime graph and its work is done by the
    // render path, so counting it would delay the channel for a device that
    // is not in it.
    const descriptor = findPlugin('pitchcorrect')!;
    assert(descriptor.offline === true, 'the fixture must be an offline device');
    eq(descriptorLatency(descriptor, defaultParams('pitchcorrect'), SR), 0, 'offline');
  });

  await check('a bypassed node in a device chain keeps its latency too', () => {
    // The chain had the same `bypass ? 0` rule as the mixer, in its own copy.
    const graph = linearGraph([
      { pluginId: 'limiter', label: 'L', params: { ...defaultParams('limiter'), lookaheadMs: 4 } },
    ]);
    const active = chainLatency(graph, [], SR);
    eq(active, 192, 'switched in');
    const node = deviceOrder(graph).find((n) => n.label === 'L')!;
    const off = {
      ...graph,
      nodes: graph.nodes.map((n) => (n.id === node.id ? { ...n, bypass: true } : n)),
    };
    eq(chainLatency(off, [], SR), 192, 'switched out');
  });

  await check('every device is built through the one call that tells it its latency', () => {
    // STRUCTURAL.  A device built with a bare `descriptor.create` never has
    // its bypass delay set, so switching it out moves the track — and nothing
    // about the call site looks wrong.  `createInstance` is the only way in.
    const sources = [
      'src/renderer/daw/engine/device-chain.ts',
      'src/renderer/daw/engine/mixer-engine.ts',
    ];
    const bare: string[] = [];
    for (const file of sources) {
      const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
      for (const [i, line] of text.split('\n').entries()) {
        if (/\bdescriptor\.create\s*\(/.test(line)) bare.push(`${file}:${i + 1}`);
      }
    }
    assert(bare.length === 0, `built without createInstance — ${bare.join(', ')}`);
  });

  // ── Freeze ──────────────────────────────────────────────────────────────

  /** Freeze the latent track the way `freezeTrack` does, minus the filesystem. */
  async function frozen(device: string, over: Record<string, number>):
  Promise<{ session: DawSession; latent: string; plain: string; fileStartsAt: number }> {
    const { session, latent, plain } = pair(device, over, false);
    const baked = await renderTrack(session, latent);
    const fileId = `frozen-${device}`;
    analyzeBuffer(fileId, baked);
    let out = addFile(session, {
      id: fileId, path: `/virtual/${fileId}.wav`, name: fileId,
      durationSec: baked.length / SR, sampleRate: SR, channels: 2,
    });
    out = updateTrack(out, latent, (t) => ({
      ...t, inserts: t.inserts.map((i) => ({ ...i, bypass: true })),
    }));
    out = updateClips(out, latent, () => [clipOf(fileId, baked.length / SR)]);
    return { session: out, latent, plain, fileStartsAt: onset(baked.getChannelData(0)) };
  }

  await check('the file a freeze writes has no latency in front of it', async () => {
    for (const [device, over] of LATENT) {
      const { fileStartsAt } = await frozen(device, over);
      eq(fileStartsAt, 0, `${device}: the frozen file starts late`);
    }
  });

  await check('a frozen track lands where it did before it was frozen', async () => {
    for (const [device, over] of LATENT) {
      const { session, latent, plain } = await frozen(device, over);
      const a = await landsAt(session, latent);
      const b = await landsAt(session, plain);
      assert(a >= 0, `${device} rendered nothing at all`);
      eq(a, b, `${device}, frozen`);
    }
  });

  await check('a track with nothing on it freezes to the same samples', async () => {
    // The trim must not take anything off a channel that has no latency —
    // that would be the same bug pointing the other way.
    const { session, latent } = pair('eq3', {}, false);
    const baked = await renderTrack(session, latent);
    eq(onset(baked.getChannelData(0)), 0, 'a zero-latency channel starts at zero');
    eq(insertLatency(findTrack(session, latent)!, SR), 0, 'and costs nothing');
  });

  await check('a clip that starts late keeps its place through a freeze', async () => {
    // The trim comes off the FRONT of the render, so a clip two hundred
    // milliseconds in has to still be two hundred milliseconds in.
    resetIds();
    let s = createSession('late', SR);
    const t = createTrack('Late', 'audio', { output: { kind: 'master' } });
    s = addTrack(s, t);
    s = addFile(s, {
      id: 'click', path: '/virtual/click.wav', name: 'click',
      durationSec: 1, sampleRate: SR, channels: 2,
    });
    s = updateClips(s, t.id, () => [
      createClip('click', 'click', { startSec: 0.1, offsetSec: 0, durationSec: 0.5 }),
    ]);
    s = setInsert(s, t.id, createInsert(0, 'linphase', 'LP',
      { params: defaultParams('linphase') }));
    const baked = await renderTrack(s, t.id);
    eq(onset(baked.getChannelData(0)), Math.round(0.1 * SR),
      'the click moved when only the latency should have come off');
  });

  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  if (failed > 0) process.exit(1);
}

void main();
