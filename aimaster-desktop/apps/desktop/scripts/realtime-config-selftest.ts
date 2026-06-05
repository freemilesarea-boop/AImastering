/**
 * realtime-config-selftest.ts — config mapping coverage for the realtime
 * mastering chain.
 *
 * Verifies that UI parameter state survives the journey to the chain config
 * payload with units preserved (the JS-boundary mapping used by live tweak).
 *
 * NOTE: the old `sanitiseConfig` clamp checks and `deriveRealtimeUiStatus`
 * status checks were dropped when the standalone realtime *graph* module
 * (`realtime-mastering-graph.ts`) and `realtime-ui-status.ts` were removed in
 * the ProductPage-orphan cleanup — value clamping now lives in the Rust chain.
 *
 * Run via:
 *   pnpm --filter @aimaster/desktop test:realtime-config
 */

import { stateToChainConfig } from '../src/renderer/audio/realtime-mastering-chain.js';
import { defaultAllModulesState } from '../src/renderer/audio/parameters/parameter-state.js';
import { ALL_MODULE_PARAMETER_DEFS } from '../src/renderer/audio/parameters/module-parameter-definitions.js';

interface T { name: string; pass: boolean; detail: string; }
const results: T[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function near(a: number, b: number, eps: number, msg: string): void {
  if (Math.abs(a - b) > eps) throw new Error(`${msg} — got ${a}, expected ≈ ${b}`);
}

// 1. stateToChainConfig maps every module field 1:1 (UI units preserved).
check('stateToChainConfig maps EQ/Dynamics/Imager/Limiter values', () => {
  const s = defaultAllModulesState(ALL_MODULE_PARAMETER_DEFS);
  s.eq.parameters['lowCutHz'] = 40;
  s.eq.parameters['presenceDb'] = 3.5;
  s.eq.parameters['airDb'] = -2.5;
  s.eq.parameters['outputGainDb'] = 1.5;
  s.dynamics.parameters['thresholdDb'] = -20;
  s.dynamics.parameters['ratio'] = 4;
  s.dynamics.parameters['mixPct'] = 80;
  s.imager.parameters['widthPct'] = 130;
  s.imager.parameters['lowMonoHz'] = 150;
  s.limiter.parameters['ceilingDbtp'] = -0.8;
  const c = stateToChainConfig(s);
  near(c.eqLowCutHz, 40, 1e-9, 'lowCutHz');
  near(c.eqPresenceDb, 3.5, 1e-9, 'presenceDb');
  near(c.eqAirDb, -2.5, 1e-9, 'airDb');
  near(c.outputGainDb, 1.5, 1e-9, 'outputGainDb');
  near(c.dynThresholdDb, -20, 1e-9, 'thresholdDb');
  near(c.dynRatio, 4, 1e-9, 'ratio');
  near(c.dynMixPct, 80, 1e-9, 'mixPct');
  near(c.imgWidthPct, 130, 1e-9, 'widthPct (percent, not ratio)');
  near(c.imgLowMonoHz, 150, 1e-9, 'lowMonoHz');
  near(c.limCeilingDbtp, -0.8, 1e-9, 'ceilingDbtp');
});

// 2. bypass flags flow through.
check('stateToChainConfig carries bypass flags', () => {
  const s = defaultAllModulesState(ALL_MODULE_PARAMETER_DEFS);
  s.eq.bypass = true; s.imager.bypass = true;
  const c = stateToChainConfig(s);
  assert(c.eqBypass === true, 'eqBypass');
  assert(c.imgBypass === true, 'imgBypass');
  assert(c.dynBypass === false, 'dynBypass default false');
});

// 3. width is percent (100 = unity), NOT a 0..2 ratio.
check('imager width default is 100 (percent)', () => {
  const s = defaultAllModulesState(ALL_MODULE_PARAMETER_DEFS);
  const c = stateToChainConfig(s);
  near(c.imgWidthPct, 100, 1e-9, 'default width 100%');
});

// 4. The config payload is JSON-serialisable (worklet postMessage).
check('config payload round-trips through JSON (postMessage-safe)', () => {
  const s = defaultAllModulesState(ALL_MODULE_PARAMETER_DEFS);
  s.imager.parameters['widthPct'] = 130;
  s.eq.parameters['presenceDb'] = 2.1;
  const c = stateToChainConfig(s);
  const round = JSON.parse(JSON.stringify(c)) as typeof c;
  for (const k of Object.keys(c) as (keyof typeof c)[]) {
    assert(round[k] === c[k], `field ${k} survived round-trip`);
  }
});

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log('\n=== realtime config mapping ===');
for (const r of results) {
  console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
}
console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
if (failed > 0) process.exit(1);
