// worklet-bootstrap-selftest — one WASM instance per worklet scope.
//
// This guards a crash, not a wrong number. `__loui_init_mastering` used to
// call `initSync` on every call, and `initSync` does not merely wire imports:
// it creates a new `WebAssembly.Instance` and rebinds the glue's module-scoped
// `wasm` to it. So the second chain replaced the linear memory that the first
// chain had already handed out pointers into, and the next `processStereo` on
// the older chain dereferenced an address that had become something else.
//
// The renderer died with SIGSEGV — exit code 11, a black window, and nothing
// in the JavaScript console, because nothing threw. It only appeared once a
// session ran one chain per track; every earlier caller built exactly one
// node and never tripped it.
//
// The bootstrap is appended to the generated glue by
// `dsp-core/scripts/build-wasm-worklet.sh`, and the served copy lives in
// `renderer/public`. Both are checked, because a fix applied to only one of
// them survives until the next build and then silently comes back.
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
// apps/desktop → apps → aimaster-desktop. `dsp-core` is a sibling of
// `apps`, not of the repository root.
const WORKSPACE = path.resolve(APP, '../..');

const SOURCES: Array<{ label: string; file: string }> = [
  { label: 'the generator', file: path.join(WORKSPACE, 'dsp-core/scripts/build-wasm-worklet.sh') },
  { label: 'the served glue', file: path.join(APP, 'src/renderer/public/loui-mastering-wasm.nomodules.js') },
];

/**
 * The bootstrap block the build appends to the generated glue.
 *
 * Extracted rather than evaluating the whole 1200-line wasm-bindgen output:
 * the block is self-contained (it touches `wasm_bindgen` and `globalThis`
 * and nothing else), and running it alone is what lets the real shipped text
 * be executed against a stub instead of being pattern-matched.
 */
function extractBootstrap(text: string): string | null {
  const start = text.indexOf('globalThis.__loui_wasm_bindgen = wasm_bindgen;');
  if (start < 0) return null;
  const end = text.indexOf('};', text.indexOf('globalThis.__loui_init_mastering', start));
  if (end < 0) return null;
  return text.slice(start, end + 2);
}

/** Run a bootstrap block against a stub and report what it did. */
function exercise(code: string, chains: number): { inits: number; built: number; sameInstance: boolean } {
  let inits = 0;
  let built = 0;
  // Stands in for the linear memory the glue rebinds on every `initSync`.
  let instance = { id: 0 };
  const seen: Array<{ id: number }> = [];

  const wasm_bindgen = {
    initSync(): void { inits += 1; instance = { id: inits }; },
    LouiMasteringChain: function (this: Record<string, unknown>) {
      built += 1;
      // A chain captures the instance that was live when it was built —
      // which is exactly what makes a later re-init fatal.
      seen.push(instance);
    } as unknown as new (sr: number) => unknown,
  };

  const sandbox: Record<string, unknown> = { wasm_bindgen };
  sandbox['globalThis'] = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);

  const init = sandbox['__loui_init_mastering'] as (m: unknown, sr: number) => unknown;
  for (let i = 0; i < chains; i++) init({}, 48_000);

  return { inits, built, sameInstance: seen.every((s) => s === seen[0]) };
}

console.log('\n=== ONE INSTANCE, MANY CHAINS ===\n');

for (const src of SOURCES) {
  const text = fs.readFileSync(src.file, 'utf8');
  const code = extractBootstrap(text);

  if (!code) {
    check(`${src.label} carries the bootstrap`, false, `${src.file} 안에서 찾지 못함`);
    continue;
  }
  check(`${src.label} carries the bootstrap`, true, path.relative(WORKSPACE, src.file));

  const r = exercise(code, 12);
  check(
    `${src.label}: twelve chains instantiate the module once`,
    r.inits === 1,
    `initSync ${r.inits}회 — 두 번 이상이면 먼저 만든 체인의 포인터가 사라진 메모리를 가리킨다 (SIGSEGV)`,
  );
  check(
    `${src.label}: and all twelve are built`,
    r.built === 12,
    `${r.built}개 체인`,
  );
  check(
    `${src.label}: every chain shares the one instance`,
    r.sameInstance,
    '체인은 각자 상태를 갖지만 메모리는 하나를 공유한다 — Rust 쪽이 기대하는 모양',
  );
}

{
  // The control. Without it, "one init" could be passing because the stub
  // never counts anything.
  const broken = `
    globalThis.__loui_wasm_bindgen = wasm_bindgen;
    globalThis.__loui_init_mastering = function (wasmModule, sr) {
      wasm_bindgen.initSync({ module: wasmModule });
      return new wasm_bindgen.LouiMasteringChain(sr);
    };`;
  const r = exercise(broken, 12);
  check(
    'control — the old bootstrap re-instantiates on every chain',
    r.inits === 12 && !r.sameInstance,
    `initSync ${r.inits}회, 인스턴스 공유 ${r.sameInstance} — 크래시가 났던 그 코드`,
  );
}

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
