/**
 * restore-selftest — Noise Reduction · De-click · De-hum · De-reverb · De-clip.
 *
 * The claims that matter:
 *
 *   A learned profile removes the noise it learned and leaves the music.
 *   Measured, not asserted: hiss added to a tone, then SNR before vs after.
 *
 *   The de-clicker can tell a click from a drum.  Both are sharp; only one is
 *   brief.  If the width test does not work, the repairer eats the drummer.
 *
 *   AR interpolation restores harmonics, not a smooth curve.  A gap punched
 *   into a rich waveform and filled must come back close to the original —
 *   which a cubic never manages.
 *
 *   De-hum removes the comb and not the bass.  A bass note sitting on a hum
 *   harmonic has to survive, or the tool is a liability.
 *
 *   De-reverb measures the room before it acts.  T60 is estimated from
 *   synthetic reverb with a known decay, and the tail then has to actually
 *   drop while the direct sound stays.
 *
 * Run: pnpm --filter @aimaster/desktop test:restore
 */

import {
  learnNoiseProfile, reduceNoise, reduceNoiseChannels, denoiseSpectrogram,
  frameGains, profileFloorDb, profileBands, MIN_PROFILE_FRAMES,
} from '../src/renderer/daw/audio/noise-reduction.js';
import {
  detectClicks, repairClicks, declick, declickChannels, secondDifference,
  lpcCoefficients, lpcFromSegments, interpolateGap,
} from '../src/renderer/daw/audio/declick.js';
import { stft, istft } from '../src/renderer/daw/audio/stft.js';
import {
  detectClipping, declip, declipChannels, clippingRatio, describeClipping,
} from '../src/renderer/daw/audio/declip.js';
import {
  detectHum, removeHum, removeHumChannels, describeHum, NOMINAL_HUM,
} from '../src/renderer/daw/audio/dehum.js';
import {
  estimateReverbTime, dereverb, dereverbChannels, describeReverb,
} from '../src/renderer/daw/audio/dereverb.js';

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
function close(a: number, b: number, m: string, tol = 1e-9): void {
  if (Math.abs(a - b) > tol) throw new Error(`${m} — got ${a}, want ${b} ±${tol}`);
}

const SR = 44100;

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5;
  };
}

function tone(hz: number, seconds: number, amp = 0.5, sampleRate = SR): Float32Array {
  const out = new Float32Array(Math.round(seconds * sampleRate));
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * hz * i) / sampleRate);
  return out;
}

/** A few harmonics — something an AR model can actually model. */
function rich(hz: number, seconds: number, amp = 0.4, sampleRate = SR): Float32Array {
  const out = new Float32Array(Math.round(seconds * sampleRate));
  for (let i = 0; i < out.length; i++) {
    const t = (2 * Math.PI * hz * i) / sampleRate;
    out[i] = amp * (Math.sin(t) + 0.5 * Math.sin(2 * t) + 0.25 * Math.sin(3 * t) + 0.12 * Math.sin(5 * t));
  }
  return out;
}

function hiss(length: number, amp: number, seed = 7): Float32Array {
  const out = new Float32Array(length);
  const random = rng(seed);
  for (let i = 0; i < length; i++) out[i] = amp * random() * 2;
  return out;
}

function mix(...parts: Float32Array[]): Float32Array {
  const length = Math.max(...parts.map((p) => p.length));
  const out = new Float32Array(length);
  for (const p of parts) for (let i = 0; i < p.length; i++) out[i] = (out[i] ?? 0) + (p[i] ?? 0);
  return out;
}

function rms(x: ArrayLike<number>, from = 0, to = x.length): number {
  let sum = 0;
  let n = 0;
  for (let i = Math.max(0, from); i < Math.min(x.length, to); i++) { sum += (x[i] ?? 0) ** 2; n++; }
  return n > 0 ? Math.sqrt(sum / n) : 0;
}

/** Goertzel — level at one frequency. */
function toneLevel(x: ArrayLike<number>, hz: number, sampleRate = SR): number {
  const n = x.length;
  if (n === 0) return 0;
  const coeff = 2 * Math.cos((2 * Math.PI * hz) / sampleRate);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < n; i++) {
    const s0 = (x[i] ?? 0) + coeff * s1 - s2;
    s2 = s1; s1 = s0;
  }
  return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - coeff * s1 * s2)) / (n / 2);
}

/** A decaying drum-like hit: sharp attack, but it rings for tens of ms. */
function drumHit(at: number, seconds: number, sampleRate = SR): Float32Array {
  const out = new Float32Array(Math.round(seconds * sampleRate));
  const start = Math.round(at * sampleRate);
  const random = rng(99);
  for (let i = 0; start + i < out.length; i++) {
    const env = Math.exp(-i / (0.03 * sampleRate));
    if (env < 1e-4) break;
    const body = Math.sin((2 * Math.PI * 180 * i) / sampleRate);
    out[start + i] = 0.7 * env * (body + 0.6 * random() * 2);
  }
  return out;
}

/** A click: one sample of discontinuity. */
function withClick(base: Float32Array, atSec: number, amplitude = 0.6, sampleRate = SR): Float32Array {
  const out = Float32Array.from(base);
  const index = Math.round(atSec * sampleRate);
  if (index < out.length) out[index] = (out[index] ?? 0) + amplitude;
  return out;
}

// ── Noise reduction ───────────────────────────────────────────────────────────

check('a profile needs a long enough region', () => {
  const noise = hiss(SR, 0.02);
  let threw = false;
  try { learnNoiseProfile(noise, SR, 0, 0.01); } catch { threw = true; }
  assert(threw, 'a 10 ms region is not a measurement');
  const profile = learnNoiseProfile(noise, SR, 0, 0.5);
  assert(profile.frames >= MIN_PROFILE_FRAMES, `learned ${profile.frames} frames`);
  close(profile.durationSec, 0.5, 'duration recorded', 1e-3);
  eq(profile.mean.length, profile.fftSize / 2 + 1, 'one value per bin');
});

check('the profile measures the noise floor it was given', () => {
  const quiet = learnNoiseProfile(hiss(SR, 0.01, 1), SR, 0, 1);
  const loud = learnNoiseProfile(hiss(SR, 0.1, 1), SR, 0, 1);
  const delta = profileFloorDb(loud) - profileFloorDb(quiet);
  close(delta, 20, '10× the noise reads 20 dB higher', 0.5);
  eq(profileBands(quiet, 8).length, 8, 'band summary');
  for (const band of profileBands(quiet, 8)) {
    assert(band.db < 0 && band.db > -120, `band level out of range: ${band.db}`);
  }
});

check('denoising raises the signal-to-noise ratio of a hissy tone', () => {
  // 0.5 s of hiss only, then hiss + a 440 Hz tone.
  const noiseOnly = hiss(Math.round(0.5 * SR), 0.02, 3);
  const music = mix(tone(440, 1.5, 0.25), hiss(Math.round(1.5 * SR), 0.02, 5));
  const dirty = new Float32Array(noiseOnly.length + music.length);
  dirty.set(noiseOnly, 0);
  dirty.set(music, noiseOnly.length);

  const profile = learnNoiseProfile(dirty, SR, 0.05, 0.45);
  const clean = reduceNoise(dirty, SR, profile, { reductionDb: 18 });

  const from = noiseOnly.length + Math.round(0.2 * SR);
  const to = noiseOnly.length + Math.round(1.2 * SR);
  const toneBefore = toneLevel(dirty.subarray(from, to), 440);
  const toneAfter = toneLevel(clean.subarray(from, to), 440);

  // Noise measured where there is no music at all.
  const noiseBefore = rms(dirty, Math.round(0.1 * SR), Math.round(0.4 * SR));
  const noiseAfter = rms(clean, Math.round(0.1 * SR), Math.round(0.4 * SR));

  const snrBefore = 20 * Math.log10(toneBefore / noiseBefore);
  const snrAfter = 20 * Math.log10(toneAfter / noiseAfter);
  assert(snrAfter > snrBefore + 8, `SNR ${snrBefore.toFixed(1)} → ${snrAfter.toFixed(1)} dB`);
  // The tone itself must survive: it is far above the noise threshold.
  assert(toneAfter > toneBefore * 0.7, `the tone lost too much: ${toneBefore} → ${toneAfter}`);
});

check('more reduction removes more noise, monotonically', () => {
  const noise = hiss(Math.round(1.5 * SR), 0.02, 11);
  const profile = learnNoiseProfile(noise, SR, 0.1, 0.6);
  const levels = [6, 12, 24].map((db) =>
    rms(reduceNoise(noise, SR, profile, { reductionDb: db }), Math.round(0.8 * SR), Math.round(1.2 * SR)));
  assert((levels[0] ?? 0) > (levels[1] ?? 0), `6 dB should leave more than 12: ${levels[0]} vs ${levels[1]}`);
  assert((levels[1] ?? 0) > (levels[2] ?? 0), `12 dB should leave more than 24: ${levels[1]} vs ${levels[2]}`);
  const floor = rms(noise, Math.round(0.8 * SR), Math.round(1.2 * SR));
  assert((levels[2] ?? 0) < floor * 0.2, `24 dB should get most of it: ${levels[2]} vs ${floor}`);
});

check('the residual is what was taken out', () => {
  const noise = hiss(Math.round(1.2 * SR), 0.02, 13);
  const signal = mix(tone(660, 1.2, 0.3), noise);
  const profile = learnNoiseProfile(noise, SR, 0.1, 0.7);
  const clean = reduceNoise(signal, SR, profile, { reductionDb: 18 });
  const residual = reduceNoise(signal, SR, profile, { reductionDb: 18, output: 'residual' });

  // clean + residual reconstructs the input, because the two gains sum to 1.
  let worst = 0;
  const from = Math.round(0.3 * SR);
  const to = Math.round(0.9 * SR);
  for (let i = from; i < to; i++) {
    worst = Math.max(worst, Math.abs(((clean[i] ?? 0) + (residual[i] ?? 0)) - (signal[i] ?? 0)));
  }
  assert(worst < 1e-4, `clean + residual should rebuild the input, worst ${worst}`);
  // And the residual should be mostly noise, not the tone.
  assert(toneLevel(residual.subarray(from, to), 660) < toneLevel(signal.subarray(from, to), 660) * 0.35,
    'the tone should stay out of the residual');
});

check('gain smoothing across bins is what it says', () => {
  // The profile is learned from ONE realisation of the hiss and applied to
  // ANOTHER at the same level — so every bin sits right at its threshold and
  // the raw gains flap up and down.  That is the musical-noise mechanism.
  const learned = hiss(Math.round(1.0 * SR), 0.02, 17);
  const other = hiss(Math.round(1.0 * SR), 0.02, 18);
  const profile = learnNoiseProfile(learned, SR, 0.1, 0.7);
  const spec = stft(other, SR, { fftSize: profile.fftSize, hopSize: profile.hopSize });
  const frame = spec.frames[Math.floor(spec.frames.length / 2)]!;

  const rough = frameGains(frame, profile, { bandSmoothing: 0 });
  const smooth = frameGains(frame, profile, { bandSmoothing: 4 });
  // Musical noise is isolated bins flipping up and down, so the metric is how
  // many times the curve turns around — not its total variation, which a
  // moving average leaves untouched across a monotone edge.
  const turns = (g: Float32Array): number => {
    let count = 0;
    for (let i = 1; i + 1 < g.length; i++) {
      const a = (g[i] ?? 0) - (g[i - 1] ?? 0);
      const b = (g[i + 1] ?? 0) - (g[i] ?? 0);
      if (a > 1e-6 && b < -1e-6) count++;
      else if (a < -1e-6 && b > 1e-6) count++;
    }
    return count;
  };
  assert(turns(smooth) < turns(rough) * 0.5,
    `smoothing should stop the gain curve flapping: ${turns(rough)} → ${turns(smooth)}`);
  for (const g of [rough, smooth]) {
    for (let i = 0; i < g.length; i++) {
      assert((g[i] ?? 0) >= 0 && (g[i] ?? 0) <= 1, `gain out of range at ${i}: ${g[i]}`);
    }
  }
});

check('denoising a silent-noise-free signal changes almost nothing', () => {
  // Profile learned from near-silence: there is nothing to subtract.
  const quiet = hiss(Math.round(1.0 * SR), 1e-6, 23);
  const profile = learnNoiseProfile(quiet, SR, 0.1, 0.8);
  const music = tone(440, 1.0, 0.4);
  const clean = reduceNoise(music, SR, profile, { reductionDb: 18 });
  const from = Math.round(0.3 * SR);
  const to = Math.round(0.7 * SR);
  close(toneLevel(clean.subarray(from, to), 440), toneLevel(music.subarray(from, to), 440),
    'the tone is untouched', 0.01);
});

check('stereo channels share one profile', () => {
  const noise = hiss(Math.round(1.0 * SR), 0.02, 29);
  const profile = learnNoiseProfile(noise, SR, 0.1, 0.8);
  const left = mix(tone(440, 1.0, 0.3), noise);
  const [a, b] = reduceNoiseChannels([left, left], SR, profile, { reductionDb: 12 });
  assert(!!a && !!b, 'two channels back');
  for (let i = 0; i < a!.length; i += 251) close(a![i] ?? 0, b![i] ?? 0, 'identical input, identical output', 1e-9);
});

check('denoiseSpectrogram works on a spectrogram the caller already has', () => {
  const noise = hiss(Math.round(1.0 * SR), 0.02, 31);
  const profile = learnNoiseProfile(noise, SR, 0.1, 0.8);
  const spec = stft(noise, SR, { fftSize: profile.fftSize, hopSize: profile.hopSize });
  denoiseSpectrogram(spec, profile, { reductionDb: 24 });
  const out = istft(spec);
  assert(rms(out, Math.round(0.4 * SR), Math.round(0.6 * SR)) < rms(noise, Math.round(0.4 * SR), Math.round(0.6 * SR)) * 0.3,
    'in-place denoise reduces the floor');
});

// ── De-click ──────────────────────────────────────────────────────────────────

check('the second difference is near zero for smooth audio', () => {
  const smooth = tone(440, 0.1, 0.5);
  const clicked = withClick(smooth, 0.05, 0.6);
  const a = secondDifference(smooth);
  const b = secondDifference(clicked);
  let peakA = 0;
  let peakB = 0;
  for (let i = 0; i < a.length; i++) peakA = Math.max(peakA, a[i] ?? 0);
  for (let i = 0; i < b.length; i++) peakB = Math.max(peakB, b[i] ?? 0);
  assert(peakB > peakA * 50, `a click should dominate: ${peakA} vs ${peakB}`);
});

check('clicks are found where they were put', () => {
  const times = [0.2, 0.5, 0.8];
  let signal = tone(440, 1.2, 0.4);
  for (const t of times) signal = withClick(signal, t, 0.5);

  const clicks = detectClicks(signal, SR);
  eq(clicks.length, 3, `found ${clicks.length}`);
  clicks.forEach((c, i) => {
    assert(Math.abs(c.startSec - (times[i] ?? 0)) < 0.002,
      `click ${i} at ${c.startSec.toFixed(4)}, expected ${times[i]}`);
    assert(c.strength > 8, `weak detection: ${c.strength}`);
  });
  eq(detectClicks(tone(440, 1.2, 0.4), SR).length, 0, 'clean audio has no clicks');
});

check('a drum hit is sharp but not brief — it is not a click', () => {
  const drums = mix(drumHit(0.3, 1.0), drumHit(0.7, 1.0));
  eq(detectClicks(drums, SR).length, 0, 'the width test must reject musical attacks');

  // And a click sitting on top of the drums is still found.
  const withOne = withClick(drums, 0.5, 0.6);
  const found = detectClicks(withOne, SR);
  eq(found.length, 1, `expected exactly the click, got ${found.length}`);
  assert(Math.abs((found[0]?.startSec ?? 0) - 0.5) < 0.002, 'at the right place');
});

check('LPC finds the structure of a periodic signal', () => {
  const a = lpcCoefficients(rich(220, 0.05), 24);
  eq(a.length, 25, 'order + 1 coefficients');
  assert(a.every((v) => Number.isFinite(v)), 'all finite');
  // Prediction error must be far below the signal itself.
  const frame = rich(220, 0.05);
  let error = 0;
  let energy = 0;
  for (let n = 24; n < frame.length; n++) {
    let predicted = 0;
    for (let k = 1; k <= 24; k++) predicted += (a[k] ?? 0) * (frame[n - k] ?? 0);
    error += ((frame[n] ?? 0) - predicted) ** 2;
    energy += (frame[n] ?? 0) ** 2;
  }
  assert(error / energy < 0.01, `prediction error ratio ${error / energy}`);
  // A silent frame has no model to find.
  const silent = lpcCoefficients(new Float32Array(512), 16);
  assert(silent.every((v) => v === 0), 'silence returns a null model');
});

/** Cubic Hermite across a gap — the naive repair, for comparison. */
function cubicFill(samples: Float32Array, gapStart: number, gapLength: number): void {
  const before = gapStart - 1;
  const after = gapStart + gapLength;
  const p0 = samples[before] ?? 0;
  const p1 = samples[after] ?? 0;
  const m0 = p0 - (samples[before - 1] ?? p0);
  const m1 = (samples[after + 1] ?? p1) - p1;
  for (let i = 0; i < gapLength; i++) {
    const t = (i + 1) / (gapLength + 1);
    const t2 = t * t;
    const t3 = t2 * t;
    samples[gapStart + i] = (2 * t3 - 3 * t2 + 1) * p0 + (t3 - 2 * t2 + t) * m0
      + (-2 * t3 + 3 * t2) * p1 + (t3 - t2) * m1;
  }
}

function gapError(
  original: Float32Array, filled: Float32Array, gapStart: number, gapLength: number,
): { error: number; energy: number } {
  let error = 0;
  let energy = 0;
  for (let i = 0; i < gapLength; i++) {
    const truth = original[gapStart + i] ?? 0;
    error += ((filled[gapStart + i] ?? 0) - truth) ** 2;
    energy += truth * truth;
  }
  return { error, energy };
}

check('AR interpolation reconstructs a realistic click gap', () => {
  const original = rich(220, 0.5);
  const gapStart = Math.round(0.25 * SR);
  const gapLength = 32;                              // 0.7 ms — a typical click

  const damaged = Float32Array.from(original);
  for (let i = 0; i < gapLength; i++) damaged[gapStart + i] = 0;

  const repaired = Float32Array.from(damaged);
  interpolateGap(repaired, gapStart, gapLength, { order: 32 });

  const fixed = gapError(original, repaired, gapStart, gapLength);
  const hole = gapError(original, damaged, gapStart, gapLength);
  const ratio = fixed.error / fixed.energy;
  // ~1 % of the gap's energy: inaudible, and two orders of magnitude better
  // than leaving the hole there.
  assert(ratio < 0.02, `interpolation error ${(ratio * 100).toFixed(2)} % of the original energy`);
  assert(fixed.error < hole.error * 0.02, 'the repair must beat leaving the hole');
});

check('AR interpolation restores harmonics a cubic flattens', () => {
  // 2.2 ms is a long gap — nearly half a period of the fundamental is missing,
  // which is where a smooth curve gives up and a model still has something to
  // say.
  const original = rich(220, 0.5);
  const gapStart = Math.round(0.25 * SR);
  const gapLength = 96;

  const damaged = Float32Array.from(original);
  for (let i = 0; i < gapLength; i++) damaged[gapStart + i] = 0;

  const modelled = Float32Array.from(damaged);
  interpolateGap(modelled, gapStart, gapLength, { order: 32 });
  const cubic = Float32Array.from(damaged);
  cubicFill(cubic, gapStart, gapLength);

  const ar = gapError(original, modelled, gapStart, gapLength);
  const smooth = gapError(original, cubic, gapStart, gapLength);
  assert(ar.error < smooth.error * 0.35,
    `AR ${(100 * ar.error / ar.energy).toFixed(1)} % vs cubic ${(100 * smooth.error / smooth.energy).toFixed(1)} %`);

  // The third harmonic is the part a smooth curve cannot produce at all.
  const at = (x: Float32Array): number =>
    toneLevel(x.subarray(gapStart - 300, gapStart + gapLength + 300), 660);
  const truth = at(original);
  assert(Math.abs(at(modelled) - truth) < Math.abs(at(cubic) - truth),
    'the model should track the third harmonic more closely than the cubic');
});

check('a short context starves the model, and the default does not', () => {
  // The context window is the parameter that decides the result — it has to
  // span several periods of the fundamental.
  const original = rich(220, 0.5);
  const gapStart = Math.round(0.25 * SR);
  const gapLength = 40;
  const errorWith = (contextFactor: number): number => {
    const damaged = Float32Array.from(original);
    for (let i = 0; i < gapLength; i++) damaged[gapStart + i] = 0;
    interpolateGap(damaged, gapStart, gapLength, { order: 32, contextFactor });
    const e = gapError(original, damaged, gapStart, gapLength);
    return e.error / e.energy;
  };
  const starved = errorWith(4);
  const generous = errorWith(32);
  assert(generous < starved * 0.35,
    `context should dominate: ${(starved * 100).toFixed(2)} % → ${(generous * 100).toFixed(2)} %`);
  assert(generous < 0.03, `the default context should stay under 3 %, got ${(generous * 100).toFixed(2)} %`);
});

check('interpolation near a buffer edge falls back instead of failing', () => {
  const signal = rich(220, 0.05);
  const near = Float32Array.from(signal);
  interpolateGap(near, 3, 8, { order: 32 });
  assert(near.every((v) => Number.isFinite(v)), 'no NaNs at the start of the buffer');
  const end = Float32Array.from(signal);
  interpolateGap(end, signal.length - 12, 8, { order: 32 });
  assert(end.every((v) => Number.isFinite(v)), 'no NaNs at the end');
  const zero = Float32Array.from(signal);
  interpolateGap(zero, 1000, 0, {});
  for (let i = 0; i < signal.length; i += 97) eq(zero[i], signal[i], 'a zero-length gap is a no-op');
});

check('declick removes the clicks and leaves the music', () => {
  const music = rich(220, 1.0);
  let dirty = Float32Array.from(music);
  for (const t of [0.25, 0.5, 0.75]) dirty = withClick(dirty, t, 0.7);

  const before = detectClicks(dirty, SR);
  eq(before.length, 3, 'three to fix');

  const result = declick(dirty, SR);
  eq(result.detected, 3, 'detected');
  eq(result.repaired, 3, 'repaired');
  eq(detectClicks(result.samples, SR).length, 0, 'and none are left');

  // The music either side of the repairs is untouched, and the fundamental
  // survives the repairs themselves.
  close(toneLevel(result.samples, 220), toneLevel(music, 220), 'fundamental intact', 0.01);
  let worst = 0;
  for (let i = 0; i < Math.round(0.2 * SR); i++) {
    worst = Math.max(worst, Math.abs((result.samples[i] ?? 0) - (music[i] ?? 0)));
  }
  assert(worst < 1e-6, `audio away from a click must not move, worst ${worst}`);
});

check('a gap longer than the limit is skipped, not smeared', () => {
  const music = rich(220, 0.5);
  const long = [{ startSec: 0.2, endSec: 0.25, strength: 99 }];       // 50 ms
  const result = repairClicks(music, SR, long, { maxGapMs: 10 });
  eq(result.repaired, 0, 'nothing repaired');
  eq(result.skipped, 1, 'and it said so');
  for (let i = 0; i < music.length; i += 331) eq(result.samples[i], music[i], 'audio untouched');
});

check('stereo declick uses one detection pass', () => {
  const music = rich(220, 0.8);
  const left = withClick(music, 0.4, 0.7);
  const right = withClick(Float32Array.from(music), 0.4, 0.5);
  const result = declickChannels([left, right], SR);
  eq(result.detected, 1, 'one click, found once');
  eq(result.channels.length, 2, 'two channels back');
  for (const ch of result.channels) {
    eq(detectClicks(ch, SR).length, 0, 'each channel is clean');
  }
});

// ── De-hum ────────────────────────────────────────────────────────────────────

/** Mains hum: a fundamental plus a decaying harmonic comb. */
function hum(f0: number, seconds: number, amp = 0.02, harmonics = 8, sampleRate = SR): Float32Array {
  const out = new Float32Array(Math.round(seconds * sampleRate));
  for (let k = 1; k <= harmonics; k++) {
    const hz = f0 * k;
    if (hz >= sampleRate / 2) break;
    const level = amp / k;
    const phase = k * 0.7;
    for (let i = 0; i < out.length; i++) {
      out[i] = (out[i] ?? 0) + level * Math.sin((2 * Math.PI * hz * i) / sampleRate + phase);
    }
  }
  return out;
}

check('hum is detected and its exact frequency measured', () => {
  const signal = mix(hum(50, 3), tone(440, 3, 0.2));
  const found = detectHum(signal, SR);
  assert(found !== null, 'no hum detected');
  eq(found!.nominal, 50, 'matched the 50 Hz standard');
  // Mains drifts, so the detector refines the peak rather than trusting 50.
  assert(Math.abs(found!.f0 - 50) < 1.5, `f0 measured at ${found!.f0.toFixed(2)} Hz`);
  assert(found!.harmonics.length >= 4, `found ${found!.harmonics.length} harmonics`);
  assert(found!.confidence > 0.35, `confidence ${found!.confidence}`);
  assert(describeHum(found).includes('50 Hz'), 'describes itself');
  eq(describeHum(null), '험이 검출되지 않았습니다', 'and says so when there is none');
});

check('60 Hz hum is told apart from 50 Hz hum', () => {
  const sixty = detectHum(mix(hum(60, 3), tone(440, 3, 0.2)), SR);
  assert(sixty !== null, 'no hum detected');
  eq(sixty!.nominal, 60, 'matched the 60 Hz standard');
  assert(Math.abs(sixty!.f0 - 60) < 1.5, `f0 ${sixty!.f0.toFixed(2)}`);
  eq(NOMINAL_HUM.length, 2, 'two mains standards considered');
});

check('clean music is not accused of humming', () => {
  eq(detectHum(tone(440, 3, 0.4), SR), null, 'a clean tone has no comb');
  eq(detectHum(hiss(Math.round(3 * SR), 0.05, 41), SR), null, 'noise has no comb either');
});

check('a sustained bass note is not mistaken for hum', () => {
  // A 50 Hz bass note for a third of the take: harmonics yes, stationary no.
  const length = Math.round(3 * SR);
  const bass = new Float32Array(length);
  const from = Math.round(1.0 * SR);
  const to = Math.round(1.8 * SR);
  for (let i = from; i < to; i++) {
    const t = (2 * Math.PI * 50 * i) / SR;
    bass[i] = 0.25 * (Math.sin(t) + 0.5 * Math.sin(2 * t) + 0.3 * Math.sin(3 * t));
  }
  const found = detectHum(mix(bass, tone(440, 3, 0.15)), SR);
  assert(found === null, `a note that stops is not hum (confidence ${found?.confidence})`);
});

check('removing hum leaves the music standing', () => {
  const music = tone(440, 3, 0.3);
  const dirty = mix(hum(50, 3, 0.03), music);
  const found = detectHum(dirty, SR);
  assert(found !== null, 'detected');

  const cleaned = removeHum(dirty, SR, found!, { reductionDb: 30 });
  const from = Math.round(1.0 * SR);
  const to = Math.round(2.0 * SR);

  const before = toneLevel(dirty.subarray(from, to), 50);
  const after = toneLevel(cleaned.subarray(from, to), 50);
  assert(after < before * 0.2, `fundamental ${before.toFixed(5)} → ${after.toFixed(5)}`);

  const h3before = toneLevel(dirty.subarray(from, to), 150);
  const h3after = toneLevel(cleaned.subarray(from, to), 150);
  assert(h3after < h3before * 0.35, `third harmonic ${h3before.toFixed(5)} → ${h3after.toFixed(5)}`);

  close(toneLevel(cleaned.subarray(from, to), 440), toneLevel(music.subarray(from, to), 440),
    'the music is untouched', 0.01);
});

check('a bass note on a hum harmonic survives the notch', () => {
  // 100 Hz hum harmonic runs the whole take; a 100 Hz note plays in the middle.
  const length = Math.round(3 * SR);
  const note = new Float32Array(length);
  const from = Math.round(1.2 * SR);
  const to = Math.round(2.0 * SR);
  for (let i = from; i < to; i++) note[i] = 0.3 * Math.sin((2 * Math.PI * 100 * i) / SR);

  const dirty = mix(hum(50, 3, 0.03), note, tone(440, 3, 0.2));
  const found = detectHum(dirty, SR);
  assert(found !== null, 'detected');
  const cleaned = removeHum(dirty, SR, found!, { reductionDb: 30 });

  // Quiet stretch: only hum lives at 100 Hz, so it should be gone.
  const quietFrom = Math.round(0.3 * SR);
  const quietTo = Math.round(0.9 * SR);
  const humBefore = toneLevel(dirty.subarray(quietFrom, quietTo), 100);
  const humAfter = toneLevel(cleaned.subarray(quietFrom, quietTo), 100);
  assert(humAfter < humBefore * 0.35, `hum at 100 Hz ${humBefore.toFixed(5)} → ${humAfter.toFixed(5)}`);

  // The note is far above the persistent level, so it comes through.
  const noteBefore = toneLevel(dirty.subarray(from + 4000, to - 4000), 100);
  const noteAfter = toneLevel(cleaned.subarray(from + 4000, to - 4000), 100);
  assert(noteAfter > noteBefore * 0.8,
    `the bass note must survive: ${noteBefore.toFixed(4)} → ${noteAfter.toFixed(4)}`);
});

check('hum removal is per-channel identical and can be limited', () => {
  const dirty = mix(hum(50, 3, 0.03), tone(440, 3, 0.2));
  const found = detectHum(dirty, SR)!;
  const [a, b] = removeHumChannels([dirty, dirty], SR, found, { reductionDb: 24 });
  for (let i = 0; i < (a?.length ?? 0); i += 511) close(a![i] ?? 0, b![i] ?? 0, 'channels agree', 1e-9);

  // Limiting to the fundamental leaves the upper harmonics alone.
  const onlyFirst = removeHum(dirty, SR, found, { reductionDb: 30, maxHarmonics: 1 });
  const from = Math.round(1.0 * SR);
  const to = Math.round(2.0 * SR);
  assert(toneLevel(onlyFirst.subarray(from, to), 50) < toneLevel(dirty.subarray(from, to), 50) * 0.3,
    'the fundamental still goes');
  close(toneLevel(onlyFirst.subarray(from, to), 150), toneLevel(dirty.subarray(from, to), 150),
    'the third harmonic is left alone', 0.002);
});

// ── De-reverb ─────────────────────────────────────────────────────────────────

/**
 * Synthetic room: a sparse tapped delay line whose taps decay exponentially
 * with a KNOWN T60.  Cheaper than convolving a full impulse response, and the
 * decay is exact, which is what the estimator is being measured against.
 */
function reverberate(dry: Float32Array, t60: number, sampleRate = SR): Float32Array {
  const tail = Math.round(t60 * sampleRate);
  const out = new Float32Array(dry.length + tail);
  out.set(dry, 0);
  const random = rng(4242);
  const decay = (3 * Math.LN10) / t60;
  // Taps ~1 ms apart: dense enough that the tail decays smoothly instead of
  // fluttering, which is what a real room does and what the model assumes.
  for (let delaySec = 0.004; delaySec < t60; delaySec += 0.0008 + 0.0006 * (random() + 0.5)) {
    const offset = Math.round(delaySec * sampleRate);
    const gain = 0.35 * Math.exp(-decay * delaySec) * (random() > 0 ? 1 : -1);
    for (let i = 0; i < dry.length; i++) {
      const index = i + offset;
      if (index >= out.length) break;
      out[index] = (out[index] ?? 0) + gain * (dry[i] ?? 0);
    }
  }
  return out;
}

/**
 * A struck note: fast attack, 60 ms decay.  Percussive on purpose — a
 * sustained tone satisfies the reverb model itself, so it is the one source
 * this method is documented NOT to suit.
 */
function pluck(hz: number, atSec: number, totalSec: number, sampleRate = SR): Float32Array {
  const out = new Float32Array(Math.round(totalSec * sampleRate));
  const start = Math.round(atSec * sampleRate);
  for (let i = 0; start + i < out.length; i++) {
    const env = Math.exp(-i / (0.06 * sampleRate));
    if (env < 1e-4) break;
    const attack = Math.min(1, i / (0.001 * sampleRate));
    out[start + i] = 0.6 * env * attack * Math.sin((2 * Math.PI * hz * i) / sampleRate);
  }
  return out;
}

check('T60 is measured from a room with a known decay', () => {
  const dry = mix(pluck(440, 0.1, 3.0), pluck(440, 1.2, 3.0));
  const wet = reverberate(dry, 0.8);
  const estimate = estimateReverbTime(wet, SR);
  assert(estimate !== null, 'nothing measured');
  assert(Math.abs(estimate!.t60 - 0.8) < 0.32,
    `T60 measured at ${estimate!.t60.toFixed(2)} s, room was 0.80 s`);
  assert(estimate!.segments >= 1, 'at least one decay segment');
  assert(describeReverb(estimate).includes('T60'), 'describes itself');
  eq(describeReverb(null), '자유 감쇠 구간이 없어 잔향 시간을 잴 수 없습니다', 'and says so when it cannot');
});

check('a longer room measures longer', () => {
  const dry = mix(pluck(440, 0.1, 4.0), pluck(440, 1.6, 4.0));
  const shortRoom = estimateReverbTime(reverberate(dry, 0.4), SR);
  const longRoom = estimateReverbTime(reverberate(dry, 1.2), SR);
  assert(shortRoom !== null && longRoom !== null, 'both measured');
  assert(longRoom!.t60 > shortRoom!.t60 * 1.5,
    `${shortRoom!.t60.toFixed(2)} s vs ${longRoom!.t60.toFixed(2)} s`);
});

check('de-reverb drops the tail and keeps the attack', () => {
  const dry = pluck(440, 0.2, 2.5);
  const wet = reverberate(dry, 0.8);
  const cleaned = dereverb(wet, SR, 0.8, { strength: 1.5, reductionDb: 24 });

  // The struck note itself: the first 60 ms.
  const noteFrom = Math.round(0.2 * SR);
  const noteTo = Math.round(0.26 * SR);
  const noteDropDb = 20 * Math.log10(rms(cleaned, noteFrom, noteTo) / rms(wet, noteFrom, noteTo));

  // The tail, long after the note has died.
  const tailFrom = Math.round(0.7 * SR);
  const tailTo = Math.round(1.1 * SR);
  const tailDropDb = 20 * Math.log10(rms(cleaned, tailFrom, tailTo) / rms(wet, tailFrom, tailTo));

  assert(tailDropDb < -9, `the tail should fall: ${tailDropDb.toFixed(1)} dB`);
  assert(noteDropDb > -2, `the attack should stay: ${noteDropDb.toFixed(1)} dB`);
  assert(tailDropDb < noteDropDb - 7,
    `the tail must lose far more than the note: ${tailDropDb.toFixed(1)} vs ${noteDropDb.toFixed(1)} dB`);
});

check('more strength removes more tail', () => {
  const wet = reverberate(pluck(440, 0.2, 2.5), 0.8);
  const from = Math.round(0.7 * SR);
  const to = Math.round(1.1 * SR);
  const levels = [0, 1, 2].map((strength) =>
    rms(dereverb(wet, SR, 0.8, { strength, reductionDb: 30 }), from, to));
  assert((levels[0] ?? 0) > (levels[1] ?? 0), `0 should leave more than 1: ${levels[0]} vs ${levels[1]}`);
  assert((levels[1] ?? 0) > (levels[2] ?? 0), `1 should leave more than 2: ${levels[1]} vs ${levels[2]}`);
  // Strength 0 is a no-op, so the round trip has to be transparent.
  close(levels[0] ?? 0, rms(wet, from, to), 'strength 0 changes nothing', 1e-4);
});

check('the de-reverb residual is the tail it took out', () => {
  const wet = reverberate(pluck(440, 0.2, 2.5), 0.8);
  const residual = dereverb(wet, SR, 0.8, { strength: 1.5, reductionDb: 24, output: 'residual' });
  const clean = dereverb(wet, SR, 0.8, { strength: 1.5, reductionDb: 24 });
  const tailFrom = Math.round(0.7 * SR);
  const tailTo = Math.round(1.1 * SR);
  assert(rms(residual, tailFrom, tailTo) > rms(clean, tailFrom, tailTo),
    'the residual should hold more tail than the cleaned version');
  const noteFrom = Math.round(0.2 * SR);
  const noteTo = Math.round(0.26 * SR);
  assert(rms(residual, noteFrom, noteTo) < rms(clean, noteFrom, noteTo),
    'and less of the direct attack');
});

check('stereo de-reverb is applied per channel', () => {
  const wet = reverberate(pluck(440, 0.2, 1.5), 0.6);
  const [a, b] = dereverbChannels([wet, wet], SR, 0.6, { strength: 1 });
  assert(!!a && !!b, 'two channels back');
  for (let i = 0; i < a!.length; i += 397) close(a![i] ?? 0, b![i] ?? 0, 'identical in, identical out', 1e-9);
});

// ── De-clip ───────────────────────────────────────────────────────────────────

/** Clip a signal by squashing everything above `ceiling` flat. */
function clipTo(x: Float32Array, ceiling: number): Float32Array {
  return Float32Array.from(x, (v) => Math.max(-ceiling, Math.min(ceiling, v)));
}

check('a sine that touches full scale is not clipping', () => {
  // Exactly one sample per cycle sits at the peak — that is a peak, not a
  // flat top, and treating it as damage would invent a bigger one.
  const peaked = tone(440, 0.2, 1.0);
  eq(detectClipping(peaked, SR).length, 0, 'no runs found');
  eq(describeClipping([], SR), '클리핑된 구간이 없습니다', 'and it says so');
});

check('flat tops are found, with their sign', () => {
  const clipped = clipTo(tone(220, 0.2, 1.4), 1.0);
  const runs = detectClipping(clipped, SR);
  assert(runs.length >= 8, `expected a run per half cycle, found ${runs.length}`);
  assert(runs.some((r) => r.sign > 0) && runs.some((r) => r.sign < 0), 'both polarities');
  for (const run of runs) assert(run.to > run.from, 'runs have length');
  assert(clippingRatio(clipped) > 0.1, `a heavily clipped signal reads high: ${clippingRatio(clipped)}`);
  close(clippingRatio(tone(440, 0.1, 0.5)), 0, 'and a clean one reads zero', 1e-9);
});

/** Squared error against the truth — the whole buffer, so nothing hides. */
function deviation(x: Float32Array, truth: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < truth.length; i++) sum += ((x[i] ?? 0) - (truth[i] ?? 0)) ** 2;
  return sum;
}

check('de-clip rebuilds the peaks the ceiling removed', () => {
  const original = rich(220, 0.4, 0.9);          // true peak ≈ 1.18
  const clipped = clipTo(original, 1.0);

  const runs = detectClipping(clipped, SR);
  assert(runs.length > 100, `every loud cycle has a flat top, found ${runs.length}`);

  const result = declip(clipped, SR, { normalise: false });
  eq(result.repaired, runs.length, 'every run was rebuilt');

  let truePeak = 0;
  for (let i = 0; i < original.length; i++) truePeak = Math.max(truePeak, Math.abs(original[i] ?? 0));
  assert(Math.abs(result.restoredPeak - truePeak) < 0.04,
    `the peak came back: ${result.restoredPeak.toFixed(3)} vs ${truePeak.toFixed(3)}`);

  const remaining = deviation(result.samples, original) / deviation(clipped, original);
  assert(remaining < 0.1,
    `${(remaining * 100).toFixed(1)} % of the damage remains — the shape was restored`);
});

check('extra passes matter when every cycle is damaged', () => {
  // De-clipping differs from de-clicking here: clipping is PERIODIC, so the
  // first pass fits its model to context that is itself still clipped.
  const original = rich(220, 0.3, 1.1);          // hammered — a third of the peak gone
  const clipped = clipTo(original, 1.0);
  const one = declip(clipped, SR, { normalise: false, passes: 1 });
  const four = declip(clipped, SR, { normalise: false, passes: 4 });

  const base = deviation(clipped, original);
  const after1 = deviation(one.samples, original) / base;
  const after4 = deviation(four.samples, original) / base;
  assert(after4 < after1 * 0.6,
    `passes help on heavy clipping: ${(after1 * 100).toFixed(0)} % → ${(after4 * 100).toFixed(0)} %`);
  assert(four.restoredPeak > one.restoredPeak, 'and the peak keeps coming back');
});

check('the reconstruction is allowed past full scale, then everything is scaled', () => {
  const clipped = clipTo(rich(220, 0.4, 1.6), 1.0);
  const free = declip(clipped, SR, { normalise: false });
  assert(free.restoredPeak > 1.0, `unconstrained, the peaks exceed 1: ${free.restoredPeak.toFixed(3)}`);

  const fitted = declip(clipped, SR, { normalise: true, headroomDb: 0.3 });
  let peak = 0;
  for (let i = 0; i < fitted.samples.length; i++) {
    peak = Math.max(peak, Math.abs(fitted.samples[i] ?? 0));
  }
  assert(peak <= Math.pow(10, -0.3 / 20) + 1e-6, `fitted under the ceiling: ${peak.toFixed(4)}`);
  assert(fitted.appliedGainDb < 0, 'and it reports the gain it had to apply');
});

check('a run longer than the limit is left alone', () => {
  const flat = new Float32Array(Math.round(0.2 * SR));
  const from = Math.round(0.05 * SR);
  const to = Math.round(0.15 * SR);        // 100 ms of solid ceiling
  for (let i = 0; i < flat.length; i++) flat[i] = i >= from && i < to ? 1 : 0.2;
  const result = declip(flat, SR, { maxRunMs: 10, normalise: false });
  eq(result.repaired, 0, 'nothing rebuilt');
  for (let i = from + 10; i < to - 10; i += 100) {
    close(result.samples[i] ?? 0, 1, 'the audio is untouched', 1e-6);
  }
});

check('stereo de-clip applies ONE gain to both channels', () => {
  // Both channels are clipped, at different moments — which is what a real
  // clipped stereo file looks like.
  const left = clipTo(rich(220, 0.3, 1.5), 1.0);
  const right = clipTo(rich(330, 0.3, 1.3), 1.0);

  const raw = declipChannels([left, right], SR, { normalise: false });
  const fitted = declipChannels([left, right], SR, { normalise: true });
  assert(fitted.repaired > 0, 'repaired');
  assert(fitted.appliedGainDb < 0, 'and it had to come down');

  // A per-channel normalise would change the balance between them; a stereo
  // image is a ratio and a de-clipper has no business moving it.
  const gainOf = (index: number): number => {
    const before = raw.channels[index]!;
    const after = fitted.channels[index]!;
    let ratio = 1;
    for (let i = 1000; i < before.length - 1000; i++) {
      if (Math.abs(before[i] ?? 0) > 0.2) { ratio = (after[i] ?? 0) / (before[i] ?? 1); break; }
    }
    return ratio;
  };
  close(gainOf(0), gainOf(1), 'both channels were scaled by the same factor', 1e-6);
});

check('clean audio passes through de-clip unchanged', () => {
  const clean = rich(220, 0.3, 0.5);
  const result = declip(clean, SR);
  eq(result.repaired, 0, 'nothing to do');
  close(result.appliedGainDb, 0, 'and no gain applied', 1e-12);
  for (let i = 0; i < clean.length; i += 97) eq(result.samples[i], clean[i], 'samples untouched');
});

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log('\n=== Restoration: Noise · Click · Hum · Reverb · Clip ===');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
if (failed > 0) process.exit(1);
