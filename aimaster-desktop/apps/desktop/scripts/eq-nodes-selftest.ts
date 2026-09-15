/**
 * eq-nodes-selftest.ts — the parametric EQ, as points you can grab.
 *
 * A knob grid cannot be wrong about which parameter it writes: the knob IS the
 * parameter.  A curve editor can, and silently: the handle you drag says
 * "BAND 2" and writes `b3Hz`, or writes a frequency the device cannot hold and
 * runs away from the pointer, or draws a curve from one set of numbers while
 * the engine plays another.  None of that shows up as an error.
 *
 * So the checks are the ways that mapping rots:
 *
 *   · every parameter a node writes exists on that device      (the typo)
 *   · a drag lands the handle where the pointer is             (the runaway)
 *   · the device's own limits stop it                          (the overrun)
 *   · a band that can only cut cannot be dragged into a boost  (the fiction)
 *   · the drawn curve is built from the same numbers as the handles
 *   · a device with no draggable bands says so, rather than drawing nothing
 *
 * Run via:  pnpm --filter @aimaster/desktop test:eq-nodes
 */

import {
  eqNodes, nodeSpecs, nodeDragEdits, nodeQEdit, nodeAt, clampToRange,
  type ParamRange,
} from '../src/renderer/daw/model/eq-nodes.js';
import { biquadMagnitudeDb, freqToX, xToFreq } from '../src/renderer/daw/model/plugin-curves.js';
import { PLUGINS, defaultParams } from '../src/renderer/daw/engine/plugins.js';

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

const NODE_DEVICES = ['eq8', 'eq3', 'dyneq'] as const;

function rangesOf(pluginId: string): Record<string, ParamRange> {
  const descriptor = PLUGINS.find((p) => p.id === pluginId);
  assert(descriptor, `no device ${pluginId}`);
  const out: Record<string, ParamRange> = {};
  for (const def of descriptor!.params) out[def.id] = { min: def.min, max: def.max };
  return out;
}

// ── The typo ────────────────────────────────────────────────────────────────

check('every parameter a node writes is a parameter the device has', () => {
  // Every device, not the first that breaks: a handle wired to a name the
  // device does not have is silent — the drag moves the picture and nothing
  // else — so this must report all of them at once. It is how the old
  // exciter and de-esser drawings were caught reading `amountDb`.
  const wrong: string[] = [];
  for (const id of PLUGINS.map((p) => p.id)) {
    const known = new Set(PLUGINS.find((p) => p.id === id)!.params.map((p) => p.id));
    for (const node of eqNodes(id, defaultParams(id))) {
      for (const [axis, paramId] of [
        ['freq', node.freqParam], ['gain', node.gainParam], ['q', node.qParam],
      ] as const) {
        if (paramId !== null && !known.has(paramId)) {
          wrong.push(`${id}/${node.id}: ${axis} writes '${paramId}'`);
        }
      }
    }
  }
  assert(wrong.length === 0, `parameters that do not exist — ${wrong.join('; ')}`);
});

check('every band\'s range is one the device declares, so a drag always has a limit', () => {
  const missing: string[] = [];
  for (const id of NODE_DEVICES) {
    const ranges = rangesOf(id);
    for (const node of eqNodes(id, defaultParams(id))) {
      for (const paramId of [node.freqParam, node.gainParam, node.qParam]) {
        if (paramId !== null && !ranges[paramId]) missing.push(`${id}/${node.id}: ${paramId}`);
      }
    }
  }
  assert(missing.length === 0, `unbounded axes — ${missing.join('; ')}`);
});

check('a device with no grabbable bands returns none, so the window draws a picture instead', () => {
  // The exciter and the de-esser are in this list on purpose: they are filed
  // under `eq` and are not EQs, and the curve they used to be given read a
  // parameter neither has.
  for (const id of ['comp', 'limiter', 'reverb', 'delay', 'tilt', 'mseq', 'exciter', 'deesser']) {
    assert(eqNodes(id, defaultParams(id)).length === 0, `${id} claims draggable bands`);
  }
});

check('the parametric EQ offers every band the engine builds', () => {
  const nodes = eqNodes('eq8', defaultParams('eq8'));
  assert(nodes.length === 7, `7 bands (HP, shelf, 3 bells, shelf, LP), got ${nodes.length}`);
  const bells = nodes.filter((n) => n.type === 'peaking');
  assert(bells.length === 3, `3 bells, got ${bells.length}`);
  for (const bell of bells) {
    assert(bell.freqParam && bell.gainParam && bell.qParam,
      `${bell.id}: a parametric bell must move on all three axes`);
  }
});

// ── The runaway ─────────────────────────────────────────────────────────────

check('a drag puts the band where the pointer is', () => {
  const params = { ...defaultParams('eq8') };
  const node = eqNodes('eq8', params).find((n) => n.id === 'b2');
  assert(node, 'no band 2');
  const width = 420;
  // Drop the pointer at 3 kHz, +5 dB.
  const x = freqToX(3000) * width;
  const edits = nodeDragEdits(node!, xToFreq(x / width), 5, rangesOf('eq8'));
  const freq = edits.find((e) => e.paramId === 'b2Hz');
  const gain = edits.find((e) => e.paramId === 'b2Db');
  assert(freq && gain, 'a bell drag writes both axes');
  near(freq!.value, 3000, 30, 'frequency under the pointer');
  near(gain!.value, 5, 1e-9, 'gain under the pointer');
});

check('a cut has no gain to write, so a vertical drag does not invent one', () => {
  const node = eqNodes('eq8', defaultParams('eq8')).find((n) => n.id === 'hpf');
  assert(node, 'no HPF');
  const edits = nodeDragEdits(node!, 200, -12, rangesOf('eq8'));
  assert(edits.length === 1 && edits[0]!.paramId === 'hpfHz',
    `HPF drag wrote ${edits.map((e) => e.paramId).join(', ')}`);
});

check("a band the engine pins does not move sideways", () => {
  // eq3's shelves are hard-wired at 120 Hz and 8 kHz in the graph. A handle
  // that wrote a frequency there would move the picture and not the sound.
  for (const id of ['low', 'high']) {
    const node = eqNodes('eq3', defaultParams('eq3')).find((n) => n.id === id);
    assert(node, `no ${id}`);
    assert(node!.freqParam === null, `eq3/${id} claims a frequency the engine ignores`);
    const edits = nodeDragEdits(node!, 5000, 3, rangesOf('eq3'));
    assert(edits.length === 1, `eq3/${id} wrote ${edits.length} parameters, should be gain only`);
  }
});

// ── The overrun ─────────────────────────────────────────────────────────────

check("the device's own limits stop the handle", () => {
  const ranges = rangesOf('eq8');
  const node = eqNodes('eq8', defaultParams('eq8')).find((n) => n.id === 'b1');
  assert(node, 'no band 1');
  // Band 1 tops out at 2 kHz and ±18 dB; drag it to 19 kHz and +40.
  const edits = nodeDragEdits(node!, 19_000, 40, ranges);
  near(edits.find((e) => e.paramId === 'b1Hz')!.value, 2000, 1e-9, 'clamped to b1Hz max');
  near(edits.find((e) => e.paramId === 'b1Db')!.value, 18, 1e-9, 'clamped to b1Db max');
  const low = nodeDragEdits(node!, 5, -40, ranges);
  near(low.find((e) => e.paramId === 'b1Hz')!.value, 60, 1e-9, 'clamped to b1Hz min');
  near(low.find((e) => e.paramId === 'b1Db')!.value, -18, 1e-9, 'clamped to b1Db min');
});

check('an unrangeable value falls back to the low end rather than NaN', () => {
  near(clampToRange(Number.NaN, { min: -6, max: 6 }), -6, 1e-9, 'NaN → min');
  near(clampToRange(3, undefined), 3, 1e-9, 'no range declared → unchanged');
});

// ── The inversion ───────────────────────────────────────────────────────────

check('the dynamic EQ can only be dragged into a cut, because that is all it does', () => {
  const node = eqNodes('dyneq', defaultParams('dyneq')).find((n) => n.id === 'dyn');
  assert(node, 'no dynamic EQ node');
  const ranges = rangesOf('dyneq');
  // Its range is -18..0: it ducks a band, it never boosts one.
  const up = nodeDragEdits(node!, 800, +9, ranges).find((e) => e.paramId === 'rangeDb');
  near(up!.value, 0, 1e-9, 'dragging up stops at flat');
  const down = nodeDragEdits(node!, 800, -9, ranges).find((e) => e.paramId === 'rangeDb');
  near(down!.value, -9, 1e-9, 'dragging down cuts');
  // And the handle redrawn from that value is where the pointer left it.
  const after = eqNodes('dyneq', { ...defaultParams('dyneq'), rangeDb: down!.value })
    .find((n) => n.id === 'dyn');
  near(after!.gainDb, -9, 1e-9, 'the handle stays under the pointer');
});

// ── Picture and handles from the same numbers ───────────────────────────────

check('the drawn curve is built from the handle values, not a second copy', () => {
  const params = { ...defaultParams('eq8'), b2Hz: 2400, b2Db: -7, b2Q: 3.5 };
  const nodes = eqNodes('eq8', params);
  const specs = nodeSpecs(nodes);
  assert(specs.length === nodes.length, 'one spec per handle');
  nodes.forEach((node, i) => {
    const spec = specs[i]!;
    near(spec.freq, node.freq, 1e-9, `${node.id} freq`);
    near(spec.gain, node.gainDb, 1e-9, `${node.id} gain`);
    near(spec.q, node.q, 1e-9, `${node.id} q`);
  });
  // And the dip really is a dip at the frequency the handle claims.
  const bell = specs.find((s) => s.type === 'peaking' && s.gain < 0)!;
  near(biquadMagnitudeDb(bell, 2400), -7, 0.3, 'the curve dips by what the handle says');
});

check('the curve moves when the handle does — a change of band cannot draw the same picture', () => {
  const flat = nodeSpecs(eqNodes('eq8', defaultParams('eq8')));
  const boosted = nodeSpecs(eqNodes('eq8', { ...defaultParams('eq8'), b1Db: 6, b1Hz: 400 }));
  const at = (specs: typeof flat, hz: number): number =>
    specs.reduce((db, s) => db + biquadMagnitudeDb(s, hz), 0);
  assert(at(boosted, 400) - at(flat, 400) > 4, 'a +6 dB bell did not raise the curve at its own frequency');
});

// ── Width ───────────────────────────────────────────────────────────────────

check('the wheel widens and narrows, in proportion, inside the range', () => {
  const ranges = rangesOf('eq8');
  const node = eqNodes('eq8', { ...defaultParams('eq8'), b1Q: 2 }).find((n) => n.id === 'b1')!;
  const up = nodeQEdit(node, 1, ranges);
  const down = nodeQEdit(node, -1, ranges);
  assert(up && down, 'a bell has a width');
  assert(up!.value > 2 && down!.value < 2, `wheel did not move Q — ${down!.value} / ${up!.value}`);
  // Proportional, so one notch is the same width change at 0.3 as at 6.
  near(up!.value / 2, 2 / down!.value, 1e-9, 'a notch is a ratio, not a step');
  // And it stops at the device's limit rather than running past it.
  const wide = eqNodes('eq8', { ...defaultParams('eq8'), b1Q: 7.9 }).find((n) => n.id === 'b1')!;
  near(nodeQEdit(wide, 4, ranges)!.value, 8, 1e-9, 'clamped to b1Q max');
});

check('a band with a fixed width has no wheel', () => {
  const shelf = eqNodes('eq8', defaultParams('eq8')).find((n) => n.id === 'low')!;
  assert(nodeQEdit(shelf, 1, rangesOf('eq8')) === null, 'a fixed shelf reported a width edit');
});

// ── Hit testing ─────────────────────────────────────────────────────────────

check('a click grabs the nearest handle, and empty canvas grabs nothing', () => {
  const points = [{ id: 'a', x: 100, y: 50 }, { id: 'b', x: 130, y: 50 }];
  assert(nodeAt(points, 104, 52) === 'a', 'nearest');
  assert(nodeAt(points, 128, 48) === 'b', 'nearest, the other way');
  assert(nodeAt(points, 300, 200) === null, 'empty canvas');
});

// ─────────────────────────────────────────────────────────────────────────────

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log('\n=== EQ nodes ===');
console.log(`${NODE_DEVICES.length} devices are edited on the curve\n`);
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
if (failed > 0) process.exit(1);
