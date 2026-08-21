/**
 * au-adapter-selftest — not trusting a plugin that says it succeeded.
 *
 * The host process already isolates third-party code: a crash or a hang comes
 * back as an error on one bounce.  That covers the ways a plugin fails LOUDLY.
 * This file is about the other kind — the plugin that returns `noErr` with
 * garbage in the buffer, which is the one that reaches the file.
 *
 * All of it is real: a plugin fed a rate it does not support returns NaN, one
 * with an internal feedback path returns values that grow without bound, one
 * that decided it wants a different channel count returns the wrong length.
 * Every one is a success from `AudioUnitRender`, and every one written into a
 * bounce is a file the user finds ruined a day later.
 *
 * So the fake host here is hostile on purpose, and the assertion is always the
 * same: the stage is REFUSED and the audio is exactly what went in.
 *
 * The native module these tests stand in for is macOS-only and is NOT built or
 * run here — see native/au-host/README.md.
 *
 * Run: pnpm --filter @aimaster/desktop test:au
 */

import {
  AU_MODULE, SANE_PEAK, checkBlock, hasAuHost, loadAuHost, planParameters,
  runAuStage, setAuHost, type AuNativeHost,
} from '../src/main/plugins/au-native.js';
import { runJob } from '../src/main/plugins/host-worker.js';
import { isImplemented } from '../src/main/plugins/host-protocol.js';
import { hostability, requirements, setHostCapabilities } from '../src/renderer/daw/engine/external-host.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HostStage } from '../src/main/plugins/host-protocol.js';

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }
function eq<T>(a: T, b: T, m: string): void {
  if (a !== b) throw new Error(`${m} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}
function close(a: number, b: number, m: string, tol = 1e-6): void {
  if (Math.abs(a - b) > tol) throw new Error(`${m} — got ${a}, want ${b} ±${tol}`);
}

// ── A fake Audio Unit ─────────────────────────────────────────────────────────

type Behaviour =
  | { kind: 'gain'; factor: number }
  | { kind: 'nan' }
  | { kind: 'infinity' }
  | { kind: 'runaway' }
  | { kind: 'shortFrames' }
  | { kind: 'throwOnOpen' }
  | { kind: 'throwOnProcess' }
  | { kind: 'refuseOpen' };

function fakeHost(behaviour: Behaviour): {
  host: AuNativeHost; opened: string[]; closed: number[]; params: Array<{ id: number; value: number }>;
} {
  const opened: string[] = [];
  const closed: number[] = [];
  const params: Array<{ id: number; value: number }> = [];
  return {
    opened, closed, params,
    host: {
      open: (uid) => {
        opened.push(uid);
        if (behaviour.kind === 'throwOnOpen') throw new Error('플러그인이 폭발했습니다');
        if (behaviour.kind === 'refuseOpen') return 0;
        return 7;
      },
      parameters: () => [
        { id: 1, name: 'Threshold', min: -60, max: 0 },
        { id: 2, name: 'Dry/Wet', min: 0, max: 1 },
        { id: 3, name: 'Makeup Gain', min: 0, max: 24 },
      ],
      setParameter: (_h, id, value) => { params.push({ id, value }); },
      process: (_h, samples, frames) => {
        if (behaviour.kind === 'throwOnProcess') throw new Error('렌더가 실패했습니다');
        if (behaviour.kind === 'shortFrames') return frames - 1;
        for (let i = 0; i < samples.length; i++) {
          if (behaviour.kind === 'gain') samples[i] = samples[i]! * behaviour.factor;
          if (behaviour.kind === 'nan') samples[i] = Number.NaN;
          if (behaviour.kind === 'infinity') samples[i] = Number.POSITIVE_INFINITY;
          if (behaviour.kind === 'runaway') samples[i] = 1e9;
        }
        return frames;
      },
      close: (h) => { closed.push(h); },
    },
  };
}

const stage = (over: Partial<HostStage> = {}): HostStage => ({
  pluginId: 'au:aufx-dcmp-appl',
  format: 'au',
  path: '/Library/Audio/Plug-Ins/Components/Fake.component',
  uid: 'aufx-dcmp-appl',
  name: 'Fake Compressor',
  params: {},
  bypass: false,
  ...over,
});

/** A ramp, so any change to the samples is obvious. */
/**
 * Read a float32 file back.
 *
 * A Node `Buffer` is a view into a shared pool, so `buf.buffer` is the POOL,
 * not the file — reading it without the offset gives whatever else Node had
 * allocated that second, which is how this test first "failed".
 */
function readFloats(file: string): Float32Array {
  const bytes = fs.readFileSync(file);
  return new Float32Array(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

function ramp(frames: number, channels: number): Float32Array {
  const out = new Float32Array(frames * channels);
  for (let i = 0; i < out.length; i++) out[i] = (i % 100) / 200;
  return out;
}

// ── The refusals ──────────────────────────────────────────────────────────────

check('a plugin that returns NaN is refused and the audio is untouched', () => {
  const samples = ramp(256, 2);
  const before = samples.slice();
  const outcome = runAuStage(fakeHost({ kind: 'nan' }).host, samples, 256, 2, 48000, stage());
  eq(outcome.applied, false, 'refused');
  assert(outcome.reason?.includes('숫자가 아닙니다'), `and says why: ${outcome.reason}`);
  for (let i = 0; i < samples.length; i++) eq(samples[i], before[i], `sample ${i} untouched`);
});

check('an infinity is refused too', () => {
  const samples = ramp(64, 2);
  const outcome = runAuStage(fakeHost({ kind: 'infinity' }).host, samples, 64, 2, 48000, stage());
  eq(outcome.applied, false, 'refused');
});

check('output that runs away is refused before it reaches the file', () => {
  const samples = ramp(64, 2);
  const before = samples.slice();
  const outcome = runAuStage(fakeHost({ kind: 'runaway' }).host, samples, 64, 2, 48000, stage());
  eq(outcome.applied, false, 'refused');
  assert(outcome.reason?.includes('폭주'), `and names it: ${outcome.reason}`);
  eq(samples[10], before[10], 'and the audio survived');
});

check('a plugin that writes a different number of frames is refused', () => {
  // Nobody can line up a block that came back a different length.
  const samples = ramp(64, 2);
  const outcome = runAuStage(fakeHost({ kind: 'shortFrames' }).host, samples, 64, 2, 48000, stage());
  eq(outcome.applied, false, 'refused');
  assert(outcome.reason?.includes('프레임'), `and says so: ${outcome.reason}`);
});

check('a plugin that throws on open fails its stage, not the process', () => {
  const samples = ramp(64, 2);
  const outcome = runAuStage(fakeHost({ kind: 'throwOnOpen' }).host, samples, 64, 2, 48000, stage());
  eq(outcome.applied, false, 'refused');
  assert(outcome.reason?.includes('폭발'), 'and carries the plugin’s own message');
});

check('a plugin that throws mid-render fails its stage, and is still closed', () => {
  const fake = fakeHost({ kind: 'throwOnProcess' });
  const samples = ramp(64, 2);
  const outcome = runAuStage(fake.host, samples, 64, 2, 48000, stage());
  eq(outcome.applied, false, 'refused');
  eq(fake.closed.length, 1, 'the instance was released even though it threw');
});

check('a component that will not open is refused by handle, not by exception', () => {
  const samples = ramp(64, 2);
  const outcome = runAuStage(fakeHost({ kind: 'refuseOpen' }).host, samples, 64, 2, 48000, stage());
  eq(outcome.applied, false, 'refused');
  assert(outcome.reason?.includes('열지 못했습니다'), `says so: ${outcome.reason}`);
});

check('a stage with no component identity is refused before anything opens', () => {
  const fake = fakeHost({ kind: 'gain', factor: 0.5 });
  const outcome = runAuStage(fake.host, ramp(64, 2), 64, 2, 48000, stage({ uid: '' }));
  eq(outcome.applied, false, 'refused');
  eq(fake.opened.length, 0, 'and nothing was opened');
});

// ── The success path ──────────────────────────────────────────────────────────

check('a well-behaved plugin actually changes the audio', () => {
  const fake = fakeHost({ kind: 'gain', factor: 0.5 });
  const samples = ramp(128, 2);
  const before = samples.slice();
  const outcome = runAuStage(fake.host, samples, 128, 2, 48000, stage());
  eq(outcome.applied, true, 'applied');
  for (let i = 0; i < samples.length; i++) close(samples[i]!, before[i]! * 0.5, `sample ${i} halved`);
  eq(fake.closed.length, 1, 'and the instance was released');
  eq(fake.opened[0], 'aufx-dcmp-appl', 'opened by the scanned identity');
});

check('a peak that is loud but plausible is allowed through', () => {
  // Not 1.0: a bounce is float and plugins legitimately overshoot.
  const samples = new Float32Array([0.9, -0.9, 0.9, -0.9]);
  const outcome = runAuStage(fakeHost({ kind: 'gain', factor: 3 }).host, samples, 2, 2, 48000, stage());
  eq(outcome.applied, true, 'applied');
  close(samples[0]!, 2.7, 'and it really is over 1.0');
  assert(2.7 < SANE_PEAK, 'still well inside what counts as audio');
});

// ── Parameters ────────────────────────────────────────────────────────────────

check('parameters are matched by NAME, so a preset survives a plugin update', () => {
  // An AU's parameter ids are a private numbering the vendor may renumber
  // between versions.  "Threshold" stays "Threshold".
  const declared = [
    { id: 11, name: 'Threshold', min: -60, max: 0 },
    { id: 22, name: 'Dry/Wet', min: 0, max: 1 },
  ];
  const plan = planParameters(declared, { Threshold: -12, 'Dry/Wet': 0.5 });
  eq(plan.unmatched.length, 0, 'both matched');
  eq(plan.set.find((p) => p.name === 'Threshold')?.id, 11, 'by the plugin’s own id');
});

check('matching ignores case, spaces and punctuation', () => {
  const declared = [{ id: 5, name: 'Dry/Wet', min: 0, max: 1 }];
  for (const spelling of ['dry wet', 'DRYWET', 'Dry_Wet', 'dry/wet']) {
    const plan = planParameters(declared, { [spelling]: 0.3 });
    eq(plan.set.length, 1, `${spelling} matches`);
  }
});

check('a parameter the plugin does not have is REPORTED, not dropped', () => {
  // A session that quietly stopped applying half a preset is the failure here.
  const declared = [{ id: 1, name: 'Threshold', min: -60, max: 0 }];
  const plan = planParameters(declared, { Threshold: -6, Wobble: 1, Sparkle: 2 });
  eq(plan.set.length, 1, 'only the real one is set');
  eq(plan.unmatched.sort().join(), 'Sparkle,Wobble', 'and the rest are named');
});

check('values are clamped to what the plugin says it accepts', () => {
  // Out-of-range is undefined behaviour in an AU, and undefined behaviour in
  // third-party native code is exactly what this layer exists to avoid.
  const declared = [{ id: 1, name: 'Threshold', min: -60, max: 0 }];
  eq(planParameters(declared, { Threshold: 999 }).set[0]?.value, 0, 'clamped to max');
  eq(planParameters(declared, { Threshold: -999 }).set[0]?.value, -60, 'clamped to min');
  eq(planParameters(declared, { Threshold: Number.NaN }).set.length, 0, 'NaN never reaches it');
});

check('the plugin is told the parameters, in the run', () => {
  const fake = fakeHost({ kind: 'gain', factor: 1 });
  const outcome = runAuStage(fake.host, ramp(32, 2), 32, 2, 48000,
    stage({ params: { Threshold: -12, 'Makeup Gain': 6 } }));
  eq(outcome.applied, true, 'applied');
  eq(fake.params.length, 2, 'both were set');
  eq(fake.params.find((p) => p.id === 1)?.value, -12, 'Threshold by its id');
});

check('an unmatched parameter is surfaced even on a successful stage', () => {
  const fake = fakeHost({ kind: 'gain', factor: 1 });
  const outcome = runAuStage(fake.host, ramp(32, 2), 32, 2, 48000,
    stage({ params: { Threshold: -12, Nonsense: 1 } }));
  eq(outcome.applied, true, 'still applied');
  assert(outcome.reason?.includes('Nonsense'), `and mentions it: ${outcome.reason}`);
});

// ── checkBlock on its own ─────────────────────────────────────────────────────

check('checkBlock passes clean audio and nothing else', () => {
  const clean = new Float32Array([0, 0.5, -0.5, 0.9]);
  eq(checkBlock(clean, 4, 2, 2).ok, true, 'clean');
  eq(checkBlock(new Float32Array([0, Number.NaN]), 2, 1, 1).ok, false, 'NaN');
  eq(checkBlock(new Float32Array([0, 1e9]), 2, 1, 1).ok, false, 'runaway');
  eq(checkBlock(new Float32Array([0]), 4, 2, 2).ok, false, 'short buffer');
  eq(checkBlock(clean, 4, 1, 2).ok, false, 'wrong frame count');
});

// ── Where the adapter sits ────────────────────────────────────────────────────

check('a build with no native module refuses AU, with the real reason', () => {
  // The important half of this feature on every machine that is not a Mac
  // with the addon built.  Silence would be the wrong answer.
  setAuHost(null);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'au-host-'));
  const inputPath = path.join(dir, 'in.f32');
  const outputPath = path.join(dir, 'out.f32');
  const samples = ramp(64, 2);
  fs.writeFileSync(inputPath, Buffer.from(samples.buffer));

  const result = runJob({
    id: 'j1', inputPath, outputPath, frames: 64, channels: 2, sampleRate: 48000,
    chain: [stage()],
  });
  assert(result.ok, 'the bounce still succeeds');
  const report = result.stages[0]!;
  eq(report.applied, false, 'the AU stage did not apply');
  assert(report.reason?.includes('모듈'), `and says the module is missing: ${report.reason}`);

  // And the audio came through unchanged rather than silenced.
  const written = readFloats(outputPath);
  for (let i = 0; i < samples.length; i++) close(written[i]!, samples[i]!, `sample ${i} intact`);
  fs.rmSync(dir, { recursive: true, force: true });
});

check('one bad AU stage does not take the rest of the chain with it', () => {
  setAuHost(null);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'au-host-'));
  const inputPath = path.join(dir, 'in.f32');
  const outputPath = path.join(dir, 'out.f32');
  fs.writeFileSync(inputPath, Buffer.from(ramp(64, 2).buffer));

  const result = runJob({
    id: 'j2', inputPath, outputPath, frames: 64, channels: 2, sampleRate: 48000,
    chain: [
      stage(),
      { ...stage(), pluginId: 'ref', format: 'reference', name: 'Reference', params: { gainDb: -6 } },
    ],
  });
  assert(result.ok, 'the bounce succeeded');
  eq(result.stages[0]?.applied, false, 'the AU failed');
  eq(result.stages[1]?.applied, true, 'and the next device still ran');

  const written = readFloats(outputPath);
  const gain = Math.pow(10, -6 / 20);
  close(written[10]!, ramp(64, 2)[10]! * gain, 'the reference really was applied', 1e-5);
  fs.rmSync(dir, { recursive: true, force: true });
});

check('AU has an adapter, and the format list says so', () => {
  eq(isImplemented('au'), true, 'au is wired');
  eq(isImplemented('vst3'), false, 'vst3 is not — the licence comes first');
});

check('the module loader never throws, and caches its answer', () => {
  setAuHost(undefined);
  const first = loadAuHost(() => { throw new Error('not built'); });
  eq(first, null, 'a missing module is null, not an exception');
  // Cached: a known absence must not cost a require() per bounce.
  let calls = 0;
  loadAuHost(() => { calls++; return {}; });
  eq(calls, 0, 'and it is not asked again');
  eq(hasAuHost(), false, 'so the app knows it cannot host');

  setAuHost(undefined);
  const partial = loadAuHost(() => ({ open: () => 1 }));
  eq(partial, null, 'a module missing half its surface is refused too');
  assert(AU_MODULE.length > 0, 'and the specifier is named in one place');
});

// ── The capability list ───────────────────────────────────────────────────────

check('the requirement list reports what was measured, not what was typed', () => {
  setHostCapabilities({ platform: 'darwin', auHost: false });
  eq(requirements().find((r) => r.id === 'native-module')?.met, false, 'no addon → not met');
  eq(hostability('au').hostable, false, 'and AU is not hostable');

  setHostCapabilities({ platform: 'darwin', auHost: true });
  eq(requirements().find((r) => r.id === 'native-module')?.met, true, 'addon → met');
  const au = hostability('au');
  eq(au.hostable, true, 'and now AU is hostable');
  eq(au.mode, 'offline', 'as an offline device — the live graph is Web Audio');
});

check('the entitlement is reported as shipping, because it is', () => {
  // It has been in public/entitlements.mac.plist for a while; the list said
  // otherwise until this change.  A capability remembered in two places will
  // disagree with itself.
  const plist = fs.readFileSync(
    path.join(process.cwd(), 'public', 'entitlements.mac.plist'), 'utf8');
  assert(plist.includes('com.apple.security.cs.disable-library-validation'),
    'the entitlement really is in the plist');
  eq(requirements().find((r) => r.id === 'macos-entitlement')?.met, true,
    'and the list agrees');
});

check('VST3 is still blocked, and by the licence rather than by code', () => {
  setHostCapabilities({ platform: 'darwin', auHost: true });
  const vst3 = hostability('vst3');
  eq(vst3.hostable, false, 'not hostable');
  assert(vst3.reason.includes('Steinberg'), `for the real reason: ${vst3.reason}`);
});

// ── Report ────────────────────────────────────────────────────────────────────

setAuHost(undefined);
setHostCapabilities({ platform: 'unknown', auHost: false });

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log('\n=== Audio Units: refusing what a plugin claims succeeded ===');
for (const r of results) {
  console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
}
console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
if (failed > 0) process.exit(1);
