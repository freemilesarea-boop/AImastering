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
 * Run:  node apps/desktop/scripts/prebuild.cjs
 */

'use strict';

const fs   = require('node:fs');
const path = require('node:path');

const BIN_DIR = path.join(__dirname, '../public/bin');
const IS_WIN  = process.platform === 'win32';

fs.mkdirSync(BIN_DIR, { recursive: true });

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
}

// ── FFmpeg ────────────────────────────────────────────────────────────────────
try {
  const ffmpegPath = require('ffmpeg-static');
  copyBin(ffmpegPath, 'ffmpeg');
} catch (e) {
  console.error('✗ ffmpeg-static not installed:', e.message);
  console.error('  Run: pnpm add -D ffmpeg-static');
  process.exitCode = 1;
}

// ── FFprobe ───────────────────────────────────────────────────────────────────
try {
  const { path: ffprobePath } = require('@ffprobe-installer/ffprobe');
  copyBin(ffprobePath, 'ffprobe');
} catch (e) {
  console.error('✗ @ffprobe-installer/ffprobe not installed:', e.message);
  console.error('  Run: pnpm add -D @ffprobe-installer/ffprobe');
  process.exitCode = 1;
}

// ── The Python engine ─────────────────────────────────────────────────────────
//
// Not copied — checked.  Building it needs a Python venv and PyInstaller, and
// CI does that before it gets here.  What this script can do is refuse to let
// `pnpm dist` spend four minutes making an installer that cannot analyse a
// file.  See scripts/lib/engine-binary.cjs for what was measured.
const { engineBlocker, engineWaived } = require('./lib/engine-binary.cjs');
const blocker = engineBlocker(BIN_DIR);
if (blocker !== null) {
  console.error(`\n${blocker}`);
  process.exitCode = 1;
} else if (engineWaived(BIN_DIR)) {
  console.warn('\n⚠ engine binary missing and AIMASTER_ALLOW_NO_ENGINE=1 — '
    + 'the package will not be able to analyse audio.');
} else {
  console.log('✓ engine  (already built)');
}

if (!process.exitCode) {
  console.log('\nFFmpeg binaries ready in public/bin/');
}
