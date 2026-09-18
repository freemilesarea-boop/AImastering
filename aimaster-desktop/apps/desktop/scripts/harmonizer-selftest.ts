/**
 * harmonizer-selftest — an interval made of delay lines, and what it costs.
 *
 * This engine is native Web Audio nodes only, which rules out every good
 * pitch shifter: a phase vocoder and granular resynthesis both need a
 * worklet.  What is left is the technique that was invented under the same
 * constraint in hardware — sweep a delay, splice, crossfade — and the whole
 * question is whether it is honest about what that costs.
 *
 * So the checks are the cost as much as the feature:
 *
 *   · the interval is really there, measured as where the ENERGY sits rather
 *     than as one spectral line, because the splice spreads it into a comb
 *   · the pitch error is half the window rate in hertz, which is a LAW and
 *     not a tuning — it is why a bass an octave down is 150 cents out and a
 *     vocal a fifth up is not
 *   · a unison is transparent, and at a spread of zero so is the width
 *   · the level warbles: on a sine it is a comb whose depth at one frequency
 *     is luck, and on broadband material it is two to three decibels
 *
 * Run: pnpm --filter @aimaster/desktop test:harmonizer
 */

import { OfflineAudioContext } from 'node-web-audio-api';

(globalThis as unknown as { OfflineAudioContext: unknown }).OfflineAudioContext = OfflineAudioContext;

import { defaultParams, findPlugin } from '../src/renderer/daw/engine/plugins.js';
import {
  HARMONY_WINDOW_MAX_MS, HARMONY_WINDOW_MIN_MS, harmonyBaseSec, harmonyErrorCents,
  harmonyFadeSamples, harmonyMaxDelaySec, harmonyRampSamples, harmonyRatio, harmonySpanSec,
  harmonySweepGain, harmonyWindowForMs, harmonyWindowSamples,
} from '../src/renderer/daw/engine/pitch-shift.js';
import { lfoPictureFor } from '../src/renderer/daw/model/plugin-shapes.js';

const SR = 48_000;
const results: Array<{ name: string; pass: boolean }> = [];

async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); results.push({ name, pass: true }); console.log(`[PASS] ${name}`); }
  catch (err) {
    results.push({ name, pass: false });
    console.log(`[FAIL] ${name} — ${err instanceof Error ? err.message : String(err)}`);
  }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }

/** Amplitude at one frequency, over a steady stretch. */
function tone(x: Float32Array, hz: number): number {
  const from = Math.round(SR * 0.3);
  const n = Math.round(SR * 0.6);
  const w = (2 * Math.PI * hz) / SR;
  const c = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    const win = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    const s0 = (x[from + i] ?? 0) * win + c * s1 - s2;
    s2 = s1; s1 = s0;
  }
  return Math.hypot(s1 - s2 * Math.cos(w), s2 * Math.sin(w)) / n;
}

/**
 * Where the energy sits around a target, in Hz.
 *
 * A single Goertzel at the target is the wrong measurement for this device
 * and says so loudly: the splice puts the output's energy on a comb at the
 * window rate, and the target usually falls BETWEEN two lines of it, so a
 * reading at the target alone can be zero while the shift is perfectly good.
 * The centroid is what the ear is doing instead.
 */
function centroid(x: Float32Array, want: number, semitonesEither = 4): number {
  const lo = want * Math.pow(2, -semitonesEither / 12);
  const hi = want * Math.pow(2, semitonesEither / 12);
  let num = 0;
  let den = 0;
  for (let hz = lo; hz <= hi; hz += 0.5) {
    const a = tone(x, hz) ** 2;
    num += a * hz;
    den += a;
  }
  return den > 0 ? num / den : 0;
}

function rippleDb(x: Float32Array): number {
  const step = Math.round(SR * 0.004);
  let min = Infinity;
  let max = 0;
  for (let i = Math.round(SR * 0.3); i + step < Math.round(SR * 0.95); i += step) {
    let p = 0;
    for (let k = 0; k < step; k++) p = Math.max(p, Math.abs(x[i + k] ?? 0));
    min = Math.min(min, p);
    max = Math.max(max, p);
  }
  return 20 * Math.log10(max / Math.max(1e-9, min));
}

/** One voice, fully wet, centred — the shifter with nothing else in the way. */
const WET = { v1Db: 0, v2Db: -60, mix: 1, spread: 0, outDb: 0 };

async function through(
  over: Record<string, number>, source: 'sine' | 'noise' = 'sine', f0 = 440,
): Promise<Float32Array> {
  const n = SR;
  const ctx = new OfflineAudioContext(1, n, SR);
  let input: AudioNode;
  if (source === 'sine') {
    const osc = ctx.createOscillator();
    osc.frequency.value = f0;
    osc.start(0);
    input = osc;
  } else {
    const buffer = ctx.createBuffer(1, n, SR);
    const data = buffer.getChannelData(0);
    let seed = 99;
    for (let i = 0; i < n; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      data[i] = ((seed / 0x7fffffff) * 2 - 1) * 0.5;
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.start(0);
    input = src;
  }
  const device = findPlugin('harmonizer')!.create(
    ctx as unknown as BaseAudioContext, { ...defaultParams('harmonizer'), ...over },
  );
  input.connect(device.input);
  device.output.connect(ctx.destination as unknown as AudioNode);
  return (await ctx.startRendering()).getChannelData(0) as Float32Array;
}

async function main(): Promise<void> {
  await check('the interval is really there, at every interval', async () => {
    for (const st of [12, 7, 4, 1, -1, -4, -7, -12]) {
      const want = 880 * Math.pow(2, st / 12);
      const x = await through({ ...WET, v1St: st }, 'sine', 880);
      const cents = 1200 * Math.log2(centroid(x, want) / want);
      // At 880 Hz the window's own arithmetic allows about 16 cents, and this
      // is the check that the shift HAPPENED — a device that passed the audio
      // through would read the interval's own size, in the hundreds.
      assert(Math.abs(cents) < 30,
        `${st >= 0 ? '+' : ''}${st} semitones landed ${cents.toFixed(0)} cents from `
        + `${want.toFixed(0)} Hz`);
    }
  });

  await check('the pitch error is half the window rate, which is a law', async () => {
    // Not a tuning.  The splice makes the output periodic at the window, so
    // its spectrum is a comb at the window rate, and a tone between two lines
    // is carried by both — worst case half a spacing, which is a fixed number
    // of HERTZ.  What that is worth in cents is therefore a property of where
    // it lands, and that is the whole reason this technique has always been
    // poor on bass and fine on a voice.
    const measured: Array<{ hz: number; windowMs: number; cents: number }> = [];
    for (const f0 of [220, 880]) {
      for (const windowMs of [30, 90]) {
        const want = f0 * Math.pow(2, -12 / 12);
        const x = await through({ ...WET, v1St: -12, windowMs }, 'sine', f0);
        measured.push({
          hz: want, windowMs,
          cents: Math.abs(1200 * Math.log2(centroid(x, want) / want)),
        });
      }
    }
    for (const m of measured) {
      const allowed = harmonyErrorCents(m.hz, m.windowMs / 1000);
      assert(m.cents <= allowed * 1.6 + 5,
        `${m.hz.toFixed(0)} Hz at ${m.windowMs} ms was ${m.cents.toFixed(0)} cents out and the `
        + `law allows ${allowed.toFixed(0)}`);
    }
    // And the law has to BITE, or it is a formula nobody is held to: a low
    // note through a short window is out by more than a semitone.
    const low = measured.find((m) => m.hz < 200 && m.windowMs === 30)!;
    assert(low.cents > 100,
      `110 Hz through a 30 ms window was only ${low.cents.toFixed(0)} cents out — if that is `
      + 'now accurate, the Window control has nothing to trade and the law is wrong');
    // A longer window is better at the same note, which is the trade itself.
    const same = measured.filter((m) => m.hz < 200);
    assert(same[1]!.cents < same[0]!.cents,
      `90 ms was no better than 30 at 110 Hz — ${same[1]!.cents.toFixed(0)} against `
      + `${same[0]!.cents.toFixed(0)} cents`);
  });

  await check('a unison is transparent, and so is a spread of zero', async () => {
    // Both at once, because they are the same property: the two crossfade
    // windows sum to exactly one, and a centred voice is unity in both
    // channels.  An equal-power crossfade is 2.2 dB off at a unison and an
    // equal-power PAN is 3 dB off at the centre — measured, and both rejected
    // for it.
    const wet = await through({ ...WET, v1St: 0, v1Cents: 0, v2Db: -60 }, 'noise');
    const dry = await through({ ...WET, v1St: 0, mix: 0 }, 'noise');
    let worst = 0;
    for (let i = 3000; i < SR - 3000; i++) {
      worst = Math.max(worst, Math.abs((wet[i] ?? 0) - (dry[i] ?? 0)));
    }
    // The residue is the second voice, which rests at −60 dB rather than off.
    assert(worst < 2e-3,
      `a fully wet unison differs from the dry signal by ${worst.toExponential(2)}`);

    // And spread really does something, or "transparent at zero" is just
    // "does nothing".
    const wide = await through({ ...WET, v1St: 0, spread: 1 }, 'noise');
    let moved = 0;
    for (let i = 3000; i < SR - 3000; i++) {
      moved = Math.max(moved, Math.abs((wide[i] ?? 0) - (dry[i] ?? 0)));
    }
    assert(moved > 0.1,
      `full spread only moved the mono sum by ${moved.toExponential(2)} — width that costs `
      + 'nothing in mono is width that is not there');
  });

  await check('the level warbles, and a short window is where a sine suffers', async () => {
    // The cost, stated rather than hidden — and the first version of this
    // check stated it wrong.  "A sine is always worse than noise" was
    // measured at 30 and 50 ms windows, and at the 90 ms default it is not:
    // the sine reads 1.8 dB there against noise's 2.9.
    //
    // What is actually true is the comb explanation itself.  The splice puts
    // two copies of the signal against each other, so a single frequency sits
    // wherever it sits in that comb — sometimes in a null, which is luck, and
    // the comb gets coarser as the window gets shorter.  Broadband material
    // cannot be unlucky that way: a frequency in a null has a neighbour on a
    // peak, and the total barely moves.
    const worst = async (source: 'sine' | 'noise', windowMs: number): Promise<number> => {
      let out = 0;
      for (const st of [12, 7, 4, -5, -12]) {
        out = Math.max(out, rippleDb(await through({ ...WET, v1St: st, windowMs }, source)));
      }
      return out;
    };
    const sineShort = await worst('sine', 30);
    const noiseShort = await worst('noise', 30);
    const sineLong = await worst('sine', 90);
    const noiseLong = await worst('noise', 90);

    // Broadband is steady whatever the window — that is the case this
    // technique is meant to be usable in, and the number it is usable at.
    assert(noiseShort < 5 && noiseLong < 5,
      `broadband warbled ${noiseShort.toFixed(1)} dB at 30 ms and ${noiseLong.toFixed(1)} at 90 — `
      + 'this is supposed to be the case that works');
    // A sine through a short window is where the comb bites, and it bites
    // much harder than broadband does at the same setting.
    assert(sineShort > noiseShort * 1.5,
      `a sine through a 30 ms window warbled ${sineShort.toFixed(1)} dB against broadband's `
      + `${noiseShort.toFixed(1)} — if one frequency is no worse than all of them, the comb `
      + 'explanation is wrong');
    // And the default window is where it stops biting, which is part of why
    // the default is what it is.
    assert(sineLong < sineShort * 0.6,
      `the default window left a sine at ${sineLong.toFixed(1)} dB against ${sineShort.toFixed(1)} `
      + 'at 30 ms — a longer window is supposed to make the comb finer');
  });

  await check('shifting up shrinks the delay, and a wider interval sweeps further', () => {
    // The arithmetic the whole device rests on, checked where it is readable.
    assert(harmonySweepGain(harmonyRatio(12), 0.09) < 0, 'an octave up does not shrink the delay');
    assert(harmonySweepGain(harmonyRatio(-12), 0.09) > 0, 'an octave down does not grow it');
    assert(harmonySweepGain(harmonyRatio(0), 0.09) === 0, 'a unison sweeps at all');
    let previous = 0;
    for (const st of [1, 3, 5, 7, 12]) {
      const span = harmonySpanSec(harmonyRatio(st), 0.09);
      assert(span > previous, `${st} semitones sweeps ${span} against ${previous}`);
      previous = span;
    }
    // The base is the middle of the sweep, so the delay never goes negative
    // and never exceeds the span.
    for (const st of [12, -12, 5, -5]) {
      const ratio = harmonyRatio(st, 50 * Math.sign(st || 1));
      const span = harmonySpanSec(ratio, HARMONY_WINDOW_MAX_MS / 1000);
      const base = harmonyBaseSec(ratio, HARMONY_WINDOW_MAX_MS / 1000);
      assert(Math.abs(base - span / 2) < 1e-12, `${st}: the base is not the middle of the sweep`);
      assert(base + span / 2 <= harmonyMaxDelaySec(),
        `${st}: the delay reaches ${(base + span / 2).toFixed(4)} s and the line is built for `
        + `${harmonyMaxDelaySec().toFixed(4)} — Web Audio clamps past the maximum silently`);
    }
  });

  await check('the window the law asks for is the one it advises', () => {
    // `harmonyWindowForMs` is what the advisor uses, so it has to be the
    // inverse of the error it is aimed at rather than a table.
    for (const hz of [80, 200, 440, 2000]) {
      const ms = harmonyWindowForMs(hz, 25);
      if (ms < HARMONY_WINDOW_MAX_MS - 1e-9 && ms > HARMONY_WINDOW_MIN_MS + 1e-9) {
        const got = harmonyErrorCents(hz, ms / 1000);
        assert(Math.abs(got - 25) < 0.5,
          `asking for 25 cents at ${hz} Hz gave a window worth ${got.toFixed(1)}`);
      }
    }
    // A low note asks for more than the control has, which is the limit this
    // technique has and not a bug to round away.
    assert(harmonyWindowForMs(55, 25) === HARMONY_WINDOW_MAX_MS,
      '55 Hz can be held to 25 cents inside the window range — then the range is wrong');
    assert(harmonyErrorCents(55, HARMONY_WINDOW_MAX_MS / 1000) > 30,
      'the longest window now holds 55 Hz to under 30 cents, so the limit above is stale');
    // And a bright source does not need the longest window, or the control is
    // a formality.
    assert(harmonyWindowForMs(2000, 25) < 100,
      `2 kHz asked for ${harmonyWindowForMs(2000, 25).toFixed(0)} ms`);
  });

  await check('the modulators are samples, because an oscillator is not portable', () => {
    // The check for the bug that only driving the app found.  The pitch is a
    // SLOPE, and no oscillator's slope is the same in two renderers: Chromium
    // band-limits its sawtooth and normalises the result, which flattens the
    // straight part to 86 % of the ideal ramp, while node generates the naive
    // one.  Every interval came out compressed toward a unison by that 86 %,
    // and the offline suite could not see it because node was the exact one.
    //
    // So the modulators are buffers this file generates, and these are the
    // properties a buffer has that an oscillator does not promise.
    const frames = 480;
    // A Float32Array holds about seven digits, so the tolerances here are
    // 1e-6 rather than 1e-9: these are storage comparisons, not arithmetic.
    const EPS = 1e-6;
    const ramp = harmonyRampSamples(frames);
    assert(ramp.length === frames, 'the ramp is not one window long');
    assert(Math.abs(ramp[0]! - -1) < EPS, `the ramp starts at ${ramp[0]}, not -1`);
    assert(Math.abs(ramp[frames - 1]! - (1 - 2 / frames)) < EPS,
      'the ramp does not end one step short of +1 — a loop that repeated its own endpoint '
      + 'would stall for a sample every window');
    // The slope, which IS the pitch: constant, and exactly two over a window.
    let minStep = Infinity;
    let maxStep = -Infinity;
    for (let i = 1; i < frames; i++) {
      const step = ramp[i]! - ramp[i - 1]!;
      minStep = Math.min(minStep, step);
      maxStep = Math.max(maxStep, step);
    }
    assert(Math.abs(maxStep - minStep) < EPS,
      `the ramp's slope varies between ${minStep} and ${maxStep} — a band-limited sawtooth `
      + 'does exactly this, and the varying part is the pitch');
    assert(Math.abs(maxStep - 2 / frames) < EPS,
      `the slope is ${maxStep} where an ideal ramp over ${frames} frames is ${2 / frames} — `
      + 'a slope that is 86 % of this is a shift that is 86 % of the interval');

    // The crossfade: zero where the ramp jumps, and the two phases sum to one.
    const fade = harmonyFadeSamples(frames);
    assert(Math.abs(fade[0]! - -1) < EPS,
      `the crossfade is ${fade[0]} where the ramp jumps, and it has to be -1 — the gain there `
      + 'is 0.5 + 0.5 x that, which is zero');
    for (let i = 0; i < frames; i++) {
      const a = 0.5 + 0.5 * fade[i]!;
      const b = 0.5 + 0.5 * fade[(i + frames / 2) % frames]!;
      assert(Math.abs(a + b - 1) < EPS,
        `at frame ${i} the two windows sum to ${(a + b).toFixed(6)} — a unison is only `
        + 'transparent because they sum to exactly one');
    }
    // The window quantises to whole samples, or a looping buffer cannot hold it.
    assert(harmonyWindowSamples(0.09, 48_000) === 4320, 'the window does not land on samples');
    assert(harmonyWindowSamples(0.09, 44_100) === 3969, 'the window ignores the sample rate');
  });

  await check('the interval moves two parameters, so it is driven and not a lane', async () => {
    // A lane on the sweep alone would be a shifter whose sweep no longer fits
    // the delay it sweeps around — the delay would go negative at one end.
    const ctx = new OfflineAudioContext(1, 128, SR);
    const device = findPlugin('harmonizer')!;
    const instance = device.create(
      ctx as unknown as BaseAudioContext, defaultParams('harmonizer'),
    );
    assert(!(device.automatableParams ?? []).includes('v1St'),
      'the interval is offered as an insert lane, and one lane cannot move both');
    assert((device.drivenParams ?? []).includes('v1St'), 'the interval is not declared as driven');
    assert(instance.automatable?.('v1St') == null, 'the instance offers it as a single param');
    const driven = instance.drives?.('v1St') ?? [];
    // Two lines, two parameters each.
    assert(driven.length === 4,
      `the interval drives ${driven.length} parameters, and it is two delay lines of two`);
    for (const d of driven) {
      assert(typeof d.map === 'function', 'a driven parameter arrived without its mapping');
      assert(Number.isFinite(d.map!(7)), 'the mapping does not answer for a real interval');
    }
    // Unison maps both to zero, which is what makes a lane through it smooth
    // rather than a sign flip.
    for (const d of driven) {
      assert(Math.abs(d.map!(0)) < 1e-12, 'a unison does not map to a still delay line');
    }
    instance.dispose();
  });

  await check('the picture is the two sweeps, half a window apart', () => {
    const params = { ...defaultParams('harmonizer'), v1St: 7, windowMs: 90 };
    const picture = lfoPictureFor('harmonizer', params);
    assert(picture !== null, 'the harmoniser draws no picture');
    const [a, b] = picture!.traces;
    assert(a && b, 'it draws fewer than two sweeps');
    const windowSec = 0.09;
    // Half a window apart: what one trace does at t, the other does at t+T/2.
    let worst = 0;
    for (let t = 0.2 * windowSec; t < 1.2 * windowSec; t += windowSec / 64) {
      worst = Math.max(worst, Math.abs(a!.at(t) - b!.at(t + windowSec / 2)));
    }
    assert(worst < 1e-9,
      `the two sweeps are ${worst.toFixed(4)} ms apart at the half window — they are supposed to `
      + 'be the same ramp offset by exactly that');
    // And the range it draws is the span the device really sweeps.
    const span = harmonySpanSec(harmonyRatio(7), windowSec) * 1000;
    let lo = Infinity;
    let hi = -Infinity;
    for (let t = 0; t < windowSec; t += windowSec / 256) {
      lo = Math.min(lo, a!.at(t));
      hi = Math.max(hi, a!.at(t));
    }
    assert(Math.abs((hi - lo) - span) < span * 0.02,
      `it draws a ${(hi - lo).toFixed(2)} ms sweep where the device sweeps ${span.toFixed(2)}`);
    assert(picture!.caption.includes('90 ms') && picture!.caption.includes('+7'),
      `the caption does not say what it is drawing — ${picture!.caption}`);
    const unison = lfoPictureFor('harmonizer', { ...params, v1St: 0 })!;
    assert(unison.caption.includes('유니슨'),
      `a unison does not say it is not sweeping — ${unison.caption}`);
  });

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} passed${passed === results.length ? '' : `, ${results.length - passed} FAILED`}`);
  if (passed !== results.length) process.exit(1);
}

void main();
