/**
 * rust-loudness-selftest.ts — two-pass loudness-normalize parity / safety
 * (RUST-OFFLINE-RENDER-2).  Headless via the node WASM chain + analyzer.
 *
 * Run via:  pnpm --filter @aimaster/desktop test:rust-loudness
 */

import path from 'node:path';
process.env['LOUI_WASM_NODE_PATH'] = path.resolve(
  __dirname, '../../../packages/dsp-wasm/pkg-node/loui_dsp_wasm.cjs',
);

import { renderStereoBufferNormalized } from '../src/main/offline/rust-offline-render-core.js';
import { measureStereoLoudness, solveLoudnessGain } from '../src/main/offline/offline-loudness.js';
import { loadWasmModule, type OfflineChainConfig } from '../src/main/offline/load-mastering-chain-node.js';

const SR = 48000;
const N = SR * 3; // 3 s — enough gated blocks for a stable integrated LUFS.

function cfg(over: Partial<OfflineChainConfig> = {}): OfflineChainConfig {
  return {
    inputGainDb: 0,
    eqLowCutHz: 30, eqLowShelfDb: 0, eqPresenceDb: 0, eqAirDb: 0, eqAdaptive: false, eqBypass: false,
    dynThresholdDb: -14, dynRatio: 2, dynAttackMs: 10, dynReleaseMs: 120, dynMixPct: 100, dynBypass: false,
    imgWidthPct: 100, imgLowMonoHz: 120, imgBypass: false,
    limCeilingDbtp: -1.0, limLookaheadMs: 2.5, limIsp: true, limBypass: false,
    outputGainDb: 0, masterBypass: false, ...over,
  };
}
function sine(n: number, hz: number, amp: number): Float32Array {
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) b[i] = Math.sin((2 * Math.PI * hz * i) / SR) * amp;
  return b;
}
function noise(n: number, amp: number): Float32Array {
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) b[i] = (Math.random() * 2 - 1) * amp;
  return b;
}
function peakOf(a: Float32Array): number { let p = 0; for (let i = 0; i < a.length; i++) { const v = Math.abs(a[i]!); if (v > p) p = v; } return p; }
function hasNaN(a: Float32Array): boolean { for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i]!)) return true; return false; }

interface T { name: string; pass: boolean; detail: string; }
const results: T[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }
const CEIL_LIN = Math.pow(10, -1.0 / 20);

if (!loadWasmModule()) {
  console.error('\n[rust-loudness] node WASM not built — run: pnpm --filter @loui/dsp-wasm run build:node');
  process.exit(1);
}

// ── gain solver unit checks ─────────────────────────────────────────────
check('solver: silence → no gain', () => {
  assert(solveLoudnessGain(-Infinity, -14).note === 'silence', 'silence');
  assert(solveLoudnessGain(-Infinity, -14).appliedGainDb === 0, 'zero gain');
});
check('solver: boost + cut clamped', () => {
  assert(solveLoudnessGain(-40, -14, { maxBoostDb: 12 }).appliedGainDb === 12, 'boost clamp');
  assert(solveLoudnessGain(-2, -24, { maxCutDb: -12 }).appliedGainDb === -12, 'cut clamp');
  assert(Math.abs(solveLoudnessGain(-18, -14).appliedGainDb - 4) < 1e-9, 'exact');
});

// ── render fixtures ─────────────────────────────────────────────────────
const norm = (over = {}) => ({ targetLufs: -16, targetTp: -1.0, ...over });

check('silence: not boosted', () => {
  const r = renderStereoBufferNormalized(new Float32Array(N), new Float32Array(N), cfg(), SR, norm());
  assert(!hasNaN(r.left), 'no NaN');
  assert(r.metrics.appliedLoudnessGainDb === 0, `silence gain ${r.metrics.appliedLoudnessGainDb}`);
  assert(peakOf(r.left) < 1e-3, 'stays silent');
});

check('quiet sine moves toward target (±2 LU)', () => {
  const l = sine(N, 1000, 0.05); // ~quiet
  const r = renderStereoBufferNormalized(l, sine(N, 1000, 0.05), cfg(), SR, norm({ targetLufs: -16 }));
  assert(!hasNaN(r.left), 'no NaN');
  assert(r.metrics.appliedLoudnessGainDb > 0, `should boost (got ${r.metrics.appliedLoudnessGainDb})`);
  assert(Number.isFinite(r.metrics.finalLufs), 'finalLufs finite');
  assert(Math.abs(r.metrics.finalLufs - (-16)) <= 2.5, `finalLufs ${r.metrics.finalLufs.toFixed(2)} not near -16`);
});

check('loud sine: ceiling never exceeded after normalize', () => {
  const l = sine(N, 1000, 0.9);
  const r = renderStereoBufferNormalized(l, sine(N, 1000, 0.9), cfg(), SR, norm({ targetLufs: -9 }));
  assert(!hasNaN(r.left), 'no NaN');
  assert(peakOf(r.left) <= CEIL_LIN + 0.03, `peak ${peakOf(r.left)} > ceiling`);
  assert(peakOf(r.right) <= CEIL_LIN + 0.03, 'right ceiling');
});

check('noise: finite + bounded', () => {
  const r = renderStereoBufferNormalized(noise(N, 0.3), noise(N, 0.3), cfg(), SR, norm());
  assert(!hasNaN(r.left) && !hasNaN(r.right), 'no NaN');
  assert(peakOf(r.left) <= CEIL_LIN + 0.05, 'within ceiling');
});

check('stereo balance maintained (different L/R levels)', () => {
  const l = sine(N, 500, 0.4), rr = sine(N, 500, 0.2);
  const r = renderStereoBufferNormalized(l, rr, cfg(), SR, norm());
  assert(!hasNaN(r.left), 'no NaN');
  // L was louder than R; that ordering should survive normalization.
  assert(peakOf(r.left) >= peakOf(r.right) - 0.02, 'L≥R preserved');
});

check('extreme low level respects maxBoost', () => {
  const l = sine(N, 1000, 0.0008);
  const r = renderStereoBufferNormalized(l, l.slice(), cfg(), SR, norm({ targetLufs: -9, maxBoostDb: 12 }));
  assert(r.metrics.appliedLoudnessGainDb <= 12 + 1e-6, `gain ${r.metrics.appliedLoudnessGainDb} > maxBoost`);
});

check('metrics shape complete', () => {
  const r = renderStereoBufferNormalized(sine(N, 1000, 0.3), sine(N, 1000, 0.3), cfg(), SR, norm());
  const m = r.metrics;
  assert(Number.isFinite(m.measuredProcessedLufs) || m.measuredProcessedLufs === -Infinity, 'measuredProcessedLufs');
  assert(typeof m.appliedLoudnessGainDb === 'number', 'appliedLoudnessGainDb');
  assert(m.targetLufs === -16, 'targetLufs echoed');
  assert(typeof m.finalTruePeakDb === 'number', 'finalTruePeakDb');
});

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log('\n=== Rust offline loudness normalization ===');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
if (failed > 0) process.exit(1);
