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

/**
 * The only specifiers left out of the three bundles.
 *
 * Exported because electron-builder.yml excludes node_modules wholesale and
 * has to put each of these back by hand — a specifier added here and not
 * there breaks a packaged build only.  asar-payload-selftest.ts reads this
 * list and the yml and fails when they disagree, so neither side is a
 * transcription of the other.
 *
 * `electron` is the exception: the runtime provides it, it is not in the
 * app's node_modules, and nothing needs to ship it.
 */
const EXTERNAL = ['electron', 'node-machine-id'];
module.exports = { EXTERNAL };

// Required for EXTERNAL alone when a test imports this file, so stop before
// the builds.  A top-level `return` is legal in CommonJS — the module body is
// a function — and keeps the three build calls below at their own indent.
if (require.main !== module) return;

// v3.4.5 — Auto-update gate baked at build time.
// CI sets AUTO_UPDATE_ENABLED=true ONLY for tag pushes (production
// installer that ships to a published GitHub Release).  Branch / workflow_
// dispatch / dev builds default to false so the autoUpdater never queries
// GitHub for a release that doesn't exist (avoids the misleading
// "No published versions on GitHub" toast).  See src/main/updater.ts.
const AUTO_UPDATE_ENABLED = process.env.AUTO_UPDATE_ENABLED === 'true';

// v3.6 — License backend config baked at build time.  CI injects these for
// production installers (LICENSE_API_URL + LICENSE_API_KEY → RemoteValidator;
// LICENSE_HMAC_SECRET → tamper-resistant local binding).  When absent (dev /
// branch builds) license-core falls back to LocalValidator + the dev HMAC
// secret, and the packaged-only assertLicenseSecretReady() gate stays off.
const LICENSE_API_URL     = process.env.LICENSE_API_URL || '';
const LICENSE_API_KEY     = process.env.LICENSE_API_KEY || '';
const LICENSE_HMAC_SECRET = process.env.LICENSE_HMAC_SECRET || '';

const shared = {
  bundle:    true,
  platform:  'node',
  format:    'cjs',
  target:    'node20',
  sourcemap: isDev ? 'inline' : false,
  minify:    !isDev,
  external:  EXTERNAL,
  define: {
    '__AUTO_UPDATE_ENABLED__':        JSON.stringify(AUTO_UPDATE_ENABLED),
    'process.env.LICENSE_API_URL':     JSON.stringify(LICENSE_API_URL),
    'process.env.LICENSE_API_KEY':     JSON.stringify(LICENSE_API_KEY),
    'process.env.LICENSE_HMAC_SECRET': JSON.stringify(LICENSE_HMAC_SECRET),
  },
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

  // ── Plugin host ───────────────────────────────────────────────────────────
  // Forked as its own process so a third-party plugin that crashes takes down
  // one bounce instead of the session.  Built separately because a fork needs
  // a real file on disk, not a module inside the main bundle.
  esbuild.build({
    ...shared,
    entryPoints: ['src/main/plugins/host-worker.ts'],
    outfile:     'dist-electron/main/plugin-host.js',
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
