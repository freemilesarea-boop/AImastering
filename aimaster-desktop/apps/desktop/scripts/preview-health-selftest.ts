/**
 * preview-health-selftest — the realtime preview's own readout.
 *
 * The worklet has counted everything needed to tell whether the preview is
 * healthy since it was written: process time per block, the block period,
 * xruns, safety bypasses, and three cumulative counters that separate
 * "never pulled" from "pulled but no audio" from "audio but all silence".
 * `RealtimeMetrics` aggregates it all — and had no test, and the thresholds
 * lived in two components that read different fields and disagreed.
 *
 * What the instrumentation reported before this, measured against the
 * 2.667 ms quantum a 48 kHz 128-frame graph gives:
 *
 *   8.0 ms per block (3x over, unusable)   → cpuLoad 100.0 %
 *   2.667 ms (exactly at the deadline)     → cpuLoad 100.0 %
 *   one startup xrun, then 60 s clean      → xruns 1, panel red forever
 *   blockPeriodMs never reported           → cpuLoad 0 % on 5 ms of work
 *
 * The first pair cannot be told apart, the second never clears, and the
 * third renders the most alarming state as the calmest.
 *
 * Run via:  pnpm --filter @aimaster/desktop test:preview-health
 */

import {
  RealtimeMetrics, XRUN_WINDOW,
  type RealtimeMetricSample,
} from '../src/renderer/audio/realtime-metrics.js';
import {
  previewHealth, TIGHT_LOAD, OVER_LOAD,
  type PreviewHealthInput,
} from '../src/renderer/audio/realtime-health.js';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { passed++; console.log(`[PASS] ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failed++; console.error(`[FAIL] ${name}${detail ? ` — ${detail}` : ''}`); }
}

/** The real quantum: 128 frames at 48 kHz. */
const BLOCK_MS = (128 / 48_000) * 1000;

function sample(over: Partial<RealtimeMetricSample> = {}): RealtimeMetricSample {
  return {
    avgProcessMs: 0.3, peakProcessMs: 0.6, blockPeriodMs: BLOCK_MS, xruns: 0,
    limiterGrDb: 0, processCalls: 100, audioBlocks: 100, nonSilentBlocks: 100,
    ...over,
  };
}
function feed(n: number, over: Partial<RealtimeMetricSample> = {}): RealtimeMetrics {
  const m = new RealtimeMetrics();
  for (let i = 0; i < n; i++) m.push(sample(over));
  return m;
}

console.log(`\n=== THE LOAD IS REPORTED PAST THE DEADLINE, NOT CLAMPED AT IT ===\n`);
console.log(`block period ${BLOCK_MS.toFixed(3)} ms\n`);

{
  const easy = feed(20).snapshot();
  const edge = feed(20, { avgProcessMs: BLOCK_MS, peakProcessMs: BLOCK_MS }).snapshot();
  const over = feed(20, { avgProcessMs: 8, peakProcessMs: 12 }).snapshot();
  check(
    'a comfortable chain reports a fraction of its budget',
    easy.cpuLoad > 0.1 && easy.cpuLoad < 0.15,
    `${(easy.cpuLoad * 100).toFixed(1)} % for 0.3 ms of ${BLOCK_MS.toFixed(3)} ms`,
  );
  check(
    'at the deadline reports 1.0',
    Math.abs(edge.cpuLoad - 1) < 1e-9,
    `${(edge.cpuLoad * 100).toFixed(1)} %`,
  );
  check(
    'and three times over reports three, not one',
    over.cpuLoad > 2.9 && over.cpuLoad < 3.1,
    `${(over.cpuLoad * 100).toFixed(1)} % for 8 ms — clamped, this was indistinguishable from the line above`,
  );
  check(
    'an unreported block period is unknown, not idle',
    (() => {
      const s = feed(5, { blockPeriodMs: 0, avgProcessMs: 5 }).snapshot();
      return s.cpuLoadKnown === false;
    })(),
    '5 ms of work with no budget used to read as 0 % load',
  );
  check(
    'and a reported one says so',
    easy.cpuLoadKnown === true,
  );
}

console.log('\n=== A GLITCH AT STARTUP IS NOT A GLITCH NOW ===\n');

{
  const m = new RealtimeMetrics();
  m.push(sample({ xruns: 1, peakProcessMs: 2.9 }));
  for (let i = 0; i < 600; i++) m.push(sample());        // ~60 s at 10/s
  const s = m.snapshot();
  check(
    'the cumulative total still remembers it',
    s.totalXruns === 1,
    `${s.totalXruns} since the preview started`,
  );
  check(
    'but the recent window has cleared',
    s.recentXruns === 0,
    `${s.recentXruns} in the last ${XRUN_WINDOW} samples`,
  );
  check(
    'so the verdict is healthy again',
    previewHealth({ ...s, bypass: false }).level === 'ok',
    previewHealth({ ...s, bypass: false }).reason,
  );

  // And a glitch that is still happening is still reported.
  const now = feed(XRUN_WINDOW, { xruns: 2 }).snapshot();
  check(
    'a glitch that is still happening still reads as a problem',
    now.recentXruns === 2 * XRUN_WINDOW
      && previewHealth({ ...now, bypass: false }).level === 'over',
    `${now.recentXruns} recent → '${previewHealth({ ...now, bypass: false }).level}'`,
  );
  // The window is a window: one sample of xruns scrolls out after
  // XRUN_WINDOW clean ones, and not before.
  const edge = new RealtimeMetrics();
  edge.push(sample({ xruns: 3 }));
  for (let i = 0; i < XRUN_WINDOW - 1; i++) edge.push(sample());
  const stillIn = edge.snapshot().recentXruns;
  edge.push(sample());
  check(
    'the window drops a sample only once it has scrolled past',
    stillIn === 3 && edge.snapshot().recentXruns === 0,
    `${stillIn} at the edge, ${edge.snapshot().recentXruns} one sample later`,
  );
}

console.log('\n=== THE QUESTIONS, IN THE ORDER THEY HAVE TO BE ASKED ===\n');

{
  const base: PreviewHealthInput = {
    avgProcessMs: 0.3, blockPeriodMs: BLOCK_MS, recentXruns: 0, safetyEvents: 0,
    processCalls: 100, audioBlocks: 100, nonSilentBlocks: 100, bypass: false,
  };
  const cases: Array<[string, Partial<PreviewHealthInput>, string]> = [
    ['not pulled at all',            { processCalls: 0 },                      'off'],
    ['pulled, no audio yet',         { audioBlocks: 0 },                       'waiting'],
    ['audio, all of it silence',     { nonSilentBlocks: 0 },                   'silent'],
    ['deliberately bypassed',        { bypass: true },                         'bypassed'],
    ['rescued by the safety layer',  { safetyEvents: 4 },                      'over'],
    ['glitching now',               { recentXruns: 1 },                        'over'],
    ['past the deadline',           { avgProcessMs: BLOCK_MS * 1.2 },          'over'],
    ['half the budget gone',        { avgProcessMs: BLOCK_MS * TIGHT_LOAD },   'tight'],
    ['comfortable',                 {},                                        'ok'],
  ];
  for (const [label, over, want] of cases) {
    const h = previewHealth({ ...base, ...over });
    check(`${label} → '${want}'`, h.level === want, `'${h.level}': ${h.reason}`);
  }

  // A stopped preview must not be called healthy because its load is low.
  const stopped = previewHealth({ ...base, processCalls: 0, avgProcessMs: 0 });
  check(
    'a stopped preview is not healthy just because it is idle',
    stopped.level === 'off',
    `'${stopped.level}' — asking about load first is how this reads as ok`,
  );
  // Every reason says something a user can act on.
  check(
    'every verdict carries a reason',
    cases.every(([, over]) => previewHealth({ ...base, ...over }).reason.length > 5),
  );
  // The load travels with the verdict even when it is not what decided it.
  const silent = previewHealth({ ...base, nonSilentBlocks: 0 });
  check(
    'the load is reported even when something else decided the level',
    silent.load !== null && Math.abs(silent.load - 0.3 / BLOCK_MS) < 1e-9,
    `level '${silent.level}', load ${(silent.load! * 100).toFixed(1)} %`,
  );
}

console.log('\n=== AND A CALLER WITH NO COUNTERS GETS THE SAME RULE ===\n');

{
  // The preview store keeps `running` and throws the counters away, so the
  // transport cannot be asked the first three questions. It must still get
  // the load half rather than its own thresholds.
  const noCounters = {
    avgProcessMs: BLOCK_MS * 0.8, blockPeriodMs: BLOCK_MS, recentXruns: 0,
    safetyEvents: 0, running: true, bypass: false,
  };
  check(
    'a store-shaped snapshot still gets a load verdict',
    previewHealth(noCounters).level === 'tight',
    previewHealth(noCounters).reason,
  );
  check(
    'and a stopped one is still off',
    previewHealth({ ...noCounters, running: false }).level === 'off',
    previewHealth({ ...noCounters, running: false }).reason,
  );
  check(
    'OVER_LOAD is the deadline and TIGHT_LOAD is half of it',
    OVER_LOAD === 1 && TIGHT_LOAD === 0.5,
    `${TIGHT_LOAD} / ${OVER_LOAD}`,
  );
}

console.log('\n=== THE REST OF THE ACCUMULATOR, WHICH ALSO HAD NO TEST ===\n');

{
  const m = new RealtimeMetrics();
  check('an empty accumulator reports nothing rather than zeroes it invented',
    m.snapshot().samples === 0 && m.snapshot().cpuLoadKnown === false);

  // The EMA: the first sample is taken whole, later ones are blended.
  const ema = new RealtimeMetrics(0.2);
  ema.push(sample({ avgProcessMs: 1 }));
  check('the first sample sets the average outright',
    Math.abs(ema.snapshot().avgProcessMs - 1) < 1e-9,
    `${ema.snapshot().avgProcessMs.toFixed(3)} ms`);
  ema.push(sample({ avgProcessMs: 2 }));
  check('the second is blended at alpha, not replaced',
    Math.abs(ema.snapshot().avgProcessMs - 1.2) < 1e-9,
    `${ema.snapshot().avgProcessMs.toFixed(3)} ms for 1 → 2 at alpha 0.2`);

  // The decaying peak: a spike is remembered, then let go.
  const spike = new RealtimeMetrics();
  spike.push(sample({ peakProcessMs: 9.9 }));
  const held = spike.snapshot().peakProcessMs;
  for (let i = 0; i < 22; i++) spike.push(sample({ peakProcessMs: 0.2 }));
  check(
    'a peak is held, then decays',
    Math.abs(held - 9.9) < 1e-9 && spike.snapshot().peakProcessMs < 1.5,
    `${held.toFixed(2)} ms held, ${spike.snapshot().peakProcessMs.toFixed(2)} ms after 22 quiet samples`,
  );

  // Cumulative counters only ever go up, even if a sample arrives stale.
  const counters = new RealtimeMetrics();
  counters.push(sample({ processCalls: 500, audioBlocks: 400, nonSilentBlocks: 300, safetyEvents: 2 }));
  counters.push(sample({ processCalls: 10, audioBlocks: 5, nonSilentBlocks: 1, safetyEvents: 0 }));
  const c = counters.snapshot();
  check(
    'a stale sample cannot walk the cumulative counters backwards',
    c.processCalls === 500 && c.audioBlocks === 400 && c.nonSilentBlocks === 300 && c.safetyEvents === 2,
    `calls ${c.processCalls}, blocks ${c.audioBlocks}, non-silent ${c.nonSilentBlocks}, safety ${c.safetyEvents}`,
  );

  // Reset clears everything, including the new window.
  const r = feed(10, { xruns: 1 });
  r.reset();
  check(
    'reset clears the window as well as the total',
    r.snapshot().totalXruns === 0 && r.snapshot().recentXruns === 0 && r.snapshot().samples === 0,
  );
}

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed === 0 ? 0 : 1);
