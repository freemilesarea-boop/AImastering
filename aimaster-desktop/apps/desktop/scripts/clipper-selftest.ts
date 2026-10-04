/**
 * clipper-selftest — the Soft Clipper, which was neither soft nor a clipper.
 *
 * `clipCurve` was `tanh(k·x/ceiling) / tanh(k) · ceiling` with `k = 1 + 40·h`.
 * It lands on the ceiling at x = ceiling, which looks right on paper, but its
 * slope at the origin is k — so at the factory hardness of 0.5 the curve
 * carried +26.4 dB of gain and flattened everything above about −25 dBFS.
 * Measured through the device at its defaults, a 1 kHz tone arrived at
 * −1.00 dBFS with 43 % THD from EVERY input level between −40 and 0 dBFS: a
 * −40 dBFS whisper came out 39 dB louder, as a square wave.  It was also the
 * loudest aliaser in the whole plugin set, −14.3 dB at 7 kHz and independent
 * of level, because the output was a square whatever went in.
 *
 * The curve's own doc comment said "straight through below the ceiling".  No
 * hardness value had a unity region at all.
 *
 * It is a knee family now: unity up to `hardness × ceiling`, then a tanh bend
 * whose slope is 1 where it starts and whose asymptote is the ceiling.  What
 * this file pins is the shape (unity, monotone, bounded, odd), the device
 * (gain, distortion, aliasing, the ceiling under drive), and the division of
 * labour with the un-oversampled guard — which is still needed, and now only
 * ever sees the oversampler's own ringing.
 *
 * Run:  pnpm --filter @aimaster/desktop test:clipper
 */

import { OfflineAudioContext } from 'node-web-audio-api';
(globalThis as unknown as { OfflineAudioContext: unknown }).OfflineAudioContext = OfflineAudioContext;

import { PLUGINS, defaultParams } from '../src/renderer/daw/engine/plugins.js';
import { dbToGain, makeShaper } from '../src/renderer/daw/engine/plugin-kit.js';
import { clipCurve } from '../src/renderer/daw/engine/plugins-extended.js';
import { shaperFor } from '../src/renderer/daw/model/plugin-shapes.js';

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }

const SR = 48_000;
const N = SR;
const CEIL_DB = -1;
const CEILING = dbToGain(CEIL_DB);
const HARDNESSES = [0, 0.25, 0.5, 0.75, 1];
const db = (g: number): number => 20 * Math.log10(Math.max(1e-12, g));

/** The curve read the way a WaveShaper reads it: linear between entries. */
function at(curve: Float32Array, x: number): number {
  const n = curve.length;
  const t = ((x + 1) / 2) * (n - 1);
  const i = Math.max(0, Math.min(n - 2, Math.floor(t)));
  return curve[i]! + (curve[i + 1]! - curve[i]!) * (t - i);
}

function goertzel(x: Float32Array, from: number, to: number, f: number): number {
  const w = (2 * Math.PI * f) / SR, c = 2 * Math.cos(w);
  let s1 = 0, s2 = 0;
  for (let i = from; i < to; i += 1) { const s = x[i]! + c * s1 - s2; s2 = s1; s1 = s; }
  return Math.sqrt(s1 * s1 + s2 * s2 - c * s1 * s2) / ((to - from) / 2);
}

interface Measured { peakDb: number; gainDb: number; thdDb: number; aliasDb: number }

/** A steady tone through the real device, measured over the settled half. */
async function throughDevice(
  f0: number, inDb: number, over: Record<string, number> = {},
): Promise<Measured> {
  const dev = PLUGINS.find((p) => p.id === 'clipper');
  assert(dev, 'the clipper is in the plugin set');
  const ctx = new OfflineAudioContext(1, N, SR);
  const buf = ctx.createBuffer(1, N, SR);
  const d = buf.getChannelData(0);
  const amp = dbToGain(inDb);
  for (let i = 0; i < N; i += 1) d[i] = amp * Math.sin((2 * Math.PI * f0 * i) / SR);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const node = dev!.create(
    ctx as unknown as BaseAudioContext, { ...defaultParams('clipper'), ...over });
  src.connect(node.input as AudioNode);
  (node.output as AudioNode).connect(ctx.destination as unknown as AudioNode);
  src.start(0);
  const ch = (await ctx.startRendering()).getChannelData(0) as unknown as Float32Array;
  const from = Math.round(N / 2), to = N;
  let peak = 0;
  for (let i = from; i < to; i += 1) peak = Math.max(peak, Math.abs(ch[i]!));
  const f1 = goertzel(ch, from, to, f0);
  let harm = 0;
  for (let h = 2; h <= 25; h += 1) {
    const f = h * f0;
    if (f >= SR / 2) break;
    const m = goertzel(ch, from, to, f);
    harm += m * m;
  }
  // Folded images of a 7 kHz tone's odd harmonics: none is a multiple of 7.
  let alias = -200;
  for (const f of [1_000, 5_000, 9_000, 11_000, 13_000, 15_000, 17_000, 19_000]) {
    if (f % f0 === 0) continue;
    alias = Math.max(alias, db(goertzel(ch, from, to, f) / Math.max(1e-12, f1)));
  }
  return {
    peakDb: db(peak), gainDb: db(peak) - inDb,
    thdDb: db(Math.sqrt(harm) / Math.max(1e-12, f1)), aliasDb: alias,
  };
}

/** The 4x shaper with the guard either present or absent, peak in dB. */
async function peakWith(f0: number, driveDb: number, hardness: number, guard: boolean): Promise<number> {
  const ctx = new OfflineAudioContext(1, N, SR);
  const buf = ctx.createBuffer(1, N, SR);
  const d = buf.getChannelData(0);
  for (let i = 0; i < N; i += 1) d[i] = Math.sin((2 * Math.PI * f0 * i) / SR);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const gain = ctx.createGain();
  gain.gain.value = dbToGain(driveDb);
  const soft = makeShaper(ctx as unknown as BaseAudioContext, clipCurve(CEILING, hardness), '4x');
  src.connect(gain as unknown as AudioNode);
  (gain as unknown as AudioNode).connect(soft as unknown as AudioNode);
  let tail = soft as unknown as AudioNode;
  if (guard) {
    const g = makeShaper(ctx as unknown as BaseAudioContext, clipCurve(CEILING, 1));
    tail.connect(g as unknown as AudioNode);
    tail = g as unknown as AudioNode;
  }
  tail.connect(ctx.destination as unknown as AudioNode);
  src.start(0);
  const ch = (await ctx.startRendering()).getChannelData(0) as unknown as Float32Array;
  let peak = 0;
  for (let i = Math.round(N / 2); i < N; i += 1) peak = Math.max(peak, Math.abs(ch[i]!));
  return db(peak);
}

async function main(): Promise<void> {
  // ── The curve ─────────────────────────────────────────────────────────────────

  await check('the curve is unity below the knee, at every hardness', () => {
    // The defect, as a number: the old curve's slope at the origin was
    // 1 + 40·hardness, so this read +26.4 dB at the factory setting.
    for (const h of HARDNESSES) {
      const c = clipCurve(CEILING, h);
      const small = db(at(c, 1e-4) / 1e-4);
      assert(Math.abs(small) < 0.01, `hardness ${h}: small-signal gain ${small.toFixed(2)} dB`);
      // A level a good way under the knee passes through untouched.
      const x = dbToGain(-40);
      const g = db(at(c, x) / x);
      assert(Math.abs(g) < 0.01, `hardness ${h}: −40 dBFS moved ${g.toFixed(3)} dB`);
    }
  });

  await check('the knee is where hardness says it is, and it MOVES', () => {
    const knees = HARDNESSES.map((h) => {
      const c = clipCurve(CEILING, h);
      for (let d = -80; d <= 0; d += 0.05) {
        const x = dbToGain(d);
        if (Math.abs(db(at(c, x) / x)) > 0.1) return d;
      }
      return 0;
    });
    for (let i = 1; i < knees.length; i += 1) {
      assert(knees[i]! > knees[i - 1]! + 1,
        `hardness ${HARDNESSES[i]} bends later than ${HARDNESSES[i - 1]}: ${knees.join(', ')}`);
    }
    // Softest bends well below the ceiling; hardest essentially at it.
    assert(knees[0]! < -12, `hardness 0 bends low: ${knees[0]}`);
    assert(knees[knees.length - 1]! > -1.5, `hardness 1 bends at the ceiling: ${knees.at(-1)}`);
  });

  await check('hardness 1 IS a hard clip, and nothing ever exceeds the ceiling', () => {
    const hard = clipCurve(CEILING, 1);
    for (let d = -60; d <= 0; d += 0.25) {
      const x = dbToGain(d);
      const want = Math.min(x, CEILING);
      assert(Math.abs(at(hard, x) - want) < 2e-3,
        `hard clip at ${d} dBFS: ${at(hard, x).toFixed(5)} vs ${want.toFixed(5)}`);
    }
    for (const h of HARDNESSES) {
      const c = clipCurve(CEILING, h);
      for (let i = 0; i < c.length; i += 1) {
        assert(Math.abs(c[i]!) <= CEILING + 1e-6,
          `hardness ${h} entry ${i} is ${c[i]}, over the ceiling ${CEILING}`);
      }
    }
  });

  await check('the curve rises monotonically — a clipper does not fold', () => {
    // A non-monotone transfer curve inverts the waveform's tips, which reads as
    // a different and much nastier distortion than clipping.
    for (const h of HARDNESSES) {
      const c = clipCurve(CEILING, h);
      for (let i = 1; i < c.length; i += 1) {
        assert(c[i]! >= c[i - 1]! - 1e-7, `hardness ${h} dips at entry ${i}`);
      }
    }
  });

  await check('the curve is odd-symmetric, with a real sample at the origin', () => {
    // An even-length curve has no entry at x = 0, and an odd-symmetric shape
    // sampled off-centre is no longer odd — the pickup curve in instruments
    // carries 1025 points for the same reason.
    for (const h of HARDNESSES) {
      const c = clipCurve(CEILING, h);
      assert(c.length % 2 === 1, `hardness ${h}: length ${c.length} is even`);
      assert(c[(c.length - 1) / 2] === 0, `hardness ${h}: the middle entry is not zero`);
      let worst = 0;
      for (let i = 0; i < c.length; i += 1) worst = Math.max(worst, Math.abs(c[i]! + c[c.length - 1 - i]!));
      assert(worst < 1e-9, `hardness ${h}: |f(x)+f(−x)| reaches ${worst}`);
    }
  });

// ── The device ────────────────────────────────────────────────────────────────

  await check('below the knee the device is audibly absent', async () => {
    // Was: every one of these came out at −1.00 dBFS with −7.3 dB THD.
    for (const level of [-40, -30, -20, -12]) {
      const r = await throughDevice(1_000, level);
      assert(Math.abs(r.gainDb) < 0.05, `${level} dBFS moved ${r.gainDb.toFixed(2)} dB`);
      assert(r.thdDb < -100, `${level} dBFS distorted to ${r.thdDb.toFixed(1)} dB THD`);
    }
  });

  await check('the ceiling holds however hard it is driven', async () => {
    for (const driveDb of [0, 6, 12, 24]) {
      const r = await throughDevice(1_000, 0, { driveDb });
      assert(r.peakDb <= CEIL_DB + 0.01,
        `drive ${driveDb} dB peaked at ${r.peakDb.toFixed(3)} dBFS, ceiling ${CEIL_DB}`);
    }
    // And it really is clipping by then, not merely quiet.
    const hot = await throughDevice(1_000, 0, { driveDb: 24 });
    assert(hot.thdDb > -12, `driven 24 dB it distorts: ${hot.thdDb.toFixed(1)} dB THD`);
  });

  await check('a high tone no longer folds down into the mix', async () => {
    // The old device read −14.3 dB here at every level, which is grit at a
    // third of full scale in a part of the spectrum the signal never touched.
    for (const [level, limit] of [[-20, -120], [-6, -110], [0, -80]] as const) {
      const r = await throughDevice(7_000, level);
      assert(r.aliasDb < limit,
        `7 kHz at ${level} dBFS aliases at ${r.aliasDb.toFixed(1)} dB, want under ${limit}`);
    }
  });

  await check('softer really is softer', async () => {
    // Driven into the knee, a lower hardness has to come out lower: that is
    // what the asymptote means.  The old curve gave the same square either way.
    const peaks: number[] = [];
    for (const hardness of HARDNESSES) {
      peaks.push((await throughDevice(1_000, 0, { hardness, driveDb: 12 })).peakDb);
    }
    for (let i = 1; i < peaks.length; i += 1) {
      assert(peaks[i]! > peaks[i - 1]! + 0.1,
        `hardness ${HARDNESSES[i]} peaks above ${HARDNESSES[i - 1]}: ${peaks.map((p) => p.toFixed(2)).join(', ')}`);
    }
    assert(peaks[0]! < CEIL_DB - 1, `the softest stays under the ceiling: ${peaks[0]!.toFixed(2)}`);
  });

// ── The guard, and why it is still there ──────────────────────────────────────

  await check('the oversampler overshoots, so the guard earns its place', async () => {
    // Without it a "−1 dB ceiling" is a suggestion: the 4x resampling filter
    // rings past the curve, worst at high frequency with a hard knee.
    const bare = await peakWith(12_000, 24, 1, false);
    assert(bare > CEIL_DB + 1, `the bare shaper reaches ${bare.toFixed(3)} dBFS`);
    const guarded = await peakWith(12_000, 24, 1, true);
    assert(Math.abs(guarded - CEIL_DB) < 0.01,
      `with the guard it lands on the ceiling: ${guarded.toFixed(3)} dBFS`);
  });

  await check('the guard does NOT touch material that is not over the ceiling', async () => {
    // The old curve handed it a square wave at every level, and a hard,
    // un-oversampled clip of a square is where the −14.3 dB of aliasing came
    // from.  Now the soft output sits under the ceiling and passes through.
    for (const f0 of [1_000, 7_000]) {
      const bare = await peakWith(f0, 0, 0.5, false);
      const guarded = await peakWith(f0, 0, 0.5, true);
      assert(bare < CEIL_DB, `undriven, the soft curve stays under the ceiling: ${bare.toFixed(3)}`);
      assert(Math.abs(bare - guarded) < 1e-4,
        `${f0} Hz: the guard changed the peak by ${(guarded - bare).toFixed(5)} dB`);
    }
  });

// ── The picture ───────────────────────────────────────────────────────────────

  await check('the plugin window draws a curve with the same unity region', async () => {
    // plugin-shapes-selftest already checks the picture is built from the real
    // function rather than a second copy.  This checks the SHAPE, which is what
    // a copy-versus-copy comparison can never catch.
    const spec = shaperFor('clipper', { ...defaultParams('clipper'), ceilingDb: -1, hardness: 0.5 });
    assert(spec && spec.curves.length === 2, 'two stages are drawn');
    const drawn = spec!.curves[0]!;
    const x = dbToGain(-40);
    assert(Math.abs(db(at(drawn, x) / x)) < 0.01, 'the drawn curve is unity at −40 dBFS');
    assert(Math.abs(db(at(drawn, 1e-4) / 1e-4)) < 0.01, 'and at the origin');
  });

// ── Report ────────────────────────────────────────────────────────────────────

  let pass = 0;
  for (const r of results) {
    if (r.pass) { pass += 1; console.log(`  PASS  ${r.name}`); }
    else console.log(`  FAIL  ${r.name}\n        ${r.detail}`);
  }
  console.log(`\nclipper-selftest: ${pass}/${results.length}`);
  if (pass !== results.length) process.exit(1);
}

void main();
