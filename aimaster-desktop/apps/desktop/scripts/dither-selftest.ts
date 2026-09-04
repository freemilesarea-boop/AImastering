/**
 * dither-selftest.ts — the noise that stops the quantiser lying.
 *
 * The thing worth testing is not "does it add noise" — anything adds noise.
 * It is the property dither exists for: that the rounding error stops being a
 * FUNCTION OF THE SIGNAL.  So the headline test is a sine quieter than one
 * LSB.  Undithered it rounds to a stair-step or to nothing; dithered it
 * survives, buried in hiss but measurably still there at its own frequency.
 * That single test is the whole justification for the feature, and it is
 * measured here with a Goertzel bin rather than asserted.
 *
 * The rest guards the ways a dither implementation goes quietly wrong:
 * clipping at full scale, correlated noise across channels, a shaper whose
 * tilt goes the wrong way, and a bounce that is not reproducible.
 *
 * Run via:  pnpm --filter @aimaster/desktop test:dither
 */

import {
  DEFAULT_DITHER_SEED, DITHER_MODES, createQuantizer, defaultDither,
  describeDither, fullScale, lsbOf, type DitherMode,
} from '../src/renderer/daw/audio/dither.js';
import { encodeWav } from '../src/renderer/daw/engine/wav.js';

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }
function near(a: number, b: number, eps: number, m: string): void {
  if (!(Math.abs(a - b) <= eps)) throw new Error(`${m} — ${a} vs ${b}`);
}

/** Energy at one frequency, by Goertzel — no FFT needed for a single bin. */
function binPower(x: Float64Array, sampleRate: number, hz: number): number {
  const k = (2 * Math.PI * hz) / sampleRate;
  const coeff = 2 * Math.cos(k);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < x.length; i++) {
    const s0 = (x[i] as number) + coeff * s1 - s2;
    s2 = s1; s1 = s0;
  }
  return (s1 * s1 + s2 * s2 - coeff * s1 * s2) / (x.length * x.length);
}

/** Quantise a whole channel and return the result back in [-1, 1]. */
function run(mode: DitherMode, input: Float64Array, bitDepth: 16 | 24 = 16): Float64Array {
  const q = createQuantizer(bitDepth, mode, 1);
  const out = new Float64Array(input.length);
  for (let i = 0; i < input.length; i++) out[i] = q.code(input[i] as number, 0) / q.peak;
  return out;
}

const RATE = 48_000;
const N = 16_384;

/** A sine at `hz` with amplitude `amp`, in normalised units. */
function sine(hz: number, amp: number, n = N): Float64Array {
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin((2 * Math.PI * hz * i) / RATE);
  return x;
}

// ── The headline: a signal below one bit ────────────────────────────────────

check('a sine quieter than one LSB dies undithered and survives dithered', () => {
  const lsb = lsbOf(16);
  // 0.4 LSB peak — genuinely below the quantiser's resolution.  Exactly 0.5
  // would sit on the rounding boundary, where the peaks round to 1 and the
  // test would be measuring JavaScript's tie-breaking rule instead of dither.
  const input = sine(1000, lsb * 0.4);
  const hz = 1000;

  const plain = run('none', input);
  const tpdf  = run('tpdf', input);

  const wanted = binPower(input, RATE, hz);
  const plainAt = binPower(plain, RATE, hz);
  const tpdfAt  = binPower(tpdf, RATE, hz);

  // Undithered, every sample rounds to zero: the tone is simply gone.
  assert(plain.every((v) => v === 0), 'undithered, the whole sine rounds away to digital silence');
  assert(plainAt < wanted * 1e-6, `and its bin is empty — ${plainAt} vs ${wanted}`);

  // Dithered, the tone is back at roughly its real level.  "Roughly" is the
  // point: it is riding on noise, so a factor-of-two window is the honest
  // assertion, not equality.
  assert(tpdfAt > wanted * 0.25, `dithered, the tone survives — ${tpdfAt} vs ${wanted}`);
  assert(tpdfAt < wanted * 4, `and is not inflated — ${tpdfAt} vs ${wanted}`);
});

check('the error stops tracking the signal — harmonics become hiss', () => {
  // "Correlated with the signal" has a concrete, audible meaning: the error
  // appears at HARMONICS of the tone.  That is distortion, and it is what a
  // quiet undithered passage actually sounds like.  Dithered, those harmonics
  // drop into a flat floor.
  //
  // (Plain correlation between input and error is NOT the measurement: for a
  // ramp the error is a sawtooth that averages out over its cycles, so it
  // reads near zero even undithered.  That was this test's first draft.)
  const lsb = lsbOf(16);
  const tone = 1000;
  const input = sine(tone, lsb * 3);

  const harmonicRatio = (mode: DitherMode): number => {
    const out = run(mode, input);
    const err = new Float64Array(out.length);
    for (let i = 0; i < out.length; i++) err[i] = (out[i] as number) - (input[i] as number);
    let harmonics = 0;
    for (const h of [3, 5, 7, 9]) harmonics += binPower(err, RATE, tone * h);
    // A handful of bins that are not harmonics of anything, as the floor.
    let floor = 0;
    for (const hz of [1370, 2610, 4130, 6890]) floor += binPower(err, RATE, hz);
    return harmonics / Math.max(floor, 1e-30);
  };

  const plain = harmonicRatio('none');
  const dithered = harmonicRatio('tpdf');
  assert(plain > 20, `undithered, the error piles up on the harmonics — ratio ${plain.toFixed(1)}`);
  assert(dithered < 5, `dithered, they are gone into the floor — ratio ${dithered.toFixed(2)}`);
  assert(dithered < plain / 10, `and by a wide margin — ${dithered.toFixed(2)} vs ${plain.toFixed(1)}`);
});

// ── Not breaking the loud parts ─────────────────────────────────────────────

check('full scale never wraps, whatever the dither adds', () => {
  for (const mode of DITHER_MODES) {
    const q = createQuantizer(16, mode, 1);
    for (const v of [1, -1, 1.5, -1.5, 0.99999, 42, -42]) {
      for (let i = 0; i < 200; i++) {
        const c = q.code(v, 0);
        assert(c <= q.peak && c >= -q.peak, `${mode}: code ${c} outside ±${q.peak} for input ${v}`);
        assert(Number.isInteger(c), `${mode}: ${c} is not an integer code`);
      }
    }
  }
});

check("'none' reproduces the old rounding exactly", () => {
  const input = sine(440, 0.7, 512);
  const q = createQuantizer(16, 'none', 1);
  for (let i = 0; i < input.length; i++) {
    const v = input[i] as number;
    const old = Math.round(Math.max(-1, Math.min(1, v)) * 0x7fff);
    assert(q.code(v, 0) === old, `sample ${i}: ${q.code(v, 0)} vs ${old}`);
  }
});

check('the dither is about one LSB, not ten', () => {
  const q = createQuantizer(16, 'tpdf', 1);
  let worst = 0;
  for (let i = 0; i < 20_000; i++) worst = Math.max(worst, Math.abs(q.code(0, 0)));
  // TPDF is ±1 LSB peak, so a code of ±1 is expected and ±2 is not.
  assert(worst >= 1, 'silence does not stay bit-exact silent — that is the point');
  assert(worst <= 1, `and it never exceeds one LSB — saw ${worst}`);
});

check('dither adds no DC offset', () => {
  const q = createQuantizer(16, 'tpdf', 1);
  let sum = 0;
  const n = 200_000;
  for (let i = 0; i < n; i++) sum += q.code(0, 0);
  const mean = sum / n / fullScale(16);
  near(mean, 0, 1e-6, 'the mean of the added noise');
});

// ── Channels and reproducibility ────────────────────────────────────────────

check('each channel gets its own noise', () => {
  const q = createQuantizer(16, 'tpdf', 2);
  let same = 0;
  const n = 4000;
  for (let i = 0; i < n; i++) {
    const l = q.code(0, 0);
    const r = q.code(0, 1);
    if (l === r) same++;
  }
  // Identical streams would image dead centre.  Three codes are possible, so
  // agreeing by chance about a third of the time is expected; 90 % is not.
  assert(same < n * 0.6, `L and R agree ${((same / n) * 100).toFixed(0)}% of the time — too correlated`);
});

check('the same seed gives the same file, a different seed does not', () => {
  const input = sine(440, 0.5, 4096);
  const bytesFor = (seed: number): string => {
    const q = createQuantizer(16, 'tpdf', 1, seed);
    return Array.from(input, (v) => q.code(v, 0)).join(',');
  };
  assert(bytesFor(DEFAULT_DITHER_SEED) === bytesFor(DEFAULT_DITHER_SEED), 'a bounce is reproducible');
  assert(bytesFor(1) !== bytesFor(2), 'and the seed actually reaches the noise');
});

check('a zero seed does not lock the generator', () => {
  const q = createQuantizer(16, 'tpdf', 1, 0);
  const codes = new Set<number>();
  for (let i = 0; i < 500; i++) codes.add(q.code(0, 0));
  assert(codes.size > 1, 'a zero seed still produces noise');
});

// ── Noise shaping ───────────────────────────────────────────────────────────

check('shaping tilts the noise upward, flat dither does not', () => {
  // Quantise silence and compare energy low against energy high.
  const silence = new Float64Array(N);
  const tilt = (mode: DitherMode): number => {
    const out = run(mode, silence);
    let low = 0, high = 0;
    for (const hz of [500, 1000, 2000, 3000]) low += binPower(out, RATE, hz);
    for (const hz of [18_000, 20_000, 22_000, 23_000]) high += binPower(out, RATE, hz);
    return high / Math.max(low, 1e-30);
  };
  const flat = tilt('tpdf');
  const shaped = tilt('shaped');
  const strong = tilt('shaped-strong');
  assert(flat > 0.3 && flat < 3, `flat TPDF is roughly flat — ratio ${flat.toFixed(2)}`);
  assert(shaped > flat * 5, `2nd order pushes noise up — ${shaped.toFixed(1)} vs ${flat.toFixed(2)}`);
  assert(strong > shaped, `3rd order pushes harder — ${strong.toFixed(1)} vs ${shaped.toFixed(1)}`);
});

check('shaping keeps the audible band quieter than flat dither', () => {
  // The whole trade: total noise power goes UP, in-band noise goes DOWN.
  const silence = new Float64Array(N);
  const inBand = (mode: DitherMode): number => {
    const out = run(mode, silence);
    let sum = 0;
    for (let hz = 1000; hz <= 5000; hz += 250) sum += binPower(out, RATE, hz);
    return sum;
  };
  const flat = inBand('tpdf');
  const shaped = inBand('shaped');
  assert(shaped < flat, `2-5 kHz is quieter with shaping — ${shaped.toExponential(2)} vs ${flat.toExponential(2)}`);
});

check('the shaper is per channel, not one shared history', () => {
  // Feeding one channel must not move the other's noise.  If the error
  // history were shared, interleaving two channels would change what each of
  // them produced.
  const alone = createQuantizer(16, 'shaped', 2);
  const solo: number[] = [];
  for (let i = 0; i < 64; i++) solo.push(alone.code(0.5, 0));

  const both = createQuantizer(16, 'shaped', 2);
  const mixed: number[] = [];
  for (let i = 0; i < 64; i++) { mixed.push(both.code(0.5, 0)); both.code(-0.5, 1); }

  assert(solo.join(',') === mixed.join(','), 'channel 0 is unaffected by channel 1');
});

// ── Depth handling ──────────────────────────────────────────────────────────

check('24-bit uses the 24-bit scale and a smaller LSB', () => {
  assert(fullScale(24) === 0x7fffff, 'full scale');
  assert(lsbOf(24) < lsbOf(16) / 200, 'one LSB is 256 times smaller');
  const q = createQuantizer(24, 'tpdf', 1);
  let worst = 0;
  for (let i = 0; i < 5000; i++) worst = Math.max(worst, Math.abs(q.code(0, 0)));
  assert(worst <= 1, `still one LSB of noise, just a smaller one — saw ${worst}`);
});

check('32-bit float asks for no dither at all', () => {
  assert(defaultDither(32) === 'none', 'float is not a reduction');
  assert(defaultDither(16) === 'tpdf', '16-bit gets dither by default');
  assert(defaultDither(24) === 'tpdf', 'so does 24-bit');
  assert(describeDither('tpdf', 32).includes('양자화가 없어'), describeDither('tpdf', 32));
});

// ── Through the encoder ─────────────────────────────────────────────────────

/** The 16-bit sample frames of a WAV, back as numbers. */
function pcm16(bytes: Uint8Array): Int16Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const frames = (bytes.length - 44) / 2;
  const out = new Int16Array(frames);
  for (let i = 0; i < frames; i++) out[i] = view.getInt16(44 + i * 2, true);
  return out;
}

check('encodeWav dithers by default and obeys an explicit mode', () => {
  const lsb = lsbOf(16);
  const quiet = Float32Array.from({ length: 2048 }, (_, i) =>
    lsb * 0.5 * Math.sin((2 * Math.PI * 1000 * i) / RATE));

  const plain = pcm16(encodeWav([quiet], RATE, 16, 'none'));
  const dithered = pcm16(encodeWav([quiet], RATE, 16));

  assert(plain.every((v) => v === 0), 'dither off: the quiet sine is gone');
  assert(dithered.some((v) => v !== 0), 'dither on by default: it is still there');
});

check('encodeWav at 32-bit float is untouched by any of this', () => {
  const hot = Float32Array.from([1.4, -1.4, 0.5]);
  const bytes = encodeWav([hot], RATE, 32);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  near(view.getFloat32(44, true), 1.4, 1e-6, 'past full scale, kept — float must not clamp');
  near(view.getFloat32(48, true), -1.4, 1e-6, 'and the same the other way');
});

check('a stereo encode keeps the channels apart', () => {
  const silence = new Float32Array(2000);
  const bytes = encodeWav([silence, silence], RATE, 16);
  const codes = pcm16(bytes);
  let same = 0;
  for (let i = 0; i < codes.length; i += 2) if (codes[i] === codes[i + 1]) same++;
  assert(same < codes.length / 2 * 0.7, 'the two channels do not carry identical noise');
});

// ─────────────────────────────────────────────────────────────────────────────

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log('\n=== Dither ===');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
if (failed > 0) process.exit(1);
