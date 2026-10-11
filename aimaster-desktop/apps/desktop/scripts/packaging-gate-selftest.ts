/**
 * packaging-gate-selftest — `pnpm dist` must refuse to ship a broken package.
 *
 * Measured on real artifacts, not argued.  Two rounds.
 *
 * ROUND 1 — the binary was not there.  `pnpm dist` succeeded, producing
 * `LV DAW-3.7.0-linux-amd64.deb` (128 MB) and an AppImage (202 MB).  The
 * deb's `resources/bin/` held ffmpeg and ffprobe and nothing else.  The
 * packaged app booted, served all four worklet assets out of the asar, and
 * answered the very first `audio:analyze` with
 *
 *   PYTHON_PROCESS_FAILED — spawn .../resources/bin/engine ENOENT
 *   "오디오 처리 엔진이 응답하지 않습니다"
 *
 * ROUND 2 — the binary was there and could not start.  Built with CI's exact
 * PyInstaller command, shipped into the package, and the packaged app still
 * failed `audio:analyze`:
 *
 *   ModuleNotFoundError: No module named 'backports'
 *   [PYI-1683:ERROR] Failed to execute script 'pyi_rth_pkgres'
 *
 * The gate written for round 1 passed it.  It called `existsSync` — which is
 * a different question from the one `resolvePaths()` asks, and the gap
 * between them is the whole bug.  So the gate now STARTS the binary and
 * waits for the READY handshake `app/main.py` documents, and this file
 * checks that decision with four stubs: ready, exit-nonzero, exit-zero-but-
 * silent, and hanging.
 *
 * The third stub is the one worth having.  A binary that exits 0 and never
 * says READY is exactly what a half-collected PyInstaller bundle looks like
 * from the outside, and it is the only failure an exit-code check misses.
 *
 * Run:  pnpm --filter @aimaster/desktop test:packaging-gate
 */

import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);

interface Verdict { ok: boolean; detail: string }
interface Status { state: 'ok' | 'missing' | 'broken' | 'unverifiable'; name: string; full: string; detail: string }
type Env = Record<string, string | undefined>;
type Probe = (full: string) => Verdict;

const gate = require_('./lib/engine-binary.cjs') as {
  engineBinaryName(platform?: string): string;
  engineBlocker(binDir: string, platform?: string, env?: Env, probe?: Probe): string | null;
  engineWaived(binDir: string, platform?: string, env?: Env, probe?: Probe): boolean;
  engineStatus(binDir: string, platform?: string, env?: Env, probe?: Probe): Status;
  probeEngine(full: string, timeoutMs?: number): Verdict;
  ENGINE_READY: string;
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
/** A bin dir holding a shell stub that behaves like `body` says. */
function binDirWith(body: string, platform = process.platform): string {
  const d = emptyBinDir();
  const f = join(d, gate.engineBinaryName(platform));
  writeFileSync(f, `#!/bin/sh\n${body}\n`);
  chmodSync(f, 0o755);
  return d;
}
/** The handshake a working engine performs: READY on stderr, then exit 0. */
const READY_STUB   = `echo "${gate.ENGINE_READY}" 1>&2`;
const CRASH_STUB   = 'echo "ModuleNotFoundError: No module named \'backports\'" 1>&2; exit 1';
const SILENT_STUB  = 'echo "nothing to say"';
const HANGING_STUB = 'sleep 30';

const always  = (): Verdict => ({ ok: true,  detail: '' });
const refuses = (): Verdict => ({ ok: false, detail: 'stub verdict: unusable' });

check('an absent engine stops packaging', () => {
  const msg = gate.engineBlocker(emptyBinDir(), process.platform, {}, always);
  assert(msg !== null, 'packaging was allowed to continue with no engine binary');
});

check('and says where it looked and how to build it', () => {
  const dir = emptyBinDir();
  const msg = gate.engineBlocker(dir, process.platform, {}, always) ?? '';
  // The path, because "not found" without a path is a scavenger hunt; and
  // pyinstaller, because the next question is always "build it how?".
  assert(msg.includes(dir), `the message does not name the directory it checked: ${msg}`);
  assert(/pyinstaller/i.test(msg), 'the message does not say how to build it');
  assert(/AIMASTER_ALLOW_NO_ENGINE/.test(msg), 'the message does not mention the deliberate override');
  // The exclusions are the fix for round 2; a hint that omits them rebuilds
  // the same dead binary.
  assert(/exclude-module pkg_resources/.test(msg), 'the build hint omits the exclusion that makes the binary start');
});

check('an engine that reaches READY lets packaging through', () => {
  assert(gate.engineBlocker(binDirWith(READY_STUB), process.platform, {}) === null,
    'packaging was blocked even though the engine binary starts and says READY');
});

check('an engine that is present but cannot start stops packaging', () => {
  const dir = binDirWith(CRASH_STUB);
  const msg = gate.engineBlocker(dir, process.platform, {});
  assert(msg !== null, 'a binary that dies on startup was packaged — this is the bug this round');
  assert(/cannot start/.test(msg ?? ''), `the message does not say it cannot start: ${msg}`);
  // The operator needs the engine's own words, not just a verdict.
  assert(/backports/.test(msg ?? ''), 'the message drops the engine\'s own error output');
  assert(gate.engineStatus(dir, process.platform, {}).state === 'broken',
    'a crashing binary was not classified as broken');
});

check('and so does one that exits 0 without ever saying READY', () => {
  // The only failure mode an exit-code check cannot see.
  const dir = binDirWith(SILENT_STUB);
  const msg = gate.engineBlocker(dir, process.platform, {});
  assert(msg !== null, 'a binary that exits 0 and never reaches READY was packaged');
  assert(gate.probeEngine(join(dir, gate.engineBinaryName())).ok === false,
    'the probe accepted an engine that never performed the handshake');
});

check('a hanging engine is refused rather than waited on forever', () => {
  const dir = binDirWith(HANGING_STUB);
  const v = gate.probeEngine(join(dir, gate.engineBinaryName()), 1200);
  assert(v.ok === false, 'a binary that never returns was accepted');
  assert(/kill|SIG/i.test(v.detail), `the detail does not say it was killed: ${v.detail}`);
});

check('the override lets a broken engine through, and reports it as a waiver', () => {
  const dir = binDirWith(CRASH_STUB);
  const env = { AIMASTER_ALLOW_NO_ENGINE: '1' };
  assert(gate.engineBlocker(dir, process.platform, env) === null, 'the override did not unblock packaging');
  assert(gate.engineWaived(dir, process.platform, env) === true,
    'the waiver is silent — nothing would tell the operator the package cannot analyse');
  // And the same for an absent one, which is what the override was added for.
  const empty = emptyBinDir();
  assert(gate.engineBlocker(empty, process.platform, env, refuses) === null, 'the override did not unblock an absent engine');
  assert(gate.engineWaived(empty, process.platform, env, refuses) === true, 'an absent-but-waived engine was not reported');
});

check('and a waiver is not claimed when the engine is simply working', () => {
  // Otherwise `pnpm dist` would print the "cannot analyse audio" warning on
  // a perfectly good build, which teaches the operator to ignore it.
  assert(gate.engineWaived(binDirWith(READY_STUB), process.platform, { AIMASTER_ALLOW_NO_ENGINE: '1' }) === false,
    'a complete build was reported as a waiver');
});

check('Windows looks for engine.exe', () => {
  assert(gate.engineBinaryName('win32') === 'engine.exe',
    `win32 expects engine.exe, got ${gate.engineBinaryName('win32')}`);
  assert(gate.engineBinaryName('darwin') === 'engine',
    `darwin expects engine, got ${gate.engineBinaryName('darwin')}`);
  // A linux-named stub must not satisfy a win32 build.
  assert(gate.engineBlocker(binDirWith(READY_STUB), 'win32', {}, always) !== null,
    'a win32 package was allowed through with only the extensionless binary');
});

check('a cross-platform build says its check was weaker, instead of claiming ok', () => {
  // `engine.exe` cannot be executed on this host, so presence is all there
  // is.  That is the one case where this gate's guarantee is thinner than
  // it looks, and saying so is the difference between a check and a ritual.
  const other = process.platform === 'win32' ? 'linux' : 'win32';
  const dir = binDirWith(READY_STUB, other);
  const s = gate.engineStatus(dir, other, {}, refuses);
  assert(s.state === 'unverifiable', `expected unverifiable for a ${other} binary on ${process.platform}, got ${s.state}`);
  assert(s.detail !== '', 'an unverifiable status carries no explanation');
  assert(gate.engineBlocker(dir, other, {}, refuses) === null,
    'a cross-platform build was blocked for a check that cannot be run');
});

for (const d of dirs) rmSync(d, { recursive: true, force: true });

console.log('');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
const bad = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - bad}/${results.length} passed${bad ? `, ${bad} FAILED` : ''}`);
if (bad) process.exit(1);
