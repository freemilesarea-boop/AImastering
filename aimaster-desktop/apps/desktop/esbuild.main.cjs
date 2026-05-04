/**
 * esbuild bundler for Electron main + preload processes.
 *
 * Output layout (v3.4.2 — separated from renderer's dist/ to avoid the CI
 * cleanup-step bug where `rm -rf dist` between build and packaging wiped
 * the freshly-built main process):
 *
 *   src/main/index.ts    → dist-electron/main/index.js     (Node.js CJS)
 *   src/preload/index.ts → dist-electron/preload/index.js  (Node.js CJS)
 *
 * `electron` stays external in both — provided by the Electron runtime.
 * `node-machine-id` stays external — native module with .node bindings.
 */
const esbuild = require('esbuild');
const path    = require('path');

const isDev = process.argv.includes('--dev');

const shared = {
  bundle:    true,
  platform:  'node',
  format:    'cjs',
  target:    'node20',
  sourcemap: isDev ? 'inline' : false,
  minify:    !isDev,
  external:  ['electron', 'node-machine-id'],
};

const workspaceAlias = {
  '@aimaster/audio-engine': path.resolve(__dirname, '../../packages/audio-engine/src/index.ts'),
  '@aimaster/license-core': path.resolve(__dirname, '../../packages/license-core/src/index.ts'),
  '@aimaster/shared-types':  path.resolve(__dirname, '../../packages/shared-types/src/index.ts'),
};

Promise.all([
  // ── Main process ──────────────────────────────────────────────────────────
  esbuild.build({
    ...shared,
    entryPoints: ['src/main/index.ts'],
    outfile:     'dist-electron/main/index.js',
    alias:       workspaceAlias,
  }),

  // ── Preload ───────────────────────────────────────────────────────────────
  // Preload runs in a sandboxed renderer context; it only uses the
  // built-in `electron` module (contextBridge + ipcRenderer).
  // No workspace packages are imported — no alias needed.
  esbuild.build({
    ...shared,
    entryPoints: ['src/preload/index.ts'],
    outfile:     'dist-electron/preload/index.js',
  }),
]).catch((err) => {
  console.error(err);
  process.exit(1);
});
