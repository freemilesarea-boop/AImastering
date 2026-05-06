/**
 * Pre-build hook for AudioWorklet sources.
 *
 * Vite handles `new URL('./x.ts', import.meta.url)` by emitting the file
 * as a separate static asset — but it does NOT transpile TypeScript-only
 * syntax inside that asset.  Browsers' AudioWorkletGlobalScope refuses
 * to parse the resulting raw .ts file (declare, type annotations).
 *
 * Run this before `vite build` (and once at dev startup) to esbuild each
 * .worklet.ts into a sibling .worklet.js that Vite copies as plain JS.
 *
 * Caller pattern in package.json:
 *   "build:renderer": "node scripts/build-worklets.cjs && vite build"
 */
const esbuild = require('esbuild');
const path    = require('path');
const fs      = require('fs');

const SRC_DIR = path.resolve(__dirname, '../src/renderer/audio');

const entries = fs.readdirSync(SRC_DIR)
  .filter((f) => f.endsWith('.worklet.ts'))
  .map((f) => path.join(SRC_DIR, f));

if (!entries.length) {
  console.log('[worklets] no .worklet.ts found, skipping');
  process.exit(0);
}

for (const entry of entries) {
  const out = entry.replace(/\.worklet\.ts$/, '.worklet.js');
  esbuild.buildSync({
    entryPoints: [entry],
    bundle:      false,    // worklets are self-contained on purpose
    format:      'esm',    // modern AudioWorklet supports ESM
    target:      'es2020',
    outfile:     out,
    loader:      { '.ts': 'ts' },
    logLevel:    'info',
  });
  console.log(`[worklets] ${path.basename(entry)} → ${path.basename(out)}`);
}
