// wasm-resolve-selftest — does the APP find the offline render engine?
//
// Every other offline test answered that question from `src/main/offline`,
// because tsx runs them from the source tree.  The app does not: esbuild
// bundles the main process into `dist-electron/main/index.js`, one directory
// shallower, and the loader counted directories —
// `../../../../../packages/dsp-wasm/pkg-node` — so it landed one level above
// the workspace and found nothing.
//
//   from src/main/offline  → .../aimaster-desktop/packages/.../loui_dsp_wasm.cjs  ✓
//   from dist-electron/main → /home/user/packages/.../loui_dsp_wasm.cjs           ✗
//
// `isRustOfflineAvailable()` was therefore false in every dev run and in
// every packaged build (where the file was not copied at all), so three
// features silently took their failure path: the Studio's offline render
// (which then fell back to an engine that cannot read a chain config, and
// returned the original as if it were the master), the song profile behind
// the adaptive defaults, and the Match EQ reference measurement.
//
// So this test asks the question from the directories the app actually runs
// in, and reads the build config to find them rather than hard-coding them.

import fs from 'node:fs';
import path from 'node:path';
import {
  wasmNodeCandidates, WASM_NODE_RESOURCE_DIR, pythonFallbackMayStandIn,
  applyChainConfigForRender,
  type OfflineChainConfig, type WasmMasteringChain,
} from '../src/main/offline/load-mastering-chain-node.js';
import { isRustOfflineAvailable } from '../src/main/offline/process-audio-file-rust.js';
import { findUp, ancestorCandidates, PYTHON_ENTRY_REL } from '../src/main/utils/workspace-paths.js';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const DESKTOP = path.resolve(__dirname, '..');

/** The first candidate that exists, or null. */
function resolved(fromDir: string): string | null {
  for (const c of wasmNodeCandidates(fromDir, null)) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

console.log('\n── where the loader looks ──────────────────────────────────');

// 1. The source layout — what every other offline test exercises.
const fromSource = resolved(path.join(DESKTOP, 'src', 'main', 'offline'));
check(
  'found from src/main/offline (the layout tsx runs in)',
  fromSource !== null,
  String(fromSource),
);

// 2. The built layout — what the app runs in.  This is the regression.
//
// The directory is read out of esbuild.main.cjs rather than written here,
// so moving the build output cannot leave this test checking a path nothing
// produces any more.
const esbuildCfg = fs.readFileSync(path.join(DESKTOP, 'esbuild.main.cjs'), 'utf8');
const outfile = /outfile:\s*'([^']*main\/index\.js)'/.exec(esbuildCfg)?.[1];
check(
  "esbuild.main.cjs still declares the main bundle's outfile",
  typeof outfile === 'string',
  String(outfile),
);
const builtDir = path.join(DESKTOP, path.dirname(outfile ?? 'dist-electron/main'));
const fromBuilt = resolved(builtDir);
check(
  `found from the built main bundle's directory (${path.relative(DESKTOP, builtDir)})`,
  fromBuilt !== null,
  'the loader counted directories; from here the count was one too many',
);
check(
  'and it is the same file the source layout finds',
  fromBuilt !== null && fromBuilt === fromSource,
  `${String(fromBuilt)} vs ${String(fromSource)}`,
);

// 3. Depth-independence is the actual property. Any directory inside the
//    workspace must find it, so a future output path cannot break this.
const deep = path.join(DESKTOP, 'a', 'b', 'c', 'd', 'e', 'f');
check(
  'found from an arbitrarily deep directory inside the workspace',
  resolved(deep) === fromSource,
  String(resolved(deep)),
);

// 4. The availability predicate the IPC handler gates on.
check(
  'isRustOfflineAvailable() is true in this workspace',
  isRustOfflineAvailable(),
  'the offline chain render, song profile and Match EQ reference all need it',
);

// 5. The explicit override still wins, and the packaged location is still
//    offered.
const over = wasmNodeCandidates(DESKTOP, '/Res');
check(
  'the packaged resources directory is a candidate',
  over.includes(path.join('/Res', WASM_NODE_RESOURCE_DIR, 'loui_dsp_wasm.cjs')),
  over[over.length - 1] ?? '',
);
process.env['LOUI_WASM_NODE_PATH'] = '/explicit/loui_dsp_wasm.cjs';
check(
  'LOUI_WASM_NODE_PATH is tried first',
  wasmNodeCandidates(DESKTOP, null)[0] === '/explicit/loui_dsp_wasm.cjs',
);
delete process.env['LOUI_WASM_NODE_PATH'];

// 3b. Every other workspace path the main process reaches for, asked from
//     both depths.  The Python bridge's was `../../../../services/...`,
//     right from `dist-electron/main` and wrong from `src/main/ipc` — the
//     same arithmetic as the bug above, pointing the other way, and correct
//     only because nothing happens to run it from source.
for (const [label, rel] of [['the dev Python entry point', PYTHON_ENTRY_REL]] as const) {
  const a = findUp(path.join(DESKTOP, 'src', 'main', 'ipc'), rel);
  const b = findUp(builtDir, rel);
  check(
    `${label} resolves from the source layout`,
    a !== null, String(a),
  );
  check(
    `${label} resolves from the built main bundle too`,
    b !== null && b === a,
    `${String(b)} vs ${String(a)}`,
  );
}

// And the walk itself: nearest ancestor first, root last, no duplicates.
const walk = ancestorCandidates('/a/b/c', 'x/y');
check(
  'the ancestor walk goes nearest-first and reaches the root',
  walk[0] === path.join('/a/b/c', 'x/y')
    && walk[walk.length - 1] === path.join('/', 'x/y')
    && new Set(walk).size === walk.length,
  walk.join(' · '),
);

console.log('\n── and does the packaged app ship it ───────────────────────');

// 6. The packaged candidate is only a candidate if something copies the
//    file there. Nothing did: `dsp-wasm-node` appeared in the loader and
//    nowhere in electron-builder.yml, so a packaged build could not have
//    worked even with the path arithmetic fixed.
const yml = fs.readFileSync(path.join(DESKTOP, 'electron-builder.yml'), 'utf8');
const entries = [...yml.matchAll(/-\s*from:\s*"([^"]+)"\s*\n\s*to:\s*"([^"]+)"/g)]
  .map((m) => ({ from: m[1]!, to: m[2]! }));
const wasmEntry = entries.find((e) => e.from.includes('dsp-wasm/pkg-node'));
check(
  'electron-builder.yml copies packages/dsp-wasm/pkg-node into the app',
  wasmEntry !== undefined,
  entries.map((e) => `${e.from}→${e.to}`).join(', '),
);
check(
  "and copies it to exactly the directory the loader looks in",
  wasmEntry?.to === WASM_NODE_RESOURCE_DIR,
  `yml says "${String(wasmEntry?.to)}", loader says "${WASM_NODE_RESOURCE_DIR}"`,
);
// The `from` is relative to the app directory, so it has to actually exist
// from there — a typo'd path is silently skipped by electron-builder.
const fromDir = path.resolve(DESKTOP, wasmEntry?.from ?? 'nowhere');
check(
  'the `from` directory resolves to the real pkg-node from apps/desktop',
  fs.existsSync(path.join(fromDir, 'loui_dsp_wasm.cjs')),
  fromDir,
);
// The glue requires its .wasm sibling by real path, so copying one without
// the other packages a module that throws on load.
const filterBlock = /dsp-wasm\/pkg-node"[\s\S]*?filter:([\s\S]*?)\n  - from:/.exec(yml)?.[1] ?? '';
check(
  'both the .cjs glue and its .wasm sibling are copied',
  filterBlock.includes('*.cjs') && filterBlock.includes('*.wasm'),
  filterBlock.trim().replace(/\s+/g, ' '),
);

console.log('\n── and when it cannot be used, does anything pretend ───────');

// 7. The Python engine may stand in only when there is nothing to drop.
check(
  'the Python fallback may stand in for a request with no chain config',
  pythonFallbackMayStandIn({}) && pythonFallbackMayStandIn(null) && pythonFallbackMayStandIn(undefined),
);
check(
  'but never for one carrying a suite config',
  !pythonFallbackMayStandIn({ suiteConfig: { limiter: { enabled: true } } }),
  'it takes five scalars and cannot apply a chain — the master would be the original',
);

// 8. A WASM build without `setConfigJson` cannot honour a suite config
//    either. It used to fall through to the 22-argument flat call, with a
//    config that carries none of those 22 fields.
const flatCalls: unknown[][] = [];
const oldChain = {
  setConfig: (...a: unknown[]) => { flatCalls.push(a); },
  setParametricEqBands: () => {},
  parametricEqBandCount: () => 0,
  processStereo: () => {},
  limiterGrDb: () => 0,
  reset: () => {},
} as unknown as WasmMasteringChain;
let threw = false;
try {
  applyChainConfigForRender(oldChain, { suiteConfig: { limiter: {} } } as OfflineChainConfig);
} catch { threw = true; }
check(
  'applying a suite config to a chain that cannot take one throws',
  threw && flatCalls.length === 0,
  flatCalls.length > 0
    ? `it called setConfig(${flatCalls[0]!.map(String).join(', ')})`
    : 'nothing was applied',
);

// And the flat path still works for a caller that really has flat fields.
const flat: OfflineChainConfig = {
  inputGainDb: 0,
  eqLowCutHz: 20, eqLowShelfDb: 0, eqPresenceDb: 0, eqAirDb: 0,
  eqAdaptive: false, eqBypass: true,
  dynThresholdDb: -18, dynRatio: 2, dynAttackMs: 10, dynReleaseMs: 100,
  dynMixPct: 100, dynBypass: true,
  imgWidthPct: 100, imgLowMonoHz: 120, imgBypass: true,
  limCeilingDbtp: -1, limLookaheadMs: 5, limIsp: true, limBypass: true,
  outputGainDb: 0, masterBypass: false,
};
applyChainConfigForRender(oldChain, flat);
check(
  'a flat config still goes through the positional call',
  flatCalls.length === 1 && flatCalls[0]!.length === 22,
  `${flatCalls.length} call(s), ${flatCalls[0]?.length ?? 0} args`,
);

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed === 0 ? 0 : 1);
