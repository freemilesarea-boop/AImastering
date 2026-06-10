// Selftest — committed WASM artifacts are fresh vs the Rust binding source.
//
// The wasm/node/worklet artifacts (packages/dsp-wasm/pkg, pkg-node, and the
// renderer public/ worklet assets) are COMMITTED and CI does NOT rebuild them.
// So if someone adds a `#[wasm_bindgen(js_name = ...)]` method to the Rust
// binding but forgets to rebuild + commit, the new method silently never
// reaches the runtime.  This guard fails loudly in that case.
//
// Checks:
//   1. Every explicit `js_name = X` exported by loui-dsp-wasm appears in the
//      committed pkg/.d.ts AND pkg-node/.d.ts (web + node artifacts fresh).
//   2. The generated worklet copy (public/mastering-chain.worklet.js) is
//      byte-identical to its source (audio/mastering-chain.worklet.js) — i.e.
//      build:worklet was run after the source changed, and nobody edited the
//      generated copy directly.
//
// Run via `pnpm test:wasm-fresh`.  Headless.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');            // apps/desktop
const REPO = resolve(ROOT, '..', '..');           // aimaster-desktop
const LIB_RS = resolve(REPO, 'dsp-core/crates/loui-dsp-wasm/src/lib.rs');
const PKG_DTS = resolve(REPO, 'packages/dsp-wasm/pkg/loui_dsp_wasm.d.ts');
const PKG_NODE_DTS = resolve(REPO, 'packages/dsp-wasm/pkg-node/loui_dsp_wasm.d.ts');
const WORKLET_SRC = resolve(ROOT, 'src/renderer/audio/mastering-chain.worklet.js');
const WORKLET_PUB = resolve(ROOT, 'src/renderer/public/mastering-chain.worklet.js');

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { console.log(`  ✓ ${name}`); }
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

console.log('wasm-freshness-selftest');

// ── 1. js_name exports present in committed .d.ts ──────────────────────────
console.log('binding exports present in committed artifacts');
{
  const lib = readFileSync(LIB_RS, 'utf8');
  const names = [...lib.matchAll(/js_name\s*=\s*(\w+)/g)].map((m) => m[1]!);
  const unique = [...new Set(names)].sort();
  check(`found ${unique.length} js_name exports in lib.rs`, unique.length > 0);

  const pkg = readFileSync(PKG_DTS, 'utf8');
  const node = readFileSync(PKG_NODE_DTS, 'utf8');
  const missingWeb = unique.filter((n) => !pkg.includes(n));
  const missingNode = unique.filter((n) => !node.includes(n));
  check('pkg/.d.ts (web) contains every js_name export', missingWeb.length === 0,
    missingWeb.length ? `STALE — rebuild: pnpm --filter @loui/dsp-wasm run build:web. missing: ${missingWeb.join(', ')}` : '');
  check('pkg-node/.d.ts contains every js_name export', missingNode.length === 0,
    missingNode.length ? `STALE — rebuild: pnpm --filter @loui/dsp-wasm run build:node. missing: ${missingNode.join(', ')}` : '');
}

// ── 2. worklet generated copy == source ────────────────────────────────────
console.log('worklet generated copy is in sync with its source');
{
  const src = readFileSync(WORKLET_SRC, 'utf8');
  const pub = readFileSync(WORKLET_PUB, 'utf8');
  check('public/mastering-chain.worklet.js === audio/ source', src === pub,
    src === pub ? '' : 'OUT OF SYNC — run: pnpm --filter @loui/dsp-wasm run build:worklet (edit the audio/ SOURCE, not public/)');
}

if (failures > 0) {
  console.error(`\nFAILED: ${failures} check(s) — committed WASM artifacts are stale.`);
  console.error('Fix: rebuild all targets and commit:');
  console.error('  pnpm --filter @loui/dsp-wasm run build:all');
  process.exit(1);
}
console.log('\nALL FRESH');
