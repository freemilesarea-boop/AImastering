/**
 * plugin-host-selftest — the process that runs other people's code.
 *
 * The host is the one place in this app where a bug is not a wrong number but
 * a lost session: it forks a process, hands it a whole track, and waits for a
 * binary nobody here wrote to hand something back.  Three things therefore
 * have to be true, and none of them can be established by reading the code.
 *
 *   1. The audio really makes the round trip.  Samples leave the renderer,
 *      cross a process boundary as a file, get processed, and come back
 *      changed in exactly the way the device says it changes them.  The
 *      reference device — a gain and a phase invert — exists to make that
 *      claim checkable from the rendered file.
 *
 *   2. A format with no adapter is REFUSED.  Passing unprocessed audio
 *      through and reporting success is the one outcome worse than failing:
 *      you would spend an afternoon wondering why your compressor has no
 *      effect.  So a VST3 stage, today, must come back `applied: false` with
 *      a reason, and the samples must be untouched.
 *
 *   3. A host that dies or wedges is an error on one bounce, not an
 *      exception in the renderer.  Both are tested against real forked
 *      children that really crash and really hang.
 *
 * Run:  pnpm --filter @aimaster/desktop test:plugin-host
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OfflineAudioContext } from 'node-web-audio-api';

(globalThis as unknown as { OfflineAudioContext: unknown }).OfflineAudioContext = OfflineAudioContext;

import { runJob } from '../src/main/plugins/host-worker.js';
import { runJobInProcess } from '../src/main/plugins/host-runner.js';
import { isImplemented, type HostJob, type HostStage } from '../src/main/plugins/host-protocol.js';
import {
  applyExternalInserts, describeExternalPass, externalInserts, hasExternalInserts, interleave,
  type ExternalRenderResult,
} from '../src/renderer/daw/engine/external-render.js';
import {
  REFERENCE_PLUGIN, REFERENCE_PLUGIN_ID, descriptorFor, externalParams,
} from '../src/renderer/daw/engine/external-device.js';
import { pcmToBuffer } from '../src/renderer/daw/engine/audio-cache.js';
import { decodeContext } from '../src/renderer/audio/decode-context.js';
import { toFileUrl, fromFileUrl } from '../src/renderer/utils/fileUrl.js';
import type { ExternalPluginRef, Insert, Track } from '../src/renderer/daw/model/types.js';

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }

const SR = 48_000;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'loui-host-test-'));
let seq = 0;
const scratchFile = (suffix: string): string => path.join(scratch, `f${seq++}${suffix}`);

// ── Fixtures ────────────────────────────────────────────────────────────────

/** Interleaved stereo, deterministic and non-zero everywhere it matters. */
function makePcm(frames: number, channels = 2): Float32Array {
  const out = new Float32Array(frames * channels);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      out[i * channels + c] = Math.sin((i / SR) * 2 * Math.PI * 440 * (c + 1)) * 0.5;
    }
  }
  return out;
}

function writePcm(samples: Float32Array): string {
  const file = scratchFile('.f32');
  fs.writeFileSync(file, Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
  return file;
}

function readPcm(file: string, count: number): Float32Array {
  const bytes = fs.readFileSync(file);
  return new Float32Array(bytes.buffer, bytes.byteOffset, count);
}

function stage(over: Partial<HostStage> = {}): HostStage {
  return {
    pluginId: REFERENCE_PLUGIN_ID,
    format: 'reference',
    path: '',
    uid: REFERENCE_PLUGIN.uid,
    name: 'Reference Gain',
    params: {},
    bypass: false,
    ...over,
  };
}

function job(input: string, output: string, frames: number, chain: HostStage[], channels = 2): HostJob {
  return { id: `job-${seq++}`, inputPath: input, outputPath: output, frames, channels, sampleRate: SR, chain };
}

/** Write a throwaway child process and return its path. */
function writeChild(name: string, body: string): string {
  const file = path.join(scratch, name);
  fs.writeFileSync(file, body, 'utf-8');
  return file;
}

async function main(): Promise<void> {
  // ── 1. The reference device really processes ────────────────────────────────

  await check('a −6 dB reference stage scales every sample by 0.501', async () => {
    const frames = 4096;
    const source = makePcm(frames);
    const input = writePcm(source);
    const output = scratchFile('.out.f32');

    const result = runJob(job(input, output, frames, [stage({ params: { gainDb: -6 } })]));
    assert(result.ok, `host failed: ${result.ok ? '' : result.error}`);
    assert(result.stages[0]?.applied === true, 'the stage reports itself applied');

    const processed = readPcm(output, frames * 2);
    assert(processed.length === source.length, 'same number of samples out as in');
    const expected = Math.pow(10, -6 / 20);
    let worst = 0;
    for (let i = 0; i < source.length; i++) {
      if (Math.abs(source[i]!) < 1e-6) continue;
      worst = Math.max(worst, Math.abs(processed[i]! / source[i]! - expected));
    }
    assert(worst < 1e-5, `gain is ${expected} everywhere (worst error ${worst})`);
  });

  await check('invert flips the sign, and composes with gain', async () => {
    const frames = 1024;
    const source = makePcm(frames);
    const input = writePcm(source);
    const output = scratchFile('.out.f32');

    const result = runJob(job(input, output, frames,
      [stage({ params: { gainDb: -6, invert: 1 } })]));
    assert(result.ok, 'host ran');

    const processed = readPcm(output, frames * 2);
    const expected = -Math.pow(10, -6 / 20);
    let worst = 0;
    for (let i = 0; i < source.length; i++) {
      if (Math.abs(source[i]!) < 1e-6) continue;
      worst = Math.max(worst, Math.abs(processed[i]! / source[i]! - expected));
    }
    assert(worst < 1e-5, `inverted and attenuated (worst error ${worst})`);
  });

  await check('a unity stage is bit-identical, not merely close', () => {
    // The adapter short-circuits at gain 1.  If that path ever stopped being a
    // no-op, a chain of harmless devices would quietly dither the whole mix.
    const frames = 512;
    const source = makePcm(frames);
    const input = writePcm(source);
    const output = scratchFile('.out.f32');

    const result = runJob(job(input, output, frames, [stage({ params: { gainDb: 0 } })]));
    assert(result.ok, 'host ran');
    assert(result.stages[0]?.applied === true, 'unity is still an applied stage');

    const processed = readPcm(output, frames * 2);
    for (let i = 0; i < source.length; i++) {
      assert(processed[i] === source[i], `sample ${i} unchanged`);
    }
  });

  await check('stages are reported in the order they were sent', () => {
    const frames = 256;
    const input = writePcm(makePcm(frames));
    const output = scratchFile('.out.f32');
    const chain = ['첫째', '둘째', '셋째'].map((name, i) =>
      stage({ name, pluginId: `ref-${i}`, params: { gainDb: 0 } }));

    const result = runJob(job(input, output, frames, chain));
    assert(result.ok, 'host ran');
    assert(result.stages.length === 3, 'one report per stage');
    assert(result.stages.map((s) => s.name).join(',') === '첫째,둘째,셋째', 'in chain order');
    assert(result.stages.map((s) => s.pluginId).join(',') === 'ref-0,ref-1,ref-2', 'ids follow too');
  });

  // ── 2. Refusing what it cannot do ───────────────────────────────────────────

  await check('a bypassed stage is skipped and says so, leaving the audio alone', () => {
    const frames = 512;
    const source = makePcm(frames);
    const input = writePcm(source);
    const output = scratchFile('.out.f32');

    const result = runJob(job(input, output, frames,
      [stage({ params: { gainDb: -12 }, bypass: true })]));
    assert(result.ok, 'host ran');
    assert(result.stages[0]?.applied === false, 'not applied');
    assert(result.stages[0]?.reason === '바이패스', `reason is bypass, got ${result.stages[0]?.reason}`);

    const processed = readPcm(output, frames * 2);
    for (let i = 0; i < source.length; i++) assert(processed[i] === source[i], `sample ${i} untouched`);
  });

  await check('a real format with no adapter is refused, not passed through', () => {
    // The whole point of the honesty rule.  If this test ever passes because
    // the samples came back unchanged AND the stage said `applied: true`,
    // someone has shipped a plugin that silently does nothing.
    const frames = 512;
    const source = makePcm(frames);
    const input = writePcm(source);
    const output = scratchFile('.out.f32');

    // `au` is deliberately NOT in this list any more: it has an adapter now.
    // Its own refusal — "the native module is not in this build" — is a
    // different claim with a different reason, and it is covered by test:au.
    for (const format of ['vst3', 'vst2', 'clap'] as const) {
      assert(!isImplemented(format), `${format} has no adapter yet`);
      const result = runJob(job(input, output, frames,
        [stage({ format, path: `/Library/Audio/Plug-Ins/VST3/X.${format}`, params: { gainDb: -12 } })]));
      assert(result.ok, 'the job itself still completes');
      assert(result.stages[0]?.applied === false, `${format} is not applied`);
      assert((result.stages[0]?.reason ?? '').includes(format.toUpperCase()),
        `the reason names the format, got ${result.stages[0]?.reason}`);
      const processed = readPcm(output, frames * 2);
      assert(processed[100] === source[100], 'and the audio is untouched');
    }
  });

  await check('AU is refused for the module, not for the adapter', () => {
    // The reason has to be the real one.  "AU 어댑터가 아직 없습니다" would
    // now be a lie: the adapter is written and tested, and what is missing on
    // this machine is the native module it calls.
    const frames = 256;
    const source = makePcm(frames);
    const input = writePcm(source);
    const output = scratchFile('.out.f32');
    assert(isImplemented('au'), 'au has an adapter');

    const result = runJob(job(input, output, frames,
      [stage({ format: 'au', uid: 'aufx-dcmp-appl', path: '/x.component', params: {} })]));
    assert(result.ok, 'the job completes');
    assert(result.stages[0]?.applied === false, 'and the stage did not apply');
    assert((result.stages[0]?.reason ?? '').includes('모듈'),
      `for the module, got: ${result.stages[0]?.reason}`);
    const processed = readPcm(output, frames * 2);
    assert(processed[100] === source[100], 'and the audio is untouched');
  });

  await check('one refused stage does not stop the rest of the chain', () => {
    const frames = 512;
    const source = makePcm(frames);
    const input = writePcm(source);
    const output = scratchFile('.out.f32');

    const result = runJob(job(input, output, frames, [
      stage({ name: 'A', params: { gainDb: -6 } }),
      stage({ name: 'B', format: 'vst3', params: { gainDb: -60 } }),
      stage({ name: 'C', params: { gainDb: -6 } }),
    ]));
    assert(result.ok, 'host ran');
    assert(result.stages.map((s) => s.applied).join(',') === 'true,false,true', 'middle one skipped');

    const processed = readPcm(output, frames * 2);
    const expected = Math.pow(10, -12 / 20);   // the two that ran, not the one that did not
    const ratio = processed[100]! / source[100]!;
    assert(Math.abs(ratio - expected) < 1e-5, `two −6 dB stages applied (got ${ratio})`);
  });

  await check('a truncated input is refused rather than read past the end', () => {
    const frames = 4096;
    const short = makePcm(64);
    const input = writePcm(short);
    const output = scratchFile('.out.f32');

    const result = runJob(job(input, output, frames, [stage({ params: { gainDb: -6 } })]));
    assert(!result.ok, 'the job fails');
    assert(!result.ok && result.error.includes('잘려'), `and says why: ${result.ok ? '' : result.error}`);
    assert(!fs.existsSync(output), 'no half-written output is left behind');
  });

  await check('an input that is not there fails with a message, not a throw', () => {
    const result = runJob(job(path.join(scratch, 'nope.f32'), scratchFile('.out.f32'), 128,
      [stage({ params: { gainDb: -6 } })]));
    assert(!result.ok, 'the job fails');
    assert(!result.ok && result.error.includes('입력을 읽지'), 'names the input as the problem');
  });

  // ── 3. The forked process, for real ─────────────────────────────────────────

  const TSX = ['--import', 'tsx'];
  const WORKER = path.resolve(process.cwd(), 'src/main/plugins/host-worker.ts');

  await check('the real worker, really forked, really processes the audio', async () => {
    const frames = 8192;
    const source = makePcm(frames);
    const input = writePcm(source);
    const output = scratchFile('.out.f32');

    const result = await runJobInProcess(
      job(input, output, frames, [stage({ params: { gainDb: -6, invert: 1 } })]),
      { workerPath: WORKER, execArgv: TSX, timeoutMs: 60_000 },
    );

    assert(result.ok, `forked host failed: ${result.ok ? '' : result.error}`);
    assert(result.ok && result.frames === frames, 'frame count comes back');
    assert(result.stages[0]?.applied === true, 'the stage ran in the child');

    const processed = readPcm(output, frames * 2);
    const expected = -Math.pow(10, -6 / 20);
    const ratio = processed[500]! / source[500]!;
    assert(Math.abs(ratio - expected) < 1e-5, `the child did the work (got ${ratio})`);
  });

  await check('a host that crashes is an error on one bounce, not a throw', async () => {
    const child = writeChild('crasher.cjs', 'process.on("message", () => { process.exit(3); });\n');
    const result = await runJobInProcess(
      job(writePcm(makePcm(64)), scratchFile('.out.f32'), 64, [stage()]),
      { workerPath: child, timeoutMs: 20_000 },
    );
    assert(!result.ok, 'reported as a failure');
    assert(!result.ok && (result.error.includes('코드 3') || result.error.includes('종료')),
      `and says how it died: ${result.ok ? '' : result.error}`);
  });

  await check('a host killed by a signal names the signal', async () => {
    const child = writeChild('segfaulter.cjs',
      'process.on("message", () => { process.kill(process.pid, "SIGKILL"); });\n');
    const result = await runJobInProcess(
      job(writePcm(makePcm(64)), scratchFile('.out.f32'), 64, [stage()]),
      { workerPath: child, timeoutMs: 20_000 },
    );
    assert(!result.ok, 'reported as a failure');
    assert(!result.ok && result.error.includes('SIGKILL'), `names it: ${result.ok ? '' : result.error}`);
  });

  await check('a host that never answers is cut off at the deadline', async () => {
    const child = writeChild('hanger.cjs',
      'process.on("message", () => { setInterval(() => {}, 1000); });\n');
    const started = Date.now();
    const result = await runJobInProcess(
      job(writePcm(makePcm(64)), scratchFile('.out.f32'), 64, [stage()]),
      { workerPath: child, timeoutMs: 400 },
    );
    const took = Date.now() - started;
    assert(!result.ok, 'reported as a failure');
    assert(!result.ok && result.error.includes('응답하지'), `says it hung: ${result.ok ? '' : result.error}`);
    assert(took < 10_000, `and returns at the deadline, not later (${took} ms)`);
  });

  await check('a reply for a different job is ignored', async () => {
    // A plugin that answers late, or twice, must not resolve the wrong bounce.
    const child = writeChild('confused.cjs',
      'process.on("message", (job) => { process.send({ id: job.id + "-wrong", result: { ok: true, frames: 1, stages: [] } }); setInterval(() => {}, 1000); });\n');
    const result = await runJobInProcess(
      job(writePcm(makePcm(64)), scratchFile('.out.f32'), 64, [stage()]),
      { workerPath: child, timeoutMs: 400 },
    );
    assert(!result.ok, 'the stray reply did not resolve it');
    assert(!result.ok && result.error.includes('응답하지'), 'it timed out instead');
  });

  // ── 4. The renderer side ────────────────────────────────────────────────────

  function insert(over: Partial<Insert> = {}): Insert {
    return {
      id: `i${seq++}`, slot: 0, pluginId: REFERENCE_PLUGIN_ID, label: 'Reference Gain',
      bypass: false, latencySamples: 0, params: {}, sidechainSource: null,
      external: REFERENCE_PLUGIN, ...over,
    };
  }

  function track(inserts: Insert[]): Track {
    return { id: 't1', name: 'Vox', inserts } as unknown as Track;
  }

  await check('external inserts come out in slot order, natives excluded', () => {
    const t = track([
      insert({ slot: 4, label: 'D' }),
      { ...insert({ slot: 2, label: 'native' }), external: undefined },
      insert({ slot: 1, label: 'A' }),
      insert({ slot: 3, label: 'C' }),
    ]);
    const found = externalInserts(t);
    assert(found.map((i) => i.label).join(',') === 'A,C,D', `slot order, got ${found.map((i) => i.label).join(',')}`);
    assert(hasExternalInserts(t), 'the track has externals');
    assert(!hasExternalInserts(track([{ ...insert(), external: undefined }])), 'and a native-only track does not');
  });

  await check('interleave round-trips through pcmToBuffer', () => {
    const ctx = decodeContext();
    assert(ctx !== null, 'a decode context exists in Node');
    const frames = 777;
    const source = ctx!.createBuffer(2, frames, SR);
    for (let c = 0; c < 2; c++) {
      const data = source.getChannelData(c);
      for (let i = 0; i < frames; i++) data[i] = Math.sin(i * 0.01) * (c === 0 ? 0.4 : -0.7);
    }

    const flat = interleave(source);
    assert(flat.length === frames * 2, 'one sample per frame per channel');
    const bytes = new Uint8Array(flat.buffer.slice(0));
    const back = pcmToBuffer(ctx!, { sampleRate: SR, channels: 2, frames, pcm: bytes });

    for (let c = 0; c < 2; c++) {
      const a = source.getChannelData(c);
      const b = back.getChannelData(c);
      for (let i = 0; i < frames; i++) assert(a[i] === b[i], `channel ${c} sample ${i} survived`);
    }
  });

  await check('descriptorFor answers for external and native inserts alike', () => {
    const external = descriptorFor(insert());
    assert(external !== undefined, 'an external insert has a descriptor');
    assert(external!.offline === true, 'it is offline — the live graph cannot call it');
    assert(external!.category === 'external', 'and it is categorised as such');
    assert(external!.params.map((p) => p.id).join(',') === 'gainDb,invert', 'reference params');

    const native = descriptorFor({ ...insert({ pluginId: 'eq8' }), external: undefined });
    assert(native !== undefined, 'a native insert still resolves through the registry');
    assert(native!.category !== 'external', 'and is not external');

    const unknown = descriptorFor({ ...insert({ pluginId: 'no-such-device' }), external: undefined });
    assert(unknown === undefined, 'an unknown native id is still undefined');
  });

  await check('an unknown external plugin exposes no invented knobs', () => {
    const ref: ExternalPluginRef = {
      format: 'vst3', path: '/x/Pro-Q 4.vst3', uid: 'abc', name: 'Pro-Q 4', vendor: 'FabFilter',
    };
    assert(externalParams(ref).length === 0, 'no parameters until an adapter can read them');
    const d = descriptorFor(insert({ pluginId: 'vst3:abc', external: ref }));
    assert(d?.name === 'Pro-Q 4', 'it is still named');
    assert(d?.offline === true, 'and still offline');
  });

  await check('describeExternalPass says what ran and what did not', () => {
    const make = (stages: ExternalRenderResult['stages'], error: string | null): ExternalRenderResult =>
      ({ buffer: null as unknown as AudioBuffer, stages, error });

    assert(describeExternalPass(make([], null)) === null, 'silence when there was nothing to do');
    assert(describeExternalPass(make([], 'X')) === '외부 플러그인 적용 실패: X', 'errors are reported');

    const applied = describeExternalPass(make(
      [{ pluginId: 'a', name: 'A', applied: true }, { pluginId: 'b', name: 'B', applied: true }], null));
    assert(applied === '외부 플러그인 2개 적용', `got ${applied}`);

    const mixed = describeExternalPass(make([
      { pluginId: 'a', name: 'A', applied: true },
      { pluginId: 'b', name: 'Pro-Q 4', applied: false, reason: 'VST3 어댑터가 아직 없습니다' },
    ], null));
    assert(mixed !== null && mixed.includes('Pro-Q 4') && mixed.includes('VST3'),
      `the first skipped device is named with its reason, got ${mixed}`);

    const none = describeExternalPass(make(
      [{ pluginId: 'b', name: 'Pro-Q 4', applied: false, reason: '어댑터 없음' }], null));
    assert(none !== null && none.startsWith('외부 플러그인을 적용하지 못했습니다'), `got ${none}`);
  });

  await check('outside the desktop app, the audio survives and the reason is given', async () => {
    const ctx = decodeContext()!;
    const buffer = ctx.createBuffer(2, 128, SR);
    const before = (globalThis as { electronAPI?: unknown }).electronAPI;
    delete (globalThis as { electronAPI?: unknown }).electronAPI;
    try {
      const result = await applyExternalInserts(buffer, track([insert({ slot: 0 })]));
      assert(result.buffer === buffer, 'the take is not lost');
      assert(result.error === null, 'this is not an error, it is a limitation');
      assert(result.stages[0]?.applied === false, 'and it is reported as not applied');
      assert((result.stages[0]?.reason ?? '').includes('데스크톱'), 'with the reason');
    } finally {
      if (before !== undefined) (globalThis as { electronAPI?: unknown }).electronAPI = before;
    }
  });

  await check('the whole renderer→host→renderer round trip changes the audio', async () => {
    // Everything except Electron itself: the renderer interleaves, a stand-in
    // bridge writes the PCM and calls the real host, and the result comes back
    // through the real `aimaster-local://` URL and the real `pcmToBuffer`.
    const ctx = decodeContext()!;
    const frames = 2048;
    const buffer = ctx.createBuffer(2, frames, SR);
    for (let c = 0; c < 2; c++) {
      const data = buffer.getChannelData(c);
      for (let i = 0; i < frames; i++) data[i] = Math.sin(i * 0.02) * 0.6;
    }

    const bridgeBefore = (globalThis as { electronAPI?: unknown }).electronAPI;
    const fetchBefore = (globalThis as { fetch?: unknown }).fetch;

    (globalThis as { electronAPI?: unknown }).electronAPI = {
      invoke: async (channel: string, payload: {
        pcm: Uint8Array; frames: number; channels: number; sampleRate: number;
        chain: Omit<HostStage, 'path' | 'uid'> & { path: string; uid: string }[];
      }) => {
        assert(channel === 'daw:host-apply', `the renderer calls the right channel, got ${channel}`);
        const input = path.join(scratch, 'bridge-in.f32');
        const output = path.join(scratch, 'bridge-out.f32');
        fs.writeFileSync(input, Buffer.from(
          payload.pcm.buffer, payload.pcm.byteOffset, payload.pcm.byteLength));
        const result = runJob({
          id: 'bridge', inputPath: input, outputPath: output,
          frames: payload.frames, channels: payload.channels, sampleRate: payload.sampleRate,
          chain: payload.chain as unknown as HostStage[],
        });
        return result.ok
          ? { ok: true, stages: result.stages, outputPath: output }
          : { ok: false, error: result.error, stages: result.stages, outputPath: null };
      },
    };
    (globalThis as { fetch?: unknown }).fetch = async (url: string) => {
      const file = fromFileUrl(url);
      const bytes = fs.readFileSync(file);
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      };
    };

    try {
      const t = track([insert({ slot: 0, params: { gainDb: -6, invert: 1 } })]);
      const result = await applyExternalInserts(buffer, t);
      assert(result.error === null, `no error: ${result.error}`);
      assert(result.stages[0]?.applied === true, 'the stage applied');
      assert(result.buffer !== buffer, 'a new buffer came back');
      assert(result.buffer.length === frames, 'same length');
      assert(result.buffer.numberOfChannels === 2, 'same channel count');

      const expected = -Math.pow(10, -6 / 20);
      for (let c = 0; c < 2; c++) {
        const a = buffer.getChannelData(c);
        const b = result.buffer.getChannelData(c);
        for (const i of [7, 300, 1500, frames - 1]) {
          if (Math.abs(a[i]!) < 1e-6) continue;
          const ratio = b[i]! / a[i]!;
          assert(Math.abs(ratio - expected) < 1e-4,
            `channel ${c} frame ${i}: expected ${expected}, got ${ratio}`);
        }
      }

      assert(describeExternalPass(result) === '외부 플러그인 1개 적용', 'and the toast says so');

      // The URL the renderer asked for is the one the protocol actually serves.
      assert(toFileUrl(path.join(scratch, 'bridge-out.f32')).startsWith('aimaster-local://local/'),
        'read back through the app URL scheme');
    } finally {
      if (bridgeBefore === undefined) delete (globalThis as { electronAPI?: unknown }).electronAPI;
      else (globalThis as { electronAPI?: unknown }).electronAPI = bridgeBefore;
      if (fetchBefore === undefined) delete (globalThis as { fetch?: unknown }).fetch;
      else (globalThis as { fetch?: unknown }).fetch = fetchBefore;
    }
  });

  await check('a host failure loses the plugin, never the take', async () => {
    const ctx = decodeContext()!;
    const buffer = ctx.createBuffer(2, 256, SR);
    // Exactly representable in float32, so the check is an equality and not a
    // tolerance that could hide a resampled or re-rendered buffer.
    buffer.getChannelData(0)[10] = 0.375;

    const before = (globalThis as { electronAPI?: unknown }).electronAPI;
    (globalThis as { electronAPI?: unknown }).electronAPI = {
      invoke: async () => { throw new Error('호스트가 죽었습니다'); },
    };
    try {
      const result = await applyExternalInserts(buffer, track([insert({ slot: 0 })]));
      assert(result.buffer === buffer, 'the rendered audio is returned unchanged');
      assert(result.buffer.getChannelData(0)[10] === 0.375, 'and it is still the take');
      assert(result.error === '호스트가 죽었습니다', `the failure is reported: ${result.error}`);
      assert(describeExternalPass(result)?.startsWith('외부 플러그인 적용 실패'), 'and surfaced');
    } finally {
      if (before === undefined) delete (globalThis as { electronAPI?: unknown }).electronAPI;
      else (globalThis as { electronAPI?: unknown }).electronAPI = before;
    }
  });

}


// ── Report ──────────────────────────────────────────────────────────────────

function report(): void {
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }

  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  console.log('\n=== Third-party plugin host ===');
  for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
  if (failed > 0) process.exit(1);
}

main().then(report, (err) => { console.error(err); process.exit(1); });
