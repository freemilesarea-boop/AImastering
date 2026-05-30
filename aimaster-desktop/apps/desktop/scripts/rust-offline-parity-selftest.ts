/**
 * rust-offline-parity-selftest.ts — Rust offline render parity / safety
 * (RUST-OFFLINE-RENDER-1).
 *
 * Drives the SAME Rust MasteringChain (node-target WASM) the realtime
 * preview uses, over synthetic fixtures, and checks safety invariants:
 * no NaN, ceiling respected, length preserved, bypass ≈ input.
 *
 * Requires the node WASM build:  pnpm --filter @loui/dsp-wasm run build:node
 * Run via:                       pnpm --filter @aimaster/desktop test:rust-offline
 */

import path from 'node:path';
import {
  renderStereoBuffer, type RenderResult,
} from '../src/main/offline/rust-offline-render-core.js';
import type { OfflineChainConfig } from '../src/main/offline/load-mastering-chain-node.js';
import { loadWasmModule } from '../src/main/offline/load-mastering-chain-node.js';

// Point the loader at the workspace node-WASM build explicitly.
process.env['LOUI_WASM_NODE_PATH'] = path.resolve(
  __dirname, '../../../packages/dsp-wasm/pkg-node/loui_dsp_wasm.cjs',
);

const SR = 48000;

function cfg(over: Partial<OfflineChainConfig> = {}): OfflineChainConfig {
  return {
    inputGainDb: 0,
    eqLowCutHz: 30, eqLowShelfDb: 1.0, eqPresenceDb: 0.5, eqAirDb: 2.0, eqAdaptive: false, eqBypass: false,
    dynThresholdDb: -14, dynRatio: 2, dynAttackMs: 10, dynReleaseMs: 120, dynMixPct: 100, dynBypass: false,
    imgWidthPct: 110, imgLowMonoHz: 120, imgBypass: false,
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
function hasNaN(a: Float32Array): boolean { for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i]!)) return true; return false; }
function peakOf(a: Float32Array): number { let p = 0; for (let i = 0; i < a.length; i++) { const v = Math.abs(a[i]!); if (v > p) p = v; } return p; }

interface T { name: string; pass: boolean; detail: string; }
const results: T[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }
const noNaN = (r: RenderResult) => { assert(!hasNaN(r.left) && !hasNaN(r.right), 'NaN/Inf in output'); };
const CEIL_LIN = Math.pow(10, -1.0 / 20); // -1 dBTP

// Guard: the node WASM must be built.
if (!loadWasmModule()) {
  console.error('\n[rust-offline-parity] node WASM not built — run: pnpm --filter @loui/dsp-wasm run build:node');
  process.exit(1);
}

const N = SR; // 1 second.

check('silence stays silent + no NaN', () => {
  const r = renderStereoBuffer(new Float32Array(N), new Float32Array(N), cfg(), SR);
  noNaN(r);
  assert(peakOf(r.left) < 1e-4, `silence peak ${peakOf(r.left)}`);
});

check('1 kHz sine: no NaN, length preserved', () => {
  const l = sine(N, 1000, 0.5);
  const r = renderStereoBuffer(l, sine(N, 1000, 0.5), cfg(), SR);
  noNaN(r);
  assert(r.left.length === N && r.right.length === N, 'length preserved');
});

check('loud sine respects the −1 dBTP ceiling', () => {
  const l = sine(N, 1000, 0.98);
  const r = renderStereoBuffer(l, sine(N, 1000, 0.98), cfg({ limCeilingDbtp: -1.0 }), SR);
  noNaN(r);
  assert(peakOf(r.left) <= CEIL_LIN + 0.03, `peak ${peakOf(r.left)} > ceiling ${CEIL_LIN}`);
  assert(peakOf(r.right) <= CEIL_LIN + 0.03, 'right ceiling');
});

check('white noise: no NaN, bounded', () => {
  const r = renderStereoBuffer(noise(N, 0.6), noise(N, 0.6), cfg(), SR);
  noNaN(r);
  assert(peakOf(r.left) <= CEIL_LIN + 0.05, 'noise within ceiling');
});

check('stereo (different L/R) both channels processed', () => {
  const l = sine(N, 440, 0.4), rr = sine(N, 660, 0.4);
  const r = renderStereoBuffer(l, rr, cfg(), SR);
  noNaN(r);
  assert(peakOf(r.left) > 0 && peakOf(r.right) > 0, 'both channels non-silent');
});

check('master bypass ≈ input', () => {
  const l = sine(N, 1000, 0.3);
  const r = renderStereoBuffer(l, l.slice(), cfg({ masterBypass: true }), SR);
  noNaN(r);
  let maxDiff = 0;
  for (let i = 0; i < N; i++) maxDiff = Math.max(maxDiff, Math.abs(r.left[i]! - l[i]!));
  assert(maxDiff < 1e-3, `bypass diff ${maxDiff}`);
});

check('metrics are sane', () => {
  const r = renderStereoBuffer(sine(N, 1000, 0.5), sine(N, 1000, 0.5), cfg(), SR);
  assert(r.metrics.samples === N, 'samples');
  assert(Math.abs(r.metrics.durationSec - 1) < 1e-6, 'duration');
  assert(r.metrics.renderMs >= 0, 'renderMs');
  assert(Number.isFinite(r.metrics.samplePeak), 'peak finite');
});

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log('\n=== Rust offline render parity / safety ===');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
if (failed > 0) process.exit(1);
