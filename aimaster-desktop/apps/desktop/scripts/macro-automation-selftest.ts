/**
 * macro-automation-selftest — a lane on a Smart Control knob.
 *
 * A macro is a pure function from one number to every parameter of the rack,
 * so automating it is not "ramp a parameter", it is "recompute the rack
 * continuously".  Two claims have to hold, and both are measured here rather
 * than argued:
 *
 *   1. The lane REACHES THE AUDIO, in the offline render as well as live.
 *      A macro driven by a timer would work while you monitored and vanish
 *      from the bounce, which is the failure this engine is built to avoid.
 *
 *   2. A lane parked at a value sounds like the KNOB at that value.  This is
 *      the one that catches a half-wired macro: ramping four of a macro's
 *      seven targets moves the audio, passes claim 1, and is still wrong.
 *
 * And where a target genuinely cannot follow — a shaper curve is rebuilt,
 * not ramped — the coverage is stated rather than silently approximated.
 *
 * Run: pnpm --filter @aimaster/desktop test:macro-automation
 */

import { OfflineAudioContext } from 'node-web-audio-api';

(globalThis as unknown as { OfflineAudioContext: unknown }).OfflineAudioContext = OfflineAudioContext;

import {
  addFile, addTrack, createClip, createSession, createTrack, findTrack,
  updateClips, updateTrack,
} from '../src/renderer/daw/model/session-ops.js';
import { resetIds } from '../src/renderer/daw/model/ids.js';
import { analyzeBuffer } from '../src/renderer/daw/engine/audio-cache.js';
import { renderSession } from '../src/renderer/daw/engine/offline-render.js';
import { createLane } from '../src/renderer/daw/model/automation.js';
import {
  EMPTY_RACK, MACROS, RACK_MODULES, setMacro, setOverride,
  type MacroId, type MacroRack,
} from '../src/renderer/daw/model/macros.js';
import {
  automatableMacros, describeCoverage, findCoverage, macroCoverage,
  unautomatableMacros,
} from '../src/renderer/daw/model/macro-automation.js';
import {
  availableTargets, describeTarget, isPlayable, laneRange, staticValue, setStaticValue,
} from '../src/renderer/daw/edit/automation-lanes.js';
import { findPlugin } from '../src/renderer/daw/engine/plugins.js';
import type { AutomationPoint, DawSession } from '../src/renderer/daw/model/types.js';

const SR = 44100;
const results: { name: string; pass: boolean }[] = [];

async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); results.push({ name, pass: true }); console.log(`[PASS] ${name}`); }
  catch (err) {
    results.push({ name, pass: false });
    console.log(`[FAIL] ${name} — ${err instanceof Error ? err.message : String(err)}`);
  }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function eq(a: unknown, b: unknown, msg: string): void {
  if (a !== b) throw new Error(`${msg} — got ${String(a)}, want ${String(b)}`);
}

/** Deterministic wideband noise: every module in the rack has something to act on. */
function source(id: string, seconds: number): void {
  const ctx = new OfflineAudioContext(2, Math.floor(SR * seconds), SR);
  const buffer = ctx.createBuffer(2, Math.floor(SR * seconds), SR);
  let seed = 12345;
  for (let c = 0; c < 2; c++) {
    const data = buffer.getChannelData(c);
    // Different seed per channel, or width and mid/side have nothing to move.
    seed = 12345 + c * 7919;
    for (let i = 0; i < data.length; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      data[i] = ((seed / 0x7fffffff) * 2 - 1) * 0.3;
    }
  }
  analyzeBuffer(id, buffer as unknown as AudioBuffer);
}

const SECONDS = 2.5;

/** One noise track with the rack on, and optionally a macro lane. */
function sessionWith(
  macroId: MacroId | null, points: AutomationPoint[], rack: Partial<MacroRack> = {},
): DawSession {
  resetIds();
  let session = createSession('macro', SR);
  const track = createTrack('Ch', 'audio');
  session = addTrack(session, track);
  source('src', SECONDS + 0.5);
  session = addFile(session, {
    id: 'src', path: '/virtual/src.wav', name: 'src',
    durationSec: SECONDS + 0.5, sampleRate: SR, channels: 2,
  });
  session = updateClips(session, track.id, () => [createClip('src', 'src', {
    startSec: 0, offsetSec: 0, durationSec: SECONDS + 0.5,
  })]);
  session = updateTrack(session, track.id, (t) => ({
    ...t, macros: { ...EMPTY_RACK, enabled: true, ...rack },
  }));
  if (!macroId) return session;
  const lane = createLane({ kind: 'macro', macroId }, points[0]?.value ?? 0);
  return updateTrack(session, track.id, (t) => ({
    ...t, automation: [{ ...lane, mode: 'read', points }],
  }));
}

/** The same rack with the macro parked at a value, and no lane at all. */
function parkedAt(macroId: MacroId, value: number): DawSession {
  const session = sessionWith(null, [], {});
  const track = session.tracks.find((t) => t.kind === 'audio')!;
  return updateTrack(session, track.id, (t) => ({
    ...t, macros: setMacro(t.macros, macroId, value),
  }));
}

async function render(session: DawSession): Promise<AudioBuffer> {
  return renderSession(session, { startSec: 0, endSec: SECONDS }, { tailSec: 0 });
}

function worstDiff(a: AudioBuffer, b: AudioBuffer, fromSec = 0, toSec = SECONDS): number {
  let worst = 0;
  for (let c = 0; c < a.numberOfChannels; c++) {
    const x = a.getChannelData(c);
    const y = b.getChannelData(c);
    const from = Math.floor(fromSec * SR);
    const to = Math.min(x.length, Math.floor(toSec * SR));
    for (let i = from; i < to; i++) worst = Math.max(worst, Math.abs((y[i] ?? 0) - (x[i] ?? 0)));
  }
  return worst;
}

function peak(buffer: AudioBuffer): number {
  let out = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i++) out = Math.max(out, Math.abs(d[i] ?? 0));
  }
  return out;
}

const NEUTRAL: MacroRack = { ...EMPTY_RACK, enabled: true };

async function run(): Promise<void> {
  // ── Coverage ────────────────────────────────────────────────────────────

  await check('the coverage table is exactly what the devices can ramp', () => {
    // Pinned so a device losing an automatable parameter shows up HERE, as a
    // macro that quietly stopped following, rather than as a mix that
    // changed for no reason anyone can name.
    const table = MACROS.map((m) => {
      const c = macroCoverage(m, NEUTRAL);
      return `${m.id}:${c.moving.length}/${m.targets.length}`;
    }).join(' ');
    eq(table,
      'warmth:5/5 clarity:5/5 punch:6/7 air:4/4 width:2/2 depth:3/4 loudness:2/4',
      'coverage');
  });

  await check('what cannot follow is a rebuild, not an oversight', () => {
    // Every fixed target must be one the device genuinely cannot ramp — if a
    // parameter shows up here that IS a single AudioParam, it was forgotten.
    for (const macro of MACROS) {
      for (const fixed of macroCoverage(macro, NEUTRAL).fixed) {
        const module = RACK_MODULES.find((m) => m.id === fixed.module)!;
        const device = findPlugin(module.pluginId)!;
        const rampable = [
          ...(device.automatableParams ?? []),
          ...(device.drivenParams ?? []),
        ];
        assert(!rampable.includes(fixed.param),
          `${macro.id}: ${fixed.module}.${fixed.param} is rampable but listed as fixed`);
      }
    }
  });

  await check('a macro that can move nothing is not offered at all', () => {
    // LOUDNESS is a ceiling that rebuilds a transfer curve and a release that
    // is two biquads — but it also moves the compressor, so it IS offered.
    // The property that matters is the rule, not which macro it lands on.
    const offered = new Set(automatableMacros(NEUTRAL).map((c) => c.macro.id));
    for (const c of unautomatableMacros(NEUTRAL)) {
      assert(!offered.has(c.macro.id), `${c.macro.id} is both offered and not`);
      assert(c.moving.length === 0, 'and it really moves nothing');
    }
    for (const c of automatableMacros(NEUTRAL)) {
      assert(c.moving.length > 0, `${c.macro.id} is offered and moves something`);
    }
  });

  await check('a manually overridden parameter is reported as fixed, not fought', () => {
    // An override wins over the macro, so a lane must not pretend to move it.
    const pinned = setOverride(NEUTRAL, 'eq', 'highDb', 4);
    const before = macroCoverage(MACROS.find((m) => m.id === 'air')!, NEUTRAL);
    const after = macroCoverage(MACROS.find((m) => m.id === 'air')!, pinned);
    assert(before.moving.some((t) => t.module === 'eq' && t.param === 'highDb'),
      'AIR moves the high shelf normally');
    assert(!after.moving.some((t) => t.module === 'eq' && t.param === 'highDb'),
      'and stops once it is pinned');
    assert(after.fixed.some((f) => f.reason.includes('수동')), 'saying why');
  });

  await check('a partly-followed macro names the parts that do not follow', () => {
    const punch = findCoverage(NEUTRAL, 'punch')!;
    assert(!punch.complete, 'PUNCH is not complete');
    const text = describeCoverage(punch);
    assert(text.includes('Transient') && text.includes('Attack'),
      `the module and the knob are named — ${text}`);
    assert(text.includes('제외'), `and marked as excluded — ${text}`);
    const air = findCoverage(NEUTRAL, 'air')!;
    assert(air.complete, 'AIR is complete');
    eq(describeCoverage(air), air.macro.label, 'so it is just the label');
  });

  // ── The lane, in the model ──────────────────────────────────────────────

  await check('macro lanes appear in the menu only while the rack is on', () => {
    const on = sessionWith(null, [], {});
    const track = on.tracks.find((t) => t.kind === 'audio')!;
    const withRack = availableTargets(track).filter((t) => t.kind === 'macro');
    assert(withRack.length > 0, 'offered with the rack on');

    const offTrack = { ...track, macros: { ...track.macros, enabled: false } };
    eq(availableTargets(offTrack).filter((t) => t.kind === 'macro').length, 0,
      'and absent with it off — the rack is not in the graph');
    eq(isPlayable({ kind: 'macro', macroId: 'air' }, offTrack), false, 'nor playable');
    assert(isPlayable({ kind: 'macro', macroId: 'air' }, track), 'playable with it on');
  });

  await check('a macro lane reads and writes the KNOB, not the parameters', () => {
    const session = sessionWith(null, [], {});
    const track = session.tracks.find((t) => t.kind === 'audio')!;
    const target = { kind: 'macro' as const, macroId: 'air' };
    eq(staticValue(track, target), 0, 'starts where the knob is');

    const moved = setStaticValue(session, track.id, target, 0.75);
    const after = findTrack(moved, track.id)!;
    eq(after.macros.values['air'], 0.75, 'the knob moved');
    eq(staticValue(after, target), 0.75, 'and reads back');
    // The rack is materialised from the knob, so nothing else had to be written.
    eq(Object.keys(after.macros.overrides).length, 0, 'without pinning anything');
  });

  await check('a bipolar macro gets a bipolar lane', () => {
    const session = sessionWith(null, [], {});
    const track = session.tracks.find((t) => t.kind === 'audio')!;
    eq(laneRange(track, { kind: 'macro', macroId: 'width' }).min, -1, 'WIDTH narrows too');
    eq(laneRange(track, { kind: 'macro', macroId: 'air' }).min, 0, 'AIR only adds');
    eq(laneRange(track, { kind: 'macro', macroId: 'air' }).max, 1, 'to full');
  });

  await check('the lane is named for the knob, and says what will not follow', () => {
    const session = sessionWith(null, [], {});
    const track = session.tracks.find((t) => t.kind === 'audio')!;
    const text = describeTarget(track, { kind: 'macro', macroId: 'punch' });
    assert(text.includes('매크로'), `it is a macro lane — ${text}`);
    assert(text.includes('제외'), `and the gap is stated — ${text}`);
  });

  // ── The lane, in the audio ──────────────────────────────────────────────

  await check('every offered macro lane moves the rendered audio', async () => {
    for (const coverage of automatableMacros(NEUTRAL)) {
      const id = coverage.macro.id;
      const low = coverage.macro.bipolar ? -1 : 0;
      const flat = await render(sessionWith(id, [{ timeSec: 0, value: low }]));
      const swept = await render(sessionWith(id, [
        { timeSec: 0, value: low }, { timeSec: SECONDS - 0.1, value: 1 },
      ]));
      const moved = worstDiff(flat, swept);
      assert(moved > 1e-3, `${id}: a swept lane changes the render — ${moved.toExponential(2)}`);
      // And it grows: the end of a rising lane must differ more than its start.
      const early = worstDiff(flat, swept, 0, 0.3);
      const late = worstDiff(flat, swept, SECONDS - 0.5, SECONDS);
      assert(late > early, `${id}: the move follows the lane — ${early.toExponential(2)} → ${late.toExponential(2)}`);
    }
  });

  await check('a lane parked at a value sounds like the knob at that value', async () => {
    // The claim that catches a half-wired macro.  Ramping some of a macro's
    // targets moves the audio and still is not the knob.
    //
    // Only the macros whose every target follows can be held to this: where
    // a shaper curve cannot be ramped, the lane is honestly a partial move
    // and says so.
    for (const coverage of automatableMacros(NEUTRAL)) {
      if (!coverage.complete) continue;
      const id = coverage.macro.id;
      const value = coverage.macro.bipolar ? -0.7 : 0.7;
      const laned = await render(sessionWith(id, [{ timeSec: 0, value }]));
      const parked = await render(parkedAt(id, value));
      const difference = worstDiff(parked, laned, 0.2, SECONDS);
      const level = peak(parked);
      assert(level > 0.05, `${id}: the parked render is audible — ${level.toFixed(4)}`);
      assert(difference < 1e-3,
        `${id}: the lane equals the knob — ${difference.toExponential(2)} against peak ${level.toFixed(3)}`);
    }
  });

  await check('a partial macro moves the parts it can and leaves the rest put', async () => {
    // PUNCH cannot ramp the transient shaper.  What it CAN move must still
    // land exactly, so the difference from the parked knob is confined to
    // that one target rather than smeared across the whole macro.
    const parked = await render(parkedAt('punch', 0.8));
    const laned = await render(sessionWith('punch', [{ timeSec: 0, value: 0.8 }]));
    const difference = worstDiff(parked, laned, 0.2, SECONDS);
    assert(difference > 0, 'they are not identical — the transient stays put');
    // Bounded: a single un-ramped target, not a macro that mostly missed.
    assert(difference < peak(parked) * 0.5,
      `and the rest of the macro did land — ${difference.toExponential(2)} vs peak ${peak(parked).toFixed(3)}`);
  });

  await check('a lane on a macro whose rack is off does nothing, and does not throw', async () => {
    const session = sessionWith('air', [
      { timeSec: 0, value: 0 }, { timeSec: 2, value: 1 },
    ], { enabled: false });
    const track = session.tracks.find((t) => t.kind === 'audio')!;
    const plain = updateTrack(session, track.id, (t) => ({ ...t, automation: [] }));
    const difference = worstDiff(await render(plain), await render(session));
    eq(difference, 0, 'the rack is not in the graph, so the lane has nothing to move');
  });

  await check('the coupled compressor knobs move together, not apart', async () => {
    // The reason `drives` exists: threshold and its makeup compensation are
    // two AudioParams from one number.  Ramping the threshold alone would
    // leave the compensation behind and the macro would change the LEVEL as
    // well as the dynamics — which a parked-vs-laned comparison catches.
    const value = 0.9;
    const parked = await render(parkedAt('loudness', value));
    const laned = await render(sessionWith('loudness', [{ timeSec: 0, value }]));
    // LOUDNESS is partial (the limiter cannot ramp), but its compressor half
    // must land exactly — a broken coupling shows up as a level offset.
    const rmsOf = (b: AudioBuffer): number => {
      const d = b.getChannelData(0);
      let sum = 0;
      const from = Math.floor(0.3 * SR);
      for (let i = from; i < d.length; i++) sum += (d[i] ?? 0) ** 2;
      return Math.sqrt(sum / (d.length - from));
    };
    const ratio = rmsOf(laned) / Math.max(1e-9, rmsOf(parked));
    assert(ratio > 0.7 && ratio < 1.4,
      `no level offset from a half-moved compressor — ratio ${ratio.toFixed(3)}`);
  });

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} passed${passed === results.length ? '' : `, ${results.length - passed} FAILED`}`);
  if (passed !== results.length) process.exit(1);
}

void run();
