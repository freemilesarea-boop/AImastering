/**
 * rack-macros-selftest — every macro knob has to move the sound.
 *
 * A rack macro is a knob over other knobs, and that indirection hides a
 * failure the UI cannot show: a target whose ENABLING parameter belongs to a
 * different macro, sitting at a `from` value that switches the device off.
 * The knob turns, the parameter moves, the render does not change.  Three of
 * the vocal rack's four macros were in that state and nothing noticed:
 *
 *   BODY owned the compressor's threshold (−6 → −22) while PRESENCE owned its
 *   ratio, whose `from` is 1 — so with PRESENCE down the ratio was pinned at
 *   unity and the threshold had nothing to act on.  Measured, BODY changed
 *   the render by 1.9 % at full against CLEAN's 27.8 %.  Cross-checked
 *   standalone: threshold −22 at ratio 1 moves a vocal 0.01 dB, at ratio 4 it
 *   moves 2.77 dB.
 *
 *   PRESENCE owned the dynamic EQ's FREQUENCY while CLEAN owned its range,
 *   whose default and `from` are both 0 — a switched-off band.  Stripped of
 *   the compressor it read 0.0 %: bit-identical.
 *
 *   PRESENCE's measured 39.6 % was almost entirely its +3 dB of makeup gain,
 *   which is a volume knob wearing a macro's name.
 *
 * The saturator's Drive contributes almost nothing to either rack on quiet
 * material, and that is not a defect: a level-preserving saturator colours
 * what is loud (see `tanhCurve`).  It is why BODY needed the compressor
 * rather than a wider Drive range — widening it from 10 to 24 dB measured
 * identically.
 *
 * So this file renders every macro of every rack at 0 and at 1 and asks two
 * things of each: that the waveform actually changes, and that the change is
 * not just level.  Run:  pnpm --filter @aimaster/desktop test:rack-macros
 */

import { OfflineAudioContext } from 'node-web-audio-api';
(globalThis as unknown as { OfflineAudioContext: unknown }).OfflineAudioContext = OfflineAudioContext;

import { analyzeBuffer, clearAudioCache } from '../src/renderer/daw/engine/audio-cache.js';
import { renderSession } from '../src/renderer/daw/engine/offline-render.js';
import {
  buildRack, rackBlueprints, rackNode, resolveRack, setRackMacro, type Rack,
} from '../src/renderer/daw/model/racks.js';
import { createNode, deviceOrder, layout } from '../src/renderer/daw/model/device-graph.js';
import {
  addFile, addTrack, createClip, createSession, createTrack, updateClips, updateTrack,
} from '../src/renderer/daw/model/session-ops.js';
import { resetIds } from '../src/renderer/daw/model/ids.js';
import { probeRendererLatency } from '../src/renderer/daw/engine/plugin-kit.js';
import { findPlugin } from '../src/renderer/daw/engine/plugins.js';
import type { DawSession } from '../src/renderer/daw/model/types.js';

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }

const SR = 48_000;
const SECONDS = 1.5;
const FROM = Math.floor(SR * 0.3);
const TO = Math.floor(SR * 1.3);
const db = (g: number): number => 20 * Math.log10(Math.max(1e-12, g));

/**
 * A sung phrase: harmonics out to about 9 kHz, breath, and a level that
 * swells and falls.
 *
 * Every part of that is load-bearing.  Seven harmonics of 220 Hz stop at
 * 1.5 kHz and made the AIR macro — a 4-7 kHz device — read 0.6 % for a reason
 * that had nothing to do with the macro.  A steady level gives a compressor
 * nothing to do but turn things down.
 */
function makeFile(rmsDb: number, kind: 'tonal' | 'percussive'): void {
  const n = Math.floor(SR * SECONDS);
  const ctx = new OfflineAudioContext(2, n, SR);
  const buffer = ctx.createBuffer(2, n, SR);
  let seed = 12_345;
  const rnd = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x7fffffff - 1;
  };
  const raw = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    const t = i / SR;
    if (kind === 'tonal') {
      const env = 0.35 + 0.65 * (0.5 - 0.5 * Math.cos(2 * Math.PI * 1.2 * t));
      const f0 = 220 * (1 + 0.004 * Math.sin(2 * Math.PI * 5 * t));
      let v = 0;
      for (let h = 1; h <= 40; h += 1) v += (1 / h ** 1.2) * Math.sin(2 * Math.PI * f0 * h * t);
      raw[i] = (v * 0.4 + rnd() * 0.06) * env;
    } else {
      const phase = (t % 0.25) / 0.25;
      raw[i] = (rnd() * 0.6 + Math.sin(2 * Math.PI * 80 * t) * 0.8) * Math.exp(-phase * 14);
    }
  }
  let sq = 0;
  for (let i = 0; i < n; i += 1) sq += raw[i]! * raw[i]!;
  const scale = (10 ** (rmsDb / 20)) / Math.sqrt(sq / n);
  for (let c = 0; c < 2; c += 1) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < n; i += 1) d[i] = raw[i]! * scale;
  }
  analyzeBuffer('src', buffer as unknown as AudioBuffer);
}

function session(rack: Rack): DawSession {
  resetIds();
  let s = createSession('Rack macros', SR);
  const track = createTrack('Src', 'audio');
  s = addTrack(s, track);
  s = addFile(s, {
    id: 'src', path: '/virtual/src.wav', name: 'src',
    durationSec: SECONDS, sampleRate: SR, channels: 2,
  });
  s = updateClips(s, track.id, () => [
    createClip('src', 'src', { startSec: 0, offsetSec: 0, durationSec: SECONDS }),
  ]);
  const graph = layout({
    nodes: [
      createNode({ kind: 'input', id: 'dev-input', label: 'INPUT' }),
      rackNode(rack, 1),
      createNode({ kind: 'output', id: 'dev-output', label: 'OUTPUT' }),
    ],
    edges: [],
  });
  const rackId = graph.nodes.find((x) => x.kind === 'rack')!.id;
  const wired = {
    ...graph,
    edges: [
      { id: 'e1', from: 'dev-input', to: rackId, gainDb: 0 },
      { id: 'e2', from: rackId, to: 'dev-output', gainDb: 0 },
    ],
  };
  return updateTrack(s, track.id, (t) => ({ ...t, deviceGraph: wired, racks: [rack] }));
}

interface Rendered { rms: number; data: Float32Array }
async function out(rack: Rack): Promise<Rendered> {
  const buf = await renderSession(
    session(rack), { startSec: 0, endSec: SECONDS }, { sampleRate: SR, tailSec: 0 });
  const data = buf.getChannelData(0) as unknown as Float32Array;
  let sq = 0;
  for (let i = FROM; i < TO; i += 1) sq += data[i]! * data[i]!;
  return { rms: db(Math.sqrt(sq / (TO - FROM))), data };
}

/** How much of the signal the macro rewrote, in dB relative to it. */
function changeOf(on: Rendered, off: Rendered): number {
  let d = 0;
  for (let i = FROM; i < TO; i += 1) { const x = on.data[i]! - off.data[i]!; d += x * x; }
  return db(Math.sqrt(d / (TO - FROM))) - off.rms;
}

/**
 * The same thing with the level taken out first.
 *
 * This is what separates a macro from a fader.  A macro that only turns the
 * track up rewrites a lot of samples — PRESENCE measured 39.6 % of the signal
 * while +2.90 dB of that was its makeup gain — and every one of those samples
 * goes away once the two renders are matched for level.  A transient designer
 * raises the peaks and so raises the RMS too, and its residual SURVIVES
 * matching, because the shape changed and not just the size.
 */
function shapeChangeOf(on: Rendered, off: Rendered): number {
  const g = 10 ** (-(on.rms - off.rms) / 20);
  let d = 0;
  for (let i = FROM; i < TO; i += 1) { const x = on.data[i]! * g - off.data[i]!; d += x * x; }
  return db(Math.sqrt(d / (TO - FROM))) - off.rms;
}

/** Every macro of every blueprint, measured once. */
interface Measured {
  rack: string; macro: string; changeDb: number; shapeDb: number; levelDb: number;
}
const measured: Measured[] = [];

async function main(): Promise<void> {
  await probeRendererLatency(SR);

  for (const blueprint of rackBlueprints()) {
    clearAudioCache();
    makeFile(-18, blueprint.id === 'loui-drum' ? 'percussive' : 'tonal');
    const rack = buildRack(blueprint.id);
    assert(rack, `${blueprint.id} builds`);
    const off = await out(rack!);
    for (const macro of rack!.macros) {
      const on = await out(setRackMacro(rack!, macro.id, 1));
      measured.push({
        rack: blueprint.id, macro: macro.name,
        changeDb: changeOf(on, off), shapeDb: shapeChangeOf(on, off),
        levelDb: on.rms - off.rms,
      });
    }
  }

  await check('every macro changes the sound', () => {
    // −32 dB is 2.5 % of the signal.  BODY read −34.6 dB (1.9 %) and
    // PRESENCE's remains read −222 dB — bit-identical — before the vocal
    // rack's ownership was sorted out.  AIR is the subtlest at −28.8 dB
    // (3.6 %), which is what a 40 % blend of a 4-7 kHz band comes to on a
    // vocal; it also brightens the spectral tilt by 1.5 dB.
    const weak = measured.filter((m) => m.changeDb < -32);
    assert(weak.length === 0, weak.map((m) =>
      `${m.rack}.${m.macro} ${m.changeDb.toFixed(1)} dB (${(10 ** (m.changeDb / 20) * 100).toFixed(1)} %)`).join(', '));
  });

  await check('no macro is a volume knob in disguise', () => {
    // Measured with the level matched out, so a knob that only turns the
    // track up collapses to nothing while a transient designer — which does
    // raise the level, by changing the envelope — survives.  The weakest
    // after matching is AIR at −29.0 dB; the old makeup-only PRESENCE would
    // have dropped from −8.1 dB to the floor.
    const faders = measured.filter((m) => m.shapeDb < -34);
    assert(faders.length === 0, faders.map((m) =>
      `${m.rack}.${m.macro} is ${m.levelDb.toFixed(2)} dB of level and `
      + `${m.shapeDb.toFixed(1)} dB of anything else`).join(', '));
  });

  await check('a macro target is a parameter its device really has', () => {
    // A typo in a blueprint is silent: `resolveRack` writes the value, the
    // device's `setParam` ignores an id it does not know, and the knob does
    // nothing for a reason no measurement can name.
    const bad: string[] = [];
    for (const blueprint of rackBlueprints()) {
      const rack = buildRack(blueprint.id)!;
      const nodes = new Map(deviceOrder(rack.graph).map((n) => [n.id, n.pluginId]));
      for (const macro of rack.macros) {
        for (const target of macro.targets) {
          const pluginId = nodes.get(target.nodeId);
          const device = pluginId ? findPlugin(pluginId) : undefined;
          if (!device || !device.params.some((p) => p.id === target.param)) {
            bad.push(`${blueprint.id}.${macro.name} → ${pluginId ?? '?'}.${target.param}`);
          }
        }
      }
    }
    assert(bad.length === 0, bad.join(', '));
  });

  await check('a target stays inside the range its parameter allows', () => {
    const bad: string[] = [];
    for (const blueprint of rackBlueprints()) {
      const rack = buildRack(blueprint.id)!;
      const nodes = new Map(deviceOrder(rack.graph).map((n) => [n.id, n.pluginId]));
      for (const macro of rack.macros) {
        for (const target of macro.targets) {
          const spec = findPlugin(nodes.get(target.nodeId) ?? '')
            ?.params.find((p) => p.id === target.param);
          if (!spec) continue;
          for (const [edge, value] of [['from', target.from], ['to', target.to]] as const) {
            if (value < spec.min || value > spec.max) {
              bad.push(`${blueprint.id}.${macro.name}.${target.param} ${edge}=${value} outside ${spec.min}..${spec.max}`);
            }
          }
        }
      }
    }
    assert(bad.length === 0, bad.join(', '));
  });

  await check('one parameter, one owner', () => {
    // `mapMacro` enforces this when the user does it by hand; a blueprint
    // bypasses that, and the second owner silently wins because its targets
    // are applied later.  That is how PRESENCE came to pin the ratio BODY's
    // threshold depended on.
    for (const blueprint of rackBlueprints()) {
      const rack = buildRack(blueprint.id)!;
      const owner = new Map<string, string>();
      for (const macro of rack.macros) {
        for (const target of macro.targets) {
          const key = `${target.nodeId}.${target.param}`;
          const already = owner.get(key);
          assert(already === undefined,
            `${blueprint.id}: ${target.param} is claimed by ${already} and ${macro.name}`);
          owner.set(key, macro.name);
        }
      }
    }
  });

  await check('a macro at rest only departs from the device default on purpose', () => {
    // The `from` end of a target IS the rack's resting value for that
    // parameter, so a `from` that is not the device's own default changes how
    // the rack sounds before anyone touches a knob.  Sometimes that is the
    // point and it has to be said out loud; a typo is the same edit with
    // nobody to answer for it.
    // A snapshot of what each rack chooses to rest at where that is not the
    // device's own default.  The note says what the value DOES, not why the
    // author picked it — the point of the list is that a new entry has to be
    // added by hand, so an accidental one is visible.
    const DELIBERATE: Readonly<Record<string, string>> = {
      // Mine: at ratio 1 the compressor is a pass-through, and three of this
      // rack's targets were measuring 0 because of it.
      'loui-vocal.BODY.ratio': '1.6 — lightly engaged, so the attack has something to sharpen',
      'loui-vocal.CLEAN.thresholdDb': '-60 — the denoiser rests below anything it would gate',
      'loui-vocal.BODY.thresholdDb': '-6 — the compressor rests above a vocal, so it is idle',
      'loui-vocal.PRESENCE.midHz': '900 — the bell rests below the presence band it sweeps to',
      'loui-vocal.PRESENCE.attackMs': '30 — slow, so PRESENCE is what makes it fast',
      'loui-drum.ATTACK.midHz': '900 — as above, on the drum bus',
      'loui-drum.GLUE.thresholdDb': '0 — the glue compressor rests at the top of its range',
      'loui-drum.GLUE.ratio': '1 — and at unity, so GLUE owns both ends of it',
    };
    const surprises: string[] = [];
    for (const blueprint of rackBlueprints()) {
      const rack = buildRack(blueprint.id)!;
      const nodes = new Map(deviceOrder(rack.graph).map((n) => [n.id, n.pluginId]));
      const resolved = resolveRack(rack);
      for (const macro of rack.macros) {
        for (const target of macro.targets) {
          // What the rack actually resolves to has to be the `from` value:
          // if it is not, a second macro owns the parameter and won.
          const got = resolved.get(target.nodeId)?.[target.param];
          assert(got !== undefined && Math.abs(got - target.from) < 1e-9,
            `${blueprint.id}.${macro.name}.${target.param} rests at ${got}, not ${target.from}`);
          const spec = findPlugin(nodes.get(target.nodeId) ?? '')
            ?.params.find((p) => p.id === target.param);
          if (!spec || Math.abs(spec.default - target.from) < 1e-9) continue;
          const key = `${blueprint.id}.${macro.name}.${target.param}`;
          if (!(key in DELIBERATE)) {
            surprises.push(`${key} rests at ${target.from}, default ${spec.default}`);
          }
        }
      }
    }
    assert(surprises.length === 0,
      `undeclared resting values: ${surprises.join(', ')}`);
  });

  for (const m of measured) {
    console.log(`      (${m.rack} ${m.macro}: ${(10 ** (m.changeDb / 20) * 100).toFixed(1)} % of the signal, `
      + `${(10 ** (m.shapeDb / 20) * 100).toFixed(1)} % with the level matched out, `
      + `level ${(m.levelDb >= 0 ? '+' : '') + m.levelDb.toFixed(2)} dB)`);
  }
  let pass = 0;
  for (const r of results) {
    if (r.pass) { pass += 1; console.log(`  PASS  ${r.name}`); }
    else console.log(`  FAIL  ${r.name}\n        ${r.detail}`);
  }
  console.log(`\nrack-macros-selftest: ${pass}/${results.length}`);
  if (pass !== results.length) process.exit(1);
}
void main();
