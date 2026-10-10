/**
 * preview-worklet-selftest — does the PREVIEW engine honour each module?
 *
 * Every other check in this suite measures a config: move a parameter,
 * rebuild the JSON, see whether it changed.  That answers "is the value
 * carried" and nothing more, and the difference matters, because this repo
 * has twice been wrong about the preview by reading names instead of audio:
 *
 *   • 23 parameters declared `status: 'pending'` with notes promising
 *     "M2-full will add it" for fields the Rust engine had all along.
 *   • A report claimed "the realtime chain carries 17 of 223 parameters",
 *     measured off `stateToChainConfig` — a five-module mapping for the
 *     WebAudio fallback that `fixtures/test-only-exports.txt` already
 *     listed as reached by nothing but a test.  Sixteen controls were
 *     tagged "inaudible in the preview" in the running app on the strength
 *     of it.  All sixteen were audible.
 *
 * So this file does not read a config.  It loads the committed worklet
 * assets — `public/loui-mastering-wasm.nomodules.{js,wasm}`, the same bytes
 * `mastering-worklet-loader.ts` hands the AudioWorkletProcessor — builds the
 * same `LouiMasteringChain` through the same `__loui_init_mastering`
 * bootstrap, pushes audio through it, and compares samples.
 *
 * ── Two things that had to be got right ─────────────────────────────────
 *
 * The judge is validated before it is trusted.  `reset()` does not clear
 * everything: the same config run twice came back 10 dB apart, which would
 * have made every per-module verdict noise.  A fresh chain per run fixes it,
 * and the check below fails if two identical runs ever differ again.
 *
 * Engagement is per-parameter.  Pushing every parameter of a module to its
 * far end at once silenced three working modules — the de-esser's threshold
 * went to 0 dBFS, which nothing exceeds.  So one control moves at a time and
 * a module counts as honoured if ANY of them moves the audio, which is the
 * same rule `parameter-reach-selftest` uses and for the same reason.
 *
 * Run:  pnpm --filter @aimaster/desktop test:preview-worklet
 */

import { readFileSync, existsSync } from 'node:fs';
import { buildChainConfig, chainConfigToJson } from '../src/renderer/audio/chain-config.js';
import { ALL_MODULE_PARAMETER_DEFS } from '../src/renderer/audio/parameters/module-parameter-definitions.js';
import {
  MODULE_IDS, defaultAllModulesState,
  type AllModulesParameterState, type ModuleId, type ParameterDef,
} from '../src/renderer/audio/parameters/parameter-state.js';
import { LOUI_MODULES } from '../src/renderer/audio/modules/loui-module-suite.js';

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}
function assert(cond: unknown, detail: string): void { if (!cond) throw new Error(detail); }

const SR = 48_000;
const GLUE = 'src/renderer/public/loui-mastering-wasm.nomodules.js';
const WASM = 'src/renderer/public/loui-mastering-wasm.nomodules.wasm';

interface Chain {
  setConfigJson(json: string): void;
  processStereo(l: Float32Array, r: Float32Array): void;
  latencySamples(): number;
}

let freshChain: () => Chain = () => { throw new Error('wasm not loaded'); };
let loadError = '';
try {
  assert(existsSync(GLUE) && existsSync(WASM), `worklet assets missing: ${GLUE} / ${WASM}`);
  const mod = new WebAssembly.Module(readFileSync(WASM));
  // The glue is a `--target no-modules` bundle: evaluating it defines the
  // bootstrap on globalThis, exactly as it does in the worklet scope.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(readFileSync(GLUE, 'utf8'))();
  const g = globalThis as unknown as {
    __loui_init_mastering?: (m: WebAssembly.Module, sr: number) => Chain;
    __loui_wasm_bindgen?: { LouiMasteringChain: new (sr: number) => Chain };
  };
  const boot = g.__loui_init_mastering;
  if (typeof boot !== 'function') {
    throw new Error('the glue did not define __loui_init_mastering — the worklet bootstrap is missing');
  }
  boot(mod, SR);
  const bindgen = g.__loui_wasm_bindgen;
  if (bindgen === undefined) throw new Error('the glue did not expose __loui_wasm_bindgen');
  freshChain = () => new bindgen.LouiMasteringChain(SR);
} catch (e) { loadError = e instanceof Error ? e.message : String(e); }

/** Broadband + tones, with L ≠ R so the stereo modules have something to work on. */
const N = SR / 2;
function signal(): [Float32Array, Float32Array] {
  const l = new Float32Array(N); const r = new Float32Array(N);
  let seed = 12345;
  const rnd = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x3fffffff - 1; };
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    const tone = 0.18 * Math.sin(2 * Math.PI * 60 * t)
      + 0.18 * Math.sin(2 * Math.PI * 1000 * t)
      + 0.12 * Math.sin(2 * Math.PI * 7000 * t);
    l[i] = tone + 0.06 * rnd();
    r[i] = tone * 0.85 + 0.06 * rnd();
  }
  return [l, r];
}

/** Push the signal through a fresh chain at the worklet's own 128-frame quantum. */
function run(json: string): Float32Array {
  const [l, r] = signal();
  const chain = freshChain();
  chain.setConfigJson(json);
  const BLK = 128;
  for (let off = 0; off + BLK <= N; off += BLK) {
    chain.processStereo(l.subarray(off, off + BLK), r.subarray(off, off + BLK));
  }
  const out = new Float32Array(N * 2);
  out.set(l, 0); out.set(r, N);
  return out;
}

function maxAbsDiffDb(a: Float32Array, b: Float32Array): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs((a[i] ?? 0) - (b[i] ?? 0)));
  return m === 0 ? -Infinity : 20 * Math.log10(m);
}
function peakDb(a: Float32Array): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] ?? 0));
  return m === 0 ? -Infinity : 20 * Math.log10(m);
}

/** Somewhere audibly away from where the state starts. */
function away(def: ParameterDef): unknown {
  if (def.kind === 'number') {
    const mid = (def.min + def.max) / 2;
    const at = Number(def.default);
    if (Math.abs(def.max - at) > Math.abs(at - def.min)) return def.max;
    return def.min === 0 ? mid : def.min;
  }
  if (def.kind === 'boolean') return !def.default;
  return def.values.find((v) => v !== def.default) ?? def.default;
}

// Match EQ is off without a curve to match, and the free EQ's bands are an
// input rather than a parameter.  Both get what they need, as in
// parameter-reach-selftest.
const MATCH_TARGET = Array.from({ length: 32 }, (_, i) => (i % 4) - 1.5);
const FREE_BANDS = [{ enabled: true, frequencyHz: 1000, gainDb: 6, q: 1, type: 'peaking' }];
function cfgFor(state: AllModulesParameterState, bands = FREE_BANDS): string {
  return chainConfigToJson(buildChainConfig({
    state, matchTargetCurveDb: MATCH_TARGET, parametricBands: bands as never,
  }));
}

const neutral = defaultAllModulesState(ALL_MODULE_PARAMETER_DEFS);
const AUDIBLE = -60;   // a difference below this is not a module working

check('the committed worklet assets load and build a chain', () => {
  assert(loadError === '', loadError);
  const lat = freshChain().latencySamples();
  assert(Number.isFinite(lat) && lat >= 0, `latencySamples() returned ${lat}`);
});

let ref: Float32Array = new Float32Array(0);

check('the same config twice is bit-identical — the judge is usable', () => {
  assert(loadError === '', 'skipped: the wasm did not load');
  const base = cfgFor(neutral);
  ref = run(base);
  const d = maxAbsDiffDb(ref, run(base));
  assert(d === -Infinity,
    `two identical runs differ by ${d.toFixed(1)} dB — state is surviving between runs, `
    + 'so no per-module verdict below would mean anything');
});

check('and it passes audio rather than silence', () => {
  assert(loadError === '', 'skipped: the wasm did not load');
  const p = peakDb(ref);
  assert(p > -40, `the neutral chain's output peaks at ${p.toFixed(1)} dBFS — nothing is getting through`);
});

const honoured = new Map<ModuleId, { db: number; via: string }>();

check('every module in the suite is honoured by the preview engine', () => {
  assert(loadError === '', 'skipped: the wasm did not load');
  const silent: string[] = [];
  for (const id of MODULE_IDS) {
    const defs = ALL_MODULE_PARAMETER_DEFS[id];
    if (defs === undefined || id === 'export') continue;
    // `parametric-eq` has no parameters of its own — checked below, through
    // the band list that is its real control.
    if (defs.parameters.length === 0) continue;
    let best = -Infinity;
    let via = '';
    for (const d of defs.parameters) {
      const state: AllModulesParameterState = {
        ...neutral,
        [id]: {
          ...neutral[id], bypass: false,
          parameters: { ...neutral[id].parameters, [d.id]: away(d) } as never,
        },
      };
      let diff = -Infinity;
      try { diff = maxAbsDiffDb(ref, run(cfgFor(state))); } catch { continue; }
      if (diff > best) { best = diff; via = d.id; }
      if (best > -40) break;
    }
    if (best <= AUDIBLE) silent.push(`${id} (best ${best === -Infinity ? '-inf' : best.toFixed(1)} dB)`);
    else honoured.set(id, { db: best, via });
  }
  assert(silent.length === 0,
    `${silent.length} module(s) no control of which moved the audio: ${silent.join(', ')}`);
});

check('the free EQ is honoured through its band list', () => {
  assert(loadError === '', 'skipped: the wasm did not load');
  const d = maxAbsDiffDb(run(cfgFor(neutral, [])), run(cfgFor(neutral)));
  assert(d > AUDIBLE, `adding a +6 dB band at 1 kHz moved the audio by ${d === -Infinity ? '-inf' : d.toFixed(1)} dB`);
});

check('and the module registry\'s previewSupport says so too', () => {
  // The claim this file exists to check.  `previewSupport` is documented as
  // "whether the realtime Rust preview chain processes this", and it is what
  // the rack shows the user — so a module claiming `full` that the engine
  // ignores is a promise the product does not keep.
  assert(loadError === '', 'skipped: the wasm did not load');
  const wrong: string[] = [];
  for (const m of LOUI_MODULES) {
    const pid = m.paramModuleId as ModuleId | undefined;
    if (pid === undefined || pid === 'export') continue;
    const measured = honoured.has(pid) || pid === 'parametric-eq';
    if (m.previewSupport === 'full' && !measured) wrong.push(`${m.id} claims full`);
    if (m.previewSupport === 'none' && measured) wrong.push(`${m.id} claims none`);
  }
  assert(wrong.length === 0, `${wrong.length} registry claim(s) the engine contradicts: ${wrong.join(', ')}`);
});

console.log('');
for (const [id, r] of honoured) {
  console.log(`      ${id.padEnd(17)} ${r.db.toFixed(1).padStart(7)} dB via ${r.via}`);
}
console.log('');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
const bad = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - bad}/${results.length} passed${bad ? `, ${bad} FAILED` : ''}`);
if (bad) process.exit(1);
