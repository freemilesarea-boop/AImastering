// python-rpc-selftest — the three calls the app makes to the engine, and the
// line protocol they all arrive on.
//
// `PythonBridge` is how every mastering run reaches the Python engine: one
// subprocess, newline-delimited JSON over stdin/stdout, progress messages
// interleaved with responses, replies matched by id.  The only test that
// touched it covered SHUTDOWN.  Nothing covered the protocol — not the
// buffering, not the progress demultiplexing, not the id matching, not the
// error mapping, not the queue that holds calls made before the engine says
// READY.
//
// And nothing drove `master` at all, on either side.  The Python suite's RPC
// test reads one line per call, which a method that emits fourteen progress
// messages would break, so it covers `analyze` and `qc_check` and stops there
// — leaving the one method that writes the user's file untested over the
// protocol it is called through.
//
// Driving the real engine here turned up what the two sides disagree about.
// Measured against a 3-second wav:
//
//   analyze → 8 keys; `AudioAnalysisResult` declared 6.  `warnings` and
//             `waveform` were sent on every call and declared by nobody, so
//             no code could read them.  On a mono 22.05 kHz file `warnings`
//             carries three Korean sentences written for the user —
//             NON_STANDARD_SAMPLE_RATE, MONO_INPUT, WAVEFORM_DETAIL — and the
//             user was shown none of them.
//   master  → 25 keys; `MasteringResult` declared 23.  `style` (what the
//             engine actually applied) and `postWaveform` (the measured state
//             of the file it wrote) were the other two.
//   qc_check→ 5 keys, all 5 declared.  Nothing wrong there.
//
// Both types now declare them, HomePage shows the file warnings on the queue
// row, and the checks below compare what the engine SENDS against what the
// types SAY, in both directions, so the next added field cannot go unread for
// as long as these did.
//
// Run: pnpm --filter @aimaster/desktop test:python-rpc

export {};

import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { PythonBridge } from '@aimaster/audio-engine';
import { pythonBin, pythonBinSource, applyShippedFfmpegEnv } from './lib/python-bin.js';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail: string): void {
  if (ok) { passed++; console.log(`[PASS] ${name} — ${detail}`); }
  else { failed++; console.error(`[FAIL] ${name} — ${detail}`); }
}

const WORK = mkdtempSync(path.join(os.tmpdir(), 'aimaster-rpc-'));
const SERVICE = path.resolve('../../services/python-audio');
const FFMPEG = createRequire(import.meta.url)('ffmpeg-static') as string;

/**
 * A fake engine, in node, that speaks the line protocol badly on purpose.
 *
 * The real engine is the right thing to check the CONTRACT against, and it is
 * used for that below.  It is the wrong thing to check the protocol against:
 * a split JSON line, a reply with somebody else's id, a line that is not JSON
 * at all, and a request that is never answered are all things the bridge must
 * survive and none of them can be asked of a correct engine.
 */
function fakeEngine(body: string): string {
  const file = path.join(WORK, `fake-${Math.random().toString(36).slice(2)}.cjs`);
  writeFileSync(file, `'use strict';
const send = (s) => process.stdout.write(s);
const ready = () => process.stderr.write('READY\\n');
let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf8');
  const lines = buf.split('\\n');
  buf = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    const req = JSON.parse(line);
    (${body})(req, send, process);
  }
});
${body.includes('/* no ready */') ? '' : 'ready();'}
`);
  return file;
}

function bridgeOn(scriptPath: string, timeoutMs?: number): PythonBridge {
  const bridge = new PythonBridge(
    timeoutMs === undefined
      ? { pythonPath: process.execPath, scriptPath }
      : { pythonPath: process.execPath, scriptPath, timeoutMs },
  );
  bridge.spawn();
  return bridge;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Deadline for a call to the FAKE engine.
 *
 * The bridge's own table gives `master` fifteen minutes and `analyze` three,
 * which is right for a real render and wrong for a check whose engine answers
 * in a millisecond.  The first version of this file left the table to it: with
 * the line buffer deliberately broken, the split-reply check did not fail — it
 * sat there for the full fifteen minutes, and the break showed up as "the
 * suite did not finish" instead of naming the one thing that was wrong.
 */
const FAKE_DEADLINE_MS = 2_000;

/**
 * `bridge.call`, with a clock of its own.
 *
 * The bridge's deadline cannot be trusted by a test whose subject IS the
 * bridge: break the ready queue and the call is neither sent nor rejected;
 * break the wait timer and the same.  Three breaks in a row made a check hang
 * — once for the full fifteen minutes of the `master` timeout — and the run
 * said "the suite did not finish" instead of naming the check.  So every call
 * to the fake engine races a timer this file owns.
 */
function ask<T>(
  bridge: PythonBridge, method: string, params: Record<string, unknown> = {},
  ms = FAKE_DEADLINE_MS,
): Promise<T> {
  return Promise.race([
    bridge.call<T>(method as Parameters<PythonBridge['call']>[0], params, ms),
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`the call never settled within ${ms + 500} ms`)), ms + 500);
    }),
  ]);
}

/** Field names declared at the top level of a TS interface. */
function declaredFields(source: string, name: string): string[] {
  const at = source.indexOf(`export interface ${name} {`);
  if (at < 0) return [];
  let depth = 0;
  const fields: string[] = [];
  for (let i = source.indexOf('{', at); i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') { depth++; continue; }
    if (ch === '}') { depth--; if (depth === 0) break; continue; }
    if (depth !== 1) continue;
    if (ch === '\n') {
      const line = source.slice(i + 1, source.indexOf('\n', i + 1) === -1 ? undefined : source.indexOf('\n', i + 1));
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\??\s*:/.exec(line);
      if (m?.[1]) fields.push(m[1]);
    }
  }
  return fields;
}

async function main(): Promise<void> {
  console.log('\n=== The engine bridge: the protocol, and the contract ===\n');

  // ── The protocol, against an engine that behaves badly on purpose ───────
  {
    const engine = fakeEngine(`(req, send) => send(JSON.stringify({ id: req.id, result: { ok: 1, method: req.method } }) + '\\n')`);
    const bridge = bridgeOn(engine);
    const outcome = await ask<{ ok: number; method: string }>(bridge, 'analyze', { file_path: '/x' })
      .then((value) => ({ value, error: '' }), (err: Error) => ({ value: null, error: err.message }));
    bridge.kill();
    check(
      'a call gets its own result back',
      outcome.value?.ok === 1 && outcome.value.method === 'analyze',
      outcome.error || JSON.stringify(outcome.value),
    );
  }
  {
    // Fourteen progress messages arrive before the result of a real master.
    // Each one must reach the `progress` listener and none of them may be
    // mistaken for the answer.
    const engine = fakeEngine(`(req, send) => {
      for (let i = 1; i <= 3; i++) send(JSON.stringify({ type: 'progress', jobId: req.id, percent: i * 10, stage: 'stage' + i }) + '\\n');
      send(JSON.stringify({ id: req.id, result: { done: true } }) + '\\n');
    }`);
    const bridge = bridgeOn(engine);
    const seen: number[] = [];
    bridge.on('progress', (p: unknown) => { seen.push((p as { percent: number }).percent); });
    const outcome = await ask<{ done: boolean }>(bridge, 'master')
      .then((value) => ({ value, error: '' }), (err: Error) => ({ value: null, error: err.message }));
    await sleep(30);
    bridge.kill();
    check(
      'progress messages are delivered, and none of them is read as the answer',
      outcome.value?.done === true && seen.join(',') === '10,20,30',
      `percent seen: [${seen.join(', ')}], ${outcome.error || `result=${JSON.stringify(outcome.value)}`}`,
    );
  }
  {
    // A master result is 25 keys of nested objects; stdout hands it over in
    // whatever chunks the pipe feels like.  Split mid-key on purpose.
    const engine = fakeEngine(`(req, send, proc) => {
      const line = JSON.stringify({ id: req.id, result: { outputPath: '/tmp/a.wav', nested: { deep: [1, 2, 3] } } }) + '\\n';
      const cut = Math.floor(line.length / 2);
      send(line.slice(0, cut));
      setTimeout(() => send(line.slice(cut)), 20);
    }`);
    const bridge = bridgeOn(engine);
    // Caught here, not by the net at the bottom: with the buffer broken this
    // call rejects on its deadline, and a failure that reaches the net is
    // reported as "the suite did not finish" instead of naming the one thing
    // that is wrong.
    let result: { outputPath?: string; nested?: { deep: number[] } } | null = null;
    let trouble = '';
    try {
      result = await ask<{ outputPath: string; nested: { deep: number[] } }>(bridge, 'master');
    } catch (err) { trouble = (err as Error).message; }
    bridge.kill();
    check(
      'a reply split across two chunks is put back together',
      result?.outputPath === '/tmp/a.wav' && result?.nested?.deep.length === 3,
      trouble ? `the halves never came back together: ${trouble}` : JSON.stringify(result),
    );
  }
  {
    const engine = fakeEngine(`(req, send) => send(JSON.stringify({ id: req.id, error: { code: -32000, message: '오디오 파일을 읽을 수 없습니다.' } }) + '\\n')`);
    const bridge = bridgeOn(engine);
    const thrown = await ask(bridge, 'analyze')
      .then(() => null, (err: Error & { rpcCode?: number }) => err);
    bridge.kill();
    check(
      'an error reply rejects with the Korean message the engine wrote',
      thrown?.message === '오디오 파일을 읽을 수 없습니다.',
      `"${String(thrown?.message)}"`,
    );
    check(
      'and the JSON-RPC code travels with it',
      thrown?.rpcCode === -32000,
      // Without the code, the engine's own sentence about a missing ffmpeg
      // reached the user as "알 수 없는 오류가 발생했습니다": `engine-error.ts`
      // keys on it to tell an answer FROM the engine from a failure to reach
      // the engine at all.
      `rpcCode=${String(thrown?.rpcCode)}`,
    );
  }
  {
    // A reply for a request this bridge never made (a late answer after a
    // timeout, a confused engine) must be dropped, not crash the handler and
    // not resolve somebody else's call.
    const engine = fakeEngine(`(req, send) => {
      send(JSON.stringify({ id: 'nobody-asked-for-this', result: { wrong: true } }) + '\\n');
      send('this line is not JSON at all\\n');
      send(JSON.stringify({ id: req.id, result: { right: true } }) + '\\n');
    }`);
    const bridge = bridgeOn(engine);
    const outcome = await ask<{ right?: boolean; wrong?: boolean }>(bridge, 'analyze')
      .then((value) => ({ value, error: '' }), (err: Error) => ({ value: null, error: err.message }));
    bridge.kill();
    check(
      'a reply with an unknown id, and a line that is not JSON, are both ignored',
      outcome.value?.right === true && outcome.value.wrong === undefined,
      outcome.error || JSON.stringify(outcome.value),
    );
  }
  {
    // The engine takes about a second to start.  A call made in that window
    // has to wait, not vanish.
    const engine = fakeEngine(`(req, send) => send(JSON.stringify({ id: req.id, result: { queued: true } }) + '\\n') /* no ready */`);
    writeFileSync(engine, readFileSync(engine, 'utf8').replace(
      "process.stdin.on('data'",
      "setTimeout(() => process.stderr.write('READY\\n'), 120);\nprocess.stdin.on('data'",
    ));
    const bridge = bridgeOn(engine);
    const t0 = Date.now();
    const outcome = await ask<{ queued: boolean }>(bridge, 'analyze')
      .then((value) => ({ value, error: '' }), (err: Error) => ({ value: null, error: err.message }));
    const waited = Date.now() - t0;
    bridge.kill();
    check(
      'a call made before the engine is READY is held and then sent',
      outcome.value?.queued === true && waited >= 100,
      outcome.error || `answered after ${waited} ms (the engine said READY at 120 ms)`,
    );
  }
  {
    // An engine that starts, stays alive, and never says READY.  The queue
    // above had no deadline of its own until this check existed: the call was
    // neither sent nor rejected, so it never settled at all, and the only
    // thing that ever emptied the queue was the process EXITING.  A
    // PyInstaller bootloader stuck unpacking is exactly this shape.
    const engine = fakeEngine(`(req, send) => send(JSON.stringify({ id: req.id, result: {} }) + '\\n') /* no ready */`);
    const bridge = bridgeOn(engine);
    const t0 = Date.now();
    let message = '';
    try { await ask(bridge, 'analyze', {}, 300); } catch (err) { message = (err as Error).message; }
    const waited = Date.now() - t0;
    bridge.kill();
    check(
      'an engine that never says READY gives up instead of waiting forever',
      /never reported READY/.test(message) && waited >= 250 && waited < 3000,
      `"${message}" after ${waited} ms`,
    );
  }
  {
    const engine = fakeEngine(`(req, send, proc) => { proc.exit(3); }`);
    const bridge = bridgeOn(engine);
    let message = '';
    try { await ask(bridge, 'master'); } catch (err) { message = (err as Error).message; }
    check(
      'an engine that dies mid-call rejects it instead of hanging',
      /exited with code 3/.test(message),
      `"${message}"`,
    );
  }
  {
    const engine = fakeEngine(`(req, send) => { /* never answers */ }`);
    const bridge = bridgeOn(engine, 250);
    const t0 = Date.now();
    let message = '';
    try { await bridge.call('master', {}); } catch (err) { message = (err as Error).message; }
    const waited = Date.now() - t0;
    bridge.kill();
    check(
      'a call the engine never answers times out, and says which method',
      /RPC timeout after 250ms \(method: master\)/.test(message) && waited < 3000,
      `"${message}" after ${waited} ms`,
    );
  }

  // ── The contract, against the real engine ──────────────────────────────
  const havePython = spawnSync(pythonBin(), ['-c', 'import numpy, soundfile'],
    { cwd: SERVICE, encoding: 'utf8', timeout: 60_000 }).status === 0;
  check(
    'the Python engine can be started from here',
    havePython,
    havePython
      ? 'numpy and soundfile are installed'
      : `missing — ${pythonBin()} -m pip install -r services/python-audio/requirements.txt` + ` (interpreter from ${pythonBinSource()})`,
  );
  if (!havePython) {
    rmSync(WORK, { recursive: true, force: true });
    console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
    process.exit(1);
  }

  const wav = (name: string, args: string[]): string => {
    const out = path.join(WORK, name);
    const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args, out],
      { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`could not build ${name}: ${String(r.stderr)}`);
    return out;
  };
  const stereo = wav('src.wav', ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
    '-ar', '44100', '-ac', '2', '-acodec', 'pcm_s24le']);
  const mono22 = wav('mono.wav', ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-ar', '22050', '-ac', '1', '-acodec', 'pcm_s16le']);

  // Launched exactly the way `audioHandlers.resolvePaths()` launches it in a
  // dev build: python3, the app/main.py path, and PYTHONPATH pointing at the
  // service directory so `from app…` resolves.  The first version of this
  // check left PYTHONPATH off and the engine exited 1 — which is what the
  // handler's own line prevents, and the reason this mirrors it rather than
  // inventing its own launch.
  process.env['PYTHONPATH'] = SERVICE;
  // And the ffmpeg pair, for the same reason the PYTHONPATH line exists: this
  // mirrors how the app launches the engine instead of inventing its own
  // launch.  Without it the engine resolves ffprobe from PATH, which on a CI
  // runner is empty — four checks came back
  // "'ffprobe'을 찾을 수 없습니다" instead of a key list.
  applyShippedFfmpegEnv();
  const realEngine = new PythonBridge({
    pythonPath: pythonBin(), scriptPath: path.join(SERVICE, 'app', 'main.py'),
  });
  realEngine.spawn();
  const types = readFileSync('../../packages/shared-types/src/index.ts', 'utf8');

  try {
    const analysis = await realEngine.call<Record<string, unknown>>('analyze', { file_path: stereo });
    const declared = declaredFields(types, 'AudioAnalysisResult');
    const sent = Object.keys(analysis).sort();
    const undeclared = sent.filter((k) => !declared.includes(k));
    check(
      'every key `analyze` sends is declared in AudioAnalysisResult',
      undeclared.length === 0 && declared.length >= 8,
      undeclared.length === 0
        ? `${sent.length} keys sent, all of them declared: ${sent.join(', ')}`
        : `the engine sends ${undeclared.join(', ')} and the type does not declare it`,
    );
    const required = ['fileInfo', 'loudness', 'aiDetection', 'warnings'];
    check(
      'and the fields the app reads are all there',
      required.every((k) => k in analysis)
        && typeof (analysis['loudness'] as { integratedLufs?: number }).integratedLufs === 'number',
      `${required.join(', ')} present; LUFS `
      + `${String((analysis['loudness'] as { integratedLufs?: number }).integratedLufs)}`,
    );
  } catch (err) {
    check('every key `analyze` sends is declared in AudioAnalysisResult', false, String(err));
  }

  try {
    const analysis = await realEngine.call<{ warnings: Array<Record<string, unknown>> }>(
      'analyze', { file_path: mono22 });
    const codes = analysis.warnings.map((w) => String(w['code'])).sort();
    check(
      'a mono 22 kHz file comes back with the engine’s own warnings about it',
      codes.includes('MONO_INPUT') && codes.includes('NON_STANDARD_SAMPLE_RATE')
        && analysis.warnings.every((w) => typeof w['userMessage'] === 'string'
          && (w['userMessage'] as string).length > 0),
      `${codes.length} warning(s): ${codes.join(', ')} — `
      + `"${String(analysis.warnings[0]?.['userMessage']).slice(0, 44)}…"`,
    );
    const shown = readFileSync('src/renderer/pages/HomePage.tsx', 'utf8');
    check(
      'and the queue row the file sits on puts them in front of the user',
      /data-testid="analysis-warnings"/.test(shown)
        && /item\.analysis!\.warnings\.map/.test(shown),
      'HomePage renders item.analysis.warnings',
    );
  } catch (err) {
    check('a mono 22 kHz file comes back with the engine’s own warnings about it', false, String(err));
  }

  try {
    const out = path.join(WORK, 'master.wav');
    const stages: string[] = [];
    realEngine.on('progress', (p: unknown) => { stages.push(String((p as { stage: string }).stage)); });
    const result = await realEngine.call<Record<string, unknown>>('master', {
      input_path: stereo, output_path: out, style: 'balanced',
      target_lufs: -14.0, target_tp: -1.0, sample_rate: 44100, bit_depth: 24,
      apply_ai_corrections: true,
    });
    const declared = declaredFields(types, 'MasteringResult');
    const sent = Object.keys(result).sort();
    const undeclared = sent.filter((k) => !declared.includes(k));
    check(
      'every key `master` sends is declared in MasteringResult',
      undeclared.length === 0 && declared.length >= 25,
      undeclared.length === 0
        ? `${sent.length} keys sent, all declared (type declares ${declared.length})`
        : `the engine sends ${undeclared.join(', ')} and the type does not declare it`,
    );
    check(
      'the master is written, measured, and reported with its own progress',
      existsSync(out) && typeof result['processingTimeSec'] === 'number'
        && typeof (result['loudnessAfter'] as { integratedLufs?: number }).integratedLufs === 'number'
        && stages.length >= 5,
      `${(readFileSync(out).length / 1e3).toFixed(0)} kB written, `
      + `${String((result['loudnessAfter'] as { integratedLufs?: number }).integratedLufs)} LUFS, `
      + `${stages.length} progress stages`,
    );
  } catch (err) {
    check('every key `master` sends is declared in MasteringResult', false, String(err));
  }

  try {
    const qc = await realEngine.call<Record<string, unknown>>('qc_check', {
      file_path: stereo, target_lufs: -14.0, target_tp: -1.0,
    });
    const declared = declaredFields(types, 'QCResult');
    const undeclared = Object.keys(qc).filter((k) => !declared.includes(k));
    check(
      'and the same holds for qc_check',
      undeclared.length === 0 && declared.length === 5,
      undeclared.length === 0
        ? `${Object.keys(qc).length} keys, all declared: ${Object.keys(qc).sort().join(', ')}`
        : `undeclared: ${undeclared.join(', ')}`,
    );
  } catch (err) {
    check('and the same holds for qc_check', false, String(err));
  }

  await realEngine.killAndWait(1000);
  rmSync(WORK, { recursive: true, force: true });
  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
  if (failed > 0) process.exit(1);
}

// An exception thrown inside the bridge's own `stdout.on('data')` handler
// does not reach the promise chain: it comes out as an uncaughtException and
// takes the process down before the summary is printed.  Measured — breaking
// the handler's try/catch produced exit 1 with no check named at all.
process.on('uncaughtException', (err: unknown) => {
  console.error(`[FAIL] something threw outside the checks — `
    + `${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  rmSync(WORK, { recursive: true, force: true });
  process.exit(1);
});

void main().catch((err: unknown) => {
  console.error(`[FAIL] the suite did not finish — ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  rmSync(WORK, { recursive: true, force: true });
  process.exit(1);
});
