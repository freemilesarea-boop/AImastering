// audio-engine-selftest — what the app tells a user when ffmpeg fails.
//
// `packages/audio-engine` had one line of test coverage before this file: a
// single selftest imports `PythonBridge` from it.  Nothing had ever resolved a
// binary, classified an ffmpeg failure, or parsed a loudnorm block.  The
// package is also outside the lint run (`eslint src scripts` is the desktop
// app only), so an unused local sat in `normalizeLoudnessPass2` resolving the
// ffmpeg path a second time and throwing the answer away.
//
// What the classifier is FOR is the error the user reads.  `MasteringPage`
// switches on the code to print a hint: FILE_CORRUPTED says "다른 파일로
// 시도하거나 파일을 다시 내보내주세요", OUTPUT_DIR_NOT_WRITABLE says
// "디스크 여유 공간을 확인하거나 권한 설정을 확인해주세요".  Getting the code
// wrong is not a wording slip; it is sending somebody to the wrong problem.
//
// Measured here, against real ffmpeg, before anything was changed:
//
//   · A FULL DISK came out as "your audio file is damaged".  ffmpeg prints
//     nothing but `Conversion failed!` when the destination can take no more
//     bytes — no errno, no "No space left on device" — so it matched none of
//     the patterns and fell out of a catch-all that asserted the input file
//     was corrupt.
//   · A MISSING OUTPUT FOLDER came out the same way, because
//     /no such file or directory/ was tested against the whole stderr without
//     asking which side of the pipe it came from.  ffmpeg says which:
//     "Error opening output files: No such file or directory".
//   · Three of the four "unsupported format" patterns could not match either
//     ffmpeg 6.1.1 or 7.0.2.  They were written from memory: both versions
//     say "Encoder not found" and "Decoder not found", not "unknown encoder"
//     and not "decoder X not found".
//   · And none of it could fire in the running app anyway: the classifier only
//     recognised its own two error classes, while all three places that spawn
//     ffmpeg in the desktop app reject with a plain
//     `Error("ffmpeg exited 1: …")`.  Every one of their failures reached the
//     user as "알 수 없는 오류" with English stderr attached.
//
// Run: pnpm --filter @aimaster/desktop test:audio-engine

export {};

import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, chmodSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  classifyFFmpegError,
  resolveFFmpegPath,
  resolveFFprobePath,
  resolveFFmpegBinaries,
  checkFFmpeg,
  measureLoudnessPass1,
  runFFprobe,
  AppError,
  isAppError,
  fromIPC,
  FFmpegSpawnError,
  FFmpegParseError,
} from '@aimaster/audio-engine';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail: string): void {
  if (ok) { passed++; console.log(`[PASS] ${name} — ${detail}`); }
  else { failed++; console.error(`[FAIL] ${name} — ${detail}`); }
}

const FFMPEG = createRequire(import.meta.url)('ffmpeg-static') as string;
const WORK = mkdtempSync(path.join(os.tmpdir(), 'aimaster-engine-'));

/** One line of ffmpeg's version, so the measurements name what produced them. */
const FFMPEG_VERSION = (spawnSync(FFMPEG, ['-version'], { encoding: 'utf8' }).stdout ?? '')
  .split('\n')[0] ?? '(unknown)';

/**
 * Run ffmpeg and, on failure, reject exactly the way the desktop app does.
 *
 * Not an approximation: `process-audio-file-rust.ts`, `audioTranscode.ts` and
 * `decodeHandlers.ts` each build `` `${bin} exited ${code}: ${stderr}` `` and
 * reject with a plain Error.  A check below holds that this is still their
 * shape, so this helper cannot drift away from what it stands in for.
 */
function runLikeTheApp(args: string[], bin = FFMPEG, name = 'ffmpeg'): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    let err = '';
    child.stderr.on('data', (c: Buffer) => { err += c.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(err);
      else reject(new Error(`${name} exited ${String(code)}: ${err.slice(-400)}`));
    });
  });
}

/** Make `args` fail and hand the thrown error to the classifier. */
async function classifyRun(args: string[], filePath = '', name = 'ffmpeg'): Promise<{
  code: string; userMessage: string; devDetail: string; line: string;
}> {
  try {
    await runLikeTheApp(args, name === 'ffprobe' ? FFPROBE : FFMPEG, name);
    return { code: '(no failure)', userMessage: '', devDetail: '', line: 'ffmpeg exited 0' };
  } catch (err) {
    const app = classifyFFmpegError(err, name === 'ffprobe', filePath);
    const msg = (err as Error).message;
    // The one line that drove the decision, for the check's detail.
    const line = msg.split('\n').filter((l) => /Error opening|Conversion failed|Invalid data|No such file|Nothing was written|Unknown|not found/i.test(l)).pop()
      ?? msg.split('\n').pop() ?? msg;
    return { code: app.code, userMessage: app.userMessage, devDetail: app.devDetail, line: line.trim().slice(0, 150) };
  }
}

/** ffprobe beside the pinned ffmpeg, else the system one. */
const FFPROBE = (() => {
  const beside = path.join(path.dirname(FFMPEG), 'ffprobe');
  return spawnSync(beside, ['-version']).status === 0 ? beside : 'ffprobe';
})();

const REAL    = path.join(WORK, 'real.wav');
const SILENT  = path.join(WORK, 'silent.wav');
const TINY    = path.join(WORK, 'tiny.wav');
const CORRUPT = path.join(WORK, 'corrupt.wav');
const MISSING = path.join(WORK, 'nope.wav');

function makeInputs(): void {
  const gen = (filter: string, dur: string, out: string): void => {
    const r = spawnSync(FFMPEG, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', filter, '-t', dur, '-ac', '2', '-ar', '48000', out,
    ], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`could not build ${out}: ${String(r.stderr)}`);
  };
  gen('sine=frequency=440', '2', REAL);
  gen('anullsrc=r=48000:cl=stereo', '2', SILENT);
  gen('sine=frequency=440', '0.01', TINY);
  // 4 KB of bytes that are not a wav, with a name that says they are.
  writeFileSync(CORRUPT, Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 37) % 256)));
}

async function main(): Promise<void> {
  console.log(`\n=== audio-engine: what the user is told when ffmpeg fails ===`);
  console.log(`    driven by ${FFMPEG_VERSION}\n`);
  makeInputs();

  // ── The failures a user actually hits ─────────────────────────────────────
  {
    const full = await classifyRun(['-hide_banner', '-y', '-i', REAL, '-f', 'wav', '/dev/full'], REAL);
    check(
      'a full disk is a full disk, not a damaged audio file',
      full.code === 'OUTPUT_DIR_NOT_WRITABLE' && full.userMessage.includes('디스크'),
      `ffmpeg said "${full.line}" → ${full.code}: ${full.userMessage}`,
    );
  }
  {
    const out = path.join(WORK, 'no-such-dir', 'out.wav');
    const dir = await classifyRun(['-hide_banner', '-y', '-i', REAL, out], REAL);
    check(
      'an output folder that is not there is reported as the output, not the input',
      dir.code === 'OUTPUT_DIR_NOT_WRITABLE',
      `ffmpeg said "${dir.line}" → ${dir.code}`,
    );
  }
  {
    const bad = await classifyRun(['-hide_banner', '-y', '-i', CORRUPT, '-f', 'null', '-'], CORRUPT);
    check(
      'a file that is not audio is reported as unreadable',
      bad.code === 'FILE_CORRUPTED' && bad.devDetail.includes('Invalid data found'),
      `ffmpeg said "${bad.line}" → ${bad.code}`,
    );
  }
  {
    const gone = await classifyRun(['-hide_banner', '-y', '-i', MISSING, '-f', 'null', '-'], MISSING);
    check(
      'a file that has moved is reported against the input side',
      gone.code === 'FILE_CORRUPTED' && gone.devDetail.includes('input rejected'),
      `ffmpeg said "${gone.line}" → ${gone.code}`,
    );
  }
  {
    const dec = await classifyRun(
      ['-hide_banner', '-y', '-c:a', 'nosuchdec', '-i', REAL, '-f', 'null', '-'], REAL);
    const enc = await classifyRun(
      ['-hide_banner', '-y', '-i', REAL, '-c:a', 'nosuchcodec', path.join(WORK, 'x.wav')], REAL);
    check(
      'a codec this build cannot read is an unsupported format, both directions',
      dec.code === 'FORMAT_UNSUPPORTED' && enc.code === 'FORMAT_UNSUPPORTED',
      `decoder → ${dec.code} ("${dec.line}"), encoder → ${enc.code} ("${enc.line}")`,
    );
    check(
      'and the Korean message names the codec, not the word "unknown"',
      dec.userMessage.includes('지원하지 않는') && dec.userMessage.includes('nosuchdec')
        && !dec.userMessage.includes('unknown') && dec.userMessage.includes('WAV'),
      dec.userMessage,
    );
  }
  {
    // Our own filter string, not their file.  The user can do nothing with
    // "try another file", so this must not claim their file is broken.
    const flt = await classifyRun(
      ['-hide_banner', '-y', '-i', REAL, '-af', 'nosuchfilter=1', '-f', 'null', '-'], REAL);
    check(
      'a filter chain WE got wrong is not blamed on the user’s file',
      flt.code !== 'FILE_CORRUPTED' && flt.code !== 'OUTPUT_DIR_NOT_WRITABLE',
      `ffmpeg said "${flt.line}" → ${flt.code}`,
    );
    check(
      'and it carries the stderr, so the devDetail says what ffmpeg refused',
      /filtergraph|Invalid argument|arguments/i.test(flt.devDetail),
      flt.devDetail.slice(0, 120),
    );
  }
  {
    const nothing = await classifyRun(
      ['-hide_banner', '-y', '-i', REAL, '-c:a', 'libmp3lame', '-b:a', 'zzz',
       path.join(WORK, 'x.mp3')], REAL);
    check(
      'an encoder argument we got wrong is ours too',
      nothing.code === 'UNKNOWN' && /Nothing was written|arguments/i.test(nothing.devDetail),
      `ffmpeg said "${nothing.line}" → ${nothing.code}`,
    );
  }
  {
    const probe = await classifyRun(
      ['-v', 'error', '-show_format', '-of', 'json', CORRUPT], CORRUPT, 'ffprobe');
    check(
      'ffprobe says it differently, and is classified too',
      probe.code === 'FILE_CORRUPTED',
      `ffprobe said "${probe.line}" → ${probe.code}`,
    );
  }
  {
    // The gate: the same words in something that is NOT an ffmpeg failure must
    // not be read as one.  A session file that moved says exactly this.
    const notFfmpeg = classifyFFmpegError(
      new Error('ENOENT: no such file or directory, open \'/Users/me/세션.louisession\''),
      false, '/Users/me/세션.louisession');
    check(
      'a non-ffmpeg error that happens to contain ffmpeg words is left alone',
      notFfmpeg.code === 'UNKNOWN',
      `"${notFfmpeg.devDetail.slice(0, 60)}…" → ${notFfmpeg.code}`,
    );
  }
  {
    const missingBin = classifyFFmpegError(new Error('spawn ffmpeg ENOENT'));
    const missingProbe = classifyFFmpegError(new Error('spawn /opt/bin/ffprobe ENOENT'));
    check(
      'a missing binary tells the user to install FFmpeg, not that the engine is busy',
      missingBin.code === 'FFMPEG_NOT_FOUND' && missingProbe.code === 'FFPROBE_NOT_FOUND',
      `${missingBin.code} / ${missingProbe.code} — "${missingBin.userMessage}"`,
    );
  }
  {
    const timedOut = classifyFFmpegError(
      new FFmpegSpawnError(FFMPEG, ['-i', REAL], null, '', `Process timed out after 1 ms: ${FFMPEG}`));
    check(
      'a timeout is the one ffmpeg failure worth retrying, and says so',
      timedOut.recoverable && timedOut.userMessage.includes('시간이 초과')
        && !timedOut.userMessage.includes('엔진'),
      `${timedOut.code}, recoverable=${timedOut.recoverable}: ${timedOut.userMessage}`,
    );
  }
  {
    const parse = classifyFFmpegError(new FFmpegParseError('{"input_i":"-inf"}', 'silent'));
    check(
      'a loudnorm block that could not be read keeps its own code',
      parse.code === 'LOUDNORM_PARSE_FAILED' && parse.devDetail.includes('input_i'),
      `${parse.code}: ${parse.devDetail.slice(0, 80)}`,
    );
  }
  {
    // The last branch: ffmpeg failed and said nothing this file has seen
    // before.  It must NOT answer with a statement about the user's file —
    // that is what the old catch-all did for every unrecognised exit, which
    // is how a full disk became "your audio file is damaged".
    const strange = classifyFFmpegError(
      new Error('ffmpeg exited 69: Assertion failed in some future ffmpeg'), false, REAL);
    check(
      'an ffmpeg failure nobody has seen before is not blamed on the file',
      strange.code === 'UNKNOWN' && strange.devDetail.includes('Assertion failed')
        && strange.devDetail.includes('exit 69'),
      `${strange.code}: ${strange.devDetail.slice(0, 90)}`,
    );
  }
  {
    // The runner's OWN error class, which is what `measureLoudnessPass1` and
    // friends raise.  Nothing in the desktop app constructs one today, so
    // these two branches are reachable only from here and from a host that
    // calls the package's runner functions directly.
    const noFfmpeg = classifyFFmpegError(new FFmpegSpawnError(
      'ffmpeg', ['-i', REAL], null, '', 'Failed to start process "ffmpeg": spawn ffmpeg ENOENT'));
    const noProbe = classifyFFmpegError(new FFmpegSpawnError(
      '/opt/bin/ffprobe', ['-i', REAL], null, '', 'Failed to start process: ENOENT'));
    check(
      'a runner that could not start its binary names which binary it was',
      noFfmpeg.code === 'FFMPEG_NOT_FOUND' && noProbe.code === 'FFPROBE_NOT_FOUND'
        && noProbe.devDetail.includes('/opt/bin/ffprobe'),
      `${noFfmpeg.code} / ${noProbe.code} (from the path, with isFfprobe left false)`,
    );
  }
  {
    const already = classifyFFmpegError(new AppError('TRIAL_COUNT_ANOMALY', 'u', 'd', false));
    check(
      'an error that was already classified is passed through untouched',
      already.code === 'TRIAL_COUNT_ANOMALY',
      already.code,
    );
  }

  // ── The shape this file stands in for ────────────────────────────────────
  {
    // If the app stops rejecting with `<bin> exited <code>: <stderr>`, the
    // classifier stops recognising it, silently, and every ffmpeg failure
    // goes back to "알 수 없는 오류".  So the shape is held here.
    const spawners: [string, RegExp][] = [
      ['src/main/offline/process-audio-file-rust.ts', /`ffmpeg exited \$\{code\}/],
      ['src/main/utils/audioTranscode.ts',            /`ffmpeg exited \$\{code\}/],
      ['src/main/ipc/decodeHandlers.ts',              /`\$\{path\.basename\(bin\)\} exited \$\{code\}/],
    ];
    const drifted = spawners.filter(([file, pat]) => !pat.test(readFileSync(file, 'utf8')));
    check(
      'the three places that spawn ffmpeg still reject in the shape this test feeds in',
      drifted.length === 0,
      drifted.length === 0
        ? spawners.map(([f]) => path.basename(f)).join(', ')
        : `changed: ${drifted.map(([f]) => f).join(', ')}`,
    );
  }

  // ── Binary resolution ────────────────────────────────────────────────────
  {
    const both = resolveFFmpegBinaries();
    check(
      'with nothing configured, both binaries resolve to something',
      both.ffmpeg.length > 0 && both.ffprobe.length > 0
        && both.ffmpeg === resolveFFmpegPath() && both.ffprobe === resolveFFprobePath(),
      `ffmpeg=${both.ffmpeg}, ffprobe=${both.ffprobe}`,
    );
  }
  {
    const before = process.env['AIMASTER_FFMPEG'];
    process.env['AIMASTER_FFMPEG'] = FFMPEG;
    const chosen = resolveFFmpegPath();
    if (before === undefined) delete process.env['AIMASTER_FFMPEG'];
    else process.env['AIMASTER_FFMPEG'] = before;
    check(
      'the environment override is honoured when it points at a real binary',
      chosen === FFMPEG,
      `AIMASTER_FFMPEG=${FFMPEG} → ${chosen}`,
    );
  }
  {
    // The bug this found: `access(X_OK)` is true for a DIRECTORY, so a folder
    // was accepted as the binary and the warning that exists to say "not
    // executable" could not fire for the most likely mistake.
    const dir = path.join(WORK, 'bin-dir');
    mkdirSync(dir, { recursive: true });
    const warned: string[] = [];
    const realWarn = console.warn;
    console.warn = (...a: unknown[]): void => { warned.push(a.map(String).join(' ')); };
    const before = process.env['AIMASTER_FFMPEG'];
    process.env['AIMASTER_FFMPEG'] = dir;
    const chosen = resolveFFmpegPath();
    if (before === undefined) delete process.env['AIMASTER_FFMPEG'];
    else process.env['AIMASTER_FFMPEG'] = before;
    console.warn = realWarn;
    check(
      'a folder is not a binary, and the user is told which variable is wrong',
      chosen !== dir && warned.some((w) => w.includes('AIMASTER_FFMPEG') && w.includes(dir)),
      chosen === dir
        ? `resolved to the folder ${dir}`
        : `fell through to ${chosen}; warned: ${warned[0]?.slice(0, 90) ?? '(nothing)'}`,
    );
  }
  {
    const file = path.join(WORK, 'not-executable');
    writeFileSync(file, 'I am not a program\n');
    chmodSync(file, 0o644);
    const before = process.env['AIMASTER_FFPROBE'];
    process.env['AIMASTER_FFPROBE'] = file;
    const chosen = resolveFFprobePath();
    if (before === undefined) delete process.env['AIMASTER_FFPROBE'];
    else process.env['AIMASTER_FFPROBE'] = before;
    check(
      'a file without the execute bit is refused too',
      chosen !== file,
      `AIMASTER_FFPROBE=${file} → ${chosen}`,
    );
  }
  {
    // The packaged branch, which is the one nobody can try by hand: a bundled
    // binary under <resources>/bin must win, and a broken one must be REPORTED
    // broken rather than quietly replaced by the system ffmpeg.
    const resources = path.join(WORK, 'resources');
    const binDir = path.join(resources, 'bin');
    mkdirSync(binDir, { recursive: true });
    const fake = path.join(binDir, 'ffmpeg');
    writeFileSync(fake, '#!/bin/sh\necho "bundled ffmpeg is broken" >&2\nexit 1\n');
    chmodSync(fake, 0o755);

    const resolved = resolveFFmpegPath({ packaged: true, resourcesPath: resources });
    const ignored  = resolveFFmpegPath({ packaged: false, resourcesPath: resources });
    check(
      'a packaged build prefers the binary it shipped with',
      resolved === fake && ignored !== fake,
      `packaged → ${resolved}; unpackaged → ${ignored}`,
    );

    const status = checkFFmpeg({ packaged: true, resourcesPath: resources });
    check(
      'and a bundled binary that cannot run is reported unavailable, by path',
      status.available === false && status.path === fake,
      `available=${status.available}, path=${status.path}`,
    );
  }
  {
    const ok = checkFFmpeg();
    check(
      'the startup check reads a real version out of a working ffmpeg',
      ok.available && typeof ok.version === 'string' && /\d/.test(ok.version ?? ''),
      `available=${ok.available}, version=${String(ok.version)}, ffprobe=${ok.ffprobeAvailable}`,
    );
  }

  // ── loudnorm, through real ffmpeg ────────────────────────────────────────
  {
    const m = await measureLoudnessPass1(REAL, { packaged: false });
    const i = Number(m.input_i);
    check(
      'the loudnorm block is found in ffmpeg’s stderr and parsed',
      Number.isFinite(i) && i < 0 && typeof m.input_tp === 'string' && typeof m.target_offset === 'string',
      `input_i=${m.input_i} LUFS, input_tp=${m.input_tp} dBTP, offset=${m.target_offset}`,
    );
  }
  {
    let code = '(no failure)';
    let said = '';
    try { await measureLoudnessPass1(SILENT); }
    catch (err) { const a = classifyFFmpegError(err, false, SILENT); code = a.code; said = a.userMessage; }
    check(
      'a silent file is called silent, not corrupt',
      code === 'LOUDNORM_PARSE_FAILED' && said.includes('무음'),
      `${code}: ${said}`,
    );
  }
  {
    // 0.01 s: shorter than loudnorm's own window.  Whatever it does, it must
    // not come back as a measurement nobody can use.
    let outcome = '';
    try {
      const m = await measureLoudnessPass1(TINY);
      outcome = `measured input_i=${m.input_i}`;
      check(
        'a file too short to measure either measures or refuses — never NaN',
        Number.isFinite(Number(m.input_i)),
        outcome,
      );
    } catch (err) {
      const a = classifyFFmpegError(err, false, TINY);
      check(
        'a file too short to measure either measures or refuses — never NaN',
        a.code === 'LOUDNORM_PARSE_FAILED',
        `refused: ${a.code}`,
      );
    }
  }
  {
    const info = await runFFprobe(REAL);
    const audio = info.streams.find((s) => s['codec_type'] === 'audio');
    check(
      'ffprobe JSON comes back whole',
      audio !== undefined && Number(info.format['duration']) > 1.9,
      `${info.streams.length} stream(s), duration=${String(info.format['duration'])}`,
    );
  }

  // ── AppError over IPC ────────────────────────────────────────────────────
  {
    const original = classifyFFmpegError(new Error('ffmpeg exited 1: Error opening output files: No space left on device'), false, '/tmp/out.wav');
    const roundTripped = fromIPC(JSON.parse(JSON.stringify(original.toJSON())));
    check(
      'an AppError survives the trip to the renderer with every field',
      isAppError(roundTripped) && roundTripped.code === original.code
        && roundTripped.userMessage === original.userMessage
        && roundTripped.devDetail === original.devDetail
        && roundTripped.recoverable === original.recoverable,
      `${roundTripped.code} / recoverable=${roundTripped.recoverable}`,
    );
    check(
      'and an out-of-space write is a destination problem on a real stderr line',
      original.code === 'OUTPUT_DIR_NOT_WRITABLE',
      original.userMessage,
    );
  }
  {
    const junk = fromIPC({ nope: true });
    check(
      'something that is not an AppError becomes UNKNOWN rather than undefined fields',
      junk.code === 'UNKNOWN' && junk.userMessage.length > 0 && junk.recoverable,
      `${junk.code}: ${junk.userMessage}`,
    );
  }

  // ── The UI has to have a hint for every code this can produce ───────────
  {
    const page = readFileSync('src/renderer/pages/MasteringPage.tsx', 'utf8');
    const store = readFileSync('src/renderer/stores/audioStore.ts', 'utf8');
    const engine = readFileSync('../../packages/audio-engine/src/errors.ts', 'utf8');
    const declared = [...engine.matchAll(/^ {2}\| '([A-Z_]+)'$/gm)].map((m) => m[1] ?? '');
    const noHint = declared.filter((c) => c !== 'UNKNOWN' && !page.includes(`case '${c}':`));
    const notInStore = declared.filter((c) => !store.includes(`'${c}'`));
    check(
      'every error code the engine can return has a hint on the page that shows it',
      declared.length >= 10 && noHint.length === 0,
      noHint.length === 0 ? `${declared.length} codes, all with a hint` : `no hint for ${noHint.join(', ')}`,
    );
    check(
      'and the renderer’s own copy of the code list is not missing any',
      notInStore.length === 0,
      notInStore.length === 0
        ? `${declared.length} codes in both lists (two copies, one meaning — audioStore.ts cannot import the Node package)`
        : `audioStore.ts has no case for ${notInStore.join(', ')}`,
    );
  }

  rmSync(WORK, { recursive: true, force: true });
  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
  if (failed > 0) process.exit(1);
}

void main().catch((err: unknown) => {
  console.error(`[FAIL] the suite did not finish — ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  rmSync(WORK, { recursive: true, force: true });
  process.exit(1);
});
