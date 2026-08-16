// loudness-controls-selftest — the volume controls actually change volume.
//
// Reported symptom: "the limiter and the volume-related controls do nothing
// in the preview — moving LUFS and the rest barely changes the level."
//
// It was true, for two separate reasons, and neither would have shown up in
// any test that existed:
//
//   1. `limiter.targetLufs` was read by nobody. `chain-config.ts` never
//      looked at it. The panel drew it, the state stored it, and it stopped
//      there. Its `binding` even claimed `status: 'wired'` — that field is
//      documentation, not wiring, so nothing checked the claim.
//
//   2. `limiter.driveDb` — the one control that makes a master louder, read
//      by the config builder and used by the Rust limiter as the maximizer
//      input — had NO parameter definition at all, so it read its default
//      of 0 forever and could not be reached from the UI.
//
// Meanwhile the offline render DID honour the target, by measuring its own
// output and re-rendering with the input gain adjusted. So the preview was
// raw chain output while the export was normalised — routinely 6-10 dB
// apart, with the preview the quiet one.
//
// Every check here pushes real audio through the real WASM chain and
// measures the level that comes out.
//
// Run:  pnpm --filter @aimaster/desktop test:loudness-controls

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ALL_MODULE_PARAMETER_DEFS,
  defaultAllModulesState,
  type AllModulesParameterState,
  type ModuleId,
  type ParameterValue,
} from '../src/renderer/audio/parameters/index.js';
import { buildChainConfig, chainConfigToJson } from '../src/renderer/audio/chain-config.js';

const __dirname_ = path.dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);
const SR = 48_000;

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail: string): void {
  if (ok) { passed++; console.log(`[PASS] ${name} — ${detail}`); }
  else { failed++; console.error(`[FAIL] ${name} — ${detail}`); }
}

interface WasmChain {
  setConfigJson(json: string): void;
  processStereo(left: Float32Array, right: Float32Array): void;
}
const wasmPath = path.resolve(__dirname_, '../../../packages/dsp-wasm/pkg-node/loui_dsp_wasm.cjs');
const Chain = (require_(wasmPath) as { LouiMasteringChain: new (sr: number) => WasmChain })
  .LouiMasteringChain;

/**
 * Music-like material: partials plus a beat, so the limiter has something
 * to work on and the loudness measurement means something. A pure sine
 * would let a bug hide behind a constant envelope.
 */
function material(n: number, amp: number): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const beat = 1 + 0.9 * Math.exp(-8 * ((t * 2) % 1));
    out[i] = amp * beat * (
      0.5 * Math.sin(2 * Math.PI * 110 * t) +
      0.3 * Math.sin(2 * Math.PI * 440 * t) +
      0.2 * Math.sin(2 * Math.PI * 2200 * t)
    );
  }
  return out;
}

/**
 * Render and measure.
 *
 * Six seconds, measured over the last two: the loudness loop is deliberately
 * slow — a fast one is a compressor that flattens the song — so a short
 * render would measure it mid-flight.
 */
function render(state: AllModulesParameterState, amp = 0.25): { rms: number; peak: number } {
  const cfg = buildChainConfig({ state, masterBypass: false });
  const chain = new Chain(SR);
  chain.setConfigJson(chainConfigToJson(cfg));
  const n = SR * 6;
  const l = material(n, amp);
  const r = material(n, amp);
  for (let a = 0; a < n; a += 512) {
    const b = Math.min(a + 512, n);
    chain.processStereo(l.subarray(a, b), r.subarray(a, b));
  }
  const from = n - SR * 2;
  let sum = 0;
  let peak = 0;
  for (let i = from; i < n; i++) {
    sum += l[i]! * l[i]!;
    peak = Math.max(peak, Math.abs(l[i]!));
  }
  return {
    rms: 20 * Math.log10(Math.max(Math.sqrt(sum / (n - from)), 1e-9)),
    peak: 20 * Math.log10(Math.max(peak, 1e-9)),
  };
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

console.log('\n=== THE CONTROLS EXIST AND REACH THE ENGINE ===\n');

{
  // The defect in its simplest form: does the parameter exist at all?
  // `driveDb` did not, which is why it was stuck at 0 forever.
  const ids = new Set(ALL_MODULE_PARAMETER_DEFS.limiter.parameters.map((p) => p.id));
  for (const id of ['targetLufs', 'driveDb', 'autoGain', 'maxBoostDb']) {
    check(`the limiter defines "${id}"`, ids.has(id), ids.has(id) ? 'present' : 'MISSING');
  }
}

{
  const cfg = buildChainConfig({
    state: withParams([['limiter', { targetLufs: -9, driveDb: 4 }]]),
    masterBypass: false,
  });
  check(
    'targetLufs reaches the chain config',
    cfg.loudness?.targetLufs === -9,
    `loudness.targetLufs = ${String(cfg.loudness?.targetLufs)}`,
  );
  check(
    'driveDb reaches the chain config',
    cfg.limiter?.driveDb === 4,
    `limiter.driveDb = ${String(cfg.limiter?.driveDb)}`,
  );
}

console.log('\n=== TARGET LUFS CHANGES THE LEVEL ===\n');

{
  const quiet = render(withParams([['limiter', { targetLufs: -20 }]]));
  const loud = render(withParams([['limiter', { targetLufs: -9 }]]));
  const moved = loud.rms - quiet.rms;
  check(
    'raising the target makes it louder',
    moved > 6,
    `-20 → -9 LUFS moved the output ${moved.toFixed(2)} dB`,
  );
}

{
  // The direction and the amount both have to be right, so sweep it.
  const levels = [-20, -17, -14, -11, -9].map(
    (t) => render(withParams([['limiter', { targetLufs: t }]])).rms,
  );
  let monotonic = true;
  for (let i = 1; i < levels.length; i++) {
    if (levels[i]! <= levels[i - 1]!) monotonic = false;
  }
  check(
    'every step up the target is a step up in level',
    monotonic,
    levels.map((v) => v.toFixed(1)).join(' → '),
  );
}

{
  // A quiet source and a loud source must land at the SAME output level —
  // that is the whole point of a loudness target, and it is what makes a
  // batch of twenty songs come out even.
  //
  // Given room to work: the default +12 dB cap deliberately refuses to
  // close a 20 dB gap, which the next check is about.
  const tune = { targetLufs: -14, maxBoostDb: 24 };
  const fromQuiet = render(withParams([['limiter', tune]]), 0.06);
  const fromLoud = render(withParams([['limiter', tune]]), 0.6);
  const gap = Math.abs(fromLoud.rms - fromQuiet.rms);
  check(
    'a quiet source and a loud source land at the same level',
    gap < 1.5,
    `20 dB apart at the input, ${gap.toFixed(2)} dB apart at the output`,
  );
}

{
  // And when it cannot match, the cap is why. A source far quieter than
  // the cap can lift must come out audibly short — the guard working,
  // rather than the loop silently doing something else.
  const tune = { targetLufs: -14, maxBoostDb: 12 };
  const fromQuiet = render(withParams([['limiter', tune]]), 0.006);
  const fromLoud = render(withParams([['limiter', tune]]), 0.6);
  const gap = fromLoud.rms - fromQuiet.rms;
  check(
    'a source quieter than the cap can lift comes out short, by the cap',
    gap > 12,
    `${gap.toFixed(2)} dB short, from a 40 dB input gap with only 12 dB of boost allowed`,
  );
}

{
  const on = render(withParams([['limiter', { autoGain: true, targetLufs: -9 }]]), 0.06);
  const off = render(withParams([['limiter', { autoGain: false, targetLufs: -9 }]]), 0.06);
  check(
    'turning Auto Gain off leaves the level alone',
    on.rms - off.rms > 6,
    `auto ${on.rms.toFixed(1)} dB vs manual ${off.rms.toFixed(1)} dB`,
  );
}

{
  const capped = render(
    withParams([['limiter', { targetLufs: -6, maxBoostDb: 3, autoGain: true }]]),
    0.01,
  );
  const uncapped = render(
    withParams([['limiter', { targetLufs: -6, maxBoostDb: 18, autoGain: true }]]),
    0.01,
  );
  check(
    'Max Boost limits how far Auto Gain will go',
    uncapped.rms - capped.rms > 6,
    `+3 dB cap ${capped.rms.toFixed(1)} dB vs +18 dB cap ${uncapped.rms.toFixed(1)} dB`,
  );
}

console.log('\n=== DRIVE CHANGES THE LEVEL ===\n');

{
  const levels = [0, 3, 6, 12].map(
    (d) => render(withParams([['limiter', { driveDb: d, autoGain: false }]])).rms,
  );
  let monotonic = true;
  for (let i = 1; i < levels.length; i++) {
    if (levels[i]! <= levels[i - 1]! - 0.01) monotonic = false;
  }
  check(
    'more drive is never less level',
    monotonic && levels[3]! - levels[0]! > 2,
    levels.map((v) => v.toFixed(1)).join(' → '),
  );
}

console.log('\n=== THE CEILING IS STILL THE LAST WORD ===\n');

{
  // The bug the loudness loop exposed: `output_gain` runs after the
  // limiter, so a positive trim walked past the ceiling the limiter had
  // just enforced. It read +1.70 dBFS with a +3 dB trim — a clipped file.
  let worst = -99;
  let worstAt = 0;
  for (const g of [0, 3, 6, 12]) {
    const r = render(withParams([['eq', { outputGainDb: g }]]));
    if (r.peak > worst) { worst = r.peak; worstAt = g; }
  }
  check(
    'a positive output trim cannot push past the ceiling',
    worst <= -1.0 + 0.15,
    `worst peak ${worst.toFixed(2)} dBFS at +${worstAt} dB trim, ceiling -1.0 dBTP`,
  );
}

{
  let worst = -99;
  for (const t of [-20, -14, -9, -6]) {
    for (const d of [0, 6, 12]) {
      const r = render(withParams([['limiter', { targetLufs: t, driveDb: d }]]), 0.6);
      worst = Math.max(worst, r.peak);
    }
  }
  check(
    'no combination of target and drive breaks the ceiling',
    worst <= -1.0 + 0.15,
    `worst peak across 12 combinations: ${worst.toFixed(2)} dBFS`,
  );
}

console.log('\n=== THE CEILING ITSELF STILL WORKS ===\n');

{
  // With Auto Gain OFF the ceiling is the only thing setting the peak, so
  // lowering it must lower the peak, step for step.
  const levels = [-0.1, -3, -6, -12].map(
    (c) => render(withParams([['limiter', { ceilingDbtp: c, autoGain: false }]]), 0.9).peak,
  );
  let tracks = true;
  for (let i = 1; i < levels.length; i++) {
    if (levels[i]! >= levels[i - 1]!) tracks = false;
  }
  check(
    'with Auto Gain off, lowering the ceiling lowers the peak',
    tracks,
    levels.map((v) => v.toFixed(1)).join(' → '),
  );
}

{
  // With Auto Gain ON it does NOT, and that is correct rather than a bug.
  //
  // The loop targets loudness, so a lower ceiling means the limiter takes
  // more away, which means the loop pushes more in to compensate. The
  // master gets more limited, not quieter — exactly what a maximizer does,
  // and the opposite of what someone expects the first time they see it.
  // Worth a test so nobody "fixes" it later.
  const loud = render(withParams([['limiter', { ceilingDbtp: -0.5, targetLufs: -12 }]])).rms;
  const squashed = render(withParams([['limiter', { ceilingDbtp: -6, targetLufs: -12 }]])).rms;
  check(
    'with Auto Gain on, a lower ceiling means more limiting, not less level',
    Math.abs(squashed - loud) < 2.5,
    `ceiling -0.5 → ${loud.toFixed(1)} dB, ceiling -6 → ${squashed.toFixed(1)} dB`,
  );
  const peaks = [-0.5, -3, -6, -12].map(
    (c) => render(withParams([['limiter', { ceilingDbtp: c, targetLufs: -12 }]])).peak,
  );
  const held = peaks.every((p, i) => p <= [-0.5, -3, -6, -12][i]! + 0.15);
  check(
    'and the ceiling is still never exceeded',
    held,
    peaks.map((v) => v.toFixed(1)).join(' → '),
  );
}

{
  // Bypassing the limiter must genuinely bypass it — including the new
  // ceiling clamp, which would otherwise be a limiter that cannot be
  // switched off.
  const on = render(withParams([['limiter', { ceilingDbtp: -12, autoGain: false }]]), 0.9);
  const s = defaultAllModulesState(ALL_MODULE_PARAMETER_DEFS);
  s.limiter = { ...s.limiter, bypass: true, parameters: { ...s.limiter.parameters, ceilingDbtp: -12, autoGain: false } };
  const off = render(s, 0.9);
  check(
    'bypassing the limiter also bypasses the ceiling clamp',
    off.peak > on.peak + 3,
    `bypassed ${off.peak.toFixed(1)} dBFS vs limited ${on.peak.toFixed(1)} dBFS`,
  );
}

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed === 0 ? 0 : 1);
