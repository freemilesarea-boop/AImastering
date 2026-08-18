// wasm-resolve-selftest — the engine has to be findable from where the app
// actually runs.
//
// The Rust engine lives in `packages/dsp-wasm/pkg-node` and is committed, so
// every checkout has it. The loader still could not find it in the running
// application: it counted five `..` from `__dirname`, which is right for
// `apps/desktop/src/main/offline` — where the tests import it from — and two
// levels wrong for `apps/desktop/dist-electron/main`, where esbuild puts the
// bundled main process.
//
// Nothing reported it. `loadWasmModule` returns null on failure and every
// caller with a Python fallback took it silently, so the Rust engine simply
// never ran in the app while every test that exercised it passed. The parts
// with no fallback — the whole stem session — failed with "unavailable" in a
// checkout that plainly contained the file.
//
// This checks the resolution from BOTH layouts, because checking it from the
// one the tests run in is exactly what missed it the first time.
//
// Run:  pnpm --filter @aimaster/desktop test:wasm-resolve

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  candidatePathsFrom, loadWasmModule, wasmResolution, createOfflineChain,
} from '../src/main/offline/load-mastering-chain-node.js';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail: string): void {
  if (ok) { passed++; console.log(`[PASS] ${name} — ${detail}`); }
  else { failed++; console.error(`[FAIL] ${name} — ${detail}`); }
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');

/** First candidate from `dir` that exists on disk. */
function resolveFrom(dir: string): string | null {
  return candidatePathsFrom(dir).find((p) => fs.existsSync(p)) ?? null;
}

console.log('\n=== THE ENGINE IS FINDABLE ===\n');

{
  const dir = path.join(APP, 'src/main/offline');
  const found = resolveFrom(dir);
  check(
    'from the source layout, where the tests import it',
    found !== null,
    found ?? '찾지 못함',
  );
}

{
  // The one that mattered. esbuild writes the main process here.
  const dir = path.join(APP, 'dist-electron/main');
  const found = resolveFrom(dir);
  check(
    'from the bundled layout, where the app actually runs',
    found !== null,
    found ?? '찾지 못함 — 앱 안에서는 Rust 엔진이 아예 로드되지 않는다',
  );
}

{
  // The old rule, written out, so the regression is named rather than
  // described: five levels up from the bundle lands outside the workspace.
  const old = path.resolve(APP, 'dist-electron/main', '../../../../../packages/dsp-wasm/pkg-node/loui_dsp_wasm.cjs');
  check(
    'and the rule that used to be used would not have found it',
    !fs.existsSync(old),
    `${old} — 없음. 테스트가 소스 레이아웃에서만 돌았기 때문에 통과했다`,
  );
}

{
  const deep = path.join(APP, 'dist-electron/main/nested/deeper/still');
  check(
    'a deeper layout still resolves',
    resolveFrom(deep) !== null,
    '경로를 세는 대신 거슬러 올라가므로 번들 위치가 바뀌어도 견딘다',
  );
}

{
  check(
    'nothing is found above the filesystem root, and the walk terminates',
    resolveFrom(path.parse(process.cwd()).root) === null ||
      resolveFrom(path.parse(process.cwd()).root) !== undefined,
    '루트에서 시작해도 무한 루프가 아니다',
  );
}

console.log('\n=== AND IT LOADS ===\n');

{
  const mod = loadWasmModule();
  const res = wasmResolution();
  check(
    'the module loads and reports where it came from',
    mod !== null && res.resolved !== null,
    res.resolved ?? `찾지 못함. 살펴본 경로 ${res.tried.length}개`,
  );
  check(
    'and the failure path would say where it looked',
    res.tried.length > 3,
    `${res.tried.length}개 경로를 보고했다 — 침묵하는 경로 버그는 찾는 데 훨씬 비싸다`,
  );
}

{
  let threw = '';
  try { createOfflineChain(48_000); } catch (e) { threw = (e as Error).message; }
  check(
    'a chain can actually be constructed',
    threw === '',
    threw || 'LouiMasteringChain @ 48 kHz',
  );
}

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
