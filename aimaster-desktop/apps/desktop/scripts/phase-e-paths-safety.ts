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
import { resolveBundledFfmpegEnv } from '../src/main/utils/ffmpegEnv.js';
import { parseRangeHeader, contentTypeForPath } from '../src/main/utils/localFileResponse.js';
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
// v3.7 format: aimaster-local://local/<encodeURIComponent(normalizedPath)>.
// The decisive properties are (a) a fixed `local` host so Chromium can't pull
// a path segment / Windows drive into the authority, and (b) lossless
// round-trip of the absolute path (with backslashes normalised to `/`).

const PATH_INPUTS: string[] = [
  '/Users/foo/song.wav',
  '/Users/foo/My Track v2.wav',          // spaces
  '/Users/foo/Track #3.mp3',             // hash (would truncate to a fragment)
  '/Users/foo/What is this?.mp3',        // question mark (would become a query)
  '/Users/foo/음악/한글_파일명.wav',       // Korean (UTF-8)
  'C:\\Users\\foo\\song.wav',            // Windows drive + backslashes
  'D:\\Music\\곡 이름 (final) #3.mp3',    // Windows + Korean + spaces + hash
];

for (const input of PATH_INPUTS) {
  const normalized = input.replace(/\\/g, '/');
  check(`fileUrl: encode "${input}" → fixed local host, single segment`, () => {
    const url = toFileUrl(input);
    assert(url.startsWith('aimaster-local://local/'), `fixed host prefix: ${url}`);
    // The path must be ONE encoded segment — no literal slash after the host.
    const seg = url.slice('aimaster-local://local/'.length);
    assert(!seg.includes('/'), `single encoded segment (no literal /): ${url}`);
    eq(decodeURIComponent(seg), normalized, 'segment decodes to normalized path');
  });
  check(`fileUrl: round-trip "${input}"`, () => {
    eq(fromFileUrl(toFileUrl(input)), normalized, `round-trip equality for ${input}`);
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

// ── 1b′. EXACT request.url forms Chromium hands the protocol handler ─────────
// These strings were captured from a real Electron/Chromium run (not derived
// from toFileUrl).  They are the ground-truth regression guard for the Windows
// "preview + detailed controls dead" bug: the standard-scheme parser pulls the
// first segment into the host, so the decoder MUST reconstruct the path from
// BOTH the new fixed-host form and the legacy host-pulled form.

const CHROMIUM_URL_CASES: Array<[string, string, string]> = [
  // [label, request.url as Chromium delivers it, expected fs path]
  // v3.7 fixed-host form (what toFileUrl now emits; Chromium keeps verbatim):
  ['v3.7 posix',   'aimaster-local://local/%2Ftmp%2Faimtest%2Fplain.wav', '/tmp/aimtest/plain.wav'],
  ['v3.7 windows', 'aimaster-local://local/C%3A%2FUsers%2Fme%2Fsong.wav', 'C:/Users/me/song.wav'],
  ['v3.7 korean',  'aimaster-local://local/%2Ftmp%2F%EA%B3%A1%20(final).mp3', '/tmp/곡 (final).mp3'],
  // Legacy forms still accepted (older renderer bundle / in-flight URLs):
  ['legacy posix host-pulled', 'aimaster-local://tmp/aimtest/plain.wav', '/tmp/aimtest/plain.wav'],
  ['legacy windows drive-in-path', 'aimaster-local:///C%3A/Users/me/song.wav', 'C:/Users/me/song.wav'],
  ['legacy windows drive-as-host(enc)', 'aimaster-local://c%3a/Users/me/song.wav', 'c:/Users/me/song.wav'],
];

for (const [label, url, expected] of CHROMIUM_URL_CASES) {
  check(`chromiumUrl: ${label}`, () => {
    eq(localUrlToFsPath(url), expected, `decode ${url}`);
  });
}

// ── 1c. bundled FFmpeg env resolution (resolveBundledFfmpegEnv) ─────────────
// Regression guard for the "FFmpeg not found on a clean machine" bug: in a
// packaged build the bundled binaries MUST be discoverable regardless of call
// order.  The pure resolver maps resourcesPath → AIMASTER_FFMPEG/FFPROBE with
// the right extension per platform, is a no-op in dev, and never clobbers a
// value the environment already supplies.

check('ffmpegEnv: packaged win32 → .exe binary names under resources/bin', () => {
  // NOTE: the directory separator comes from the HOST path.join (this test
  // runs on POSIX/CI), so assert the win32-specific bit — the `.exe`
  // extension — plus the bin/ placement rather than an exact separator.
  const v = resolveBundledFfmpegEnv({ packaged: true, resourcesPath: 'C:\\App\\resources', platform: 'win32' });
  assert(/ffmpeg\.exe$/.test(v.AIMASTER_FFMPEG ?? ''),  `ffmpeg.exe suffix: ${v.AIMASTER_FFMPEG}`);
  assert(/ffprobe\.exe$/.test(v.AIMASTER_FFPROBE ?? ''), `ffprobe.exe suffix: ${v.AIMASTER_FFPROBE}`);
  assert(/[\\/]bin[\\/]ffmpeg\.exe$/.test(v.AIMASTER_FFMPEG ?? ''), `under bin/: ${v.AIMASTER_FFMPEG}`);
});

check('ffmpegEnv: packaged darwin → extensionless paths under resources/bin', () => {
  const v = resolveBundledFfmpegEnv({ packaged: true, resourcesPath: '/App/Contents/Resources', platform: 'darwin' });
  eq(v.AIMASTER_FFMPEG,  '/App/Contents/Resources/bin/ffmpeg',  'ffmpeg');
  eq(v.AIMASTER_FFPROBE, '/App/Contents/Resources/bin/ffprobe', 'ffprobe');
});

check('ffmpegEnv: dev (not packaged) → no env set', () => {
  const v = resolveBundledFfmpegEnv({ packaged: false, resourcesPath: '/App/Contents/Resources', platform: 'darwin' });
  eq(v.AIMASTER_FFMPEG,  undefined, 'ffmpeg unset');
  eq(v.AIMASTER_FFPROBE, undefined, 'ffprobe unset');
});

check('ffmpegEnv: missing resourcesPath → no env set', () => {
  const v = resolveBundledFfmpegEnv({ packaged: true, platform: 'darwin' });
  eq(v.AIMASTER_FFMPEG,  undefined, 'ffmpeg unset');
  eq(v.AIMASTER_FFPROBE, undefined, 'ffprobe unset');
});

check('ffmpegEnv: existing override is never clobbered', () => {
  const v = resolveBundledFfmpegEnv({
    packaged: true, resourcesPath: '/App/Contents/Resources', platform: 'darwin',
    existing: { ffmpeg: '/usr/local/bin/ffmpeg' },
  });
  eq(v.AIMASTER_FFMPEG,  undefined, 'existing ffmpeg kept (not returned)');
  eq(v.AIMASTER_FFPROBE, '/App/Contents/Resources/bin/ffprobe', 'ffprobe still resolved');
});

// ── 1d. aimaster-local Range serving (parseRangeHeader / contentTypeForPath) ─
// Regression guard for the Windows "preview + detailed controls don't respond"
// bug: the media element issues a Range probe and needs a 206 reply or
// `loadedmetadata` never fires.  We serve the file ourselves, so the Range
// math must be correct for the forms the <audio> element emits.

check('range: no header → full body', () => {
  const r = parseRangeHeader(null, 1000);
  eq(r.kind, 'full', 'null → full');
  eq(parseRangeHeader(undefined, 1000).kind, 'full', 'undefined → full');
  eq(parseRangeHeader('', 1000).kind, 'full', 'empty → full');
});

check('range: bytes=0- → full span as a 206 range', () => {
  const r = parseRangeHeader('bytes=0-', 1000);
  assert(r.kind === 'range', 'is range');
  if (r.kind === 'range') { eq(r.start, 0, 'start'); eq(r.end, 999, 'end clamped to size-1'); }
});

check('range: bytes=100-199 → inclusive', () => {
  const r = parseRangeHeader('bytes=100-199', 1000);
  assert(r.kind === 'range', 'is range');
  if (r.kind === 'range') { eq(r.start, 100, 'start'); eq(r.end, 199, 'end'); }
});

check('range: end past EOF is clamped', () => {
  const r = parseRangeHeader('bytes=900-99999', 1000);
  assert(r.kind === 'range', 'is range');
  if (r.kind === 'range') { eq(r.start, 900, 'start'); eq(r.end, 999, 'clamped end'); }
});

check('range: suffix bytes=-200 → last 200 bytes', () => {
  const r = parseRangeHeader('bytes=-200', 1000);
  assert(r.kind === 'range', 'is range');
  if (r.kind === 'range') { eq(r.start, 800, 'start'); eq(r.end, 999, 'end'); }
});

check('range: start beyond EOF → unsatisfiable (416)', () => {
  eq(parseRangeHeader('bytes=2000-3000', 1000).kind, 'unsatisfiable', 'start past EOF');
});

check('range: empty file + concrete range → unsatisfiable', () => {
  eq(parseRangeHeader('bytes=0-10', 0).kind, 'unsatisfiable', 'empty file');
});

check('range: multi-range / unknown unit → full body fallback', () => {
  eq(parseRangeHeader('bytes=0-99,200-299', 1000).kind, 'full', 'multi-range');
  eq(parseRangeHeader('items=0-10', 1000).kind, 'full', 'non-bytes unit');
});

check('contentType: audio + image extensions, case-insensitive', () => {
  eq(contentTypeForPath('/x/song.wav'), 'audio/wav', 'wav');
  eq(contentTypeForPath('C:\\x\\song.MP3'), 'audio/mpeg', 'MP3 upper');
  eq(contentTypeForPath('/x/track.flac'), 'audio/flac', 'flac');
  eq(contentTypeForPath('/x/wave.aiff'), 'audio/aiff', 'aiff');
  eq(contentTypeForPath('/x/peaks.png'), 'image/png', 'png');
  eq(contentTypeForPath('/x/unknown.xyz'), 'application/octet-stream', 'fallback');
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
