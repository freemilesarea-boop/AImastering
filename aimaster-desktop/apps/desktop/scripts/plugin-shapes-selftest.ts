/**
 * plugin-shapes-selftest.ts — the pictures the non-EQ devices draw.
 *
 * A drawing is the easiest thing in an audio app to get quietly wrong, because
 * nothing fails when it does: the canvas still fills, the numbers still move,
 * and the picture is simply of a device nobody is listening to.  That is
 * exactly how the exciter and the de-esser spent their whole existence drawing
 * a flat line from a parameter neither of them has.
 *
 * So these checks are about agreement with the engine, not about pixels:
 *
 *   · the curve drawn is the array the WaveShaperNode is loaded with
 *   · it is read the way WaveShaperNode reads it
 *   · the gains sit where the graph puts them, not all in one place
 *   · a knob that changes the sound changes the picture
 *   · a device that only ducks cannot be drawn boosting
 *
 * Run via:  pnpm --filter @aimaster/desktop test:plugin-shapes
 */

import {
  shaperFor, detectorFor, shaperOutput, readCurve, detectorGainDb, expanderGainCurve,
} from '../src/renderer/daw/model/plugin-shapes.js';
import {
  bitCurve, clipCurve, gateGainCurve, tubeCurve,
} from '../src/renderer/daw/engine/plugins-extended.js';
import { tanhCurve, makeExpanderCurve } from '../src/renderer/daw/engine/plugin-kit.js';
import { defaultParams, PLUGINS } from '../src/renderer/daw/engine/plugins.js';

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
function sameArray(a: Float32Array, b: Float32Array, m: string): void {
  assert(a.length === b.length, `${m}: length ${a.length} vs ${b.length}`);
  for (let i = 0; i < a.length; i++) {
    if (Math.abs((a[i] ?? 0) - (b[i] ?? 0)) > 1e-9) {
      throw new Error(`${m}: differs at ${i} — ${a[i]} vs ${b[i]}`);
    }
  }
}

const SHAPERS = ['trim', 'saturation', 'tube', 'clipper', 'bitcrush'] as const;
const DETECTORS = ['gate', 'denoise'] as const;

// ── The picture is the engine's own array ───────────────────────────────────

check('the saturator draws the array its shaper is loaded with', () => {
  const spec = shaperFor('saturation', { ...defaultParams('saturation'), bias: 0.4 });
  assert(spec, 'no spec');
  sameArray(spec!.curves[0]!, tanhCurve(0.4), 'saturation curve');
});

check('the tube draws the array its shaper is loaded with', () => {
  const spec = shaperFor('tube', { ...defaultParams('tube'), drive: 0.7, bias: 0.3 });
  sameArray(spec!.curves[0]!, tubeCurve(0.7, 0.3), 'tube curve');
});

check('the bit crusher draws the array its shaper is loaded with', () => {
  const spec = shaperFor('bitcrush', { ...defaultParams('bitcrush'), bits: 5 });
  sameArray(spec!.curves[0]!, bitCurve(5), 'bit curve');
});

check('the clipper draws BOTH its stages, so the ceiling drawn is the real one', () => {
  const ceiling = Math.pow(10, -3 / 20);
  const spec = shaperFor('clipper', { ...defaultParams('clipper'), ceilingDb: -3, hardness: 0.2 });
  assert(spec!.curves.length === 2, `two stages, got ${spec!.curves.length}`);
  sameArray(spec!.curves[0]!, clipCurve(ceiling, 0.2), 'clipper shaper');
  sameArray(spec!.curves[1]!, clipCurve(ceiling, 1), 'clipper guard');
});

check('the gate draws the array its shaper is loaded with', () => {
  const spec = detectorFor('gate', { ...defaultParams('gate'), thresholdDb: -30, rangeDb: 25 });
  sameArray(spec!.curve, gateGainCurve(-30, 25), 'gate curve');
});

check("the denoiser's drawn expander matches plugin-kit's, ratio mapping included", () => {
  // The engine maps amount 0..1 to ratio 1..6; if the drawing used a different
  // mapping the picture would be of a device with a different ratio.
  const spec = detectorFor('denoise', { ...defaultParams('denoise'), thresholdDb: -50, amount: 0.6 });
  const ratio = 1 + 0.6 * 5;
  sameArray(spec!.curve, expanderGainCurve(-50, ratio), 'denoise curve');
  sameArray(expanderGainCurve(-50, ratio), makeExpanderCurve(-50, ratio), 'copy has not drifted from plugin-kit');
});

// ── Read the way Web Audio reads ────────────────────────────────────────────

check('a curve is read the way WaveShaperNode reads it', () => {
  const curve = new Float32Array([-1, 0, 1]);
  near(readCurve(curve, -1), -1, 1e-9, 'x=-1 is the first entry');
  near(readCurve(curve, 0), 0, 1e-9, 'x=0 is the middle');
  near(readCurve(curve, 1), 1, 1e-9, 'x=+1 is the last');
  near(readCurve(curve, 0.5), 0.5, 1e-9, 'interpolated between');
  near(readCurve(curve, 9), 1, 1e-9, 'clamped above');
  near(readCurve(curve, -9), -1, 1e-9, 'clamped below');
});

// ── The gains sit where the graph puts them ─────────────────────────────────

check("the saturator's compensation is inside its wet path, so mix uncovers the dry signal", () => {
  const spec = shaperFor('saturation', { driveDb: 18, bias: 0, mix: 0 })!;
  // Fully dry: whatever the drive and compensation are, nothing may change.
  near(shaperOutput(spec, 0.5), 0.5, 1e-6, 'mix 0 passes the input through');
  assert(spec.postGain === 1, 'the saturator has no gain after the blend');
  assert(spec.wetGain < 1, `18 dB of drive must be compensated — ${spec.wetGain}`);
});

check("the tube's output trim is AFTER the blend, so it moves the dry signal too", () => {
  const spec = shaperFor('tube', { drive: 0.3, bias: 0.15, toneHz: 8000, mix: 0, outDb: 6 })!;
  const expected = 0.5 * Math.pow(10, 6 / 20);
  near(shaperOutput(spec, 0.5), expected, 1e-6, 'fully dry still takes the output trim');
});

check('trim is a straight line whose slope is the knob', () => {
  const spec = shaperFor('trim', { gainDb: -6 })!;
  assert(spec.curves.length === 0, 'a gain is not a shaper');
  const g = Math.pow(10, -6 / 20);
  for (const x of [-0.8, -0.2, 0.3, 0.9]) near(shaperOutput(spec, x), x * g, 1e-6, `x=${x}`);
});

// ── A knob that changes the sound changes the picture ───────────────────────

check('drive bends the curve away from the diagonal', () => {
  const flat = shaperFor('saturation', { driveDb: 0, bias: 0, mix: 1 })!;
  const hot = shaperFor('saturation', { driveDb: 18, bias: 0, mix: 1 })!;
  const bend = (s: ReturnType<typeof shaperFor>): number =>
    Math.abs(shaperOutput(s!, 0.3) / 0.3 - shaperOutput(s!, 0.9) / 0.9);
  assert(bend(hot) > bend(flat) + 0.05,
    `18 dB of drive did not bend the curve — ${bend(flat).toFixed(3)} vs ${bend(hot).toFixed(3)}`);
});

check('bias makes the curve asymmetric — that is what even harmonics are', () => {
  const symmetric = shaperFor('saturation', { driveDb: 12, bias: 0, mix: 1 })!;
  const leaning = shaperFor('saturation', { driveDb: 12, bias: 0.8, mix: 1 })!;
  const asym = (s: ReturnType<typeof shaperFor>): number =>
    Math.abs(shaperOutput(s!, 0.6) + shaperOutput(s!, -0.6));
  near(asym(symmetric), 0, 1e-3, 'no bias is symmetric');
  assert(asym(leaning) > 0.02, `bias did not lean the curve — ${asym(leaning)}`);
});

check('the bit crusher has exactly the steps the bit depth has', () => {
  // Count PLATEAUS, not distinct sampled values: Web Audio interpolates
  // between curve entries, so every step edge also yields a handful of
  // in-between values, and counting those would be counting the ramp.
  for (const bits of [3, 4, 6]) {
    const spec = shaperFor('bitcrush', { bits, mix: 100 })!;
    const seen = new Map<number, number>();
    const N = 20_000;
    for (let i = 0; i <= N; i++) {
      const key = Math.round(shaperOutput(spec, (i / N) * 2 - 1) * 1e6);
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    // A plateau is a value the curve rests on; a ramp value appears once or
    // twice in twenty thousand samples.
    const plateaus = [...seen.values()].filter((n) => n > 20).length;
    // 2^bits/2 levels each side of zero, plus zero itself.
    near(plateaus, Math.pow(2, bits) / 2 * 2 + 1, 0, `${bits} bit`);
  }
});

check('the crusher stops crushing when the blend is dry', () => {
  const wet = shaperFor('bitcrush', { bits: 3, mix: 100 })!;
  const dry = shaperFor('bitcrush', { bits: 3, mix: 0 })!;
  assert(Math.abs(shaperOutput(wet, 0.31) - 0.31) > 0.02, 'wet must quantise');
  near(shaperOutput(dry, 0.31), 0.31, 1e-6, 'dry must not');
});

check('the clipper cannot be drawn going above its ceiling', () => {
  for (const ceilingDb of [-1, -6, -12]) {
    const spec = shaperFor('clipper', { driveDb: 24, ceilingDb, hardness: 0.5 })!;
    const ceiling = Math.pow(10, ceilingDb / 20);
    for (const x of [0.2, 0.6, 1]) {
      assert(Math.abs(shaperOutput(spec, x)) <= ceiling + 1e-6,
        `${ceilingDb} dB ceiling exceeded at x=${x}: ${shaperOutput(spec, x)}`);
    }
  }
});

// ── A device that only ducks cannot be drawn boosting ───────────────────────

check('a gate never gives back more than it was given', () => {
  const spec = detectorFor('gate', { thresholdDb: -40, rangeDb: 40 })!;
  for (const db of [-70, -50, -40, -30, -10, -1]) {
    assert(detectorGainDb(spec, db) <= 0.01, `gate boosted at ${db} dB: ${detectorGainDb(spec, db)}`);
  }
});

check('the gate is open above the threshold and closed below it', () => {
  const spec = detectorFor('gate', { thresholdDb: -30, rangeDb: 40 })!;
  assert(detectorGainDb(spec, -6) > -0.5, `should be open at -6 dB: ${detectorGainDb(spec, -6)}`);
  assert(detectorGainDb(spec, -60) < -20, `should be shut at -60 dB: ${detectorGainDb(spec, -60)}`);
  // And the threshold is where it turns, not somewhere else.
  assert(detectorGainDb(spec, -25) > detectorGainDb(spec, -40), 'the curve runs the wrong way');
});

check('raising the range digs the closed gate deeper, and zero range is no gate at all', () => {
  const shallow = detectorFor('gate', { thresholdDb: -30, rangeDb: 6 })!;
  const deep = detectorFor('gate', { thresholdDb: -30, rangeDb: 50 })!;
  assert(detectorGainDb(deep, -70) < detectorGainDb(shallow, -70) - 10,
    'range did not deepen the gate');
  const off = detectorFor('gate', { thresholdDb: -30, rangeDb: 0 })!;
  near(detectorGainDb(off, -70), 0, 0.01, 'zero range passes everything');
});

// ── Coverage ────────────────────────────────────────────────────────────────

check('every shaping device has a spec, and nothing else claims one', () => {
  for (const id of SHAPERS) assert(shaperFor(id, defaultParams(id)), `${id} has no shaper spec`);
  for (const id of DETECTORS) assert(detectorFor(id, defaultParams(id)), `${id} has no detector spec`);
  for (const p of PLUGINS) {
    const isShaper = (SHAPERS as readonly string[]).includes(p.id);
    const isDetector = (DETECTORS as readonly string[]).includes(p.id);
    if (!isShaper) assert(!shaperFor(p.id, defaultParams(p.id)), `${p.id} claims a transfer curve`);
    if (!isDetector) assert(!detectorFor(p.id, defaultParams(p.id)), `${p.id} claims a detector curve`);
  }
});

check('every caption says something, at the defaults and at the extremes', () => {
  for (const id of SHAPERS) {
    for (const params of [defaultParams(id), {}]) {
      const spec = shaperFor(id, params)!;
      assert(spec.caption.trim().length > 0, `${id}: empty caption`);
      assert(!spec.caption.includes('NaN'), `${id}: NaN in caption — ${spec.caption}`);
    }
  }
  for (const id of DETECTORS) {
    const spec = detectorFor(id, defaultParams(id))!;
    assert(spec.caption.trim().length > 0, `${id}: empty caption`);
    assert(!spec.caption.includes('NaN'), `${id}: NaN in caption — ${spec.caption}`);
  }
});

check('a device with no parameters set draws its defaults rather than NaN', () => {
  for (const id of SHAPERS) {
    const spec = shaperFor(id, {})!;
    for (const x of [-1, -0.4, 0, 0.4, 1]) {
      assert(Number.isFinite(shaperOutput(spec, x)), `${id}: not finite at x=${x}`);
    }
  }
  for (const id of DETECTORS) {
    const spec = detectorFor(id, {})!;
    for (const db of [-80, -40, -6]) {
      assert(Number.isFinite(detectorGainDb(spec, db)), `${id}: not finite at ${db} dB`);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log('\n=== Plugin shapes ===');
console.log(`${SHAPERS.length} transfer curves, ${DETECTORS.length} detector curves\n`);
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
if (failed > 0) process.exit(1);
