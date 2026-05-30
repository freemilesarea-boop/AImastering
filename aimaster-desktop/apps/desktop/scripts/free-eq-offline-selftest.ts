/**
 * free-eq-offline-selftest — Phase 3b verification: free parametric EQ
 * bands authored in the renderer are applied by the Rust offline render.
 *
 * Drives the same node-target WASM chain the export uses, with the new
 * `setParametricEqBands` binding.  Renders a 1 kHz sine through:
 *   1) empty band list   → near-identity (just the rest of the chain at
 *      flat settings, which limits headroom but otherwise passes through).
 *   2) +12 dB bell @ 1 kHz Q 0.8  → output RMS ≥ +6 dB louder than (1).
 *   3) -24 dB high-pass @ 8 kHz   → DC + 1 kHz survive (cut is well above).
 *   4) Surplus bands → still finite.
 *
 * Run: pnpm --filter @aimaster/desktop test:free-eq-offline
 */

import path from 'node:path';
process.env['LOUI_WASM_NODE_PATH'] = path.resolve(
  __dirname, '../../../packages/dsp-wasm/pkg-node/loui_dsp_wasm.cjs',
);

import { renderStereoBuffer } from '../src/main/offline/rust-offline-render-core.js';
import { loadWasmModule, type OfflineChainConfig, type OfflineParametricBand } from '../src/main/offline/load-mastering-chain-node.js';

const SR = 48_000;
const N = SR * 1; // 1 second is enough to settle the filters + measure RMS.

function flatCfg(parametricBands?: OfflineParametricBand[]): OfflineChainConfig {
  // All non-EQ modules at unity — isolate the parametric EQ contribution.
  return {
    inputGainDb: 0,
    eqLowCutHz: 20, eqLowShelfDb: 0, eqPresenceDb: 0, eqAirDb: 0, eqAdaptive: false, eqBypass: true,
    dynThresholdDb: 0, dynRatio: 1, dynAttackMs: 10, dynReleaseMs: 120, dynMixPct: 100, dynBypass: true,
    imgWidthPct: 100, imgLowMonoHz: 20, imgBypass: true,
    limCeilingDbtp: 0, limLookaheadMs: 1, limIsp: false, limBypass: true,
    outputGainDb: 0, masterBypass: false,
    ...(parametricBands ? { parametricBands } : {}),
  };
}

function sine(n: number, hz: number, amp: number): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sin(2 * Math.PI * hz * i / SR) * amp;
  return out;
}
function rms(buf: Float32Array, startFrac = 0.25): number {
  const start = Math.floor(buf.length * startFrac);
  let s = 0, n = 0;
  for (let i = start; i < buf.length; i++) { s += buf[i]! * buf[i]!; n++; }
  return Math.sqrt(s / Math.max(1, n));
}
function rmsDb(buf: Float32Array, startFrac = 0.25): number {
  const r = rms(buf, startFrac);
  return r < 1e-9 ? -120 : 20 * Math.log10(r);
}

let fail = 0;
const check = (name: string, pass: boolean, detail = '') => {
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
  if (!pass) fail++;
};

console.log('\n=== FREE PARAMETRIC EQ — RUST OFFLINE RENDER ===\n');

if (!loadWasmModule()) {
  console.log('[SKIP] node-target WASM unavailable (run pnpm --filter @loui/dsp-wasm run build:node first).');
  process.exit(0);
}

// 1) Empty band list = identity (we'll use the +12 dB case below as the
//    relative reference instead of absolute RMS, since limiter/output are off
//    but the chain still has a tiny envelope cost).
const baseLeft = sine(N, 1000, 0.3);
const baseRight = sine(N, 1000, 0.3);
const baseResult = renderStereoBuffer(baseLeft, baseRight, flatCfg(), SR, 512);
const baseDb = rmsDb(baseResult.left);
check('Empty band list near-identity (RMS ≈ -13 dBFS, no NaN)',
  Math.abs(baseDb - (-13)) < 1.0 && baseResult.left.every((x) => Number.isFinite(x)),
  `baseDb=${baseDb.toFixed(2)}`,
);

// 2) +12 dB bell at 1 kHz, Q 0.8.
const boostLeft = sine(N, 1000, 0.3);
const boostRight = sine(N, 1000, 0.3);
const boostResult = renderStereoBuffer(boostLeft, boostRight, flatCfg([
  { type: 2 /* Bell */, frequencyHz: 1000, gainDb: 12, q: 0.8, enabled: true },
]), SR, 512);
const boostDb = rmsDb(boostResult.left);
const deltaDb = boostDb - baseDb;
check('+12 dB bell @ 1 kHz produces ≥ +8 dB boost',
  deltaDb > 8.0,
  `delta=${deltaDb.toFixed(2)} dB`,
);

// 3) Disabled band — should match identity.
const disabledResult = renderStereoBuffer(boostLeft, boostRight, flatCfg([
  { type: 2 /* Bell */, frequencyHz: 1000, gainDb: 12, q: 0.8, enabled: false },
]), SR, 512);
const disabledDelta = rmsDb(disabledResult.left) - baseDb;
check('Disabled band does NOT affect output',
  Math.abs(disabledDelta) < 0.3,
  `delta=${disabledDelta.toFixed(2)} dB`,
);

// 4a) High-pass @ 8 kHz — 1 kHz should be strongly attenuated.
const hpCutResult = renderStereoBuffer(boostLeft, boostRight, flatCfg([
  { type: 0 /* HighPass */, frequencyHz: 8000, gainDb: 0, q: 0.707, enabled: true },
]), SR, 512);
const hpCutDelta = rmsDb(hpCutResult.left) - baseDb;
check('HighPass @ 8 kHz strongly attenuates 1 kHz (≥ 20 dB cut)',
  hpCutDelta < -20,
  `delta=${hpCutDelta.toFixed(2)} dB`,
);

// 4b) High-pass @ 100 Hz — 1 kHz should pass through unchanged.
const hpPassResult = renderStereoBuffer(boostLeft, boostRight, flatCfg([
  { type: 0 /* HighPass */, frequencyHz: 100, gainDb: 0, q: 0.707, enabled: true },
]), SR, 512);
const hpPassDelta = rmsDb(hpPassResult.left) - baseDb;
check('HighPass @ 100 Hz passes 1 kHz unchanged',
  Math.abs(hpPassDelta) < 0.3,
  `delta=${hpPassDelta.toFixed(2)} dB`,
);

// 5) Surplus bands → still finite (Rust caps internally at MAX_PARAMETRIC_BANDS=16).
const manyBands: OfflineParametricBand[] = [];
for (let i = 0; i < 20; i++) {
  manyBands.push({ type: 2, frequencyHz: 200 + i * 200, gainDb: 1, q: 1, enabled: true });
}
const surplusResult = renderStereoBuffer(boostLeft, boostRight, flatCfg(manyBands), SR, 512);
check('Surplus bands produce finite output',
  surplusResult.left.every((x) => Number.isFinite(x)) && surplusResult.right.every((x) => Number.isFinite(x)),
);

console.log(`\n=== ${fail === 0 ? 'ALL FREE EQ OFFLINE TESTS PASS' : `${fail} FAILED`} ===\n`);
if (fail) process.exit(1);
