// The checklist from ../README.md, as something that runs.
//
// This is the half that only a Mac can answer: the same `au_host.mm` compiled
// against Apple's real AudioToolbox and pointed at Apple's own Audio Units.
// The Linux self-test (`pnpm test:au-native`) proves our logic; this proves
// the API is the API.
//
// It discovers what is installed with `auval -a` rather than hard-coding a
// component triple, because "the plugin was not there" and "the host is
// broken" must not look the same.  Any step that cannot run says so and does
// not pass.
//
// Usage:  node native/au-host/test/au-host-mac-smoke.mjs
// Expects build/Release/au_host.node to exist (npx node-gyp rebuild).

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require_ = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

const results = [];
const check = (name, fn) => {
  try { fn(); results.push({ name, pass: true }); console.log(`[PASS] ${name}`); }
  catch (e) {
    results.push({ name, pass: false });
    console.log(`[FAIL] ${name} — ${e instanceof Error ? e.message : String(e)}`);
  }
};
const assert = (cond, why) => { if (!cond) throw new Error(why); };

if (process.platform !== 'darwin') {
  console.log('건너뜀 — macOS 가 아닙니다. 이 스모크 테스트는 Mac 전용입니다.');
  process.exit(0);
}

const au = require_(path.join(here, '..', 'build', 'Release', 'au_host.node'));

// ── 1. It opens ──────────────────────────────────────────────────────────────

/** Every `aufx` Apple ships on this machine, as the triple the app scans. */
function installedEffects() {
  const out = execFileSync('auval', ['-a'], { encoding: 'utf8' });
  const found = [];
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^aufx\s+(\S{4})\s+(\S{4})/);
    if (m) found.push(`aufx-${m[1]}-${m[2]}`);
  }
  return found;
}

const effects = installedEffects();
console.log(`auval -a: ${effects.length} 개의 aufx`);
assert(effects.length > 0, 'auval reported no effect units at all — nothing here can be checked');

// AUDelay first: its dry/wet mix is guaranteed to change the signal at the
// extremes, which is what step 2 needs.  The others are fallbacks.
const PREFERRED = ['aufx-dely-appl', 'aufx-lmtr-appl', 'aufx-dcmp-appl', 'aufx-nbeq-appl'];
const uid = PREFERRED.find((u) => effects.includes(u)) ?? effects[0];
console.log(`대상: ${uid}`);

check('an Apple unit opens', () => {
  const h = au.open(uid, 48000, 2);
  assert(h > 0, `handle ${h}`);
  au.close(h);
});

check('a component that is not installed is refused by name', () => {
  let threw = '';
  try { au.open('aufx-zzzz-zzzz', 48000, 2); } catch (e) { threw = String(e); }
  assert(threw.includes('설치'), `said so: ${threw || '(no throw)'}`);
});

// ── 2. It changes the audio ──────────────────────────────────────────────────

const FRAMES = 4096;
function noise(seed = 1) {
  // Deterministic, so a difference between two runs is the plugin's doing.
  const buf = new Float32Array(FRAMES * 2);
  let x = seed;
  for (let i = 0; i < buf.length; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    buf[i] = (x / 0x7fffffff) * 2 - 1;
  }
  return buf;
}
const peak = (b) => b.reduce((m, v) => (Math.abs(v) > m ? Math.abs(v) : m), 0);

check('a real unit returns real audio', () => {
  const h = au.open(uid, 48000, 2);
  const buf = noise();
  const written = au.process(h, buf, FRAMES);
  au.close(h);
  assert(written === FRAMES, `all frames written: ${written} ≠ ${FRAMES}`);
  assert(buf.every(Number.isFinite), 'every sample is a number');
  assert(peak(buf) > 0, 'and it is not silence');
});

// ── 3. Parameters land ───────────────────────────────────────────────────────

let params = [];
check('the unit declares parameters with names', () => {
  const h = au.open(uid, 48000, 2);
  params = au.parameters(h);
  au.close(h);
  assert(params.length > 0, 'at least one parameter');
  assert(params.every((p) => typeof p.name === 'string' && p.name.length > 0),
    `all named: ${JSON.stringify(params.slice(0, 4))}`);
  assert(params.every((p) => Number.isFinite(p.min) && Number.isFinite(p.max) && p.max >= p.min),
    'with a usable range');
  console.log(`  파라미터: ${params.map((p) => p.name).slice(0, 8).join(', ')}`);
});

check('a parameter reaches the unit — at least one demonstrably does', () => {
  // Every declared parameter is tried at both ends of its own range, and the
  // step passes on the first one that changes the audio.  Picking a single
  // likely-looking name instead would fail on a unit where that one control
  // happens to be a no-op, which says nothing about whether setParameter
  // works — and this step is about setParameter, not about that control.
  const run = (id, value) => {
    const h = au.open(uid, 48000, 2);
    au.setParameter(h, id, value);
    const buf = noise();
    au.process(h, buf, FRAMES);
    au.close(h);
    return buf;
  };
  const movable = params.filter((p) => p.max > p.min);
  assert(movable.length > 0, 'at least one parameter has a range to move within');
  const inert = [];
  for (const p of movable) {
    const low = run(p.id, p.min);
    const high = run(p.id, p.max);
    let differ = 0;
    for (let i = 0; i < low.length; i++) if (Math.abs(low[i] - high[i]) > 1e-6) differ++;
    if (differ > 0) {
      console.log(`  "${p.name}" ${p.min} → ${p.max}: ${differ}/${low.length} 샘플이 달라짐`);
      return;
    }
    inert.push(p.name);
  }
  throw new Error(
    `none of ${movable.length} parameters changed the audio at either end `
    + `(${inert.slice(0, 6).join(', ')}) — setParameter is not reaching the unit`);
});

// ── 4. A bad plugin fails alone ──────────────────────────────────────────────

check('bad arguments do not take the process down', () => {
  // The two that used to: a negative channel count aborted on std::bad_alloc,
  // and a non-Float32Array made the next throw a FATAL ERROR.
  for (const bad of [-1, 0, 999]) {
    let threw = '';
    try { au.open(uid, 48000, bad); } catch (e) { threw = String(e); }
    assert(threw.includes('채널'), `${bad} channels refused: ${threw || '(no throw)'}`);
  }
  const h = au.open(uid, 48000, 2);
  let threw = '';
  try { au.process(h, { length: 8 }, 4); } catch (e) { threw = String(e); }
  assert(threw.includes('Float32Array'), `a non-array refused: ${threw || '(no throw)'}`);
  au.close(h);
});

check('a chain survives one stage that cannot open', () => {
  // Five stages, the third one a component that does not exist.  Four apply.
  const buf = noise();
  const before = Float32Array.from(buf);
  let applied = 0;
  for (const stageUid of [uid, uid, 'aufx-zzzz-zzzz', uid, uid]) {
    let h = null;
    try {
      h = au.open(stageUid, 48000, 2);
      au.process(h, buf, FRAMES);
      applied++;
    } catch { /* this stage is lost, the bounce is not */ }
    finally { if (h !== null) { try { au.close(h); } catch { /* gone */ } } }
  }
  assert(applied === 4, `four of five applied, not ${applied}`);
  assert(buf.every(Number.isFinite), 'and the audio is still audio');
  assert(peak(before) > 0, 'against a signal that was not silence to begin with');
});

const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} passed${passed === results.length ? '' : `, ${results.length - passed} FAILED`}`);
if (passed !== results.length) process.exit(1);
