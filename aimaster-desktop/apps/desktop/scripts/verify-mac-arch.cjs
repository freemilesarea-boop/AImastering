/**
 * verify-mac-arch.cjs — refuse to ship a macOS .app whose bundled binaries
 * cannot run on the architecture the bundle claims to target.
 *
 * ── Why ──────────────────────────────────────────────────────────────────────
 * `extraResources` (Resources/bin/ffmpeg, ffprobe, engine) is copied
 * arch-blind by electron-builder.  Building `--x64 --arm64` in one invocation
 * on an Apple Silicon runner therefore produced an Intel .app — correct x64
 * Electron shell, so Finder happily reported "응용 프로그램(Intel)" — whose
 * sidecars were arm64 and could not execute on a real Intel Mac.  The app
 * died during startup in checkFFmpeg() before any window appeared.
 *
 * Finder only inspects the main executable, so nothing about the bundle looked
 * wrong until it was launched on the target hardware.  This script inspects
 * *every* Mach-O in the bundle instead.
 *
 * Usage:
 *   node scripts/verify-mac-arch.cjs <path-to-.app> <x64|arm64>
 *
 * Exits non-zero (and prints every offender) when any Mach-O in the bundle
 * lacks a slice for the requested arch.  Universal binaries pass as long as
 * they contain the requested slice.
 */

'use strict';

const fs   = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const [, , APP_PATH, RAW_ARCH] = process.argv;

if (!APP_PATH || !RAW_ARCH) {
  console.error('usage: node scripts/verify-mac-arch.cjs <path-to-.app> <x64|arm64>');
  process.exit(2);
}
if (!fs.existsSync(APP_PATH)) {
  console.error(`✗ app bundle not found: ${APP_PATH}`);
  process.exit(2);
}

const LIPO_NAME = { x64: 'x86_64', arm64: 'arm64' };
const WANT = LIPO_NAME[RAW_ARCH] || RAW_ARCH;

/** Mach-O magic numbers: 32/64-bit thin (LE + BE) and fat/universal. */
const MACHO_MAGICS = new Set([
  0xfeedface, 0xcefaedfe,   // 32-bit
  0xfeedfacf, 0xcffaedfe,   // 64-bit
  0xcafebabe, 0xbebafeca,   // fat / universal
]);

function isMachO(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(4);
    if (fs.readSync(fd, buf, 0, 4, 0) < 4) return false;
    return MACHO_MAGICS.has(buf.readUInt32BE(0)) || MACHO_MAGICS.has(buf.readUInt32LE(0));
  } catch {
    return false;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

function archsOf(file) {
  try {
    return execFileSync('lipo', ['-archs', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .trim()
      .split(/\s+/)
      .filter(Boolean);
  } catch {
    return null;
  }
}

/** Every regular file under `dir`, following the bundle's symlinked frameworks only once. */
function* walk(dir, seen = new Set()) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;          // frameworks alias their own contents
    if (entry.isDirectory()) {
      const real = fs.realpathSync(full);
      if (seen.has(real)) continue;
      seen.add(real);
      yield* walk(full, seen);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

console.log(`verify-mac-arch: bundle=${APP_PATH}`);
console.log(`verify-mac-arch: required slice=${WANT} (${RAW_ARCH})`);
console.log('');

const checked = [];
const bad     = [];

for (const file of walk(APP_PATH)) {
  if (!isMachO(file)) continue;
  const archs = archsOf(file);
  if (!archs) continue;                            // lipo could not read it — not a real Mach-O
  const rel = path.relative(APP_PATH, file);
  checked.push({ rel, archs });
  if (!archs.includes(WANT)) bad.push({ rel, archs });
}

console.log(`inspected ${checked.length} Mach-O file(s) inside the bundle`);

// The sidecars are the ones that actually broke Intel — always show them.
const SIDECARS = ['ffmpeg', 'ffprobe', 'engine'];
for (const { rel, archs } of checked) {
  if (SIDECARS.includes(path.basename(rel))) {
    console.log(`  • ${rel}  →  ${archs.join(', ')}`);
  }
}

// Every sidecar must actually be present; a missing engine/ffmpeg is just as
// fatal at runtime as a wrong-arch one, and much easier to miss in CI.
const present = new Set(checked.map((c) => path.basename(c.rel)));
const missing = SIDECARS.filter((s) => !present.has(s));

console.log('');

if (bad.length === 0 && missing.length === 0) {
  console.log(`✓ every Mach-O in the bundle runs on ${WANT}`);
  process.exit(0);
}

if (missing.length) {
  console.error(`✗ missing bundled sidecar(s): ${missing.join(', ')}`);
  console.error('  Expected under Contents/Resources/bin/ — check the PyInstaller');
  console.error('  step and scripts/prebuild.cjs ran before electron-builder.');
  console.error('');
}

if (bad.length) {
  console.error(`✗ ${bad.length} file(s) cannot run on ${WANT}:`);
  for (const { rel, archs } of bad) {
    console.error(`    ${rel}  →  ${archs.join(', ')}`);
  }
  console.error('');
  console.error('  This is the Intel-Mac failure mode: the Electron shell is the');
  console.error('  right arch (so Finder shows the right "종류"), but a bundled');
  console.error('  binary is not, and the app dies on launch.');
  console.error('  → Each arch-sensitive binary must be sourced for the target');
  console.error('    arch, not for the build host. See build-mac-intel.yml.');
}

process.exit(1);
