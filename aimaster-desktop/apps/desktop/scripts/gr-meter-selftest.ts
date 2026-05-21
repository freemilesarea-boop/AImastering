/**
 * gr-meter-selftest.ts — GR meter model (OZONE-MODULE-NEXT-3).
 * Run via:  pnpm --filter @aimaster/desktop test:gr-meter
 */

import { buildGrMeterModel, classifyGr, decayPeak, describeGr } from '../src/renderer/audio/modules/gr-meter-model.js';

interface T { name: string; pass: boolean; detail: string; }
const results: T[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }
function eq<T>(a: T, b: T, m: string): void { if (a !== b) throw new Error(`${m} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); }

check('unavailable when no realtime data', () => {
  const m = buildGrMeterModel({ grDb: 4, available: false });
  eq(m.state, 'unavailable', 'state');
  eq(m.source, 'unavailable', 'source');
  eq(m.currentGrDb, 0, 'current zeroed');
  eq(m.peakGrDb, 0, 'peak zeroed');
});

check('state classification thresholds', () => {
  eq(classifyGr(0.1, true), 'idle', 'idle');
  eq(classifyGr(1.5, true), 'active', 'active');
  eq(classifyGr(4, true), 'heavy', 'heavy');
  eq(classifyGr(8, true), 'clipping-risk', 'extreme');
  eq(classifyGr(5, false), 'unavailable', 'unavailable overrides');
});

check('negative GR clamps to 0', () => {
  const m = buildGrMeterModel({ grDb: -2, available: true });
  eq(m.currentGrDb, 0, 'clamped');
  eq(m.state, 'idle', 'idle');
});

check('peak ≥ current', () => {
  const m = buildGrMeterModel({ grDb: 2, available: true, peakGrDb: 5 });
  eq(m.peakGrDb, 5, 'peak kept');
  const m2 = buildGrMeterModel({ grDb: 6, available: true, peakGrDb: 3 });
  eq(m2.peakGrDb, 6, 'peak rises to current');
});

check('decayPeak holds then decays, never below current', () => {
  eq(decayPeak(6, 2, 0.5), 5.5, 'decays');
  eq(decayPeak(2.2, 3, 0.5), 3, 'snaps up to current');
});

check('describeGr', () => {
  eq(describeGr(buildGrMeterModel({ grDb: 2.3, available: true })), 'GR −2.3 dB', 'label');
  eq(describeGr(buildGrMeterModel({ grDb: 2.3, available: false })), 'GR —', 'unavailable label');
});

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log('\n=== GR meter model ===');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
if (failed > 0) process.exit(1);
