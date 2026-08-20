/**
 * prebuild.cjs — Copy platform-specific FFmpeg/FFprobe binaries into
 * apps/desktop/public/bin/ so electron-builder can include them in
 * extraResources.
 *
 * Packages used:
 *   ffmpeg-static          → provides ffmpeg binary
 *   @ffprobe-installer/ffprobe → provides ffprobe binary
 *
 * Both packages ship pre-built binaries for mac/win/linux; npm selects
 * the correct one for the build machine's platform automatically.
 *
 * ── v3.6.0-intel: ARCHITECTURE GUARD ────────────────────────────────────────
 * The macOS CI job used to run on `macos-14` (Apple Silicon) and package BOTH
 * `--arm64 --x64` in one invocation.  electron-builder swaps the Electron
 * shell per arch, but `extraResources` is arch-blind: whatever sits in
 * public/bin at package time is copied verbatim into *every* arch's bundle.
 *
 * Because this script resolves `require('ffmpeg-static')` — which points at
 * the binary npm installed for the BUILD MACHINE — the x64 (Intel) .app
 * shipped with arm64 ffmpeg/ffprobe inside Resources/bin.  On a real Intel
 * Mac those binaries cannot execute at all (Rosetta translates x64→arm64,
 * never the reverse), so `checkFFmpeg()` failed at startup and the app died
 * before showing a window.  The bundle *looked* like a valid Intel app in
 * Finder ("종류: 응용 프로그램(Intel)") because the Electron shell really was
 * x64 — only the sidecars were wrong.
 *
 * Building each arch on a runner of that arch would fix it, but `macos-13` —
 * the last free GitHub-hosted Intel image — has been retired, so the Intel
 * artefact is cross-built on an arm64 runner with every x64 binary sourced
 * explicitly (FFMPEG_BINARY / FFPROBE_BINARY, and an x86_64 CPython for
 * PyInstaller).  See .github/workflows/build-mac-intel.yml.
 *
 * Cross-building is only safe when it is checked, so this guard makes the
 * check non-negotiable: if the binaries we just copied do not match the arch
 * we are packaging for, the build FAILS here instead of shipping a silently
 * broken app.  Set AIMASTER_TARGET_ARCH to the arch being packaged (the Intel
 * workflow sets it to `x64`); it defaults to the host arch.
 *
 * Run:  node apps/desktop/scripts/prebuild.cjs
 */

'use strict';

const fs        = require('node:fs');
const path      = require('node:path');
const { execFileSync } = require('node:child_process');

const BIN_DIR = path.join(__dirname, '../public/bin');
const IS_WIN  = process.platform === 'win32';
const IS_MAC  = process.platform === 'darwin';

/** Arch we are packaging FOR — not necessarily the host arch. */
const TARGET_ARCH = process.env.AIMASTER_TARGET_ARCH || process.arch;

/** node arch name → the name `lipo -archs` prints. */
const LIPO_NAME = { x64: 'x86_64', arm64: 'arm64' };

fs.mkdirSync(BIN_DIR, { recursive: true });

/**
 * Return the architectures inside a Mach-O file, or null when the arch
 * cannot be determined (non-macOS host, non-Mach-O file, lipo missing).
 */
function machoArchs(file) {
  if (!IS_MAC) return null;
  try {
    return execFileSync('lipo', ['-archs', file], { encoding: 'utf8' })
      .trim()
      .split(/\s+/)
      .filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * Fail the build when a bundled binary cannot run on the target arch.
 * A universal (fat) binary that *contains* the target arch is fine.
 */
function assertArch(file, name) {
  const archs = machoArchs(file);
  if (!archs) return;   // not macOS, or not a Mach-O — nothing to check
  const want = LIPO_NAME[TARGET_ARCH] || TARGET_ARCH;
  if (archs.includes(want)) {
    console.log(`  ↳ arch ok: ${archs.join(', ')} (target ${want})`);
    return;
  }
  console.error('');
  console.error(`✗ ARCH MISMATCH — ${name}`);
  console.error(`  file:     ${file}`);
  console.error(`  contains: ${archs.join(', ')}`);
  console.error(`  required: ${want}  (AIMASTER_TARGET_ARCH=${TARGET_ARCH})`);
  console.error('');
  console.error('  Unless overridden, this binary comes from the npm package');
  console.error('  installed for the BUILD MACHINE, so on a cross-build it is');
  console.error('  only correct when staged for the target arch explicitly.');
  console.error('');
  console.error('  → Set FFMPEG_BINARY / FFPROBE_BINARY to binaries staged for');
  console.error('    the target arch (npm_config_arch=x64 npm install ...), as');
  console.error('    .github/workflows/build-mac-intel.yml does.');
  console.error('  → Do NOT pass --x64 --arm64 in a single electron-builder');
  console.error('    invocation: the extraResources sidecars are copied');
  console.error('    arch-blind, so one of the two bundles gets unusable ones.');
  console.error('');
  process.exitCode = 1;
}

function copyBin(srcPath, name) {
  if (!srcPath || !fs.existsSync(srcPath)) {
    console.error(`✗ ${name}: source not found at ${srcPath}`);
    process.exitCode = 1;
    return;
  }
  const ext  = IS_WIN ? '.exe' : '';
  const dest = path.join(BIN_DIR, `${name}${ext}`);
  fs.copyFileSync(srcPath, dest);
  fs.chmodSync(dest, 0o755);
  const sizeKb = Math.round(fs.statSync(dest).size / 1024);
  console.log(`✓ ${name}${ext}  (${sizeKb} KB)  →  ${dest}`);
  assertArch(dest, name);
}

console.log(`prebuild: platform=${process.platform} host-arch=${process.arch} target-arch=${TARGET_ARCH}`);

// ── FFmpeg ────────────────────────────────────────────────────────────────────
// ffmpeg-static downloads ONE binary at install time for the host
// platform/arch.  FFMPEG_BINARY lets a caller point at a binary they staged
// themselves (e.g. a manually fetched darwin-x64 build).
try {
  const ffmpegPath = process.env.FFMPEG_BINARY || require('ffmpeg-static');
  copyBin(ffmpegPath, 'ffmpeg');
} catch (e) {
  console.error('✗ ffmpeg-static not installed:', e.message);
  console.error('  Run: pnpm add -D ffmpeg-static');
  process.exitCode = 1;
}

// ── FFprobe ───────────────────────────────────────────────────────────────────
// @ffprobe-installer/ffprobe re-exports one of its per-platform optional
// dependencies (@ffprobe-installer/darwin-x64, darwin-arm64, …).  When the
// target arch differs from the host we try the exact per-arch package first,
// so a cross-build still has a chance of producing a correct binary.
function resolveFfprobe() {
  if (process.env.FFPROBE_BINARY) return process.env.FFPROBE_BINARY;
  if (TARGET_ARCH !== process.arch) {
    const platformPkg = `@ffprobe-installer/${process.platform}-${TARGET_ARCH}`;
    try {
      const { path: p } = require(platformPkg);
      console.log(`  (cross-build) resolved ffprobe from ${platformPkg}`);
      return p;
    } catch {
      console.warn(`  (cross-build) ${platformPkg} not installed — falling back to host ffprobe`);
    }
  }
  const { path: p } = require('@ffprobe-installer/ffprobe');
  return p;
}

try {
  copyBin(resolveFfprobe(), 'ffprobe');
} catch (e) {
  console.error('✗ @ffprobe-installer/ffprobe not installed:', e.message);
  console.error('  Run: pnpm add -D @ffprobe-installer/ffprobe');
  process.exitCode = 1;
}

// ── Python engine (built separately by PyInstaller in CI) ─────────────────────
// Not produced here, but if it is already staged we hold it to the same rule:
// an arm64 `engine` inside an Intel app is exactly the bug this guard exists
// to stop.
const enginePath = path.join(BIN_DIR, IS_WIN ? 'engine.exe' : 'engine');
if (fs.existsSync(enginePath)) {
  console.log(`• engine (pre-staged)  →  ${enginePath}`);
  assertArch(enginePath, 'engine');
}

if (!process.exitCode) {
  console.log('\nFFmpeg binaries ready in public/bin/');
}
