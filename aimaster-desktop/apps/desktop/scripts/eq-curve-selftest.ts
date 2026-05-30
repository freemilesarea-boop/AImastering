/**
 * eq-curve-selftest.ts — EQ curve model sanity (OZONE-MODULE-NEXT-2).
 * Verifies the RBJ-magnitude visualization tracks the real EQ direction.
 *
 * Run via:  pnpm --filter @aimaster/desktop test:eq-curve
 */

import { buildEqCurveModel, eqCurveDb, bandPointDb } from '../src/renderer/audio/modules/eq-curve-model.js';

interface T { name: string; pass: boolean; detail: string; }
const results: T[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }

const flat = { lowCutHz: 20, lowShelfDb: 0, presenceDb: 0, airDb: 0, outputGainDb: 0 };

check('flat EQ ≈ 0 dB across the band', () => {
  const m = buildEqCurveModel(flat);
  for (const f of [60, 200, 1000, 3000, 8000, 14000]) {
    assert(Math.abs(eqCurveDb(f, m)) < 0.6, `flat at ${f}Hz = ${eqCurveDb(f, m).toFixed(2)}`);
  }
});

check('bypass forces a flat 0 dB curve', () => {
  const m = buildEqCurveModel({ ...flat, lowShelfDb: 5, presenceDb: -4 }, true);
  assert(eqCurveDb(120, m) === 0 && eqCurveDb(3000, m) === 0, 'bypassed not flat');
});

check('low shelf boost lifts the lows', () => {
  const m = buildEqCurveModel({ ...flat, lowShelfDb: 4 });
  assert(eqCurveDb(50, m) > 2.5, `low boost @50Hz = ${eqCurveDb(50, m).toFixed(2)}`);
  assert(Math.abs(eqCurveDb(10000, m)) < 0.5, 'shelf should not move 10k');
});

check('presence cut dips ~3 kHz', () => {
  const m = buildEqCurveModel({ ...flat, presenceDb: -3 });
  assert(eqCurveDb(3000, m) < -2, `presence @3k = ${eqCurveDb(3000, m).toFixed(2)}`);
  assert(Math.abs(eqCurveDb(100, m)) < 0.5, 'presence should not move 100Hz much');
});

check('air boost lifts the top', () => {
  const m = buildEqCurveModel({ ...flat, airDb: 3 });
  assert(eqCurveDb(16000, m) > 1.5, `air @16k = ${eqCurveDb(16000, m).toFixed(2)}`);
});

check('high-pass attenuates below the corner', () => {
  const m = buildEqCurveModel({ ...flat, lowCutHz: 100 });
  assert(eqCurveDb(30, m) < -3, `HPF @30Hz = ${eqCurveDb(30, m).toFixed(2)}`);
  assert(eqCurveDb(1000, m) > -0.5, 'HPF should not touch 1k');
});

check('output gain offsets the whole curve', () => {
  const m = buildEqCurveModel({ ...flat, outputGainDb: 2 });
  assert(Math.abs(eqCurveDb(1000, m) - 2) < 0.3, `out offset = ${eqCurveDb(1000, m).toFixed(2)}`);
});

check('bandPointDb(output) = outputGainDb', () => {
  const m = buildEqCurveModel({ ...flat, outputGainDb: 1.5 });
  const out = m.bands.find((b) => b.id === 'output')!;
  assert(Math.abs(bandPointDb(out, m) - 1.5) < 1e-6, 'output point');
});

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log('\n=== EQ curve model ===');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
if (failed > 0) process.exit(1);
