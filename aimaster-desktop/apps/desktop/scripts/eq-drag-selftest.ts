/**
 * eq-drag-selftest.ts — EQ drag model (OZONE-MODULE-NEXT-5).
 * Run via:  pnpm --filter @aimaster/desktop test:eq-drag
 */

import {
  freqToX, xToFreq, gainToY, yToGain, quantize, dragToValue, EQ_BAND_DRAG, type EqGeom,
} from '../src/renderer/audio/modules/eq-drag-model.js';

interface T { name: string; pass: boolean; detail: string; }
const results: T[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }
function near(a: number, b: number, eps: number, m: string): void { if (Math.abs(a - b) > eps) throw new Error(`${m} — ${a} vs ${b}`); }

const g: EqGeom = { width: 800, height: 240, minHz: 20, maxHz: 20000, dbRange: 12 };

check('freq ⇆ x round-trips (log)', () => {
  for (const f of [20, 100, 1000, 5000, 20000]) near(xToFreq(freqToX(f, g), g), f, f * 0.01, `f=${f}`);
});

check('gain ⇆ y round-trips; 0 dB at mid', () => {
  near(gainToY(0, g), g.height / 2, 1e-6, '0dB mid');
  for (const db of [-6, -3, 0, 3, 6]) near(yToGain(gainToY(db, g), g), db, 1e-6, `db=${db}`);
});

check('quantize clamps + snaps to step', () => {
  near(quantize(3.04, 0.1, -6, 6), 3.0, 1e-9, 'snap');
  near(quantize(99, 0.1, -6, 6), 6, 1e-9, 'clamp hi');
  near(quantize(-99, 0.1, -6, 6), -6, 1e-9, 'clamp lo');
  near(quantize(NaN, 0.1, -6, 6), -6, 1e-9, 'NaN → min');
});

check('lowCut drag: x → frequency (clamped 20–120)', () => {
  const atRight = dragToValue('lowCut', g.width, 0, g);  // far right → high freq → clamp 120
  assert(atRight.paramId === 'lowCutHz', 'paramId');
  assert(atRight.value === 120, `clamped ${atRight.value}`);
  const atLeft = dragToValue('lowCut', 0, 0, g);
  assert(atLeft.value >= 20 && atLeft.value <= 120, `left ${atLeft.value}`);
});

check('lowShelf/presence/air drag: y → gain (±6)', () => {
  for (const b of ['lowShelf', 'presence', 'air'] as const) {
    const top = dragToValue(b, 0, 0, g);          // y=0 → +max
    const bottom = dragToValue(b, 0, g.height, g); // y=h → −max
    assert(top.value === 6, `${b} top ${top.value}`);
    assert(bottom.value === -6, `${b} bottom ${bottom.value}`);
  }
});

check('output drag: y → gain (±12)', () => {
  assert(dragToValue('output', 0, 0, g).value === 12, 'output +12');
  assert(dragToValue('output', 0, g.height, g).value === -12, 'output -12');
});

check('drag spec ranges match expectations', () => {
  assert(EQ_BAND_DRAG.lowCut.axis === 'x', 'lowCut x');
  assert(EQ_BAND_DRAG.lowShelf.axis === 'y', 'lowShelf y');
  assert(EQ_BAND_DRAG.output.max === 12 && EQ_BAND_DRAG.output.min === -12, 'output range');
});

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log('\n=== EQ drag model ===');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
if (failed > 0) process.exit(1);
