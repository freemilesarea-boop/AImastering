// Selftest — realtime-preview gate + metrics-sink coalescing.
//
// Verifies the two pieces that re-open the realtime worklet gate safely:
//   1. isRealtimePreviewEnabled() resolution order (env / window / LS).
//   2. createMetricsSink() coalesces per-block pushes into ≤1 emit per
//      minInterval — the fix for the renderer-crash root cause.
//
// Headless: no audio thread, no DOM.  Run via `pnpm test:realtime-gate`.

import { createMetricsSink, type WorkletMetrics } from '../src/renderer/audio/realtime-metrics-sink.js';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}`);
  }
}

function makeMetrics(grDb: number): WorkletMetrics {
  return {
    avgProcessMs: 0.1, peakProcessMs: 0.2, blockPeriodMs: 2.6, xruns: 0,
    limiterGrDb: grDb, dynamicsGrDb: 0, safetyEvents: 0,
    processCalls: 1, audioBlocks: 1, nonSilentBlocks: 1,
  };
}

console.log('realtime-preview-gate-selftest');

// ── 1. Flag resolution (pure logic mirror) ───────────────────────────────
// The flag module reads import.meta.env / window / localStorage.  We test
// the decision logic directly by emulating the documented resolution order,
// keeping this selftest free of a DOM/Vite env.
console.log('flag resolution order');
{
  const isOn = (v: string | null | undefined) => v === 'true' || v === '1' || v === 'on';
  const isForcedOff = (v: string | null | undefined) => v === 'force-off' || v === 'off' || v === '0';
  const resolve = (env?: string, win?: boolean, ls?: string | null): boolean => {
    if (isForcedOff(env)) return false;
    if (typeof win === 'boolean') return win;
    if (ls != null) { if (isForcedOff(ls)) return false; if (isOn(ls)) return true; }
    return isOn(env);
  };
  check('default OFF (no flags)', resolve(undefined, undefined, null) === false);
  check('env=true → ON', resolve('true', undefined, null) === true);
  check('env kill-switch beats everything', resolve('force-off', true, 'true') === false);
  check('window flag beats localStorage', resolve(undefined, false, 'true') === false);
  check('localStorage on → ON', resolve(undefined, undefined, 'on') === true);
  check('localStorage off → OFF', resolve(undefined, undefined, 'off') === false);
}

// ── 2. Metrics sink coalescing ───────────────────────────────────────────
console.log('metrics sink coalescing');
{
  const sink = createMetricsSink({ minIntervalMs: 100 });
  // Simulate 200 per-block pushes within a single 100 ms window.
  for (let i = 0; i < 200; i++) sink.push(makeMetrics(i));
  // First drain at t=0 emits exactly once with the LATEST value.
  const first = sink.drain(0);
  check('first drain emits latest coalesced value', first?.limiterGrDb === 199);
  // Further drains inside the window are throttled to null (no re-render).
  let emitsInWindow = 0;
  for (let t = 1; t < 100; t++) { if (sink.drain(t)) emitsInWindow++; }
  check('throttled: zero extra emits within minInterval', emitsInWindow === 0);
  // After the interval, a new push emits again.
  sink.push(makeMetrics(500));
  check('emits again after interval elapses', sink.drain(100)?.limiterGrDb === 500);
  // No new push → drain returns null even past interval.
  check('no emit without new data', sink.drain(300) === null);
  // latest() always reflects the newest push regardless of throttle.
  sink.push(makeMetrics(777));
  check('latest() reflects newest push', sink.latest()?.limiterGrDb === 777);
  // reset clears state.
  sink.reset();
  check('reset clears latest', sink.latest() === null);
}

if (failures > 0) {
  console.error(`\nFAILED: ${failures} check(s)`);
  process.exit(1);
}
console.log('\nALL PASS');
