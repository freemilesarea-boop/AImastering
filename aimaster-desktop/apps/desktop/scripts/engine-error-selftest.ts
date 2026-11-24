// engine-error-selftest — what a user is told when the engine refuses a job.
//
// The packaged app was finally built and driven this cycle (the first time
// this session), and the first thing the packaged harness showed was this: with
// the bundled ffmpeg removed — a part-installed app, or one whose binary a
// virus scanner took — the engine answered
//
//   '…/resources/bin/ffprobe'을 찾을 수 없습니다. FFmpeg가 올바르게 설치되어
//   있는지 확인해주세요.  설치 방법: brew install ffmpeg (macOS) / apt …
//
// and the user was shown
//
//   알 수 없는 오류가 발생했습니다. 다시 시도해주세요.
//
// Two reasons, both now fixed and both checked below:
//
//   · `PythonBridge` rejected with `new Error(rpc.error.message)`, dropping
//     `rpc.error.code`.  `toAppError`'s "this is an answer from the engine"
//     branch keys on a numeric code, so it could never fire — the engine
//     sends -32000 and nothing downstream ever saw it.
//   · Nothing read the engine's own sentence.  It is Korean, written for the
//     user by the code that knows what happened, and it was being replaced
//     with a placeholder.
//
// The decision now lives in `engine-error.ts`, which imports no electron, so
// every branch is driven here rather than from a running main process.
//
// Run: pnpm --filter @aimaster/desktop test:engine-error

export {};

import { readFileSync } from 'node:fs';
import { appErrorFor } from '../src/main/ipc/engine-error.js';
import { AppError, FFmpegSpawnError } from '@aimaster/audio-engine';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail: string): void {
  if (ok) { passed++; console.log(`[PASS] ${name} — ${detail}`); }
  else { failed++; console.error(`[FAIL] ${name} — ${detail}`); }
}

/** An engine rejection, in the shape the bridge now produces. */
function fromEngine(message: string, rpcCode = -32000): Error {
  const err = new Error(message) as Error & { rpcCode?: number };
  err.rpcCode = rpcCode;
  return err;
}

/** The exact sentence the shipped engine sends, measured from the binary. */
const ENGINE_MISSING_FFMPEG =
  "'/tmp/loui-pkg-smoke/installed/linux-unpacked/resources/bin/ffprobe'을 찾을 수 없습니다. "
  + 'FFmpeg가 올바르게 설치되어 있는지 확인해주세요.\n'
  + '설치 방법: brew install ffmpeg (macOS) / apt install ffmpeg (Linux)';

function main(): void {
  console.log('\n=== Engine failures, as the user reads them ===\n');

  {
    const app = appErrorFor(fromEngine(ENGINE_MISSING_FFMPEG), '/songs/mix.wav');
    check(
      'a packaged app that cannot find its ffmpeg says so, and says what to do',
      app.code === 'FFMPEG_NOT_FOUND' && app.userMessage.includes('FFmpeg')
        && !app.userMessage.includes('알 수 없는'),
      `${app.code}: ${app.userMessage}`,
    );
    const page = readFileSync('src/renderer/pages/MasteringPage.tsx', 'utf8');
    check(
      'and the page has a hint for that code, with somewhere to get it',
      page.includes("case 'FFMPEG_NOT_FOUND':") && /ffmpeg\.org\/download/.test(page),
      'MasteringPage.errorHint points at the download page',
    );
  }
  {
    // Any other engine refusal: keep its own words rather than a placeholder.
    const app = appErrorFor(fromEngine('입력 파일이 너무 짧습니다 (0.2초). 최소 1초 이상이어야 합니다.'));
    check(
      'any other engine refusal reaches the user in the engine’s own words',
      app.userMessage.startsWith('입력 파일이 너무 짧습니다')
        && app.code === 'PYTHON_PROCESS_FAILED' && app.recoverable,
      `${app.code}: ${app.userMessage}`,
    );
  }
  {
    const multi = appErrorFor(fromEngine('첫 줄만 보여 준다.\n두 번째 줄은 개발자용 detail 이다.'));
    check(
      'a multi-line engine message shows its first line and keeps the rest for the log',
      multi.userMessage === '첫 줄만 보여 준다.'
        && multi.devDetail.includes('두 번째 줄'),
      `user sees "${multi.userMessage}", devDetail has ${multi.devDetail.length} chars`,
    );
  }
  {
    // An engine message that is NOT Korean is a developer-facing failure; the
    // canned Korean sentence is the right thing to show for it.
    const app = appErrorFor(fromEngine('TypeError: unsupported operand type(s)'));
    check(
      'an English engine failure gets the Korean sentence written for the user',
      /[가-힣]/.test(app.userMessage) && app.devDetail.includes('TypeError'),
      `${app.code}: ${app.userMessage}`,
    );
  }
  {
    // No rpcCode: the engine never answered, because it never started.
    const app = appErrorFor(new Error('spawn /opt/app/resources/bin/engine ENOENT'));
    check(
      'an engine that cannot start is not reported as an engine that refused',
      app.code === 'PYTHON_PROCESS_FAILED' && !app.recoverable
        && app.devDetail.includes('failed to start'),
      `${app.code}, recoverable=${app.recoverable}`,
    );
  }
  {
    const app = appErrorFor(new Error('ffmpeg exited 1: Error opening output files: No space left on device'),
      '/songs/mix.wav');
    check(
      'an ffmpeg failure still goes to the ffmpeg classifier',
      app.code === 'OUTPUT_DIR_NOT_WRITABLE',
      `${app.code}: ${app.userMessage}`,
    );
  }
  {
    const already = appErrorFor(new AppError('TRIAL_COUNT_ANOMALY', 'u', 'd', false));
    const spawnErr = appErrorFor(new FFmpegSpawnError('ffprobe', [], null, '', 'Failed to start process'));
    check(
      'a classified error passes through, and a runner error keeps its own code',
      already.code === 'TRIAL_COUNT_ANOMALY' && spawnErr.code === 'FFPROBE_NOT_FOUND',
      `${already.code} / ${spawnErr.code}`,
    );
  }
  {
    const app = appErrorFor(new Error('ENAMETOOLONG: name too long'), '/songs/' + 'x'.repeat(300) + '.wav');
    check(
      'a path the OS will not take is reported as a path problem',
      app.code === 'PATH_ENCODING_ERROR',
      `${app.code}: ${app.userMessage.slice(0, 40)}…`,
    );
  }
  {
    const nothing = appErrorFor(new Error('something nobody has seen'));
    check(
      'and anything genuinely unrecognised is still UNKNOWN, carrying its text',
      nothing.code === 'UNKNOWN' && nothing.devDetail.includes('nobody has seen'),
      `${nothing.code}: ${nothing.devDetail}`,
    );
  }
  {
    // The bridge half of the fix: the code has to survive the rejection.
    const bridge = readFileSync('../../packages/audio-engine/src/utils/pythonBridge.ts', 'utf8');
    check(
      'the bridge attaches the JSON-RPC code to the error it rejects with',
      /failure\.rpcCode = rpc\.error\.code;/.test(bridge)
        && /pending\.reject\(failure\)/.test(bridge),
      'rpcCode travels with the rejection — python-rpc-selftest drives it for real',
    );
  }
  {
    // Not "does one spelling of the old branch still appear" — the first
    // version of this check forbade exactly `/ENOENT|spawn/i.test(msg)` and a
    // re-grown branch written against `String(err)` walked straight past it.
    //
    // The judgeable fact: deciding what a user is told means reaching for one
    // of the AppError factories, and `audioHandlers` has no business holding
    // any of them except the two it throws DELIBERATELY — the temp-dir guard
    // and the bridge-died retry.
    const handler = readFileSync('src/main/ipc/audioHandlers.ts', 'utf8');
    const classifiers = ['ffmpegNotFound', 'ffprobeNotFound', 'fileCorrupted',
      'formatUnsupported', 'pathEncodingError', 'loudnormParseFailed',
      'unknownError', 'classifyFFmpegError'];
    const regrown = classifiers.filter((name) => new RegExp(`\\b${name}\\b`).test(handler));
    check(
      'and the handler has one place where this is decided',
      /appErrorFor\(err, filePath\)/.test(handler) && regrown.length === 0,
      regrown.length === 0
        ? 'audioHandlers delegates; it holds no classifier of its own'
        : `audioHandlers reaches for ${regrown.join(', ')} again`,
    );
  }

  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
  if (failed > 0) process.exit(1);
}

main();
