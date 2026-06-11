// module-effect-selftest — PROVE the Phase 2 export modules actually alter the
// Rust offline render (the node WASM runs headlessly).  For each module, render
// the same signal with it BYPASSED vs ACTIVE and assert the output differs (and
// stays finite).  This is the objective answer to "is it really implemented?" —
// independent of the OFF-by-default export flag (which only gates ROUTING).
//
//   pnpm --filter @aimaster/desktop test:module-effect

import { renderStereoBuffer } from '../src/main/offline/rust-offline-render-core.js';
import { loadWasmModule, type OfflineChainConfig } from '../src/main/offline/load-mastering-chain-node.js';

const SR = 48000;

function base(over: Partial<OfflineChainConfig> = {}): OfflineChainConfig {
  return {
    inputGainDb: 0,
    eqLowCutHz: 20, eqLowShelfDb: 0, eqPresenceDb: 0, eqAirDb: 0, eqAdaptive: false, eqBypass: true,
    dynThresholdDb: -14, dynRatio: 2, dynAttackMs: 10, dynReleaseMs: 120, dynMixPct: 100, dynBypass: true,
    imgWidthPct: 100, imgLowMonoHz: 120, imgBypass: true,
    limCeilingDbtp: -1, limLookaheadMs: 2, limIsp: false, limBypass: true,
    outputGainDb: 0, masterBypass: false, ...over,
  };
}

function mix(n: number): { l: Float32Array; r: Float32Array } {
  const l = new Float32Array(n), r = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    // low tone + mid tone + transient clicks → exercises every band/module.
    const s = 0.3 * Math.sin(2 * Math.PI * 80 * t) + 0.25 * Math.sin(2 * Math.PI * 2500 * t) + (i % 12000 < 64 ? 0.5 : 0);
    l[i] = s; r[i] = s * 0.95 + 0.05 * Math.sin(2 * Math.PI * 6000 * t);
  }
  return { l, r };
}

function rms(a: Float32Array): number { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]! * a[i]!; return Math.sqrt(s / a.length); }
function finite(a: Float32Array): boolean { for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i]!)) return false; return true; }
function diffRms(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length); let s = 0;
  for (let i = 0; i < n; i++) { const d = a[i]! - b[i]!; s += d * d; }
  return Math.sqrt(s / n);
}

const XO = { xoverLoHz: 120, xoverMidHz: 800, xoverHiHz: 5000 };

const MODULES: Array<{ name: string; active: Partial<OfflineChainConfig> }> = [
  { name: 'EQ', active: { eqBypass: false, eqLowShelfDb: 4, eqAirDb: 4 } },
  { name: 'Dynamics', active: { dynBypass: false, dynThresholdDb: -28, dynRatio: 4 } },
  { name: 'Imager', active: { imgBypass: false, imgWidthPct: 150 } },
  { name: 'Limiter', active: { limBypass: false, limCeilingDbtp: -6 } },
  { name: 'Multiband', active: { multiband: { bypass: false, ...XO, bands: [
    { thresholdDb: -30, ratio: 4, attackMs: 10, releaseMs: 120, makeupDb: 0 },
    { thresholdDb: -30, ratio: 4, attackMs: 10, releaseMs: 120, makeupDb: 0 },
    { thresholdDb: -30, ratio: 4, attackMs: 10, releaseMs: 120, makeupDb: 0 },
    { thresholdDb: -30, ratio: 4, attackMs: 10, releaseMs: 120, makeupDb: 0 },
  ] } } },
  { name: 'Saturation', active: { saturation: { bypass: false, characterCode: 2, drive: 80, mixPct: 100, multibandEnabled: false, bandDrivesPct: [50, 50, 50, 50], ...XO } } },
  { name: 'Transient', active: { transient: { bypass: false, attackPct: 80, sustainPct: -40, multibandEnabled: false, bandAttacksPct: [0, 0, 0, 0], bandSustainsPct: [0, 0, 0, 0], ...XO } } },
  // rangeDb is the POSITIVE magnitude (0–24); modeCode sets direction
  // (0=DownCut 1=UpBoost) — matching the renderer's dyneq-config.
  { name: 'DynamicEQ', active: { dynamicEq: { bypass: false, bands: [
    { enabled: true, typeCode: 0, freqHz: 2500, q: 1.5, thresholdDb: -36, ratio: 4, attackMs: 5, releaseMs: 80, rangeDb: 10, modeCode: 0 },
  ] } } },
];

function main(): void {
  if (!loadWasmModule()) { console.error('FAIL — node WASM not built (cannot prove modules)'); process.exit(1); }
  const n = SR; // 1 s
  const { l, r } = mix(n);
  const dry = renderStereoBuffer(l, r, base(), SR);
  let allPass = true;
  console.log('[module-effect-selftest] proving each module changes the Rust render');
  for (const m of MODULES) {
    const wet = renderStereoBuffer(l, r, base(m.active), SR);
    const d = diffRms(wet.left, dry.left) + diffRms(wet.right, dry.right);
    const ok = finite(wet.left) && finite(wet.right) && d > 1e-4 && rms(wet.left) > 1e-5;
    if (!ok) allPass = false;
    console.log(`  ${ok ? '✓' : '✗'} ${m.name}: Δrms=${d.toExponential(2)} ${finite(wet.left) ? '' : '(NaN!)'}`);
  }
  if (allPass) console.log('PASS — every export module measurably alters the Rust render');
  else { console.error('FAIL — a module had no effect / NaN'); process.exit(1); }
}

main();
