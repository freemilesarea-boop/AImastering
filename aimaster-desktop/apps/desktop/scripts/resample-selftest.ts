/**
 * resample-selftest.ts — changing the rate without changing the sound.
 *
 * A resampler is easy to write badly and the bad ones sound fine on a sine
 * sweep played once.  The three ways they go wrong, and the three tests that
 * catch them:
 *
 *   • ALIASING.  Downsampling without moving the cutoff folds everything above
 *     the new Nyquist back into the audible band.  Tested by feeding a tone
 *     ABOVE the destination Nyquist and demanding it disappear rather than
 *     reappear somewhere else.
 *   • LEVEL FLUTTER.  If the filter's taps are not normalised per phase, gain
 *     wobbles at the rate of the fractional position — a slow tremolo on
 *     sustained material.  Tested by measuring peak-to-peak envelope on a
 *     steady tone.
 *   • EDGE CLICKS.  Reading zero outside the buffer is a step to silence that
 *     the filter rings on.  Tested at the first and last samples of a DC-ish
 *     signal.
 *
 * Run via:  pnpm --filter @aimaster/desktop test:resample
 */

import {
  describeResample, resampleChannel, resampleChannels, resampleFilter,
  resampledLength,
} from '../src/renderer/daw/audio/resample.js';

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

function tone(hz: number, rate: number, n: number, amp = 0.5): Float32Array {
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin((2 * Math.PI * hz * i) / rate);
  return x;
}

/** Power at one frequency, by Goertzel. */
function binPower(x: Float32Array, rate: number, hz: number, from = 0, to = x.length): number {
  const k = (2 * Math.PI * hz) / rate;
  const coeff = 2 * Math.cos(k);
  let s1 = 0, s2 = 0;
  const n = to - from;
  for (let i = from; i < to; i++) {
    const s0 = (x[i] as number) + coeff * s1 - s2;
    s2 = s1; s1 = s0;
  }
  return (s1 * s1 + s2 * s2 - coeff * s1 * s2) / (n * n);
}

const db = (p: number): number => 10 * Math.log10(Math.max(p, 1e-40));

// ── Length and identity ─────────────────────────────────────────────────────

check('the same rate returns the very same array', () => {
  const x = tone(1000, 48_000, 1024);
  assert(resampleChannel(x, 48_000, 48_000) === x, 'no copy, no work');
});

check('the length follows the ratio', () => {
  assert(resampledLength(48_000, 48_000, 44_100) === 44_100, '48k→44.1k of one second');
  assert(resampledLength(44_100, 44_100, 48_000) === 48_000, 'and back');
  assert(resampledLength(0, 48_000, 44_100) === 0, 'nothing in, nothing out');
  const y = resampleChannel(tone(440, 48_000, 48_000), 48_000, 44_100);
  assert(y.length === 44_100, `got ${y.length}`);
});

check('a zero or negative rate is refused, not guessed at', () => {
  let threw = 0;
  for (const [a, b] of [[0, 48_000], [48_000, 0], [-1, 48_000]]) {
    try { resampleChannel(tone(440, 48_000, 64), a as number, b as number); }
    catch { threw++; }
  }
  assert(threw === 3, `three refusals, got ${threw}`);
});

// ── The tone survives ───────────────────────────────────────────────────────

check('a 1 kHz tone comes through 48k → 44.1k at its own frequency and level', () => {
  const src = tone(1000, 48_000, 48_000);
  const out = resampleChannel(src, 48_000, 44_100);
  // Skip the filter's settling at each end.
  const at = binPower(out, 44_100, 1000, 2000, out.length - 2000);
  const off = binPower(out, 44_100, 1300, 2000, out.length - 2000);
  // A 0.5-amplitude sine is A²/4 = −12.04 dB of Goertzel power, so the bar is
  // just under it — the point of this assertion is "the tone is not missing",
  // and the exact level is what the next test measures.
  assert(db(at) > -13, `the tone is there at ${db(at).toFixed(1)} dB`);
  assert(db(at) - db(off) > 60, `and nothing next to it — ${(db(at) - db(off)).toFixed(0)} dB apart`);
});

check('the level is preserved, not scaled by the ratio', () => {
  const src = tone(1000, 48_000, 24_000, 0.5);
  for (const to of [44_100, 96_000, 22_050]) {
    const out = resampleChannel(src, 48_000, to);
    const mid = out.subarray(Math.floor(out.length * 0.3), Math.floor(out.length * 0.7));
    let peak = 0;
    for (const v of mid) peak = Math.max(peak, Math.abs(v));
    near(peak, 0.5, 0.02, `48k→${to} peak`);
  }
});

// ── Aliasing ────────────────────────────────────────────────────────────────

check('a tone above the destination Nyquist is filtered away, not folded back', () => {
  // 21 kHz at 48 k, resampled to 32 k (Nyquist 16 k).  Naive resampling folds
  // it to |32000 - 21000| = 11 kHz, loud and obvious.
  const src = tone(21_000, 48_000, 48_000, 0.5);
  const out = resampleChannel(src, 48_000, 32_000);
  const guard = 3000;
  const fold = binPower(out, 32_000, 11_000, guard, out.length - guard);
  const ref = binPower(tone(11_000, 32_000, out.length, 0.5), 32_000, 11_000, guard, out.length - guard);
  assert(db(fold) - db(ref) < -60,
    `the fold is ${(db(fold) - db(ref)).toFixed(0)} dB below a real 11 kHz tone`);
});

check('the cutoff moves with the ratio, and only downward', () => {
  assert(resampleFilter(0.5).cutoff === 0.5, 'halving the rate halves the cutoff');
  assert(resampleFilter(2).cutoff === 1, 'upsampling has nothing to alias');
  assert(resampleFilter(0.5).halfWidth > resampleFilter(1).halfWidth,
    'and the window grows to hold the stretched response');
});

check('content below the new Nyquist is kept while content above is cut', () => {
  // Two tones at once: 5 kHz (safe) and 21 kHz (doomed), 48k → 32k.
  const n = 48_000;
  const src = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    src[i] = 0.35 * Math.sin((2 * Math.PI * 5000 * i) / 48_000)
           + 0.35 * Math.sin((2 * Math.PI * 21_000 * i) / 48_000);
  }
  const out = resampleChannel(src, 48_000, 32_000);
  const g = 3000;
  const kept = binPower(out, 32_000, 5000, g, out.length - g);
  const gone = binPower(out, 32_000, 11_000, g, out.length - g);
  assert(db(kept) > -25, `5 kHz survives at ${db(kept).toFixed(1)} dB`);
  assert(db(kept) - db(gone) > 60, `and the alias is ${(db(kept) - db(gone)).toFixed(0)} dB down`);
});

// ── Flutter and edges ───────────────────────────────────────────────────────

check('gain does not wobble with the fractional phase', () => {
  // 44.1k → 48k is an awkward ratio, so the phase walks through the whole
  // table; a table whose phases disagree in gain shows up as a slow tremolo.
  //
  // The tone and the block length are deliberately co-prime with each other.
  // The first draft used 1000 Hz and 480-sample blocks, which is exactly ten
  // cycles per block — every block then has an identical peak BY
  // CONSTRUCTION, the measurement reads 0.000 dB whatever the filter does,
  // and the test cannot fail.
  const src = tone(997, 44_100, 44_100, 0.5);
  const out = resampleChannel(src, 44_100, 48_000);
  const from = 4000, to = out.length - 4000;
  const block = 733;
  const peaks: number[] = [];
  for (let i = from; i + block < to; i += block) {
    let p = 0;
    for (let j = i; j < i + block; j++) p = Math.max(p, Math.abs(out[j] as number));
    peaks.push(p);
  }
  const hi = Math.max(...peaks), lo = Math.min(...peaks);
  const rippleDb = 20 * Math.log10(hi / lo);
  assert(peaks.length > 20, `enough blocks to see a wobble — ${peaks.length}`);
  assert(rippleDb < 0.05, `envelope ripple ${rippleDb.toFixed(4)} dB`);
});

check('the edges do not ring on imaginary silence', () => {
  // A constant.  Anything but the constant at the ends means the filter read
  // zeros past the buffer and rang on the step.
  const n = 2048;
  const src = new Float32Array(n).fill(0.5);
  const out = resampleChannel(src, 48_000, 44_100);
  near(out[0] as number, 0.5, 0.01, 'first sample');
  near(out[out.length - 1] as number, 0.5, 0.01, 'last sample');
  let worst = 0;
  for (const v of out) worst = Math.max(worst, Math.abs(v - 0.5));
  assert(worst < 0.01, `no overshoot anywhere — worst ${worst.toFixed(4)}`);
});

check('DC is passed at unity, not attenuated', () => {
  const out = resampleChannel(new Float32Array(4096).fill(0.25), 48_000, 96_000);
  const mid = out[Math.floor(out.length / 2)] as number;
  near(mid, 0.25, 1e-3, 'DC through a 2× upsample');
});

// ── Round trip ──────────────────────────────────────────────────────────────

check('48k → 44.1k → 48k gets the signal back', () => {
  const rate = 48_000, n = 48_000;
  const src = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    src[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / rate)
           + 0.2 * Math.sin((2 * Math.PI * 3300 * i) / rate);
  }
  const back = resampleChannel(resampleChannel(src, rate, 44_100), 44_100, rate);
  assert(Math.abs(back.length - n) <= 1, `length survives — ${back.length} vs ${n}`);

  const g = 4000;
  let num = 0, den = 0;
  for (let i = g; i < n - g && i < back.length - g; i++) {
    const e = (back[i] as number) - (src[i] as number);
    num += e * e; den += (src[i] as number) ** 2;
  }
  // 99 dB is what this filter actually delivers.  The bar sits at 85 rather
  // than 55 because a loose bar let a real regression through: dropping the
  // phase interpolation costs 33 dB and still cleared 55.
  const snr = 10 * Math.log10(den / Math.max(num, 1e-40));
  assert(snr > 85, `round-trip SNR ${snr.toFixed(1)} dB`);
});

check('every channel is converted, and independently', () => {
  const l = tone(1000, 48_000, 4800, 0.5);
  const r = tone(3000, 48_000, 4800, 0.25);
  const [outL, outR] = resampleChannels([l, r], 48_000, 24_000) as [Float32Array, Float32Array];
  assert(outL.length === 2400 && outR.length === 2400, 'both resampled');
  const g = 600;
  assert(db(binPower(outL, 24_000, 1000, g, outL.length - g)) > -20, 'left kept its tone');
  assert(db(binPower(outR, 24_000, 3000, g, outR.length - g)) > -26, 'right kept its own');
  assert(db(binPower(outR, 24_000, 1000, g, outR.length - g))
       < db(binPower(outL, 24_000, 1000, g, outL.length - g)) - 40,
    'and the left tone did not leak into the right');
});

check('describeResample says what happened', () => {
  assert(describeResample(48_000, 48_000, 100).includes('변환 없음'), 'no-op is named');
  assert(describeResample(48_000, 44_100, 48_000).includes('44100'), describeResample(48_000, 44_100, 48_000));
});

// ─────────────────────────────────────────────────────────────────────────────

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log('\n=== Resample ===');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
if (failed > 0) process.exit(1);
