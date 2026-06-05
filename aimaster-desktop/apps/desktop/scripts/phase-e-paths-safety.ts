/**
 * phase-e-paths-safety.ts — automated coverage for the v3.6 RC
 * QA scenarios that DO NOT need a real OS interaction:
 *
 *   • Path edge cases for `toFileUrl` (Korean / spaces / # / ?)
 *   • Path redaction for the failure log + support bundle
 *   • Support bundle JSON shape (schemaVersion, no leaks)
 *
 * Manual scenarios (large files, low-memory systems, missing ffmpeg
 * in PATH, etc.) live in `docs/QA_v3.6_RC.md` and require human eyes.
 *
 * Run via:
 *   pnpm --filter @aimaster/desktop test:phase-e-paths
 */

import { toFileUrl, fromFileUrl } from '../src/renderer/utils/fileUrl.js';
import { localUrlToFsPath } from '../src/main/utils/localFileUrl.js';
import {
  recordFailure,
  resetFailureLogForTests,
  redactPath,
  redactObject,
  snapshotFailures,
  failureCounts,
} from '../src/main/utils/failureLog.js';
import {
  buildSupportBundle,
  supportBundleToJson,
  recordPipelineWarning,
  resetPipelineWarningsForTests,
  SUPPORT_BUNDLE_SCHEMA,
} from '../src/main/utils/supportBundle.js';

// ── Tiny harness ────────────────────────────────────────────────────────────

interface T { name: string; pass: boolean; detail: string; }
const results: T[] = [];

function check(name: string, fn: () => void): void {
  try {
    fn();
    results.push({ name, pass: true, detail: '' });
  } catch (e) {
    results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) });
  }
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

function eq<T>(a: T, b: T, msg: string): void {
  if (a !== b) throw new Error(`${msg} — got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);
}

// ── 1. fileUrl edge cases ──────────────────────────────────────────────────

const PATH_CASES: Array<[string, string]> = [
  // [input, expected URL]
  ['/Users/foo/song.wav',
   'aimaster-local:///Users/foo/song.wav'],

  // Spaces
  ['/Users/foo/My Track v2.wav',
   'aimaster-local:///Users/foo/My%20Track%20v2.wav'],

  // Hash (would otherwise truncate to a fragment in the real loader)
  ['/Users/foo/Track #3.mp3',
   'aimaster-local:///Users/foo/Track%20%233.mp3'],

  // Question mark (would otherwise become a query string)
  ['/Users/foo/What is this?.mp3',
   'aimaster-local:///Users/foo/What%20is%20this%3F.mp3'],

  // Korean (UTF-8) — `한글` → percent-encoded
  ['/Users/foo/음악/한글_파일명.wav',
   'aimaster-local:///Users/foo/%EC%9D%8C%EC%95%85/%ED%95%9C%EA%B8%80_%ED%8C%8C%EC%9D%BC%EB%AA%85.wav'],

  // Windows backslash → normalised + drive preserved
  ['C:\\Users\\foo\\song.wav',
   'aimaster-local:///C%3A/Users/foo/song.wav'],
];

for (const [input, expected] of PATH_CASES) {
  check(`fileUrl: encode "${input}"`, () => {
    eq(toFileUrl(input), expected, 'encoded URL');
  });
  check(`fileUrl: round-trip "${input}"`, () => {
    const expectedDecoded = input.replace(/\\/g, '/').startsWith('/')
      ? input.replace(/\\/g, '/')
      : '/' + input.replace(/\\/g, '/');
    eq(fromFileUrl(toFileUrl(input)), expectedDecoded,
       `round-trip equality for ${input}`);
  });
}

check('fileUrl: empty input → empty string', () => {
  eq(toFileUrl(''), '', 'empty');
});

// ── 1b. main-side decode (localUrlToFsPath) ─────────────────────────────────
// Regression guard for the Windows preview bug: a drive path round-trips
// through toFileUrl → localUrlToFsPath WITHOUT a leading slash before the
// drive letter, so pathToFileURL/path.resolve produce a valid `C:\…` path.
// Posix paths must be returned verbatim.

const MAIN_DECODE_CASES: Array<[string, string]> = [
  // [original absolute path, expected decoded path on the main side]
  ['/Users/foo/song.wav',                 '/Users/foo/song.wav'],
  ['/Users/foo/My Track v2.wav',          '/Users/foo/My Track v2.wav'],
  ['/Users/foo/Track #3.mp3',             '/Users/foo/Track #3.mp3'],
  ['/Users/foo/What is this?.mp3',        '/Users/foo/What is this?.mp3'],
  ['/Users/foo/음악/한글_파일명.wav',       '/Users/foo/음악/한글_파일명.wav'],
  // Windows: the leading slash before the drive letter MUST be dropped.
  ['C:\\Users\\foo\\song.wav',            'C:/Users/foo/song.wav'],
  ['D:\\Music\\My Track #3.mp3',          'D:/Music/My Track #3.mp3'],
];

for (const [input, expected] of MAIN_DECODE_CASES) {
  check(`mainDecode: toFileUrl → localUrlToFsPath "${input}"`, () => {
    eq(localUrlToFsPath(toFileUrl(input)), expected, 'decoded fs path');
  });
}

check('mainDecode: Windows path has no leading-slash-before-drive', () => {
  const decoded = localUrlToFsPath(toFileUrl('C:\\Users\\foo\\song.wav'));
  assert(!/^\/[A-Za-z]:/.test(decoded), `leading slash before drive survived: ${decoded}`);
  assert(/^[A-Za-z]:/.test(decoded), `drive letter does not lead: ${decoded}`);
});

// ── 2. failure-log path redaction ──────────────────────────────────────────

resetFailureLogForTests();

check('redactPath: replaces $HOME with ~', () => {
  // Use a fixed path under /home/<user>/... and assert the / home /
  // .* prefix (or whatever `os.homedir()` returns) gets folded to `~`.
  const home = process.env['HOME'] ?? '/home/user';
  const input = `${home}/Music/Track.mp3`;
  const out = redactPath(input);
  assert(!out.includes(home), `still contains $HOME: ${out}`);
  assert(out.includes('~'),    `missing ~ marker: ${out}`);
  assert(out.includes('Music/Track.mp3'), 'filename should survive');
});

check('redactPath: redacts non-home paths under /Users', () => {
  const out = redactPath('/Users/secret/Music/Out.wav');
  assert(out.includes('~'),   `expected ~ replacement, got ${out}`);
  assert(!out.includes('/Users/secret'), `still contains /Users/secret: ${out}`);
});

check('redactObject: replaces sensitive keys with [redacted]', () => {
  const out = redactObject({
    outputPath:  '/Users/secret/Out.wav',
    previewPath: '/Users/secret/Preview.mp3',
    okField:     'visible',
    nested:      { artifactDir: '/internal/dump' },
  }) as Record<string, unknown>;
  eq(out['outputPath'],  '[redacted]', 'outputPath');
  eq(out['previewPath'], '[redacted]', 'previewPath');
  eq(out['okField'],     'visible',    'okField untouched');
  const nested = out['nested'] as Record<string, unknown>;
  eq(nested['artifactDir'], '[redacted]', 'nested artifactDir');
});

check('recordFailure: redacts message + caps at 50 per category', () => {
  resetFailureLogForTests();
  for (let i = 0; i < 60; i++) {
    recordFailure('engine', `bridge died at /home/user/song-${i}.wav`, { iter: i });
  }
  const all = snapshotFailures();
  const engine = all.filter((e) => e.category === 'engine');
  eq(engine.length, 50, 'ring buffer cap');
  // Most recent should be iter=59 (oldest 0–9 dropped)
  const last = engine[engine.length - 1]!;
  assert(!last.message.includes('/home/user'), `message not redacted: ${last.message}`);
  assert(last.message.includes('~'), 'message has ~ marker');
});

// ── 3. Support bundle shape + leak guards ──────────────────────────────────

resetFailureLogForTests();
resetPipelineWarningsForTests();
recordFailure('worklet', 'load failed at /home/user/Library/foo.js', { foo: 1 });
recordFailure('preview', 'audio error code=4', { code: 4 });
recordPipelineWarning({ code: 'reference_genre_mismatch', level: 'warn', userMessage: 'genre mismatch' });

check('support bundle: schema + version present', () => {
  const b = buildSupportBundle();
  eq(b.schemaVersion, SUPPORT_BUNDLE_SCHEMA, 'schema');
  assert(typeof b.app.version === 'string', 'version present');
  assert(typeof b.runtime.platform === 'string', 'platform present');
});

check('support bundle: includes recent failures + pipeline warnings', () => {
  const b = buildSupportBundle();
  assert(b.recentFailures.length === 2, `expected 2 failures, got ${b.recentFailures.length}`);
  eq(b.recentPipelineWarnings.length, 1, 'pipeline warnings count');
  eq(b.recentPipelineWarnings[0]?.code, 'reference_genre_mismatch', 'warning code');
  eq(b.failureCounts['worklet'], 1, 'worklet count');
  eq(b.failureCounts['preview'], 1, 'preview count');
});

check('support bundle: JSON has no /Users or /home leaks', () => {
  const b = buildSupportBundle();
  const json = supportBundleToJson(b);
  assert(!/\/Users\/[^~][a-zA-Z0-9_.-]+/.test(json), `JSON leaks /Users/<name>: ${json.slice(0, 200)}`);
  assert(!/\/home\/[^~][a-zA-Z0-9_.-]+/.test(json), `JSON leaks /home/<name>: ${json.slice(0, 200)}`);
});

check('support bundle: JSON is parseable + round-trips', () => {
  const b = buildSupportBundle();
  const json = supportBundleToJson(b);
  const parsed = JSON.parse(json);
  eq(parsed.schemaVersion, SUPPORT_BUNDLE_SCHEMA, 'parsed schema');
  assert(Array.isArray(parsed.recentFailures), 'failures is an array');
});

// ── 4. failureCounts contract ──────────────────────────────────────────────

resetFailureLogForTests();
recordFailure('preview', 'one');
recordFailure('preview', 'two');
recordFailure('worklet', 'one');

check('failureCounts: per-category rollup', () => {
  const c = failureCounts();
  eq(c['preview'], 2, 'preview');
  eq(c['worklet'], 1, 'worklet');
  eq(c['engine'],  0, 'engine');
});

// ── Print summary ──────────────────────────────────────────────────────────

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;

console.log('\n=== v3.6 path + failure-log safety ===');
for (const r of results) {
  const tag = r.pass ? 'PASS' : 'FAIL';
  console.log(`[${tag}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
}
console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);

if (failed > 0) process.exit(1);
