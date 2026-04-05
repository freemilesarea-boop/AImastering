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

if (!process.exitCode) {
  console.log('\nFFmpeg binaries ready in public/bin/');
}
