// The inference path, run against a model this repository makes.
//
// The point of this file is that the ONNX plumbing — shaping the input,
// checking the output, applying masks, overlap-adding, counting the
// denominator once — has been EXECUTED before any real weights exist.  Every
// one of those steps is a place to be off by a transpose or a factor of the
// stem count, and none of them announce themselves; they come out as audio
// that is quiet, or doubled, or spectrally mirrored.
//
// `scripts/test-model.ts` builds a band-split model whose masks sum to one, so
// a run can be checked for all three at once: it loaded, the data went in the
// right way round, and the children add back up to the parent.

import * as ort from 'onnxruntime-web';

import {
  DEFAULT_MODEL_RUN, expandStems, runModel, type InferenceLike, type TensorLike,
} from '../src/renderer/daw/audio/separate/model-run.js';
import { SEPARATION_STFT } from '../src/renderer/daw/audio/separate/spectrum.js';
import type { ModelDescriptor } from '../src/renderer/daw/audio/separate/model-registry.js';
import type { StemKind } from '../src/renderer/daw/audio/separate/stem-tree.js';
import {
  openModel, sha256Hex, type OrtLike,
} from '../src/renderer/daw/audio/separate/model-session.js';
import { stemOfBin, testModelBytes } from './test-model.js';

ort.env.wasm.numThreads = 1;

const results: Array<{ name: string; pass: boolean }> = [];
const queued: Array<{ name: string; fn: () => Promise<void> }> = [];
function check(name: string, fn: () => Promise<void>): void { queued.push({ name, fn }); }
function assert(cond: unknown, why: string): asserts cond {
  if (!cond) throw new Error(why);
}
function atMost(got: number, want: number, why: string): void {
  assert(got <= want, `${why} — got ${got.toFixed(3)}, wanted at most ${want}`);
}
function atLeast(got: number, want: number, why: string): void {
  assert(got >= want, `${why} — got ${got.toFixed(3)}, wanted at least ${want}`);
}

const RATE = 48000;
const BINS = (SEPARATION_STFT.fftSize >> 1) + 1;
const STEMS: StemKind[] = ['guitar', 'keys', 'synth'];

function descriptor(over: Partial<ModelDescriptor> = {}): ModelDescriptor {
  return {
    id: 'bandsplit-test', name: '대역 분할 테스트', stems: STEMS,
    sampleRate: RATE, channels: 2, weights: 'model.onnx',
    sha256: '0'.repeat(64), license: '테스트용', commercialUse: true, ...over,
  };
}

/** The runtime's session, seen through the narrow interface `runModel` wants. */
async function makeSession(stems = STEMS.length, channels = 2): Promise<InferenceLike> {
  const session = await ort.InferenceSession.create(
    testModelBytes({ bins: BINS, stems, channels }), { executionProviders: ['wasm'] });
  return session as unknown as InferenceLike;
}
const tensor = (data: Float32Array, dims: number[]): TensorLike =>
  new ort.Tensor('float32', data, dims) as unknown as TensorLike;

/** A stereo tone sweep, so every band of every channel has something in it. */
function sweep(seconds: number): Float32Array[] {
  const n = Math.round(RATE * seconds);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    phase += (2 * Math.PI * (60 + (9000 * i) / n)) / RATE;
    l[i] = 0.4 * Math.sin(phase);
    r[i] = 0.4 * Math.sin(phase * 1.003 + 0.7);
  }
  return [l, r];
}

function energy(channels: readonly Float32Array[]): number {
  let sum = 0;
  for (const ch of channels) for (let i = 0; i < ch.length; i++) sum += (ch[i] ?? 0) ** 2;
  return sum;
}

check('the runtime loads a model and the path runs end to end', async () => {
  const audio = sweep(1.5);
  const r = await runModel(audio, RATE, descriptor(), await makeSession(), tensor);
  assert(r.stems.length === 3, `three stems, got ${r.stems.length}`);
  for (const stem of r.stems) {
    assert(stem.channels.length === 2, `${stem.kind}: two channels`);
    assert(stem.channels[0]!.length === audio[0]!.length, `${stem.kind}: full length`);
  }
});

check('the children add back up to what went in', async () => {
  // The property the whole stem tree rests on.  The band-split model's masks
  // sum to one at every bin, so anything but a near-exact reconstruction here
  // is a fault in the masking or the overlap-add, not in the model.
  const audio = sweep(1.5);
  const r = await runModel(audio, RATE, descriptor(), await makeSession(), tensor);
  atMost(r.reconstructionDb, -100, `합 − 원본 = ${r.reconstructionDb.toFixed(1)} dB`);
});

check('the denominator is counted once, not once per stem', async () => {
  // Counting the overlap-add denominator per stem divides the output by the
  // number of stems.  It is silent — everything still sums, everything is just
  // quiet — so it is asserted against the input's own energy.
  const audio = sweep(1.5);
  const r = await runModel(audio, RATE, descriptor(), await makeSession(), tensor);
  const total = r.stems.reduce((a, s) => a + energy(s.channels), 0);
  const ratio = total / energy(audio);
  atLeast(ratio, 0.9, 'energy out against energy in');
  atMost(ratio, 1.1, 'energy out against energy in');
});

check('the masks land on the right bins, the right way round', async () => {
  // The band split is asymmetric across the spectrum, so a frames/bins
  // transpose — the mistake this shape of code actually makes — cannot pass.
  // A rising sweep must therefore arrive in the stems in order.
  const audio = sweep(3);
  const r = await runModel(audio, RATE, descriptor(), await makeSession(), tensor);
  const centres = r.stems.map((s) => {
    // Where in TIME this stem's energy sits, 0…1.  Under a rising sweep that
    // is a proxy for where in FREQUENCY it sits.
    let weight = 0;
    let moment = 0;
    const ch = s.channels[0]!;
    for (let i = 0; i < ch.length; i++) { const e = (ch[i] ?? 0) ** 2; weight += e; moment += e * i; }
    return weight > 0 ? moment / weight / ch.length : 0;
  });
  assert(centres[0]! < centres[1]!, `low band before mid: ${centres[0]!.toFixed(2)} vs ${centres[1]!.toFixed(2)}`);
  assert(centres[1]! < centres[2]!, `mid band before high: ${centres[1]!.toFixed(2)} vs ${centres[2]!.toFixed(2)}`);
  // And the bands are where the model says they are, not merely ordered.
  assert(stemOfBin(1, BINS, 3) === 0 && stemOfBin(BINS - 1, BINS, 3) === 2, 'the split is what the test assumes');
});

check('a mono model on a stereo stem is run once per channel', async () => {
  const audio = sweep(1.5);
  const r = await runModel(audio, RATE, descriptor({ channels: 1 }), await makeSession(3, 1), tensor);
  atMost(r.reconstructionDb, -100, `mono model, stereo stem: ${r.reconstructionDb.toFixed(1)} dB`);
  for (const stem of r.stems) assert(stem.channels.length === 2, `${stem.kind}: two channels out`);
});

check('a model trained at another rate is RESAMPLED to, not refused', async () => {
  // This used to assert the refusal — the error message even named both rates
  // helpfully.  But the session default is 48 kHz and public separation models
  // are mostly 44.1 kHz, so "refused helpfully" meant the ONNX path never ran
  // at all.  The contract is now: convert in, convert back, and hand the
  // caller stems at the rate it asked about.
  const audio = sweep(1.5);
  const r = await runModel(audio, RATE, descriptor({ sampleRate: 44100 }), await makeSession(), tensor);

  assert(r.stems.length === STEMS.length, `all ${STEMS.length} stems came back, got ${r.stems.length}`);
  for (const stem of r.stems) {
    for (const ch of stem.channels) {
      // Back at the CALLER's rate and the caller's length — a stem still at
      // 44.1 kHz would drop into the session a semitone-and-a-bit flat and
      // 9 % short, which is the failure this asserts against.
      assert(Math.abs(ch.length - audio[0]!.length) <= 1,
        `${stem.kind}: ${ch.length} samples vs the input's ${audio[0]!.length}`);
    }
  }
});

check('the round trip through the model rate keeps the energy', async () => {
  // Resampling in and back out must not quietly cost level.  Compared against
  // a run at the model's own rate, where no conversion happens at all.
  const audio = sweep(1.5);
  const same = await runModel(audio, RATE, descriptor(), await makeSession(), tensor);
  const converted = await runModel(audio, RATE, descriptor({ sampleRate: 44100 }), await makeSession(), tensor);
  const ratio = converted.stems.reduce((a, s) => a + energy(s.channels), 0)
              / same.stems.reduce((a, s) => a + energy(s.channels), 0);
  atLeast(ratio, 0.85, 'energy after the rate round trip');
  atMost(ratio, 1.15, 'energy after the rate round trip');
});

check('a mask shape that does not match is refused, and named', async () => {
  // The model says three stems; the descriptor claims four.  Silently trusting
  // the descriptor writes one stem's audio from another stem's mask.
  let said = '';
  try {
    await runModel(sweep(0.5), RATE,
      descriptor({ stems: [...STEMS, 'strings'] }), await makeSession(3, 2), tensor);
  } catch (e) { said = e instanceof Error ? e.message : String(e); }
  assert(said.includes('bandsplit-test'), `names the model: ${said}`);
  assert(said.includes('모양'), `says what is wrong: ${said}`);
});

check('a model with no masks output is refused, saying what it did produce', async () => {
  const session: { run: () => Promise<Record<string, TensorLike>> } = {
    run: async () => ({ waveform: tensor(new Float32Array(4), [1, 1, 2, 2]) }),
  };
  let said = '';
  try {
    await runModel(sweep(0.5), RATE, descriptor(), session as never, tensor);
  } catch (e) { said = e instanceof Error ? e.message : String(e); }
  assert(said.includes('masks'), `names what was missing: ${said}`);
  assert(said.includes('waveform'), `names what came instead: ${said}`);
});

check('segmenting does not change the answer', async () => {
  // The masks are applied a segment at a time so the whole file's worth is
  // never resident.  A boundary that loses or doubles a window is audible.
  const audio = sweep(2);
  const session = await makeSession();
  const one = await runModel(audio, RATE, descriptor(), session, tensor, { segmentFrames: 100000 });
  const many = await runModel(audio, RATE, descriptor(), session, tensor, { segmentFrames: 40 });
  for (let s = 0; s < one.stems.length; s++) {
    for (let c = 0; c < 2; c++) {
      const a = one.stems[s]!.channels[c]!;
      const b = many.stems[s]!.channels[c]!;
      let worst = 0;
      for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs((a[i] ?? 0) - (b[i] ?? 0)));
      atMost(worst, 1e-5, `${one.stems[s]!.kind} ch${c}: one segment against many`);
    }
  }
});

check('the segment size is bounded, because the masks are the big array', async () => {
  // Not a behaviour test — a statement that the default is not "the whole
  // file".  Eight children of a four-minute file in one call is 1.5 GB.
  atMost(DEFAULT_MODEL_RUN.segmentFrames, 2048, 'default segment length');
  atLeast(DEFAULT_MODEL_RUN.segmentFrames, 64, 'default segment length');
});

// ── Putting the children back in the tree ────────────────────────────────────

const fake = (kind: StemKind, v: number): { kind: StemKind; channels: Float32Array[] } =>
  ({ kind, channels: [Float32Array.from([v, v])] });

check('the children take the parent’s place, in order', async () => {
  const before = [fake('vocals', 1), fake('drums', 2), fake('other', 3), fake('bass', 4)];
  const after = expandStems(before, 'other', [fake('guitar', 5), fake('keys', 6)]);
  const kinds = after.map((s) => s.kind);
  assert(kinds.join(',') === 'vocals,drums,guitar,keys,bass', `got ${kinds.join(',')}`);
});

check('the whole set still adds back up to the record', async () => {
  // The property that makes stems an edit rather than eight approximations.
  // The DSP stems sum to the mix; the model's children sum to the stem they
  // replaced; so the new set sums to the mix — but only if the parent is
  // actually removed, which is what this measures.
  const audio = sweep(1.5);
  const weights = testModelBytes({ bins: BINS, stems: 3, channels: 2 });
  const spec = descriptor({ sha256: await sha256Hex(weights) });
  const { session, tensor: make } = await openModel(spec, weights, { ort: ortLike });
  const split = await runModel(audio, RATE, spec, session, make);

  // A stand-in separation whose stems already sum to the audio: the audio
  // itself as 그 외, and silence everywhere else.
  const silence = (): Float32Array[] => audio.map((c) => new Float32Array(c.length));
  const dsp = [
    { kind: 'vocals' as StemKind, channels: silence() },
    { kind: 'other' as StemKind, channels: audio.map((c) => Float32Array.from(c)) },
  ];
  const whole = expandStems(dsp, 'other', split.stems);
  let residual = 0;
  let signal = 0;
  for (let c = 0; c < audio.length; c++) {
    for (let i = 0; i < audio[c]!.length; i++) {
      let sum = 0;
      for (const stem of whole) sum += stem.channels[c]?.[i] ?? 0;
      const d = (audio[c]![i] ?? 0) - sum;
      residual += d * d;
      signal += (audio[c]![i] ?? 0) ** 2;
    }
  }
  const db = 10 * Math.log10(Math.max(residual, Number.MIN_VALUE) / signal);
  atMost(db, -100, `전체 합 − 원본 = ${db.toFixed(1)} dB`);
});

check('a parent that is not there is refused, not silently appended', async () => {
  let said = '';
  try { expandStems([fake('vocals', 1)], 'other', [fake('guitar', 2)]); }
  catch (e) { said = e instanceof Error ? e.message : String(e); }
  assert(said.includes('그 외'), `names the missing parent: ${said}`);
});

check('a child that is already in the set is refused', async () => {
  // Otherwise the same part is written into two stems and playing them
  // together is that part twice — the same fault the DSP set refuses.
  let said = '';
  try {
    expandStems([fake('other', 1), fake('guitar', 2)], 'other', [fake('guitar', 3)]);
  } catch (e) { said = e instanceof Error ? e.message : String(e); }
  assert(said.includes('기타'), `names the clash: ${said}`);
  assert(said.includes('두 스템'), `says why it matters: ${said}`);
});

// ── Opening a model ──────────────────────────────────────────────────────────

const ortLike = ort as unknown as OrtLike;

check('the declared hash is checked, not merely written down', async () => {
  // `model.json` has carried a sha256 since the registry was built and nothing
  // looked at it.  A hash that is never verified is decoration: it makes a
  // half-downloaded file look like a broken model and a swapped file look like
  // a working one.
  const weights = testModelBytes({ bins: BINS, stems: 3, channels: 2 });
  const right = await sha256Hex(weights);
  const opened = await openModel(descriptor({ sha256: right }), weights, { ort: ortLike });
  assert(typeof opened.session.run === 'function', 'a session came back');

  let said = '';
  try {
    await openModel(descriptor({ sha256: 'a'.repeat(64) }), weights, { ort: ortLike });
  } catch (e) { said = e instanceof Error ? e.message : String(e); }
  assert(said.includes('해시'), `says it is the hash: ${said}`);
  assert(said.includes(right.slice(0, 12)), `says what the file actually is: ${said}`);
  assert(said.includes('aaaaaaaaaaaa'), `says what was expected: ${said}`);
});

check('an empty weights file is refused by name before anything loads', async () => {
  let said = '';
  try {
    await openModel(descriptor(), new Uint8Array(0), { ort: ortLike });
  } catch (e) { said = e instanceof Error ? e.message : String(e); }
  assert(said.includes('model.onnx'), `names the file: ${said}`);
  assert(said.includes('비어'), `says it is empty: ${said}`);
});

check('a file the runtime cannot read is refused as that, not as a bad hash', async () => {
  // Three failures share one symptom — "the model did not load" — and have
  // three different fixes.  The message has to pick one.
  const junk = new Uint8Array(64).fill(7);
  const hash = await sha256Hex(junk);
  let said = '';
  try {
    await openModel(descriptor({ sha256: hash }), junk, { ort: ortLike });
  } catch (e) { said = e instanceof Error ? e.message : String(e); }
  assert(said.includes('읽을 수 없는'), `says the runtime could not read it: ${said}`);
  assert(!said.includes('해시'), `does not blame the hash: ${said}`);
});

check('a session opened this way actually runs', async () => {
  // The point of the whole file: descriptor to audio, through the real runtime.
  const weights = testModelBytes({ bins: BINS, stems: 3, channels: 2 });
  const spec = descriptor({ sha256: await sha256Hex(weights) });
  const { session, tensor: make } = await openModel(spec, weights, { ort: ortLike });
  const r = await runModel(sweep(1), RATE, spec, session, make);
  atMost(r.reconstructionDb, -100, `합 − 원본 = ${r.reconstructionDb.toFixed(1)} dB`);
});

void (async () => {
  for (const { name, fn } of queued) {
    try { await fn(); results.push({ name, pass: true }); console.log(`[PASS] ${name}`); }
    catch (e) {
      results.push({ name, pass: false });
      console.log(`[FAIL] ${name} — ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} passed${failed > 0 ? `, ${failed} FAILED` : ''}`);
  if (failed > 0) process.exitCode = 1;
})();
