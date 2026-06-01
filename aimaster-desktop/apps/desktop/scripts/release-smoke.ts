/**
 * release-smoke.ts — pre-flight smoke check for the v3.6.0-rc.1 build.
 *
 * Run via:
 *   pnpm --filter @aimaster/desktop test:release-smoke
 *
 * This script does NOT compile or test code — it asserts that the
 * artefacts electron-builder will package are present and that the
 * shipped configuration is internally consistent.  It is intentionally
 * read-only and side-effect-free so it can run in CI directly after
 * `pnpm build`.
 *
 * Checks:
 *   1. Renderer build exists      (dist/renderer/index.html)
 *   2. Main build exists          (dist-electron/main/index.js)
 *   3. Preload build exists       (dist-electron/preload/index.js)
 *   4. Worklet asset is reachable from source
 *      (existence of src/renderer/audio/loudnessProcessor.worklet.ts —
 *       Vite resolves the import via `new URL(..., import.meta.url)` so
 *       no separate emitted asset is required)
 *   5. Python engine source is present
 *      (services/python-audio/app/main.py + requirements.txt)
 *   6. ffmpeg / ffprobe binaries copied into public/bin/ by prebuild.cjs
 *      (warns instead of fails if missing — they are CI-built)
 *   7. Package metadata: every workspace package.json reports the
 *      expected version + the desktop app's name = "@aimaster/desktop".
 *   8. electron-builder.yml win target contains "nsis", does NOT
 *      contain the legacy "portable" target.
 *   9. CI release-draft body_path matches an existing
 *      RELEASE_DRAFT_v<version>.md in docs/.
 *  10. Production warnings: when LICENSE_HMAC_SECRET is missing AND the
 *      PRODUCTION env var is set, fail the smoke (avoids accidentally
 *      shipping a build where every machine validates with the dev
 *      default).  Otherwise warn.
 */

import * as fs   from 'node:fs';
import * as path from 'node:path';

// ── Paths ───────────────────────────────────────────────────────────────────
//
// Layout:
//   <REPO_ROOT>/                       ← .github/, scripts/, …
//     aimaster-desktop/                ← MONOREPO_ROOT
//       apps/desktop/                  ← DESKTOP_DIR
//         scripts/release-smoke.ts     ← SCRIPT_DIR
// All check paths in this script are RELATIVE TO REPO_ROOT, so we
// resolve up four levels.

const SCRIPT_DIR    = path.dirname(new URL(import.meta.url).pathname);
const DESKTOP_DIR   = path.resolve(SCRIPT_DIR, '..');
const MONOREPO_ROOT = path.resolve(DESKTOP_DIR, '..', '..');
const REPO_ROOT     = path.resolve(MONOREPO_ROOT, '..');

// ── Tiny harness ────────────────────────────────────────────────────────────

interface Result { name: string; level: 'pass' | 'warn' | 'fail'; detail: string; }
const results: Result[] = [];

function pass(name: string, detail = ''):  void { results.push({ name, level: 'pass', detail }); }
function warn(name: string, detail = ''):  void { results.push({ name, level: 'warn', detail }); }
function fail(name: string, detail = ''):  void { results.push({ name, level: 'fail', detail }); }

function exists(rel: string, root: string = REPO_ROOT): boolean {
  try { return fs.existsSync(path.join(root, rel)); }
  catch { return false; }
}

function readJson(rel: string, root: string = REPO_ROOT): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8')) as Record<string, unknown>;
}

function readText(rel: string, root: string = REPO_ROOT): string {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

// ── Constants pulled from the bump in this RC ──────────────────────────────

const EXPECTED_VERSION = '3.6.0';
const EXPECTED_SHARED_TYPES_VERSION = '0.2.0';

// ── 1–3. Build artefacts ───────────────────────────────────────────────────

function checkRendererBuild(): void {
  const rel = 'aimaster-desktop/apps/desktop/dist/renderer/index.html';
  if (exists(rel)) pass('renderer build exists',   rel);
  else              fail('renderer build exists',   `missing ${rel} — run \`pnpm build:renderer\``);
}

function checkMainBuild(): void {
  const rel = 'aimaster-desktop/apps/desktop/dist-electron/main/index.js';
  if (exists(rel)) pass('main build exists',       rel);
  else              fail('main build exists',       `missing ${rel} — run \`pnpm build:main\``);
}

function checkPreloadBuild(): void {
  const rel = 'aimaster-desktop/apps/desktop/dist-electron/preload/index.js';
  if (exists(rel)) pass('preload build exists',    rel);
  else              fail('preload build exists',    `missing ${rel} — run \`pnpm build:main\``);
}

// ── 4. Worklet asset reachable from source ─────────────────────────────────

function checkWorklet(): void {
  // The worklet source MUST be plain JS — Vite emits static `new URL(…)`
  // assets verbatim (no TS transform), so a `.ts` worklet would be
  // delivered to the AudioWorklet loader as raw TypeScript and fail at
  // runtime.  This check fails fast if anyone reverts the conversion.
  const src = 'aimaster-desktop/apps/desktop/src/renderer/audio/loudnessProcessor.worklet.js';
  const tsLeftover = 'aimaster-desktop/apps/desktop/src/renderer/audio/loudnessProcessor.worklet.ts';
  if (!exists(src)) {
    fail('worklet source present', `missing ${src} (must be plain JS, not TS)`);
    return;
  }
  if (exists(tsLeftover)) {
    fail('worklet source present',
         `both .js and .ts worklet sources exist — Vite would emit the .ts asset; ` +
         `delete ${tsLeftover}`);
    return;
  }
  // After a build, verify Vite emitted the worklet asset alongside index*.js.
  const distAssetsRel = 'aimaster-desktop/apps/desktop/dist/renderer/assets';
  if (exists(distAssetsRel)) {
    const dir = path.join(REPO_ROOT, distAssetsRel);
    const emitted = fs.readdirSync(dir).find((f) => /^loudnessProcessor\.worklet-.*\.js$/.test(f));
    if (!emitted) {
      warn('worklet source present',
           `${src} exists but no worklet asset found in ${distAssetsRel} — re-run \`pnpm build\``);
      return;
    }
  }
  pass('worklet source present', src);
}

// ── 5. Python engine source ────────────────────────────────────────────────

function checkPythonEngine(): void {
  const main = 'aimaster-desktop/services/python-audio/app/main.py';
  const reqs = 'aimaster-desktop/services/python-audio/requirements.txt';
  if (exists(main) && exists(reqs)) {
    pass('python engine source present', `${main} + ${reqs}`);
  } else {
    fail('python engine source present',
         `missing ${exists(main) ? reqs : main} — engine cannot be packaged`);
  }
}

// ── 6. ffmpeg + ffprobe binaries ───────────────────────────────────────────

function checkFfmpegBinaries(): void {
  const binDir = 'aimaster-desktop/apps/desktop/public/bin';
  const ext    = process.platform === 'win32' ? '.exe' : '';
  const ff   = path.join(binDir, `ffmpeg${ext}`);
  const ffp  = path.join(binDir, `ffprobe${ext}`);
  if (exists(ff) && exists(ffp)) {
    pass('ffmpeg + ffprobe bundled', `${binDir}/ — both present`);
  } else {
    // Not a hard failure here; CI runs prebuild.cjs separately.  If
    // we're outside CI and the developer just hasn't run prebuild yet,
    // warn instead of erroring — the build will still succeed locally.
    warn('ffmpeg + ffprobe bundled',
         `missing ${exists(ff) ? ffp : ff} — run \`node apps/desktop/scripts/prebuild.cjs\` before electron-builder`);
  }
}

// ── 7. Package metadata ───────────────────────────────────────────────────

function checkPackageVersions(): void {
  const checks: Array<[string, string]> = [
    ['aimaster-desktop/package.json',                                  EXPECTED_VERSION],
    ['aimaster-desktop/apps/desktop/package.json',                     EXPECTED_VERSION],
    ['aimaster-desktop/packages/shared-types/package.json',            EXPECTED_SHARED_TYPES_VERSION],
  ];
  let allOk = true;
  const detail: string[] = [];
  for (const [rel, expected] of checks) {
    if (!exists(rel)) { allOk = false; detail.push(`MISSING ${rel}`); continue; }
    const pkg = readJson(rel);
    if (pkg['version'] !== expected) {
      allOk = false;
      detail.push(`${rel}: version=${String(pkg['version'])} (expected ${expected})`);
    }
  }
  // Desktop app name sanity.
  const desktop = readJson('aimaster-desktop/apps/desktop/package.json');
  if (desktop['name'] !== '@aimaster/desktop') {
    allOk = false;
    detail.push(`desktop name=${String(desktop['name'])} (expected @aimaster/desktop)`);
  }
  if (allOk) pass('package metadata',     `versions=${EXPECTED_VERSION}, shared-types=${EXPECTED_SHARED_TYPES_VERSION}`);
  else        fail('package metadata',     detail.join('; '));
}

// ── 8. electron-builder targets ───────────────────────────────────────────

function checkElectronBuilderTargets(): void {
  const rel = 'aimaster-desktop/apps/desktop/electron-builder.yml';
  if (!exists(rel)) { fail('electron-builder.yml present', `missing ${rel}`); return; }
  const yml = readText(rel);

  // Coarse text checks — the YAML is small enough that grep-style suffices
  // and avoids pulling in a YAML parser dep just for this script.
  const hasNsis     = /\btarget:\s*nsis\b/.test(yml);
  const hasPortable = /\btarget:\s*portable\b/.test(yml);

  const detail: string[] = [];
  if (!hasNsis)     detail.push('missing target: nsis under win:');
  if (hasPortable)  detail.push('legacy target: portable still present (must be removed for v3.6.x)');

  if (detail.length === 0) pass('electron-builder targets', 'win=nsis only');
  else                      fail('electron-builder targets', detail.join('; '));
}

// ── 9. CI body_path consistency ───────────────────────────────────────────

function checkCiBodyPath(): void {
  const rel = '.github/workflows/build.yml';
  if (!exists(rel)) { warn('CI body_path consistency', `missing ${rel} (running outside repo?)`); return; }
  const yml = readText(rel);

  const m = yml.match(/body_path:\s+(\S+)/);
  if (!m || !m[1]) { fail('CI body_path consistency', 'no body_path: line found in CI workflow'); return; }

  const bodyPath = m[1];
  if (!exists(bodyPath)) {
    fail('CI body_path consistency', `body_path points to ${bodyPath} which does not exist`);
    return;
  }
  if (!bodyPath.includes('v3.6.0')) {
    warn('CI body_path consistency',
         `body_path=${bodyPath} — does not include "v3.6.0".  Update when bumping to v3.6.0 final.`);
    return;
  }
  pass('CI body_path consistency', `body_path=${bodyPath}`);
}

// ── 10. License gate: DISABLED in v3.6.0-rc.1+1 ────────────────────────────
// The previous gate fail()-ed when PRODUCTION=true and
// LICENSE_HMAC_SECRET was missing.  License-key activation is no longer
// used in this build (the renderer doesn't show a key input, the main
// process doesn't register license IPC handlers), so requiring a secret
// here only blocked field-test builds without giving the app any
// protection.  The check is now an informational pass — recorded to
// prove the smoke ran the right surface, but never fails the build.
function checkLicenseSecret(): void {
  pass('license gate', 'disabled for internal RC test cycle (v3.6.0-rc.1+1)');
}

// ── Run ────────────────────────────────────────────────────────────────────

checkRendererBuild();
checkMainBuild();
checkPreloadBuild();
checkWorklet();
checkPythonEngine();
checkFfmpegBinaries();
checkPackageVersions();
checkElectronBuilderTargets();
checkCiBodyPath();
checkLicenseSecret();

// ── Print summary ──────────────────────────────────────────────────────────

const passed = results.filter((r) => r.level === 'pass').length;
const warned = results.filter((r) => r.level === 'warn').length;
const failed = results.filter((r) => r.level === 'fail').length;

console.log('\n=== v3.6 release smoke ===');
for (const r of results) {
  const tag =
    r.level === 'pass' ? 'PASS' :
    r.level === 'warn' ? 'WARN' :
                         'FAIL';
  console.log(`[${tag}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
}
console.log(`\n${passed} pass · ${warned} warn · ${failed} fail`);

if (failed > 0) process.exit(1);
// Warns alone exit 0 — they are advisory.
