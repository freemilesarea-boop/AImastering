/**
 * realtime-config-selftest.ts — config mapping + safety-clamp coverage for
 * the realtime mastering chain (REALTIME-DSP-BUG fix).
 *
 * Verifies that UI parameter state survives the journey to the worklet
 * payload, and that out-of-range / non-finite values are clamped to a safe
 * range before they can reach the audio thread (the Rust chain has its own
 * clamps too — this is the JS-boundary half of the defence in depth).
 *
 * Run via:
 *   pnpm --filter @aimaster/desktop test:realtime-config
 */

import { stateToChainConfig, type RealtimeChainConfig } from '../src/renderer/audio/realtime-mastering-chain.js';
import { sanitiseConfig } from '../src/renderer/audio/realtime-mastering-graph.js';
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

function baseConfig(over: Partial<RealtimeChainConfig> = {}): RealtimeChainConfig {
  return {
    inputGainDb: 0, eqLowCutHz: 30, eqLowShelfDb: 0, eqPresenceDb: 0, eqAirDb: 0,
    eqAdaptive: false, eqBypass: false,
    dynThresholdDb: -18, dynRatio: 2, dynAttackMs: 10, dynReleaseMs: 120, dynMixPct: 100, dynBypass: false,
    imgWidthPct: 100, imgLowMonoHz: 120, imgBypass: false,
    limCeilingDbtp: -1, limLookaheadMs: 2.5, limIsp: true, limBypass: false,
    outputGainDb: 0, masterBypass: false, ...over,
  };
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

// 4. sanitiseConfig clamps absurd width / lowMono / ratio / ceiling.
check('sanitiseConfig clamps out-of-range values', () => {
  const c = sanitiseConfig(baseConfig({
    imgWidthPct: 9999, imgLowMonoHz: 1e9, dynRatio: 999,
    limCeilingDbtp: 50, eqPresenceDb: 999, outputGainDb: -999,
  }));
  near(c.imgWidthPct, 200, 1e-9, 'width clamp 200');
  near(c.imgLowMonoHz, 2000, 1e-9, 'lowMono clamp 2000');
  near(c.dynRatio, 20, 1e-9, 'ratio clamp 20');
  near(c.limCeilingDbtp, 0, 1e-9, 'ceiling clamp 0');
  near(c.eqPresenceDb, 24, 1e-9, 'presence clamp 24');
  near(c.outputGainDb, -24, 1e-9, 'gain clamp -24');
});

// 5. sanitiseConfig replaces non-finite with a safe fallback.
check('sanitiseConfig replaces NaN/Infinity', () => {
  const c = sanitiseConfig(baseConfig({
    imgWidthPct: NaN, eqAirDb: Infinity, dynThresholdDb: -Infinity, limLookaheadMs: NaN,
  }));
  assert(Number.isFinite(c.imgWidthPct) && c.imgWidthPct === 100, 'width NaN → 100');
  assert(Number.isFinite(c.eqAirDb), 'airDb finite');
  assert(Number.isFinite(c.dynThresholdDb), 'threshold finite');
  assert(Number.isFinite(c.limLookaheadMs) && c.limLookaheadMs === 2.5, 'lookahead NaN → 2.5');
});

// 6. The sanitised payload is JSON-serialisable (worklet postMessage).
check('config payload round-trips through JSON (postMessage-safe)', () => {
  const c = sanitiseConfig(baseConfig({ imgWidthPct: 130, eqPresenceDb: 2.1 }));
  const round = JSON.parse(JSON.stringify(c)) as RealtimeChainConfig;
  for (const k of Object.keys(c) as (keyof RealtimeChainConfig)[]) {
    assert(round[k] === c[k], `field ${k} survived round-trip`);
  }
});

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log('\n=== realtime config mapping + safety clamp ===');
for (const r of results) {
  console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
}
console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
if (failed > 0) process.exit(1);
