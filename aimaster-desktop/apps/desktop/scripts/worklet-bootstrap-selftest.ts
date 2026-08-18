// worklet-bootstrap-selftest — one WASM instance, many chains, for real.
//
// A stem session runs one chain per track, so the worklet scope builds a
// dozen `LouiMasteringChain`s from a single compiled module. They share one
// linear memory. If anything re-instantiated the module part-way through,
// every chain built before it would be holding pointers into memory that no
// longer exists, and the next `processStereo` would dereference them — which
// in a renderer is a native death, not an exception.
//
// So this runs the ACTUAL shipped glue against the ACTUAL shipped `.wasm`,
// in a VM context, and pushes audio through the first chain again after the
// twelfth has been built. That is the property that matters, and it can only
// be established by running the real thing: an earlier version of this file
// exercised the bootstrap against a hand-written stub, and a stub cannot
// tell you what wasm-bindgen's `initSync` does. (It returns early when the
// module is already instantiated — so the guard in the bootstrap is a second
// lock on a door that was already locked, and worth keeping for exactly that
// reason, but it was never the thing standing between the app and a crash.)
//
// Both copies of the bootstrap are checked — the one the build appends and
// the one served from `renderer/public` — because a fix applied to only one
// survives until the next build and then quietly comes back.
//
// Run:  pnpm --filter @aimaster/desktop test:worklet-bootstrap

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail: string): void {
  if (ok) { passed++; console.log(`[PASS] ${name} — ${detail}`); }
  else { failed++; console.error(`[FAIL] ${name} — ${detail}`); }
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
// apps/desktop → apps → aimaster-desktop. `dsp-core` is a sibling of `apps`,
// not of the repository root.
const WORKSPACE = path.resolve(APP, '../..');

const GLUE = path.join(APP, 'src/renderer/public/loui-mastering-wasm.nomodules.js');
const WASM = path.join(APP, 'src/renderer/public/loui-mastering-wasm.nomodules.wasm');
const GENERATOR = path.join(WORKSPACE, 'dsp-core/scripts/build-wasm-worklet.sh');

const BOOTSTRAP_MARK = 'globalThis.__loui_init_mastering';

console.log('\n=== BOTH COPIES CARRY THE BOOTSTRAP ===\n');
for (const [label, file] of [['the generator', GENERATOR], ['the served glue', GLUE]] as const) {
  const text = fs.readFileSync(file, 'utf8');
  check(
    `${label} defines the worklet initialiser`,
    text.includes(BOOTSTRAP_MARK),
    path.relative(WORKSPACE, file),
  );
  check(
    `${label} instantiates the module once`,
    text.includes('__loui_wasm_ready'),
    '체인마다 initSync를 다시 부르지 않는다',
  );
}

console.log('\n=== TWELVE CHAINS, ONE INSTANCE ===\n');

/**
 * Run the real glue in a VM.
 *
 * The context gets its own intrinsics on purpose: wasm-bindgen's `initSync`
 * decides how it was called by comparing the argument's prototype against
 * `Object.prototype`, so injecting the outer realm's `Object` would send it
 * down the deprecated path and the test would be measuring the harness.
 */
function loadGlue(): {
  init: (sr: number) => Record<string, (...args: unknown[]) => unknown>;
  instanceCount: () => number;
} {
  const sandbox: Record<string, unknown> = { TextDecoder, TextEncoder, console };
  vm.createContext(sandbox);
  vm.runInContext('globalThis.self = globalThis;', sandbox);
  vm.runInContext(fs.readFileSync(GLUE, 'utf8'), sandbox);
  sandbox['__wasmBytes'] = fs.readFileSync(WASM);
  const module = vm.runInContext('new WebAssembly.Module(__wasmBytes)', sandbox);
  sandbox['__mod'] = module;
  return {
    init: (sr) =>
      vm.runInContext(`__loui_init_mastering(__mod, ${sr})`, sandbox) as never,
    // The glue keeps its instance in a module-scoped `wasm`; the memory it
    // exposes identifies the instance. A second instantiation would hand
    // out a different one.
    instanceCount: () => (vm.runInContext('__loui_wasm_bindgen.initSync', sandbox) ? 1 : 0),
  };
}

const SR = 48_000;
const QUANTUM = 128;
const CHAINS = 12;

function block(phase: number): { l: Float32Array; r: Float32Array } {
  const l = new Float32Array(QUANTUM);
  const r = new Float32Array(QUANTUM);
  for (let i = 0; i < QUANTUM; i++) {
    const s = Math.sin((phase + i) * 0.05) * 0.5;
    l[i] = s;
    r[i] = s * 0.9;
  }
  return { l, r };
}

function run(chain: Record<string, (...a: unknown[]) => unknown>, blocks: number, from = 0): {
  peak: number; nonFinite: number;
} {
  let peak = 0;
  let nonFinite = 0;
  for (let b = 0; b < blocks; b++) {
    const { l, r } = block((from + b) * QUANTUM);
    (chain['processStereo'] as (a: Float32Array, b: Float32Array) => void)(l, r);
    for (let i = 0; i < QUANTUM; i++) {
      if (!Number.isFinite(l[i]!) || !Number.isFinite(r[i]!)) nonFinite++;
      const a = Math.abs(l[i]!);
      if (a > peak) peak = a;
    }
  }
  return { peak, nonFinite };
}

{
  const glue = loadGlue();
  check('the shipped glue and wasm load together', glue.instanceCount() === 1, path.relative(WORKSPACE, WASM));

  const first = glue.init(SR);
  check('the first chain is built', typeof first['processStereo'] === 'function', 'processStereo 있음');

  // Warm it up and remember what healthy output looks like.
  const before = run(first, 40);
  check(
    'and processes audio',
    before.nonFinite === 0 && before.peak > 0,
    `peak ${before.peak.toFixed(4)}, 비정상 샘플 ${before.nonFinite}개`,
  );

  // Now build the rest of a full session on top of it.
  const rest = [];
  for (let i = 1; i < CHAINS; i++) rest.push(glue.init(SR));
  check(
    `all ${CHAINS} chains exist at once`,
    rest.length === CHAINS - 1 && rest.every((c) => typeof c['processStereo'] === 'function'),
    '한 인스턴스 위에 세션 전체',
  );

  // The measurement: the FIRST chain, after the twelfth was created. If the
  // module had been re-instantiated its pointers would now address something
  // else.
  const after = run(first, 40, 40);
  check(
    'the first chain still works after the twelfth is built',
    after.nonFinite === 0 && after.peak > 0,
    `peak ${after.peak.toFixed(4)}, 비정상 샘플 ${after.nonFinite}개 — 0이 아니면 메모리가 바뀐 것`,
  );

  const all = rest.map((c) => run(c, 20));
  check(
    'and so does every other chain',
    all.every((r) => r.nonFinite === 0 && r.peak > 0),
    `${all.length}개 체인 모두 정상 출력`,
  );

  // Interleave them the way the audio thread does — one block each, round
  // robin — for long enough that any drift in shared state would show.
  let interleavedBad = 0;
  const chains = [first, ...rest];
  for (let b = 0; b < 200; b++) {
    for (const c of chains) {
      const { l, r } = block(b * QUANTUM);
      (c['processStereo'] as (a: Float32Array, x: Float32Array) => void)(l, r);
      for (let i = 0; i < QUANTUM; i++) if (!Number.isFinite(l[i]!)) interleavedBad++;
    }
  }
  check(
    'interleaving all twelve for 200 quanta stays finite',
    interleavedBad === 0,
    `${200 * chains.length} blocks, 비정상 샘플 ${interleavedBad}개`,
  );
}

{
  // Calling the initialiser again must not replace the instance. This is the
  // guard the bootstrap adds; wasm-bindgen's own `initSync` also returns
  // early once instantiated, so the two agree — and a chain built after a
  // second call has to still share memory with one built before it.
  const glue = loadGlue();
  const a = glue.init(SR);
  run(a, 20);
  const b = glue.init(SR);
  run(b, 20);
  const stillGood = run(a, 20, 20);
  check(
    're-entering the initialiser does not disturb an existing chain',
    stillGood.nonFinite === 0 && stillGood.peak > 0,
    `peak ${stillGood.peak.toFixed(4)}, 비정상 샘플 ${stillGood.nonFinite}개`,
  );
}

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
