/**
 * packaging-gate-selftest — `pnpm dist` must refuse to ship a broken package.
 *
 * Measured on a real artifact, not argued.  `pnpm dist` was run in this
 * container: it succeeded, producing `LV DAW-3.7.0-linux-amd64.deb` (128 MB)
 * and an AppImage (202 MB).  The deb's `resources/bin/` held ffmpeg and
 * ffprobe and nothing else.  The packaged app booted, served all four worklet
 * assets out of the asar, and answered the very first `audio:analyze` with
 *
 *   PYTHON_PROCESS_FAILED — spawn .../resources/bin/engine ENOENT
 *   "오디오 처리 엔진이 응답하지 않습니다"
 *
 * `resolvePaths()` in `audioHandlers.ts` says why: a packaged app spawns a
 * PyInstaller-built `engine` so the user needs no Python.  CI builds it
 * before packaging (.github/workflows/build.yml) — `pnpm dist` never did,
 * and nothing said so.  An installer that launches and cannot open a file is
 * worse than a build that fails, because only one of the two tells you.
 *
 * So the gate lives in `prebuild.cjs`, the first link of `pnpm dist`, and
 * this file checks the gate's decision rather than its wording: present →
 * proceed, absent → stop, absent-but-waived → proceed loudly.
 *
 * Run:  pnpm --filter @aimaster/desktop test:packaging-gate
 */

import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const gate = require_('./lib/engine-binary.cjs') as {
  engineBinaryName(platform?: string): string;
  engineBlocker(binDir: string, platform?: string, env?: Record<string, string | undefined>): string | null;
  engineWaived(binDir: string, platform?: string, env?: Record<string, string | undefined>): boolean;
};

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}
function assert(cond: unknown, detail: string): void { if (!cond) throw new Error(detail); }

const dirs: string[] = [];
function emptyBinDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'loui-gate-'));
  dirs.push(d);
  return d;
}
function binDirWithEngine(platform = process.platform): string {
  const d = emptyBinDir();
  const f = join(d, gate.engineBinaryName(platform));
  writeFileSync(f, '#!/bin/sh\necho stub\n');
  chmodSync(f, 0o755);
  return d;
}

check('an absent engine stops packaging', () => {
  const msg = gate.engineBlocker(emptyBinDir(), 'linux', {});
  assert(msg !== null, 'packaging was allowed to continue with no engine binary');
});

check('and says where it looked and how to build it', () => {
  const dir = emptyBinDir();
  const msg = gate.engineBlocker(dir, 'linux', {}) ?? '';
  // The path, because "not found" without a path is a scavenger hunt; and
  // pyinstaller, because the next question is always "build it how?".
  assert(msg.includes(dir), `the message does not name the directory it checked: ${msg}`);
  assert(/pyinstaller/i.test(msg), 'the message does not say how to build it');
  assert(/AIMASTER_ALLOW_NO_ENGINE/.test(msg), 'the message does not mention the deliberate override');
});

check('a present engine lets packaging through', () => {
  assert(gate.engineBlocker(binDirWithEngine('linux'), 'linux', {}) === null,
    'packaging was blocked even though the engine binary is there');
});

check('the override lets it through, and is reported as a waiver', () => {
  const dir = emptyBinDir();
  const env = { AIMASTER_ALLOW_NO_ENGINE: '1' };
  assert(gate.engineBlocker(dir, 'linux', env) === null, 'the override did not unblock packaging');
  assert(gate.engineWaived(dir, 'linux', env) === true,
    'the waiver is silent — nothing would tell the operator the package cannot analyse');
});

check('and a waiver is not claimed when the engine is simply present', () => {
  // Otherwise `pnpm dist` would print the "cannot analyse audio" warning on
  // a perfectly good build, which teaches the operator to ignore it.
  assert(gate.engineWaived(binDirWithEngine('linux'), 'linux', { AIMASTER_ALLOW_NO_ENGINE: '1' }) === false,
    'a complete build was reported as a waiver');
});

check('Windows looks for engine.exe', () => {
  assert(gate.engineBinaryName('win32') === 'engine.exe',
    `win32 expects engine.exe, got ${gate.engineBinaryName('win32')}`);
  assert(gate.engineBinaryName('darwin') === 'engine',
    `darwin expects engine, got ${gate.engineBinaryName('darwin')}`);
  // A linux-named stub must not satisfy a win32 build.
  assert(gate.engineBlocker(binDirWithEngine('linux'), 'win32', {}) !== null,
    'a win32 package was allowed through with only the extensionless binary');
});

for (const d of dirs) rmSync(d, { recursive: true, force: true });

console.log('');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
const bad = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - bad}/${results.length} passed${bad ? `, ${bad} FAILED` : ''}`);
if (bad) process.exit(1);
