/**
 * saturation-selftest — drive belongs INSIDE the curve.
 *
 * `tanhCurve` was `tanh(1.6·x) / tanh(1.6)`, a fixed 2048-point array, and
 * three devices applied their drive as a GAIN IN FRONT of it: Saturation up
 * to 24 dB, the Exciter up to nine times, the Rotary up to eight.  A
 * WaveShaper's domain is [−1, 1] and it CLAMPS outside that, so every sample
 * the drive pushed past full scale landed on the last entry — a flat top.
 * Each of those three knobs became a hard clipper somewhere in its travel,
 * and a hard clip is the one thing oversampling cannot save you from.
 * Measured on a 7 kHz tone, the images folding back down:
 *
 *                       Drive floor   mid     full
 *     Saturation          −145 dB   −58.8   −37.2
 *     Exciter             −131 dB   −47.1   −42.7
 *     Rotary               −60 dB   −45.5   −40.8
 *
 * Tube Drive, whose drive is a curve PARAMETER, sits at −84 dB at full drive
 * in the same renderer with the same oversampling.  The architecture was the
 * difference, not the filter.
 *
 * The normalisation was wrong in the same way the clipper's was: dividing by
 * `tanh(1.6)` puts the curve through 1 at x = 1 but leaves the slope at the
 * origin at 1.736, so the curve carried +4.79 dB.  At Drive 0 a −6 dBFS tone
 * came out at −2.83 dBFS with 4.6 % THD — the knob's minimum was already
 * distorting — and the level then INVERTED, falling to −11.78 dBFS at Drive
 * 24 because the 1/sqrt(gain) compensation over-compensated once the curve
 * saturated.  A knob labelled Drive made the track quieter.
 *
 * It is a knee family now, the one `clipCurve` uses: unity below the knee,
 * tanh bend to full scale above it, `driveDb` being how far below full scale
 * the bend starts.  What this file pins is the curve, the three devices'
 * level and distortion, the aliasing, and — because a fourth device could be
 * written tomorrow — that none of them has a gain either side of its shaper.
 *
 * Run:  pnpm --filter @aimaster/desktop test:saturation
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { OfflineAudioContext } from 'node-web-audio-api';
(globalThis as unknown as { OfflineAudioContext: unknown }).OfflineAudioContext = OfflineAudioContext;

import { PLUGINS, defaultParams, EXCITER_MAX_BIAS } from '../src/renderer/daw/engine/plugins.js';
import { dbToGain, probeRendererLatency, tanhCurve } from '../src/renderer/daw/engine/plugin-kit.js';

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SR = 48_000;
const N = SR;
const DRIVES = [0, 6, 12, 18, 24];
const db = (g: number): number => 20 * Math.log10(Math.max(1e-12, g));

function at(curve: Float32Array, x: number): number {
  const t = ((Math.max(-1, Math.min(1, x)) + 1) / 2) * (curve.length - 1);
  const i = Math.max(0, Math.min(curve.length - 2, Math.floor(t)));
  return curve[i]! + (curve[i + 1]! - curve[i]!) * (t - i);
}

function goertzel(x: Float32Array, from: number, to: number, f: number): number {
  const w = (2 * Math.PI * f) / SR, c = 2 * Math.cos(w);
  let s1 = 0, s2 = 0;
  for (let i = from; i < to; i += 1) { const s = x[i]! + c * s1 - s2; s2 = s1; s1 = s; }
  return Math.sqrt(s1 * s1 + s2 * s2 - c * s1 * s2) / ((to - from) / 2);
}

/** Folded images of a 7 kHz tone's harmonics; none is a multiple of 7. */
const IMAGES = [1_000, 5_000, 9_000, 11_000, 13_000, 15_000, 17_000, 19_000];
/** Products of 5 k + 6 k that land back inside the exciter's band. */
const PRODUCTS = [1_000, 4_000, 7_000, 11_000, 16_000, 17_000];

interface Tone { f: number; db: number }

async function render(
  id: string, tones: Tone[], over: Record<string, number>,
): Promise<Float32Array> {
  const dev = PLUGINS.find((p) => p.id === id);
  assert(dev, `${id} is in the plugin set`);
  const ctx = new OfflineAudioContext(1, N, SR);
  const buf = ctx.createBuffer(1, N, SR);
  const d = buf.getChannelData(0);
  for (const tone of tones) {
    const amp = dbToGain(tone.db);
    for (let i = 0; i < N; i += 1) d[i] += amp * Math.sin((2 * Math.PI * tone.f * i) / SR);
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const node = dev!.create(
    ctx as unknown as BaseAudioContext, { ...defaultParams(id), ...over });
  src.connect(node.input as AudioNode);
  (node.output as AudioNode).connect(ctx.destination as unknown as AudioNode);
  src.start(0);
  return (await ctx.startRendering()).getChannelData(0) as unknown as Float32Array;
}

function rmsOf(x: Float32Array): number {
  const from = Math.round(N / 2);
  let sq = 0;
  for (let i = from; i < x.length; i += 1) sq += x[i]! * x[i]!;
  return Math.sqrt(sq / (x.length - from));
}

/** Folded-image energy relative to the surviving fundamental, in dB. */
function imageLevel(x: Float32Array, f0: number): number {
  const from = Math.round(N / 2), to = x.length;
  const ref = Math.max(1e-12, goertzel(x, from, to, f0));
  let worst = -200;
  for (const f of IMAGES) {
    if (f % f0 === 0) continue;
    worst = Math.max(worst, db(goertzel(x, from, to, f) / ref));
  }
  return worst;
}

/** Intermodulation the device added to a two-tone pair, in dB. */
function imdLevel(x: Float32Array): number {
  const from = Math.round(N / 2), to = x.length;
  const ref = Math.max(goertzel(x, from, to, 5_000), goertzel(x, from, to, 6_000));
  let sum = 0;
  for (const f of PRODUCTS) { const m = goertzel(x, from, to, f); sum += m * m; }
  return db(Math.sqrt(sum) / Math.max(1e-12, ref));
}

async function main(): Promise<void> {
  await probeRendererLatency(SR);

// ── The curve ─────────────────────────────────────────────────────────────────

  await check('the curve is unity below the knee, at every drive', () => {
    // The old normalisation read +4.79 dB here, at every setting.
    for (const driveDb of DRIVES) {
      const c = tanhCurve(0, driveDb);
      assert(Math.abs(db(at(c, 1e-4) / 1e-4)) < 0.01,
        `drive ${driveDb}: ${db(at(c, 1e-4) / 1e-4).toFixed(2)} dB at the origin`);
      // A level a good way under the knee is untouched.
      const quiet = dbToGain(-driveDb - 12);
      assert(Math.abs(db(at(c, quiet) / quiet)) < 0.01,
        `drive ${driveDb}: a signal 12 dB under the knee moved`);
    }
  });

  await check('the knee sits where driveDb says, and nothing leaves full scale', () => {
    for (const driveDb of DRIVES) {
      const c = tanhCurve(0, driveDb);
      // Checked from the knee rather than by hunting for a deviation
      // threshold: the bend leaves the diagonal with slope 1, so "where it
      // first differs by 0.1 dB" lands well above the knee and says more
      // about the threshold than about the curve.  What the knee means is
      // that AT it the curve is still unity and ABOVE it the curve gives way.
      const kneeLevel = driveDb === 0 ? 1 : dbToGain(-driveDb);
      assert(Math.abs(db(at(c, kneeLevel) / kneeLevel)) < 0.02,
        `drive ${driveDb}: the knee itself is not unity`);
      if (driveDb === 0) {
        // Nothing to bend: the knee is full scale.
        assert(Math.abs(db(at(c, dbToGain(-0.1)) / dbToGain(-0.1))) < 0.02,
          'drive 0 is a straight line all the way up');
      }
      for (let i = 0; i < c.length; i += 1) {
        assert(Math.abs(c[i]!) <= 1 + 1e-6, `drive ${driveDb} entry ${i} is ${c[i]}`);
      }
    }
    // What a lower knee buys, checked where the curve has room to show it:
    // full scale is compressed further every time the knee drops.  Not 12 dB
    // above the knee, which is where this check first looked — the bend
    // leaves the diagonal with slope 1, and a deep knee is 0.09 dB down
    // there.  That gentleness is a measured property of the family, and it is
    // why the Exciter's knob had to become the asymmetry instead.
    const tops = DRIVES.map((d) => db(at(tanhCurve(0, d), 1)));
    for (let i = 1; i < tops.length; i += 1) {
      assert(tops[i]! < tops[i - 1]! - 0.1,
        `a lower knee compresses full scale further: ${tops.map((t) => t.toFixed(2)).join(', ')}`);
    }
  });

  await check('the curve rises monotonically and is odd, with a real zero', () => {
    for (const driveDb of DRIVES) {
      const c = tanhCurve(0, driveDb);
      assert(c.length % 2 === 1, `drive ${driveDb}: length ${c.length} is even`);
      assert(c[(c.length - 1) / 2] === 0, `drive ${driveDb}: no zero at the origin`);
      for (let i = 1; i < c.length; i += 1) {
        assert(c[i]! >= c[i - 1]! - 1e-7, `drive ${driveDb} dips at ${i}`);
      }
      let worst = 0;
      for (let i = 0; i < c.length; i += 1) worst = Math.max(worst, Math.abs(c[i]! + c[c.length - 1 - i]!));
      assert(worst < 1e-9, `drive ${driveDb}: |f(x)+f(−x)| reaches ${worst}`);
    }
  });

  await check('bias is the one thing that makes the curve lean', () => {
    // The even harmonics the exciter runs on.  It is the only asymmetry: with
    // bias 0 the curve is odd at every drive, checked above.
    const lean = (bias: number): number => {
      const c = tanhCurve(bias, 12);
      return Math.abs(at(c, 0.5) + at(c, -0.5));
    };
    assert(lean(0) < 1e-6, `no bias, no lean — ${lean(0)}`);
    for (const [a, b] of [[0, 0.15], [0.15, 0.5], [0.5, 1], [1, EXCITER_MAX_BIAS]] as const) {
      assert(lean(b) > lean(a) + 1e-3, `bias ${b} leans further than ${a}`);
    }
  });

// ── Saturation ────────────────────────────────────────────────────────────────

  await check('Saturation keeps the level it is given', async () => {
    // Was: the peak fell from −2.83 to −11.78 dBFS across the Drive range.
    for (const level of [-18, -12, -6, 0]) {
      const base = rmsOf(await render('saturation', [{ f: 1_000, db: level }], { mix: 1, driveDb: 0 }));
      for (const driveDb of DRIVES) {
        const got = rmsOf(await render('saturation', [{ f: 1_000, db: level }], { mix: 1, driveDb }));
        // 1.7 dB is the measured worst case over the whole grid — a full-scale
        // sine at Drive 24, which is the one place the curve has to work hard.
        assert(Math.abs(db(got / base)) < 1.7,
          `${level} dBFS at drive ${driveDb}: RMS moved ${db(got / base).toFixed(2)} dB`);
      }
    }
  });

  await check('Saturation at Drive 0 is clean, and the knob then colours', async () => {
    const clean = imdLevel(await render(
      'saturation', [{ f: 5_000, db: -12 }, { f: 6_000, db: -12 }], { mix: 1, driveDb: 0 }));
    assert(clean < -100, `drive 0 adds nothing: ${clean.toFixed(1)} dB`);
    const got: number[] = [];
    for (const driveDb of [12, 18, 24]) {
      got.push(imdLevel(await render(
        'saturation', [{ f: 5_000, db: -12 }, { f: 6_000, db: -12 }], { mix: 1, driveDb })));
    }
    for (let i = 1; i < got.length; i += 1) {
      assert(got[i]! > got[i - 1]! + 1,
        `more drive, more colour: ${got.map((g) => g.toFixed(1)).join(', ')}`);
    }
    assert(got.at(-1)! > clean + 60, 'and the range is worth having');
  });

  await check('Saturation no longer folds a high tone back down', async () => {
    // Was −37.2 dB at drive 24 on this exact signal.
    for (const driveDb of DRIVES) {
      const got = imageLevel(await render(
        'saturation', [{ f: 7_000, db: -6 }], { mix: 1, driveDb }), 7_000);
      assert(got < -95, `drive ${driveDb}: images at ${got.toFixed(1)} dB`);
    }
    // Full scale in is the hardest case the device can be handed.
    const hot = imageLevel(await render(
      'saturation', [{ f: 7_000, db: 0 }], { mix: 1, driveDb: 24 }), 7_000);
    assert(hot < -90, `full scale at full drive: ${hot.toFixed(1)} dB`);
  });

// ── Exciter ───────────────────────────────────────────────────────────────────

  await check('the Exciter\'s Amount is a real control again', async () => {
    // Putting the drive inside the curve as a knee alone would have left the
    // knob inert: measured, the intermodulation moved only from −31.5 to
    // −28.5 dB across a knee swept 0 to 48 dB, because a soft curve's
    // curvature over a wide span is gentle.  The asymmetry is what has range.
    const got: number[] = [];
    for (const amount of [0, 0.25, 0.5, 0.75, 1]) {
      got.push(imdLevel(await render(
        'exciter', [{ f: 5_000, db: -12 }, { f: 6_000, db: -12 }], { mix: 1, amount })));
    }
    for (let i = 1; i < got.length; i += 1) {
      assert(got[i]! > got[i - 1]! + 1,
        `monotone in Amount: ${got.map((g) => g.toFixed(1)).join(', ')}`);
    }
    assert(got.at(-1)! - got[0]! > 25,
      `and the range is worth having: ${(got.at(-1)! - got[0]!).toFixed(1)} dB`);
  });

  await check('the Exciter adds harmonics without adding level', async () => {
    const base = rmsOf(await render('exciter', [{ f: 7_000, db: -6 }], { mix: 1, amount: 0 }));
    for (const amount of [0.25, 0.5, 0.75, 1]) {
      const got = rmsOf(await render('exciter', [{ f: 7_000, db: -6 }], { mix: 1, amount }));
      assert(Math.abs(db(got / base)) < 0.3,
        `amount ${amount}: level moved ${db(got / base).toFixed(2)} dB`);
    }
  });

  await check('the Exciter no longer folds its own band back down', async () => {
    // Was −42.7 dB at full Amount.
    for (const amount of [0, 0.5, 1]) {
      const got = imageLevel(await render('exciter', [{ f: 7_000, db: -6 }], { mix: 1, amount }), 7_000);
      assert(got < -95, `amount ${amount}: images at ${got.toFixed(1)} dB`);
    }
  });

// ── Rotary ────────────────────────────────────────────────────────────────────

  await check('the Rotary\'s drive changes its harmonics and not its level', async () => {
    // Which is what its own comment always claimed, and what the hand-computed
    // post-gain never achieved: measured, the level used to rise 7.4 dB from
    // drive 0 to 100 while the comment said it did not.
    const base = rmsOf(await render('rotary', [{ f: 7_000, db: -6 }], { drive: 0 }));
    const thd: number[] = [];
    for (const drive of [0, 20, 50, 100]) {
      const out = await render('rotary', [{ f: 7_000, db: -6 }], { drive });
      assert(Math.abs(db(rmsOf(out) / base)) < 0.5,
        `drive ${drive}%: level moved ${db(rmsOf(out) / base).toFixed(2)} dB`);
      const from = Math.round(N / 2);
      const f1 = goertzel(out, from, out.length, 7_000);
      let harm = 0;
      for (const h of [3, 5]) {
        const f = h * 7_000;
        if (f >= SR / 2) continue;
        const m = goertzel(out, from, out.length, f);
        harm += m * m;
      }
      thd.push(db(Math.sqrt(harm) / Math.max(1e-12, f1)));
    }
    assert(thd.at(-1)! > thd[0]! + 5,
      `and the drive still does something: ${thd.map((t) => t.toFixed(1)).join(', ')}`);
  });

// ── The rule, so a fourth device cannot reintroduce it ────────────────────────

  await check('nothing drives a tanhCurve shaper from outside', () => {
    // Every call now passes the drive as the SECOND argument.  A one-argument
    // call is a fixed curve, which is what a pre-gain in front of a shaper
    // needs — and the three devices that had one are the three this file is
    // about.  The picture draws from the same calls, so it cannot disagree.
    const files = [
      'src/renderer/daw/engine/plugins.ts',
      'src/renderer/daw/engine/plugins-extended.ts',
      'src/renderer/daw/model/plugin-shapes.ts',
    ];
    const bad: string[] = [];
    for (const rel of files) {
      const src = fs.readFileSync(path.join(DESKTOP, rel), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');
      // Paren-balanced, because the arguments are themselves calls:
      // `tanhCurve(biasFor(x), KNEE)` has a `)` inside its first argument and
      // a regex that stops at the first one counts a single argument.  That
      // is how this check first reported two honest call sites as broken.
      for (const m of src.matchAll(/tanhCurve\(/g)) {
        let depth = 1;
        let commas = 0;
        let i = m.index + m[0].length;
        for (; i < src.length && depth > 0; i += 1) {
          const ch = src[i];
          if (ch === '(') depth += 1;
          else if (ch === ')') depth -= 1;
          else if (ch === ',' && depth === 1) commas += 1;
        }
        if (commas < 1) bad.push(`${rel}: ${src.slice(m.index, i).replace(/\s+/g, ' ')}`);
      }
    }
    assert(bad.length === 0, `these still build a fixed curve: ${bad.join(' | ')}`);
  });

// ── Report ────────────────────────────────────────────────────────────────────

  let pass = 0;
  for (const r of results) {
    if (r.pass) { pass += 1; console.log(`  PASS  ${r.name}`); }
    else console.log(`  FAIL  ${r.name}\n        ${r.detail}`);
  }
  console.log(`\nsaturation-selftest: ${pass}/${results.length}`);
  if (pass !== results.length) process.exit(1);
}

void main();
