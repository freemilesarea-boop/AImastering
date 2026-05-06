/**
 * Path-allowlist security tests (Phase A3, audit 2026-05).
 *
 * The allowlist is a renderer-untrusted-input chokepoint — every IPC
 * handler that touches a renderer-supplied path goes through it.  These
 * tests prove the contract is enforced.
 *
 * Run via:
 *   node apps/desktop/scripts/security-allowlist-test.cjs
 */
const path = require('node:path');
const os   = require('node:os');
const fs   = require('node:fs');

// ── Build a tiny on-disk stub for `electron` so the bundled allowlist
//    module can require it without a real Electron runtime.
const STUB = '/tmp/_electron_stub.js';
fs.writeFileSync(STUB, `module.exports = { app: { getPath: (k) => k === 'temp' ? require('os').tmpdir() : require('path').join(require('os').tmpdir(), 'aimaster-userData') } };`);

const esbuild = require('esbuild');
const SRC     = path.resolve(__dirname, '../src/main/utils/pathAllowlist.ts');
const OUT     = '/tmp/_pathAllowlist.cjs';

esbuild.buildSync({
  entryPoints: [SRC], bundle: true, platform: 'node', format: 'cjs',
  outfile: OUT, target: ['node18'],
  alias: { 'electron': STUB },
  loader: { '.ts': 'ts' },
});

const allow = require(OUT);

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`\x1b[32mPASS\x1b[0m ${name}`); pass++; }
  catch (e) { console.log(`\x1b[31mFAIL\x1b[0m ${name}\n      ${e.message}`); fail++; }
}
function assertTrue(v, msg)  { if (!v) throw new Error(msg || `expected true, got ${v}`); }
function assertFalse(v, msg) { if (v)  throw new Error(msg || `expected false, got ${v}`); }
function assertThrows(fn, code) {
  try { fn(); throw new Error('did not throw'); }
  catch (e) { if (code && e.code !== code) throw new Error(`expected code ${code}, got ${e.code}`); }
}

// ── Tests ──────────────────────────────────────────────────────────────
allow.initAllowlist();
const tmp = os.tmpdir();

test('built-in safe roots: tmp dir is allowed',
  () => assertTrue(allow.isPathAllowed(path.join(tmp, 'aimaster_xyz.wav'))));

test('arbitrary system path NOT allowed by default',
  () => assertFalse(allow.isPathAllowed('/etc/shadow')));
test('home ssh key NOT allowed by default',
  () => assertFalse(allow.isPathAllowed('/Users/victim/.ssh/id_rsa')));
test('dotfile NOT allowed by default',
  () => assertFalse(allow.isPathAllowed('/root/.bashrc')));

test('path traversal /tmp/../etc/passwd is blocked',
  () => assertFalse(allow.isPathAllowed(path.join(tmp, '..', 'etc', 'passwd'))));
test('path traversal with multiple .. is blocked',
  () => assertFalse(allow.isPathAllowed(path.join(tmp, 'a', '..', '..', '..', 'etc'))));

test('after registerAllowedFile, sibling is allowed', () => {
  allow.registerAllowedFile('/Users/me/Music/song.wav');
  assertTrue(allow.isPathAllowed('/Users/me/Music/song.wav'));
  assertTrue(allow.isPathAllowed('/Users/me/Music/other_song.flac'));
});
test('after registerAllowedFile, OTHER directories still blocked', () => {
  assertFalse(allow.isPathAllowed('/Users/me/Documents/secret.txt'));
});
test('after registerAllowedFile, parent traversal still blocked', () => {
  assertFalse(allow.isPathAllowed('/Users/me/Music/../Documents/secret.txt'));
});

test('assertAllowed throws EPATHFORBIDDEN on rejected path',
  () => assertThrows(() => allow.assertAllowed('/etc/shadow', 'test'), 'EPATHFORBIDDEN'));

test('safeResolve throws on rejected path',
  () => assertThrows(() => allow.safeResolve('/etc/shadow', 'test'), 'EPATHFORBIDDEN'));

test('isPathAllowed handles non-string input gracefully', () => {
  assertFalse(allow.isPathAllowed(null));
  assertFalse(allow.isPathAllowed(undefined));
  assertFalse(allow.isPathAllowed(123));
  assertFalse(allow.isPathAllowed(''));
});

test('boundary: /tmpfoo is NOT inside /tmp', () => {
  // path.sep guard — /tmp/x is in /tmp but /tmpfoo is not
  allow._resetForTest();
  allow.registerAllowedDir('/tmp');
  assertTrue(allow.isPathAllowed('/tmp/file.wav'));
  assertFalse(allow.isPathAllowed('/tmpfoo/file.wav'));
});

console.log(`\n=== ${pass}/${pass + fail} pass ===`);
process.exit(fail === 0 ? 0 : 1);
