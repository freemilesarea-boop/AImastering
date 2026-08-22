// The Audio Unit addon, compiled and run.
//
// ── Why this exists ──────────────────────────────────────────────────────────
//
// `native/au-host/src/au_host.mm` was written on Linux and, for as long as it
// had never been through a compiler, it was not code — it was a design
// document with semicolons.  Two of the defects this file now guards against
// were invisible by reading and killed the whole host process on the first
// run: a negative channel count reached `std::vector::resize` and aborted on
// `std::bad_alloc` with exceptions off, and a non-Float32Array argument left a
// pending N-API exception so the next throw — the correct one, with the
// correct message — became `FATAL ERROR: napi_throw`.
//
// ── What is proved here, and what is not ─────────────────────────────────────
//
// This builds the REAL source against a FAKE CoreAudio (`native/au-host/test`)
// that keeps the parts of the contract that bite: it insists on packed
// non-interleaved float32 on both scopes, refuses a render bigger than
// MaximumFramesPerSlice, checks the buffer list is one buffer per channel of
// exactly `frames * 4` bytes, and PULLS through the host's render callback the
// way a real unit does.  Its processing is channel-dependent on purpose, so a
// de-interleave that crosses channels gives the wrong number rather than a
// plausible one.
//
// So: our logic is executed.  Apple's framework is not.  A green run here does
// not mean the addon works on a Mac — `.github/workflows/au-host-macos.yml`
// builds the same source against the real AudioToolbox and runs it against
// Apple's own units, and that is the run that answers that question.
//
// If there is no compiler, no node headers or no node-addon-api on this
// machine, the whole file SKIPS — and says which one was missing.  A silent
// skip would be the same as not having written it.

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  auCandidates, checkBlock, loadAuHost, runAuStage, setAuHost,
  type AuNativeHost,
} from '../src/main/plugins/au-native.js';
import type { HostStage } from '../src/main/plugins/host-protocol.js';

const require_ = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const auHostDir = path.join(desktop, 'native', 'au-host');

const results: Array<{ name: string; pass: boolean; note?: string }> = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true }); console.log(`[PASS] ${name}`); }
  catch (e) {
    const note = e instanceof Error ? e.message : String(e);
    results.push({ name, pass: false, note });
    console.log(`[FAIL] ${name} — ${note}`);
  }
}
function assert(cond: unknown, why: string): asserts cond {
  if (!cond) throw new Error(why);
}
function eq<T>(got: T, want: T, why: string): void {
  if (!Object.is(got, want)) throw new Error(`${why} — got ${String(got)}, want ${String(want)}`);
}
function close(got: number, want: number, why: string, tol = 1e-5): void {
  if (!(Math.abs(got - want) <= tol)) throw new Error(`${why} — got ${got}, want ${want}`);
}

// ── Toolchain ────────────────────────────────────────────────────────────────

function findCompiler(): string | null {
  for (const cc of ['clang++', 'g++', 'c++']) {
    try { execFileSync(cc, ['--version'], { stdio: 'ignore' }); return cc; } catch { /* next */ }
  }
  return null;
}

function nodeIncludeDir(): string | null {
  const dir = path.resolve(path.dirname(process.execPath), '..', 'include', 'node');
  return fs.existsSync(path.join(dir, 'node_api.h')) ? dir : null;
}

function napiIncludeDir(): string | null {
  try { return path.dirname(require_.resolve('node-addon-api/napi.h')); } catch { return null; }
}

function skip(why: string): never {
  console.log(`\n건너뜀 — ${why}.`);
  console.log('Mac 에서의 진짜 빌드는 .github/workflows/au-host-macos.yml 이 합니다.');
  process.exit(0);
}

const compiler = findCompiler() ?? skip('C++ 컴파일러가 없습니다');
const nodeInc = nodeIncludeDir() ?? skip(`node 헤더가 없습니다 (${process.execPath} 옆 include/node)`);
const napiInc = napiIncludeDir() ?? skip('node-addon-api 가 설치되지 않았습니다');

const buildDir = path.join(auHostDir, 'test', 'build');
const addon = path.join(buildDir, 'au_host.node');
const logFile = path.join(buildDir, 'render.log');
fs.mkdirSync(buildDir, { recursive: true });

console.log(`컴파일: ${compiler}  (node ${process.version})`);
try {
  execFileSync(compiler, [
    '-std=c++17', '-fPIC', '-shared', '-x', 'c++',
    path.join(auHostDir, 'src', 'au_host.mm'),
    path.join(auHostDir, 'test', 'fake', 'fake_audiotoolbox.cpp'),
    `-I${path.join(auHostDir, 'test', 'fake')}`, `-I${napiInc}`, `-I${nodeInc}`,
    '-DNAPI_DISABLE_CPP_EXCEPTIONS', '-DNAPI_VERSION=8',
    // The same warning settings a Mac build would want.  A warning here is a
    // defect that has not happened yet.
    '-Wall', '-Wextra', '-Werror',
    '-Wno-import-preprocessor-directive-pedantic', '-Wno-unused-parameter',
    '-o', addon,
  ], { stdio: 'inherit' });
} catch {
  console.log('\n컴파일 실패 — 위 오류가 전부입니다.');
  process.exit(1);
}

process.env['LOUI_FAKE_AU_LOG'] = logFile;
const clearLog = (): void => { fs.writeFileSync(logFile, ''); };
const readLog = (): string[] =>
  (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '').split('\n').filter(Boolean);

clearLog();
const au = require_(addon) as AuNativeHost;

const GAIN = 'aufx-gain-fake';       // a normal unit, "Gain" via CFString
const OLDN = 'aufx-oldn-fake';       // names in the fixed char array instead
const REFU = 'aufx-refu-fake';       // refuses to initialise
const BADR = 'aufx-badr-fake';       // fails on the second render

// ── It builds and it loads ───────────────────────────────────────────────────

check('the addon exports exactly the five functions the adapter calls', () => {
  for (const fn of ['open', 'parameters', 'setParameter', 'process', 'close']) {
    eq(typeof (au as unknown as Record<string, unknown>)[fn], 'function', `${fn} is exported`);
  }
});

// ── Opening ──────────────────────────────────────────────────────────────────

check('opening sets both scopes and the frame cap before initialising', () => {
  clearLog();
  const h = au.open(GAIN, 48000, 2);
  assert(h > 0, `a handle: ${h}`);
  // The fake refuses to initialise unless the input scope, the output scope,
  // MaximumFramesPerSlice and the render callback were all set first — so the
  // fact that it initialised at all is the assertion.
  eq(readLog()[0], 'init 2 512', 'initialised with 2 channels and a 512-frame cap');
  au.close(h);
});

check('a unit that does not implement OfflineRender still opens', () => {
  // The fake refuses that property outright, the way many real units do.
  const h = au.open(GAIN, 44100, 1);
  assert(h > 0, 'opened anyway');
  au.close(h);
});

check('the component triple is parsed, not guessed', () => {
  let threw = '';
  try { au.open('nonsense', 48000, 2); } catch (e) { threw = String(e); }
  assert(threw.includes('식별자 형식'), `a shape complaint: ${threw}`);
  threw = '';
  try { au.open('aufx-nope-fake', 48000, 2); } catch (e) { threw = String(e); }
  assert(threw.includes('설치'), `and a different one for "not installed": ${threw}`);
});

check('a unit that refuses the format is refused with a reason, not a crash', () => {
  let threw = '';
  try { au.open(REFU, 48000, 2); } catch (e) { threw = String(e); }
  assert(threw.includes('초기화'), `named: ${threw}`);
});

// ── The two arguments that used to abort the process ─────────────────────────

check('a channel count outside 1..64 is refused instead of aborting', () => {
  // -1 became four billion, `resize` threw std::bad_alloc, exceptions are off
  // in this build, and the process died.  A bad ARGUMENT must never be able to
  // do that: the whole isolation story is that a bad plugin fails alone.
  for (const bad of [-1, 0, 999, 2 ** 31 - 1]) {
    let threw = '';
    try { au.open(GAIN, 48000, bad); } catch (e) { threw = String(e); }
    assert(threw.includes('채널 수'), `${bad} channels refused: ${threw || '(no throw)'}`);
  }
});

check('a sample rate that is not one is refused', () => {
  for (const bad of [0, -48000, Number.NaN, 1e9]) {
    let threw = '';
    try { au.open(GAIN, bad, 2); } catch (e) { threw = String(e); }
    assert(threw.includes('샘플레이트'), `${bad} refused: ${threw || '(no throw)'}`);
  }
});

check('a buffer that is not a Float32Array is refused instead of aborting', () => {
  // This one was worse than a crash: `As<Float32Array>()` left an exception
  // pending, so the CORRECT throw that followed became FATAL ERROR napi_throw
  // and took the process with it.  The type check has to come first.
  const h = au.open(GAIN, 48000, 2);
  for (const bad of [{ length: 99 }, new Float64Array(8), 'hello', null]) {
    let threw = '';
    try { au.process(h, bad as unknown as Float32Array, 4); } catch (e) { threw = String(e); }
    assert(threw.includes('Float32Array'), `refused ${String(bad)}: ${threw || '(no throw)'}`);
  }
  au.close(h);
});

check('every entry point survives being called with no arguments at all', () => {
  // Not a hypothetical politeness: reaching a second throw with one already
  // pending is fatal, so the cheapest way to find that is to call everything
  // wrong and still be alive afterwards.
  let threw = '';
  try { (au as unknown as { process: () => void }).process(); } catch (e) { threw = String(e); }
  assert(threw.length > 0, 'process complained');
  eq((au as unknown as { parameters: () => unknown[] }).parameters().length, 0,
    'parameters returned an empty list');
  (au as unknown as { setParameter: () => void }).setParameter();
  (au as unknown as { close: () => void }).close();
  const h = au.open(GAIN, 48000, 2);
  assert(h > 0, 'and the module still works afterwards');
  au.close(h);
});

// ── Parameters ───────────────────────────────────────────────────────────────

check('parameter names come back from a CFString, and it is released', () => {
  clearLog();
  const h = au.open(GAIN, 48000, 2);
  const params = au.parameters(h);
  eq(params.length, 2, 'two parameters');
  eq(params[0]?.name, 'Gain', 'the first name');
  eq(params[0]?.id, 7, 'and its id, which is not its index');
  eq(params[1]?.name, 'Dry/Wet', 'the second name');
  close(params[0]?.max ?? 0, 4, 'the declared maximum');
  // kAudioUnitParameterFlag_CFNameRelease means the host owns the string.
  eq(readLog().filter((l) => l === 'cfrelease').length, 2, 'both strings released');
  au.close(h);
});

check('a unit with the old fixed char array for names works too', () => {
  const h = au.open(OLDN, 48000, 2);
  const params = au.parameters(h);
  eq(params.map((p) => p.name).join(','), 'Gain,Dry/Wet', 'the same names, the older way');
  clearLog();
  au.close(h);
});

check('setParameter reaches the unit with the id the unit declared', () => {
  clearLog();
  const h = au.open(GAIN, 48000, 2);
  au.setParameter(h, 7, 2.5);
  assert(readLog().some((l) => l.startsWith('param 7 2.5')), `it arrived: ${readLog().join(' | ')}`);
  au.close(h);
});

// ── Processing ───────────────────────────────────────────────────────────────

check('interleaved in, de-interleaved through the unit, interleaved out', () => {
  const h = au.open(GAIN, 48000, 2);
  au.setParameter(h, 7, 2);            // gain 2
  // The fake scales channel `ch` by gain * (ch + 1), so a crossed de-interleave
  // produces the wrong number rather than a differently-plausible one.
  const buf = new Float32Array([1, 1, 2, 2, 3, 3]);
  eq(au.process(h, buf, 3), 3, 'three frames written');
  eq(Array.from(buf).join(','), '2,4,4,8,6,12', 'left ×2, right ×4, in frame order');
  au.close(h);
});

check('a long buffer is split into blocks the unit agreed to accept', () => {
  clearLog();
  const h = au.open(GAIN, 48000, 2);
  const frames = 1300;
  eq(au.process(h, new Float32Array(frames * 2), frames), frames, 'all of it');
  // 512 + 512 + 276, and the sample time advances with them: a unit with a
  // lookahead is entitled to care, and a render bigger than the cap is
  // rejected outright by the fake, as many real units do.
  eq(readLog().filter((l) => l.startsWith('render')).join(' | '),
    'render 0 512 | render 512 512 | render 1024 276',
    'three blocks, with a clock that moves');
  au.close(h);
});

check('the block boundary is not a seam in the audio', () => {
  const h = au.open(GAIN, 48000, 1);
  au.setParameter(h, 7, 1);
  const frames = 1100;
  const buf = new Float32Array(frames);
  for (let i = 0; i < frames; i++) buf[i] = i / frames;
  au.process(h, buf, frames);
  for (const i of [0, 511, 512, 513, 1023, 1024, 1099]) {
    close(buf[i]!, i / frames, `sample ${i} came back as itself`, 1e-6);
  }
  au.close(h);
});

check('a render that fails mid-way is an error, not a half-processed buffer', () => {
  const h = au.open(BADR, 48000, 2);      // this unit refuses its second render
  let threw = '';
  try { au.process(h, new Float32Array(2000 * 2), 2000); } catch (e) { threw = String(e); }
  assert(threw.includes('렌더'), `it threw: ${threw || '(no throw)'}`);
  au.close(h);
});

check('a short buffer is caught before the unit is asked to fill it', () => {
  const h = au.open(GAIN, 48000, 2);
  let threw = '';
  try { au.process(h, new Float32Array(4), 100); } catch (e) { threw = String(e); }
  assert(threw.includes('짧'), `refused: ${threw || '(no throw)'}`);
  au.close(h);
});

check('a handle that was closed is not a handle any more', () => {
  const h = au.open(GAIN, 48000, 2);
  au.close(h);
  let threw = '';
  try { au.process(h, new Float32Array(8), 4); } catch (e) { threw = String(e); }
  assert(threw.includes('핸들'), `refused: ${threw || '(no throw)'}`);
});

check('closing twice disposes once', () => {
  const h = au.open(GAIN, 48000, 2);
  clearLog();
  au.close(h);
  au.close(h);
  eq(readLog().filter((l) => l === 'dispose').length, 1, 'one dispose');
  assert(!readLog().includes('double-dispose'), 'and no second one');
});

check('two units open at once do not share a handle or a buffer', () => {
  const a = au.open(GAIN, 48000, 2);
  const b = au.open(GAIN, 48000, 2);
  assert(a !== b, `distinct handles: ${a} and ${b}`);
  au.setParameter(a, 7, 1);
  au.setParameter(b, 7, 3);
  const bufA = new Float32Array([1, 1]);
  const bufB = new Float32Array([1, 1]);
  au.process(a, bufA, 1);
  au.process(b, bufB, 1);
  eq(Array.from(bufA).join(','), '1,2', 'the first kept its own gain');
  eq(Array.from(bufB).join(','), '3,6', 'and the second kept its');
  au.close(a); au.close(b);
});

// ── The adapter, running on the real addon ───────────────────────────────────

const stage = (uid: string, params: Record<string, number> = {}): HostStage =>
  ({ uid, params } as unknown as HostStage);

check('runAuStage drives the real addon end to end', () => {
  setAuHost(au);
  const buf = new Float32Array([1, 1, 2, 2]);
  const outcome = runAuStage(au, buf, 2, 2, 48000, stage(GAIN, { Gain: 2 }));
  assert(outcome.applied, `applied: ${outcome.reason ?? ''}`);
  eq(Array.from(buf).join(','), '2,4,4,8', 'and the audio came back scaled');
});

check('a parameter is matched by NAME through the real addon', () => {
  // The point of matching by name: the unit's id for "Gain" is 7, which is not
  // its index and is not anything the session knows.  Spacing and case are not
  // part of the name.
  const buf = new Float32Array([1, 1]);
  const outcome = runAuStage(au, buf, 1, 2, 48000, stage(GAIN, { 'dry wet': 0.5, gain: 3 }));
  assert(outcome.applied, `applied: ${outcome.reason ?? ''}`);
  eq(Array.from(buf).join(','), '3,6', 'the gain landed');
  eq(outcome.reason, undefined, 'and nothing was reported unmatched');
});

check('a parameter the unit does not have is reported, not dropped', () => {
  const buf = new Float32Array([1, 1]);
  const outcome = runAuStage(au, buf, 1, 2, 48000, stage(GAIN, { Wobble: 1 }));
  assert(outcome.applied, 'the stage still ran');
  assert(outcome.reason?.includes('Wobble'), `by name: ${outcome.reason ?? '(silent)'}`);
});

check('a value outside the declared range is clamped, not sent', () => {
  // Out-of-range is undefined behaviour inside third-party native code.
  const buf = new Float32Array([1, 1]);
  runAuStage(au, buf, 1, 2, 48000, stage(GAIN, { Gain: 1000 }));   // max is 4
  eq(Array.from(buf).join(','), '4,8', 'clamped to the maximum the unit declared');
});

check('a stage that fails leaves the audio exactly as it arrived', () => {
  // Five plugins, the third one hostile: you lose that plugin, not the bounce.
  const buf = new Float32Array(2000 * 2).fill(0.25);
  const outcome = runAuStage(au, buf, 2000, 2, 48000, stage(BADR));
  eq(outcome.applied, false, 'refused');
  assert(outcome.reason?.includes('렌더'), `with the reason: ${outcome.reason ?? ''}`);
  assert(buf.every((v) => v === 0.25), 'and not one sample was touched');
});

check('a unit that will not open loses its stage and nothing else', () => {
  const buf = new Float32Array([0.5, 0.5]);
  const outcome = runAuStage(au, buf, 1, 2, 48000, stage(REFU));
  eq(outcome.applied, false, 'refused');
  eq(Array.from(buf).join(','), '0.5,0.5', 'audio untouched');
});

check('real output still goes through checkBlock — it is not trusted either', () => {
  const buf = new Float32Array([1, 1]);
  runAuStage(au, buf, 1, 2, 48000, stage(GAIN, { Gain: 1 }));
  eq(checkBlock(buf, 2, 1, 1).ok, true, 'this output passes');
  eq(checkBlock(new Float32Array([Number.NaN, 0]), 2, 1, 1).ok, false, 'a NaN one would not');
});

// ── Where the app looks for it ───────────────────────────────────────────────

check('the loader looks somewhere a build actually puts the file', () => {
  // Both `__dirname`s: `src/main/plugins` when run from source,
  // `dist-electron/main` once esbuild has bundled the main process.  A path
  // that resolves in only one of those is right for nobody.
  for (const [base, label] of [
    [path.join(desktop, 'src', 'main', 'plugins'), 'source'],
    [path.join(desktop, 'dist-electron', 'main'), 'bundled'],
  ] as const) {
    const built = auCandidates(undefined, base)
      .map((c) => path.resolve(c))
      .filter((c) => c.endsWith(path.join('build', 'Release', 'au_host.node')));
    assert(built.includes(path.join(auHostDir, 'build', 'Release', 'au_host.node')),
      `the ${label} layout reaches the node-gyp output: ${built.join(', ')}`);
  }
});

check('the packaged copy is looked for outside app.asar', () => {
  // `.node` files cannot be dlopen'd from inside the archive, so the packaged
  // one goes to extraResources — and this is the path electron-builder.yml
  // puts it at.
  const where = auCandidates('/Applications/LOUI.app/Contents/Resources');
  assert(where.includes('/Applications/LOUI.app/Contents/Resources/au-host/au_host.node'),
    `tried: ${where.join(', ')}`);
  assert(!where.some((c) => c.includes('app.asar')), 'and never inside app.asar');
});

check('the loader reports where it looked when it finds nothing', () => {
  setAuHost(undefined);
  const found = loadAuHost(() => { throw new Error('없음'); }, ['/a/b.node', '/c/d.node']);
  eq(found, null, 'nothing loaded');
  setAuHost(undefined);
});

check('a module missing one function is not accepted as a host', () => {
  // Half an addon is worse than none: it loads, reports the format usable, and
  // fails on the first bounce.
  setAuHost(undefined);
  const partial = { open: () => 1, process: () => 1, close: () => undefined };
  eq(loadAuHost(() => partial, ['x']), null, 'refused');
  setAuHost(undefined);
});

check('the real addon IS accepted by the same test', () => {
  setAuHost(undefined);
  eq(loadAuHost(() => au, ['x']), au, 'accepted');
  setAuHost(undefined);
});

const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} passed${passed === results.length ? '' : `, ${results.length - passed} FAILED`}`);
console.log('※ Apple 의 AudioToolbox 로는 컴파일하지 않았습니다 — 그건 macOS CI 잡이 합니다.');
if (passed !== results.length) process.exit(1);
