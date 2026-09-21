/**
 * preview-ceiling-selftest.ts — the preview limiter's ceiling is in dBTP now.
 *
 * `LimiterConfig::ceiling_dbtp` is named dBTP and its module documented a
 * ceiling in dBTP, and the detector looked at `max(|l|, |r|)` — the SAMPLE
 * peak.  `isp` meant "subtract 0.3 dB and hope".  Measured with a validated
 * interpolator on dense material at a -1.0 dBTP ceiling:
 *
 *     sample peak  -1.00 dBTP   exactly on the ceiling
 *     true peak    +0.63 dBTP   above full scale, 1.63 over
 *     the isp flag worth 0.05 dB
 *
 * The detector oversamples now, so the flag does what its name says.  What
 * remains is about half a decibel, and it is the GAIN STEP, not the
 * detector: taking the detector from 4x to 16x moved the result 0.10 dB for
 * five times the arithmetic, and with auto-gain off and a quiet input —
 * where the limiter barely works — there is no overshoot at all.  Closing
 * that means ramping the gain inside the lookahead, which changes how the
 * limiter sounds and is its own piece of work.
 *
 * So this file holds what is true rather than what would be nice: the sample
 * peak is a hard bound, the true peak is bounded to within 0.6 dB, and the
 * flag is worth more than a decibel.  The EXPORT path is not involved — it
 * goes through the TypeScript limiter chain, which `true-peak-selftest`
 * holds to the ceiling exactly.
 *
 * The judge is `refinedTruePeakDb`, which `true-peak-selftest` validates
 * against peaks whose value is known analytically.
 */

import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ALL_MODULE_PARAMETER_DEFS, defaultAllModulesState,
  type AllModulesParameterState, type ModuleId, type ParameterValue,
} from '../src/renderer/audio/parameters/index.js';
import { buildChainConfig, chainConfigToJson } from '../src/renderer/audio/chain-config.js';
import { refinedTruePeakDb } from '../src/renderer/audio/truePeak.js';

const __dirname_ = path.dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);
const SR = 48_000;
const wasmPath = path.resolve(__dirname_, '../../../packages/dsp-wasm/pkg-node/loui_dsp_wasm.cjs');
interface WasmChain {
  setConfigJson(json: string): void;
  processStereo(l: Float32Array, r: Float32Array): void;
}
const Chain = (require_(wasmPath) as { LouiMasteringChain: new (sr: number) => WasmChain })
  .LouiMasteringChain;

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { passed += 1; console.log(`[PASS] ${name}${detail ? ` — ${detail}` : ''}`); }
  else    { failed += 1; console.log(`[FAIL] ${name}${detail ? ` — ${detail}` : ''}`); }
}

/** Dense and transient-rich with real HF — where inter-sample peaks live. */
function material(n: number, amp: number, seed0: number): Float32Array {
  const out = new Float32Array(n);
  let seed = seed0;
  const rnd = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const hit = Math.exp(-40 * ((t * 6) % 1));
    out[i] = amp * (0.5 * Math.sin(2 * Math.PI * 80 * t)
      + 0.9 * hit * (rnd() * 2 - 1)
      + 0.35 * Math.sin(2 * Math.PI * 11_000 * t));
  }
  return out;
}

function withParams(
  mods: Array<[ModuleId, Record<string, ParameterValue>]>,
): AllModulesParameterState {
  const s = defaultAllModulesState(ALL_MODULE_PARAMETER_DEFS);
  for (const [id, params] of mods) {
    s[id] = { ...s[id], parameters: { ...s[id].parameters, ...params } };
  }
  return s;
}

interface Result { samplePeak: number; truePeak: number }

function run(params: Record<string, ParameterValue>, amp = 0.35): Result {
  const cfg = buildChainConfig({
    state: withParams([['limiter', { targetLufs: -9, maxBoostDb: 24, ...params }]]),
    masterBypass: false,
  });
  const chain = new Chain(SR);
  chain.setConfigJson(chainConfigToJson(cfg));
  const n = SR * 6;
  const l = material(n, amp, 7);
  const r = material(n, amp * 0.97, 23);
  for (let a = 0; a < n; a += 512) {
    const b = Math.min(a + 512, n);
    chain.processStereo(l.subarray(a, b), r.subarray(a, b));
  }
  // The settled tail: the loudness loop is deliberately slow.
  const tail = (x: Float32Array): Float32Array => x.subarray(n - SR * 3);
  let sample = 0;
  for (const ch of [tail(l), tail(r)]) for (const v of ch) sample = Math.max(sample, Math.abs(v));
  return {
    samplePeak: 20 * Math.log10(Math.max(sample, 1e-12)),
    truePeak: Math.max(refinedTruePeakDb(tail(l)), refinedTruePeakDb(tail(r))),
  };
}

// ── 1. The hard bound: the sample peak ──────────────────────────────────────

// This states the guarantee; it does not isolate the final clamp that also
// enforces it.  Removing that clamp changes nothing measurable here, because
// with the detector working the gain already keeps every sample under the
// ceiling — the clamp is there for rounding, and rounding is not something
// this material provokes.  Said plainly rather than implied.
for (const ceiling of [-1, -0.3, -2]) {
  const got = run({ ceilingDbtp: ceiling, isp: true });
  check(`the sample peak never passes a ${ceiling} dB ceiling`,
    got.samplePeak <= ceiling + 0.05,
    `${got.samplePeak.toFixed(2)} dBFS`);
}

// ── 2. The soft bound: the true peak, which is what the field is named ──────

for (const ceiling of [-1, -0.3, -2]) {
  const got = run({ ceilingDbtp: ceiling, isp: true });
  const over = got.truePeak - ceiling;
  check(`and the TRUE peak stays within 0.6 dB of a ${ceiling} dBTP ceiling`,
    over <= 0.6,
    `${got.truePeak.toFixed(2)} dBTP, ${over >= 0 ? '+' : ''}${over.toFixed(2)} over`);
}

// ── 3. The flag has to be worth turning on ──────────────────────────────────

{
  const on = run({ ceilingDbtp: -1, isp: true });
  const off = run({ ceilingDbtp: -1, isp: false });
  const worth = off.truePeak - on.truePeak;
  // It used to be worth 0.05 dB, which is another way of saying it did
  // nothing: it subtracted a fixed 0.3 dB from a ceiling the limiter then
  // hit on the sample peak anyway.
  check('turning true-peak mode on is worth more than a decibel',
    worth > 0.8,
    `off ${off.truePeak.toFixed(2)} dBTP vs on ${on.truePeak.toFixed(2)} dBTP — ${worth.toFixed(2)} dB`);
  // And it must not buy that by simply turning everything down.  The test
  // for that is that the sample peak still sits ON the ceiling, not merely
  // below it: a first version allowed anything above -1.6 dBFS, and the
  // break that restores the old fixed 0.3 dB of headroom — which is exactly
  // "turn it down and hope" — sailed through at -1.30.
  check('and it does not buy it by making the preview quiet',
    on.samplePeak > -1.15,
    `sample peak ${on.samplePeak.toFixed(2)} dBFS against a -1.0 ceiling`);
}

// ── 4. Where the residual comes from ────────────────────────────────────────

{
  // Measured, and worth keeping measured: with the limiter barely working
  // there is no overshoot, which is what says the residual is the gain step
  // rather than the detector's resolution. If this ever stops being true,
  // the explanation in limiter.rs has gone stale.
  const quiet = run({ ceilingDbtp: -1, isp: true, autoGain: false, character: 'clean' }, 0.02);
  check('a signal that never reaches the ceiling is not pushed over it',
    quiet.truePeak < -20,
    `${quiet.truePeak.toFixed(2)} dBTP`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
