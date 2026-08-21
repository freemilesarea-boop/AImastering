/**
 * plugin-automation-selftest — automating a device's knobs.
 *
 * The interesting claim is not "a lane can be drawn on a plugin parameter".
 * It is that the lane REACHES THE AUDIO, in the offline render as well as
 * live — which is the whole reason this was blocked until now.  So the
 * centrepiece here is a set of real renders that MEASURE the result:
 *
 *   A trim lane sweeping −24 dB → 0 dB comes out 24 dB louder at the end.
 *   An LPF lane sweeping 20 kHz → 400 Hz takes a 4 kHz tone away with it.
 *   A lane on a parameter the device cannot ramp changes nothing and does not
 *   throw — the menu never offers those, so this is the hand-edited case.
 *
 * The second job is anti-drift: every device is created and its declared
 * `automatableParams` is checked against what the instance actually hands
 * back.  A list that says a knob is automatable when it is not would put a
 * lane in the menu that draws beautifully and does nothing.
 *
 * Run: pnpm --filter @aimaster/desktop test:plugin-automation
 */

import { OfflineAudioContext } from 'node-web-audio-api';

// renderSession reads OfflineAudioContext off globalThis (the browser has it).
(globalThis as unknown as { OfflineAudioContext: unknown }).OfflineAudioContext = OfflineAudioContext;

import {
  addFile, addTrack, createClip, createInsert, createSession, createTrack, findTrack,
  setInsert, updateClips, updateTrack,
} from '../src/renderer/daw/model/session-ops.js';
import { resetIds } from '../src/renderer/daw/model/ids.js';
import { analyzeBuffer } from '../src/renderer/daw/engine/audio-cache.js';
import { renderSession } from '../src/renderer/daw/engine/offline-render.js';
import { MixerEngine } from '../src/renderer/daw/engine/mixer-engine.js';
import { PLUGINS, defaultParams, findPlugin } from '../src/renderer/daw/engine/plugins.js';
import {
  createLane, parsePluginParamKey, pluginParamKey, targetKey,
} from '../src/renderer/daw/model/automation.js';
import {
  automatableParamsOf, availableTargets, describeTarget, isPlayable, laneRange,
} from '../src/renderer/daw/edit/automation-lanes.js';
import type { AutomationPoint, DawSession, Insert } from '../src/renderer/daw/model/types.js';

const SR = 48_000;

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  return Promise.resolve().then(fn)
    .then(() => { results.push({ name, pass: true, detail: '' }); })
    .catch((e: unknown) => {
      results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) });
    });
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }
function eq<T>(a: T, b: T, m: string): void {
  if (a !== b) throw new Error(`${m} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}
function close(a: number, b: number, m: string, tol: number): void {
  if (Math.abs(a - b) > tol) throw new Error(`${m} — got ${a.toFixed(4)}, want ${b.toFixed(4)} ±${tol}`);
}

function rms(data: Float32Array, from: number, to: number): number {
  let sum = 0;
  let n = 0;
  for (let i = from; i < Math.min(to, data.length); i++) { const v = data[i] ?? 0; sum += v * v; n++; }
  return n > 0 ? Math.sqrt(sum / n) : 0;
}
const db = (x: number): number => 20 * Math.log10(Math.max(1e-12, x));

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

/** One track playing a tone, with one insert, and one automation lane on it. */
function toneWithLane(
  fileId: string, seconds: number,
  pluginId: string, params: Record<string, number>,
  paramId: string, points: AutomationPoint[],
): { session: DawSession; insert: Insert } {
  resetIds();
  let session = createSession('automation test', SR);
  const track = createTrack('Tone', 'audio');
  session = addTrack(session, track);
  session = addFile(session, {
    id: fileId, path: `/virtual/${fileId}.wav`, name: fileId,
    durationSec: seconds, sampleRate: SR, channels: 2,
  });
  session = updateClips(session, track.id, () => [
    createClip(fileId, 'tone', { startSec: 0, offsetSec: 0, durationSec: seconds }),
  ]);

  const insert = createInsert(0, pluginId, pluginId);
  const configured: Insert = { ...insert, params: { ...defaultParams(pluginId), ...params } };
  session = setInsert(session, track.id, configured);

  const lane = createLane({ kind: 'plugin', insertId: configured.id, paramId }, points[0]?.value ?? 0);
  session = updateTrack(session, track.id, (t) => ({
    ...t, automation: [{ ...lane, points: [...points], mode: 'read' }],
  }));
  return { session, insert: configured };
}

async function run(): Promise<void> {
  // ── 1. The devices tell the truth about themselves ──────────────────────

  await check('every declared automatable parameter really is one AudioParam', () => {
    const ctx = new OfflineAudioContext(2, SR, SR);
    const problems: string[] = [];
    for (const device of PLUGINS) {
      const declared = device.automatableParams ?? [];
      if (declared.length === 0) continue;
      const instance = device.create(ctx as unknown as BaseAudioContext, defaultParams(device.id));
      for (const id of declared) {
        if (!device.params.some((p) => p.id === id)) {
          problems.push(`${device.id}.${id}: declared but not a parameter of the device`);
          continue;
        }
        const found = instance.automatable?.(id);
        if (!found) { problems.push(`${device.id}.${id}: declared but the instance has none`); continue; }
        if (typeof found.param?.value !== 'number') {
          problems.push(`${device.id}.${id}: not an AudioParam`);
        }
      }
      instance.dispose();
    }
    eq(problems.length, 0, `no drift — ${problems.slice(0, 4).join(' | ')}`);
  });

  await check('a parameter that is NOT declared hands back nothing', () => {
    const ctx = new OfflineAudioContext(2, SR, SR);
    const problems: string[] = [];
    for (const device of PLUGINS) {
      const declared = new Set(device.automatableParams ?? []);
      const instance = device.create(ctx as unknown as BaseAudioContext, defaultParams(device.id));
      for (const param of device.params) {
        if (declared.has(param.id)) continue;
        if (instance.automatable?.(param.id)) {
          problems.push(`${device.id}.${param.id}: automatable but not declared`);
        }
      }
      instance.dispose();
    }
    eq(problems.length, 0, `the list is complete — ${problems.slice(0, 4).join(' | ')}`);
  });

  await check('a device with nothing automatable offers nothing, rather than throwing', () => {
    const ctx = new OfflineAudioContext(2, SR, SR);
    const limiter = findPlugin('limiter');
    assert(limiter !== undefined, 'the limiter exists');
    eq(limiter?.automatableParams?.length, 0, 'and declares an empty list on purpose');
    const instance = limiter!.create(ctx as unknown as BaseAudioContext, defaultParams('limiter'));
    for (const param of limiter!.params) {
      eq(instance.automatable?.(param.id) ?? null, null, `${param.id} is not offered`);
    }
    instance.dispose();
  });

  await check('no automatable parameter changes the device’s reported latency', () => {
    // The plugin window rides an automatable knob through the automation
    // store, which writes the value without recomputing `latencySamples` —
    // correct only while this holds.  Delay compensation lines the whole
    // channel up against that number; a parameter that moved it mid-pass
    // would slide the track against everything else.
    const problems: string[] = [];
    for (const device of PLUGINS) {
      for (const id of device.automatableParams ?? []) {
        const def = device.params.find((p) => p.id === id);
        if (!def) continue;
        const base = defaultParams(device.id);
        const low = device.latencyFor({ ...base, [id]: def.min }, SR);
        const high = device.latencyFor({ ...base, [id]: def.max }, SR);
        if (low !== high) problems.push(`${device.id}.${id}: ${low} → ${high} samples`);
      }
    }
    eq(problems.length, 0, `latency is fixed across every lane — ${problems.join(' | ')}`);
  });

  // ── 2. The menu ────────────────────────────────────────────────────────

  await check('plugin parameters appear in the lane menu, in chain order', () => {
    resetIds();
    let session = createSession('menu', SR);
    const track = createTrack('Ch', 'audio');
    session = addTrack(session, track);
    session = setInsert(session, track.id,
      { ...createInsert(1, 'eq8', 'eq8'), params: defaultParams('eq8') });
    session = setInsert(session, track.id,
      { ...createInsert(0, 'trim', 'trim'), params: defaultParams('trim') });

    const laid = findTrack(session, track.id)!;
    const targets = availableTargets(laid);
    const plugins = targets.filter((t) => t.kind === 'plugin');
    assert(plugins.length > 0, 'there are plugin targets');

    // Slot 0 (trim) before slot 1 (eq8) — the menu reads down the channel.
    const first = plugins[0];
    assert(first?.kind === 'plugin', 'first is a plugin target');
    if (first?.kind !== 'plugin') return;
    const trimInsert = laid.inserts.find((i) => i.slot === 0);
    eq(first.insertId, trimInsert?.id, 'the first insert comes first');
    eq(first.paramId, 'gainDb', 'and its one automatable parameter');

    // Volume and pan are still at the top, where a channel starts.
    eq(targets[0]?.kind, 'volume', 'volume first');
    eq(targets[1]?.kind, 'pan', 'pan second');
  });

  await check('the menu offers only what the device can ramp', () => {
    resetIds();
    let session = createSession('menu', SR);
    const track = createTrack('Ch', 'audio');
    session = addTrack(session, track);
    session = setInsert(session, track.id,
      { ...createInsert(0, 'delay', 'delay'), params: defaultParams('delay') });
    const laid = findTrack(session, track.id)!;
    const insert = laid.inserts[0]!;

    const offered = automatableParamsOf(insert).map((p) => p.id).sort();
    eq(offered.join(','), 'feedback,timeMs', 'time and feedback, but not mix');
    // `mix` is two gains moving in opposite directions — half-automating it
    // would leave the dry side behind.
    assert(!offered.includes('mix'), 'mix is deliberately absent');
  });

  await check('a lane is playable only while its device is in the slot', () => {
    resetIds();
    let session = createSession('swap', SR);
    const track = createTrack('Ch', 'audio');
    session = addTrack(session, track);
    session = setInsert(session, track.id,
      { ...createInsert(0, 'trim', 'trim'), params: defaultParams('trim') });
    const laid = findTrack(session, track.id)!;
    const insert = laid.inserts[0]!;
    const target = { kind: 'plugin' as const, insertId: insert.id, paramId: 'gainDb' };

    assert(isPlayable(target, laid), 'playable while the trim is there');
    assert(!isPlayable({ ...target, paramId: 'nonsense' }, laid), 'not for a parameter it lacks');
    assert(!isPlayable({ ...target, insertId: 'gone' }, laid), 'not for an insert that is not there');
    assert(!isPlayable(target), 'and not answerable at all without the track');
    // The channel targets still answer without one.
    assert(isPlayable({ kind: 'volume' }), 'volume needs no track to answer');
  });

  await check('a plugin lane reads and draws in the device’s own units', () => {
    resetIds();
    let session = createSession('range', SR);
    const track = createTrack('Ch', 'audio');
    session = addTrack(session, track);
    session = setInsert(session, track.id,
      { ...createInsert(0, 'eq8', 'eq8'), params: defaultParams('eq8') });
    const laid = findTrack(session, track.id)!;
    const insert = laid.inserts[0]!;
    const target = { kind: 'plugin' as const, insertId: insert.id, paramId: 'lpfHz' };

    const range = laneRange(laid, target);
    const def = findPlugin('eq8')!.params.find((p) => p.id === 'lpfHz')!;
    eq(range.min, def.min, 'min from the device');
    eq(range.max, def.max, 'max from the device');
    eq(range.neutral, def.default, 'the line across the middle is the default');
    eq(range.unit, 'Hz', 'and the unit is the device’s');

    const label = describeTarget(laid, target);
    assert(label.includes('LPF'), `names the parameter — ${label}`);
    assert(label.startsWith('A '), `and the slot it is in — ${label}`);
  });

  await check('a plugin target has a stable key, both ways', () => {
    const key = targetKey({ kind: 'plugin', insertId: 'ins-7', paramId: 'lpfHz' });
    eq(key, 'plugin:ins-7:lpfHz', 'the key');
    eq(key, pluginParamKey('ins-7', 'lpfHz'), 'and the engine spells it the same');
    const back = parsePluginParamKey(key);
    eq(back?.insertId, 'ins-7', 'insert read back');
    eq(back?.paramId, 'lpfHz', 'parameter read back');
    eq(parsePluginParamKey('volume'), null, 'a channel key is not a plugin key');
    eq(parsePluginParamKey('plugin:onlyone'), null, 'and a malformed one is refused');
    eq(parsePluginParamKey('plugin:a:'), null, 'including an empty parameter');
  });

  // ── 3. The render — the part that matters ──────────────────────────────

  await check('a trim lane really moves the level in an offline render', async () => {
    makeToneFile('tone-trim', 440, 0.5, 3);
    // −24 dB at the start, 0 dB at two seconds.
    const { session } = toneWithLane('tone-trim', 3, 'trim', {}, 'gainDb', [
      { timeSec: 0, value: -24 },
      { timeSec: 2, value: 0 },
    ]);

    const buffer = await renderSession(session, { startSec: 0, endSec: 2.5 }, { tailSec: 0 });
    const data = buffer.getChannelData(0);
    const head = rms(data, Math.round(0.05 * SR), Math.round(0.25 * SR));
    const tail = rms(data, Math.round(2.05 * SR), Math.round(2.4 * SR));

    // The tone is 0.5 amplitude; at 0 dB trim that is −9 dBFS RMS.
    close(db(tail), db(0.5 / Math.SQRT2), 'the end of the lane is unity', 1.0);
    // The start should be ~23 dB down (the ramp has moved a little by 150 ms).
    const moved = db(tail) - db(head);
    assert(moved > 20 && moved < 26,
      `the lane swept about 24 dB — measured ${moved.toFixed(2)} dB`);
  });

  await check('the ramp is a ramp, not a step at the end', async () => {
    makeToneFile('tone-ramp', 440, 0.5, 3);
    const { session } = toneWithLane('tone-ramp', 3, 'trim', {}, 'gainDb', [
      { timeSec: 0, value: -24 },
      { timeSec: 2, value: 0 },
    ]);
    const buffer = await renderSession(session, { startSec: 0, endSec: 2.5 }, { tailSec: 0 });
    const data = buffer.getChannelData(0);

    // Halfway through the sweep the level must be halfway in decibels.
    const mid = db(rms(data, Math.round(0.95 * SR), Math.round(1.05 * SR)));
    const end = db(rms(data, Math.round(2.05 * SR), Math.round(2.4 * SR)));
    close(mid, end - 12, 'at the midpoint the lane is 12 dB down', 1.0);
  });

  await check('a filter lane takes the tone with it', async () => {
    // A 4 kHz tone through a lowpass that sweeps from wide open down to 400 Hz.
    makeToneFile('tone-lpf', 4000, 0.5, 3);
    const { session } = toneWithLane('tone-lpf', 3, 'eq8', {}, 'lpfHz', [
      { timeSec: 0, value: 20000 },
      { timeSec: 2, value: 400 },
    ]);

    const buffer = await renderSession(session, { startSec: 0, endSec: 2.5 }, { tailSec: 0 });
    const data = buffer.getChannelData(0);
    const open = rms(data, Math.round(0.05 * SR), Math.round(0.2 * SR));
    const shut = rms(data, Math.round(2.1 * SR), Math.round(2.4 * SR));

    close(db(open), db(0.5 / Math.SQRT2), 'wide open, the tone passes', 1.0);
    // A one-pole-per-stage biquad lowpass an octave-and-a-bit below the tone
    // takes a great deal of it away; 20 dB is a conservative floor.
    assert(db(open) - db(shut) > 20,
      `the sweep removed the tone — ${(db(open) - db(shut)).toFixed(1)} dB down`);
  });

  await check('a lane that sits still does not ramp across the flat stretch', async () => {
    // The subdivision skips blocks whose value has not changed, so a lane that
    // holds for a second and THEN rises has to pin its value at the end of the
    // hold — otherwise the ramp would interpolate across the whole hold and
    // the level would start climbing a second early.
    makeToneFile('tone-hold', 440, 0.5, 4);
    const { session } = toneWithLane('tone-hold', 4, 'trim', {}, 'gainDb', [
      { timeSec: 0, value: -24 },
      { timeSec: 1.5, value: -24 },
      { timeSec: 2.5, value: 0 },
    ]);
    const buffer = await renderSession(session, { startSec: 0, endSec: 3 }, { tailSec: 0 });
    const data = buffer.getChannelData(0);

    const early = db(rms(data, Math.round(0.2 * SR), Math.round(0.5 * SR)));
    const late = db(rms(data, Math.round(1.1 * SR), Math.round(1.4 * SR)));
    close(late, early, 'the hold really holds', 0.4);
    close(early, db(0.5 / Math.SQRT2) - 24, 'at the value it was drawn at', 1.0);

    const after = db(rms(data, Math.round(2.6 * SR), Math.round(2.9 * SR)));
    close(after, db(0.5 / Math.SQRT2), 'and it arrives at the top on time', 1.0);
  });

  await check('with no lane the same session renders flat', async () => {
    makeToneFile('tone-flat', 440, 0.5, 3);
    const { session } = toneWithLane('tone-flat', 3, 'trim', {}, 'gainDb', [
      { timeSec: 0, value: -24 },
      { timeSec: 2, value: 0 },
    ]);
    // Same session, lane removed — the control against which the sweep is read.
    const withoutLane: DawSession = {
      ...session,
      tracks: session.tracks.map((t) => ({ ...t, automation: [] })),
    };
    const buffer = await renderSession(withoutLane, { startSec: 0, endSec: 2.5 }, { tailSec: 0 });
    const data = buffer.getChannelData(0);
    const head = db(rms(data, Math.round(0.05 * SR), Math.round(0.25 * SR)));
    const tail = db(rms(data, Math.round(2.05 * SR), Math.round(2.4 * SR)));
    close(head, tail, 'nothing moves', 0.5);
    close(head, db(0.5 / Math.SQRT2), 'and it sits at the insert’s own value', 1.0);
  });

  await check('a lane on a parameter the device cannot ramp changes nothing', async () => {
    // `mix` is never offered by the menu, so this is the hand-edited session
    // case: it must be inert, not a crash and not a half-applied sweep.
    makeToneFile('tone-mix', 440, 0.5, 3);
    const { session } = toneWithLane('tone-mix', 3, 'delay', { mix: 0 }, 'mix', [
      { timeSec: 0, value: 0 },
      { timeSec: 2, value: 1 },
    ]);
    const buffer = await renderSession(session, { startSec: 0, endSec: 2.5 }, { tailSec: 0 });
    const data = buffer.getChannelData(0);
    const head = db(rms(data, Math.round(0.05 * SR), Math.round(0.25 * SR)));
    const tail = db(rms(data, Math.round(2.05 * SR), Math.round(2.4 * SR)));
    close(head, tail, 'the level does not drift', 0.5);
    close(head, db(0.5 / Math.SQRT2), 'the delay stays fully dry, as configured', 1.0);
  });

  await check('a lane surviving an insert swap does not reach the wrong device', async () => {
    makeToneFile('tone-swap', 440, 0.5, 3);
    const { session, insert } = toneWithLane('tone-swap', 3, 'trim', {}, 'gainDb', [
      { timeSec: 0, value: -24 },
      { timeSec: 2, value: 0 },
    ]);
    // The trim is replaced by an EQ, which has no `gainDb`.  The lane is now
    // pointing at nothing — and must simply not play.
    const swapped: DawSession = {
      ...session,
      tracks: session.tracks.map((t) => ({
        ...t,
        inserts: t.inserts.map((i) => (i.id === insert.id
          ? { ...i, pluginId: 'eq8', params: defaultParams('eq8') } : i)),
      })),
    };
    const buffer = await renderSession(swapped, { startSec: 0, endSec: 2.5 }, { tailSec: 0 });
    const data = buffer.getChannelData(0);
    const head = db(rms(data, Math.round(0.05 * SR), Math.round(0.25 * SR)));
    const tail = db(rms(data, Math.round(2.05 * SR), Math.round(2.4 * SR)));
    close(head, tail, 'nothing swept', 0.5);
  });

  // ── 4. The session must not fight the lane ─────────────────────────────

  await check('a running lane is not overwritten by the next session sync', () => {
    // The store changes constantly while the transport rolls, and every change
    // re-applies the session's insert parameters.  Without the guard, each one
    // would snap the automated knob back to whatever the session says.
    const ctx = new OfflineAudioContext(2, SR, SR);
    resetIds();
    let session = createSession('sync', SR);
    const track = createTrack('Ch', 'audio');
    session = addTrack(session, track);
    session = setInsert(session, track.id,
      { ...createInsert(0, 'trim', 'trim'), params: { gainDb: 0 } });
    const insert = findTrack(session, track.id)!.inserts[0]!;

    const engine = new MixerEngine(ctx as unknown as BaseAudioContext, ctx.destination as unknown as AudioNode, { meters: false });
    engine.sync(session);

    const automatable = engine.automatableParam(track.id, insert.id, 'gainDb');
    assert(automatable !== null, 'the engine can reach the parameter');
    if (!automatable) return;

    // Pretend the player has ramped it somewhere.
    automatable.param.value = 0.25;
    engine.markAutomated(track.id, pluginParamKey(insert.id, 'gainDb'));

    // Now the session says something else and syncs.
    const moved = setInsert(session, track.id, { ...insert, params: { gainDb: 12 } });
    engine.sync(moved);
    close(automatable.param.value, 0.25, 'the ramp survived the sync', 1e-6);

    // Releasing the lane hands the parameter back to the session.
    engine.clearAutomatedParam(track.id, pluginParamKey(insert.id, 'gainDb'));
    engine.sync(moved);
    close(automatable.param.value, Math.pow(10, 12 / 20), 'and the session value applies again', 1e-4);
    engine.dispose();
  });

  await check('an un-automated parameter is still written by the session', () => {
    const ctx = new OfflineAudioContext(2, SR, SR);
    resetIds();
    let session = createSession('sync2', SR);
    const track = createTrack('Ch', 'audio');
    session = addTrack(session, track);
    session = setInsert(session, track.id,
      { ...createInsert(0, 'trim', 'trim'), params: { gainDb: 0 } });
    const insert = findTrack(session, track.id)!.inserts[0]!;

    const engine = new MixerEngine(ctx as unknown as BaseAudioContext, ctx.destination as unknown as AudioNode, { meters: false });
    engine.sync(session);
    const automatable = engine.automatableParam(track.id, insert.id, 'gainDb')!;
    close(automatable.param.value, 1, 'unity to start');

    engine.sync(setInsert(session, track.id, { ...insert, params: { gainDb: -6 } }));
    close(automatable.param.value, Math.pow(10, -6 / 20), 'the knob follows the session', 1e-4);
    engine.dispose();
  });

  // ── Report ─────────────────────────────────────────────────────────────

  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  console.log('\n=== Plugin automation: menu · schedule · rendered proof ===');
  for (const r of results) {
    console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  }
  console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
  if (failed > 0) process.exit(1);
}

void run();
