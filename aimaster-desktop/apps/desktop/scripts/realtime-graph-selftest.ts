/**
 * realtime-graph-selftest.ts — lifecycle coverage for the realtime
 * mastering graph manager (M2-full-NEXT-2) that does NOT need a real
 * AudioContext / WebAssembly.
 *
 * Covers the non-audio control paths: failure-fast guards, config
 * staging + sanitisation, bypass toggling, dispose idempotency, and the
 * insert-node splice contract — using lightweight mocks.  The audio-thread
 * behaviour (worklet load / process) is validated on-device per
 * DEVICE_TEST_MATRIX.md.
 *
 * Run via:
 *   pnpm --filter @aimaster/desktop test:realtime-graph
 */

import {
  createRealtimeMasteringGraph,
  type MasteringGraphSession,
} from '../src/renderer/audio/realtime-mastering-graph.js';
import type { RealtimeChainConfig } from '../src/renderer/audio/realtime-mastering-chain.js';

// ── Tiny harness ────────────────────────────────────────────────────────────

interface T { name: string; pass: boolean; detail: string; }
const results: T[] = [];

function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => { results.push({ name, pass: true, detail: '' }); })
    .catch((e) => { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); });
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}
function eq<T>(a: T, b: T, msg: string): void {
  if (a !== b) throw new Error(`${msg} — got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);
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

// A session mock that records setInsertNode calls.  No real AudioContext.
function mockSession(opts: { hasInsert?: boolean; ctx?: unknown } = {}): MasteringGraphSession & {
  inserts: (unknown | null)[];
} {
  const inserts: (unknown | null)[] = [];
  const s: MasteringGraphSession & { inserts: (unknown | null)[] } = {
    inserts,
    audioContext: () => (opts.ctx === undefined ? null : (opts.ctx as AudioContext | null)),
  };
  if (opts.hasInsert !== false) {
    s.setInsertNode = (n: AudioNode | null) => { inserts.push(n); };
  }
  return s;
}

async function main(): Promise<void> {
  // 1. Failure-fast: session without setInsertNode.
  await check('attach fails when session lacks setInsertNode', async () => {
    const g = createRealtimeMasteringGraph({ session: mockSession({ hasInsert: false }), sampleRate: 48000 });
    const ok = await g.attach();
    eq(ok, false, 'attach should fail');
    eq(g.getState().status, 'failed', 'status failed');
    eq(g.getState().fallbackReason, 'session-no-insert-support', 'reason');
  });

  // 2. Failure-fast: no AudioContext.
  await check('attach fails when audioContext() is null', async () => {
    const g = createRealtimeMasteringGraph({ session: mockSession({ ctx: null }), sampleRate: 48000 });
    const ok = await g.attach();
    eq(ok, false, 'attach should fail');
    eq(g.getState().fallbackReason, 'no-audio-context', 'reason');
  });

  // 3. updateConfig before attach does not throw, stages config.
  await check('updateConfig before attach is safe (staged)', () => {
    const g = createRealtimeMasteringGraph({ session: mockSession(), sampleRate: 48000 });
    g.updateConfig(baseConfig());                 // node is null — must not throw
    g.updateConfig(baseConfig({ outputGainDb: NaN })); // NaN must not throw
  });

  // 4. setBypassed before attach is safe.
  await check('setBypassed before attach is safe', () => {
    const g = createRealtimeMasteringGraph({ session: mockSession(), sampleRate: 48000 });
    g.setBypassed(true);
    g.setBypassed(false);
  });

  // 5. getMetrics returns the empty snapshot initially.
  await check('getMetrics initial snapshot is empty', () => {
    const g = createRealtimeMasteringGraph({ session: mockSession(), sampleRate: 48000 });
    const m = g.getMetrics();
    eq(m.samples, 0, 'samples');
    eq(m.totalXruns, 0, 'xruns');
    eq(m.cpuLoad, 0, 'cpu');
  });

  // 6. dispose restores analyzer-only graph + is idempotent.
  await check('dispose calls setInsertNode(null) + is idempotent', () => {
    const session = mockSession();
    const g = createRealtimeMasteringGraph({ session, sampleRate: 48000 });
    g.dispose();
    g.dispose(); // second call must not throw
    eq(g.getState().status, 'disposed', 'status disposed');
    assert(session.inserts.includes(null), 'setInsertNode(null) called on dispose');
  });

  // 7. attach after dispose is a no-op (returns false).
  await check('attach after dispose returns false', async () => {
    const g = createRealtimeMasteringGraph({ session: mockSession(), sampleRate: 48000 });
    g.dispose();
    const ok = await g.attach();
    eq(ok, false, 'attach after dispose');
  });

  // 8. onStateChange fires on status transitions.
  await check('onStateChange fires on failure path', async () => {
    const seen: string[] = [];
    const g = createRealtimeMasteringGraph({
      session: mockSession({ ctx: null }),
      sampleRate: 48000,
      onStateChange: (s) => seen.push(s.status),
    });
    await g.attach();
    assert(seen.includes('failed'), `expected a failed transition, saw ${seen.join(',')}`);
  });

  // ── Print summary ──────────────────────────────────────────────────────
  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;

  console.log('\n=== realtime mastering graph lifecycle ===');
  for (const r of results) {
    const tag = r.pass ? 'PASS' : 'FAIL';
    console.log(`[${tag}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  }
  console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
  if (failed > 0) process.exit(1);
}

void main();
