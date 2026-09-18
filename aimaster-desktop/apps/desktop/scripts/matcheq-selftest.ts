/**
 * matcheq-selftest — whether matching a reference actually closes the gap.
 *
 * The device's one claim is end to end and so is the check that matters:
 * take a reference, take a mix that is audibly not it, run the match, and the
 * mix's spectrum has to end up CLOSER to the reference than it started.
 * Everything else here is about the three controls that decide how much of
 * that difference to believe.
 *
 *   · the match closes a known gap, measured through the rendered device
 *   · Amount scales it, Limit clamps it, Smooth separates tonality from the
 *     arrangement — each measured on what it does to the curve
 *   · an unmeasured curve is exactly unity, so an un-matched device in a
 *     chain is not a device doing something small
 *   · it declares its latency and its Mix blends rather than combs
 *   · advice never deletes a measurement, which it would have by default
 *
 * Run: pnpm --filter @aimaster/desktop test:matcheq
 */

import { OfflineAudioContext } from 'node-web-audio-api';

(globalThis as unknown as { OfflineAudioContext: unknown }).OfflineAudioContext = OfflineAudioContext;

import { defaultParams, findPlugin } from '../src/renderer/daw/engine/plugins.js';
import { knobParams } from '../src/renderer/daw/engine/plugin-kit.js';
import {
  MATCH_BANDS, MATCH_HZ, matchApplied, matchBandId, matchCurve, matchFeatureHz,
  matchLatency, matchMagnitudeAt, matchShapeDb, matchStored,
} from '../src/renderer/daw/engine/match-eq.js';
import {
  LINPHASE_LENGTHS, linphaseResolutionHz,
} from '../src/renderer/daw/engine/linear-phase.js';
import { averageSpectrum } from '../src/renderer/daw/analysis/reference.js';
import { filterPictureFor } from '../src/renderer/daw/model/plugin-shapes.js';
import { adviseFor } from '../src/renderer/daw/ai/plugin-advice.js';
import { profileBuffer } from '../src/renderer/daw/ai/source-profile.js';

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

/** Deterministic wideband noise — every band has something in it to compare. */
function noise(n: number, seed = 12_345): Float32Array {
  const out = new Float32Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    out[i] = ((s / 0x7fffffff) * 2 - 1) * 0.25;
  }
  return out;
}

/** Noise through a chain of biquads, rendered — a source with a known colour. */
async function coloured(
  specs: ReadonlyArray<{ type: BiquadFilterType; hz: number; gain: number; q: number }>,
  seconds = 3,
): Promise<Float32Array> {
  const n = Math.round(SR * seconds);
  const ctx = new OfflineAudioContext(1, n, SR);
  const buffer = ctx.createBuffer(1, n, SR);
  buffer.getChannelData(0).set(noise(n));
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  let cursor: AudioNode = src;
  for (const spec of specs) {
    const f = ctx.createBiquadFilter();
    f.type = spec.type;
    f.frequency.value = spec.hz;
    f.gain.value = spec.gain;
    f.Q.value = spec.q;
    cursor.connect(f);
    cursor = f;
  }
  cursor.connect(ctx.destination as unknown as AudioNode);
  src.start(0);
  return (await ctx.startRendering()).getChannelData(0) as Float32Array;
}

/** A signal through the match EQ, rendered. */
async function throughDevice(
  input: Float32Array, params: Record<string, number>,
): Promise<Float32Array> {
  const ctx = new OfflineAudioContext(1, input.length, SR);
  const buffer = ctx.createBuffer(1, input.length, SR);
  buffer.getChannelData(0).set(input);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const device = findPlugin('matcheq')!.create(
    ctx as unknown as BaseAudioContext, { ...defaultParams('matcheq'), ...params },
  );
  src.connect(device.input);
  device.output.connect(ctx.destination as unknown as AudioNode);
  src.start(0);
  return (await ctx.startRendering()).getChannelData(0) as Float32Array;
}

/** RMS distance between two level-normalised spectra, in dB. */
function spectralDistance(a: Float32Array, b: Float32Array): number {
  const sa = averageSpectrum(a, SR, { bandCount: MATCH_BANDS, minHz: 25, maxHz: 20_000 });
  const sb = averageSpectrum(b, SR, { bandCount: MATCH_BANDS, minHz: 25, maxHz: 20_000 });
  let sum = 0;
  for (let i = 0; i < MATCH_BANDS; i++) sum += ((sa.db[i] ?? 0) - (sb.db[i] ?? 0)) ** 2;
  return Math.sqrt(sum / MATCH_BANDS);
}

function curveParams(curve: readonly number[]): Record<string, number> {
  const out: Record<string, number> = {};
  curve.forEach((v, b) => { out[matchBandId(b)] = v; });
  return out;
}

async function main(): Promise<void> {
  // A reference that is bright and light, and a mix that is dark and heavy —
  // about 9 dB apart across the spectrum, which is a gap nobody would argue
  // about by ear.
  const reference = await coloured([
    { type: 'highshelf', hz: 4000, gain: 5, q: 0.707 },
    { type: 'lowshelf', hz: 150, gain: -4, q: 0.707 },
  ]);
  const mix = await coloured([
    { type: 'highshelf', hz: 4000, gain: -4, q: 0.707 },
    { type: 'lowshelf', hz: 150, gain: 5, q: 0.707 },
  ]);
  const opts = { bandCount: MATCH_BANDS, minHz: 25, maxHz: 20_000 };
  const measured = matchCurve(
    averageSpectrum(reference, SR, opts), averageSpectrum(mix, SR, opts),
  );

  await check('the match closes a gap that was really there', async () => {
    const before = spectralDistance(mix, reference);
    assert(before > 3, `the two sources are only ${before.toFixed(2)} dB apart to begin with`);

    // Everything the controls can give: the whole curve, barely smoothed, with
    // room to move.  This is the ceiling of what the device can do, and it is
    // the number the Amount control is a fraction of.
    const matched = await throughDevice(mix, {
      ...curveParams(measured), amount: 1, smoothOct: 0.2, limitDb: 18, length: 0,
    });
    const after = spectralDistance(matched, reference);
    assert(after < before * 0.35,
      `the gap went from ${before.toFixed(2)} dB to ${after.toFixed(2)} dB — a match that leaves `
      + 'two thirds of the difference is not a match');
  });

  await check('Amount is the fraction of the difference it takes', async () => {
    // Measured on the rendered audio rather than on the curve, because the
    // claim is about what comes out.
    const before = spectralDistance(mix, reference);
    const at = async (amount: number): Promise<number> => spectralDistance(
      await throughDevice(mix, {
        ...curveParams(measured), amount, smoothOct: 0.2, limitDb: 18, length: 0,
      }),
      reference,
    );
    const none = await at(0);
    const half = await at(0.5);
    const all = await at(1);
    assert(Math.abs(none - before) < 0.05,
      `Amount at zero changed the spectrum by ${(none - before).toFixed(3)} dB`);
    assert(half < none && all < half,
      `the gap does not shrink as Amount rises — ${none.toFixed(2)} → ${half.toFixed(2)} `
      + `→ ${all.toFixed(2)} dB`);
    // And half of the curve leaves about half of the gap, which is what makes
    // the control a fraction rather than a switch.
    const closed = (none - half) / Math.max(1e-9, none - all);
    assert(closed > 0.35 && closed < 0.65,
      `half the Amount closed ${(closed * 100).toFixed(0)}% of the gap, not about half`);
  });

  await check('Limit is a ceiling on belief, not a scaling', () => {
    // A reference with a sub the mix does not have asks for twenty decibels
    // at 30 Hz.  That is not an EQ move, and the difference between clamping
    // and scaling is that clamping leaves the rest of the curve alone.
    const steep = measured.map((_v, b) => (b < 4 ? 20 : 2));
    const applied = matchShapeDb(steep, { amount: 1, smoothOct: 0, limitDb: 6 });
    for (let b = 0; b < 4; b++) {
      assert(Math.abs((applied[b] ?? 0) - 6) < 1e-6,
        `band ${b} asked for 20 dB and came out at ${(applied[b] ?? 0).toFixed(2)}`);
    }
    for (let b = 8; b < MATCH_BANDS; b++) {
      assert(Math.abs((applied[b] ?? 0) - 2) < 1e-6,
        `band ${b} only asked for 2 dB and the limit moved it to ${(applied[b] ?? 0).toFixed(2)} `
        + '— a limit that scales the whole curve is a second Amount knob');
    }
  });

  await check('Smooth separates the tonality from the arrangement', () => {
    // One band standing alone is a note, not a tonal balance; a broad tilt is
    // the opposite.  Smoothing has to flatten the first and keep the second,
    // and the measurement is exactly that pair.
    const spike = Array.from({ length: MATCH_BANDS }, (_v, b) => (b === 16 ? 10 : 0));
    const tilt = Array.from({ length: MATCH_BANDS }, (_v, b) => -5 + (10 * b) / (MATCH_BANDS - 1));
    const shape = { amount: 1, limitDb: 18 };

    const spikeRaw = matchShapeDb(spike, { ...shape, smoothOct: 0 })[16] ?? 0;
    const spikeSmooth = matchShapeDb(spike, { ...shape, smoothOct: 1 })[16] ?? 0;
    assert(spikeRaw > 9 && spikeSmooth < 4,
      `one band went from ${spikeRaw.toFixed(1)} to ${spikeSmooth.toFixed(1)} dB under an `
      + 'octave of smoothing — it is supposed to be mostly gone');

    let worst = 0;
    const tiltSmooth = matchShapeDb(tilt, { ...shape, smoothOct: 1 });
    for (let b = 4; b < MATCH_BANDS - 4; b++) {
      worst = Math.max(worst, Math.abs((tiltSmooth[b] ?? 0) - (tilt[b] ?? 0)));
    }
    assert(worst < 0.6,
      `the same smoothing moved a broad tilt by ${worst.toFixed(2)} dB — it is supposed to pass `
      + 'through untouched, or Smooth is just a depth control');
  });

  await check('an unmeasured curve is exactly unity', async () => {
    // The state this device ships in.  A match EQ that coloured the signal
    // before anything was measured would be the least forgivable of all.
    // Sample by sample against the input delayed by what the device declares,
    // not spectrum against spectrum: the device IS late, so a spectral
    // comparison of the two ends up measuring the missing 127 samples at the
    // edges (0.015 dB of it) rather than measuring the filter.
    const out = await throughDevice(mix, {});
    const late = matchLatency(defaultParams('matcheq'));
    let worst = 0;
    for (let i = 2000; i < mix.length - 2000 - late; i++) {
      worst = Math.max(worst, Math.abs((out[i + late] ?? 0) - (mix[i] ?? 0)));
    }
    assert(worst < 1e-4,
      `with no curve measured the device still changed the signal by ${worst.toExponential(2)}`);
    for (const v of matchApplied(defaultParams('matcheq'))) {
      assert(v === 0, `the applied curve is not flat at rest — ${v}`);
    }
  });

  await check('it declares what it is late by, and Mix blends', async () => {
    const params = { ...defaultParams('matcheq'), ...curveParams(measured), length: 1 };
    const declared = findPlugin('matcheq')!.latencyFor(params, SR);
    assert(declared === matchLatency(params) && declared === 511,
      `it declares ${declared} and half its response is ${matchLatency(params)}`);

    // An impulse, and where the middle of the response lands.
    const impulse = new Float32Array(16_384);
    impulse[0] = 1;
    const out = await throughDevice(impulse, { ...curveParams(measured), length: 1, mix: 1 });
    let at = 0;
    let peak = 0;
    for (let i = 0; i < out.length; i++) {
      if (Math.abs(out[i]!) > peak) { peak = Math.abs(out[i]!); at = i; }
    }
    assert(at === declared, `the response peaks at ${at} and the device declares ${declared}`);

    // And the dry side is delayed to match, so Mix is a blend.  Measured as a
    // sum: the half-wet render has to be the average of the two ends.
    const dry = await throughDevice(mix, { ...curveParams(measured), length: 1, mix: 0 });
    const wet = await throughDevice(mix, { ...curveParams(measured), length: 1, mix: 1 });
    const half = await throughDevice(mix, { ...curveParams(measured), length: 1, mix: 0.5 });
    let worst = 0;
    for (let i = 4000; i < mix.length - 4000; i++) {
      worst = Math.max(worst, Math.abs((half[i] ?? 0) - 0.5 * ((dry[i] ?? 0) + (wet[i] ?? 0))));
    }
    assert(worst < 1e-3,
      `half wet is ${worst.toExponential(2)} away from the average of the two sides — the dry `
      + 'path is not aligned with the wet one');
  });

  await check('the picture is the curve the device applies', () => {
    const params = {
      ...defaultParams('matcheq'), ...curveParams(measured),
      amount: 0.6, smoothOct: 0.7, limitDb: 5,
    };
    const picture = filterPictureFor('matcheq', params);
    assert(picture !== null, 'the match EQ draws no picture');
    const applied = picture!.curves.find((c) => c.label === '적용');
    assert(applied?.dbAt !== undefined, 'the applied curve is not drawn as a sampled curve');
    const truth = matchApplied(params);
    let worst = 0;
    for (const hz of MATCH_HZ) {
      worst = Math.max(worst, Math.abs(applied!.dbAt!(hz) - matchMagnitudeAt(truth, hz)));
    }
    assert(worst < 1e-9, `the drawn curve is ${worst.toExponential(2)} dB from the applied one`);

    // Both curves, because the gap between them IS the three controls.
    assert(picture!.curves.length === 2, 'the measurement is not drawn beside what is applied');
    const raw = picture!.curves.find((c) => c.label === '측정')!;
    let spread = 0;
    for (const hz of MATCH_HZ) spread = Math.max(spread, Math.abs(raw.dbAt!(hz) - applied!.dbAt!(hz)));
    assert(spread > 1,
      `the measured and applied curves differ by only ${spread.toFixed(2)} dB — with Amount at `
      + '0.6 and a 5 dB limit they are supposed to be visibly apart');

    // And with nothing measured there is one curve and the caption says so.
    const empty = filterPictureFor('matcheq', defaultParams('matcheq'))!;
    assert(empty.curves.length === 1, 'an unmeasured device draws a measurement it does not have');
    assert(empty.caption.includes('레퍼런스'), `the caption hides it — ${empty.caption}`);
  });

  await check('advice shapes the match and never deletes it', () => {
    // `adviseFor` fills every parameter it was not given from the DEFAULT,
    // which for this device would zero a measured curve — advice that quietly
    // destroys the thing it is advising about.
    const profile = profileBuffer({
      sampleRate: SR, length: mix.length, numberOfChannels: 1,
      getChannelData: () => mix,
    } as never);
    const held = curveParams(measured);
    const result = adviseFor('matcheq', profile, held);
    assert(result.ok, `the advisor refused — ${result.ok ? '' : result.reason}`);
    if (!result.ok) return;
    const kept = matchStored(result.advice.params);
    let worstBand = 0;
    let worstDelta = 0;
    for (let b = 0; b < MATCH_BANDS; b++) {
      const delta = Math.abs(kept[b]! - measured[b]!);
      if (delta > worstDelta) { worstDelta = delta; worstBand = b; }
    }
    assert(worstDelta < 1e-6,
      `band ${worstBand} (${Math.round(MATCH_HZ[worstBand]!)} Hz) was `
      + `${measured[worstBand]!.toFixed(2)} dB and came back ${kept[worstBand]!.toFixed(2)} — `
      + 'the advice overwrote the measurement');
    assert(result.advice.params['amount']! < 1,
      'the advice matches the reference exactly, which makes a worse copy of it');

    // With nothing held, the curve stays at rest rather than being invented.
    const fresh = adviseFor('matcheq', profile);
    assert(fresh.ok && matchStored(fresh.advice.params).every((v) => v === 0),
      'the advisor invented a curve out of a source it was never given a reference for');
  });

  await check('Resolution earns its default, and the short one is not enough', async () => {
    // Written first as "a match curve is broad, so the shortest response
    // holds it".  It does not: a band is 0.31 octaves, which at 785 Hz is
    // 164 Hz wide, and 255 taps only build features down to 1478 Hz.  The two
    // only cross around 7 kHz, so the short response is too coarse for the
    // curve across nearly the whole band.
    const shortest = LINPHASE_LENGTHS[0]!.taps;
    const holds = linphaseResolutionHz(shortest, SR);
    const crossing = MATCH_HZ.find((hz) => matchFeatureHz(hz, 0) > holds) ?? Infinity;
    assert(crossing > 5000,
      `the shortest response already holds the curve from ${Math.round(crossing)} Hz up — if it `
      + 'reaches down into the midrange, the longer lengths are dead weight here');

    // And the consequence, measured end to end rather than argued: the middle
    // length closes a third more of the same gap.
    const closure = async (length: number): Promise<number> => spectralDistance(
      await throughDevice(mix, {
        ...curveParams(measured), amount: 1, smoothOct: 0.5, limitDb: 18, length,
      }),
      reference,
    );
    const short = await closure(0);
    const middle = await closure(1);
    const long = await closure(2);
    assert(middle < short * 0.85,
      `the middle length closed ${middle.toFixed(2)} dB against the short one's ${short.toFixed(2)} `
      + '— if they are level, the default should be the short one and the delay saved');
    assert(long > middle * 0.85,
      `the longest length closed ${long.toFixed(2)} against ${middle.toFixed(2)} — that is worth `
      + 'four times the delay, so the default is wrong');
    assert(findPlugin('matcheq')!.params.find((p) => p.id === 'length')!.default === 1,
      'the device does not default to the length this measurement chose');
  });

  await check('Smooth has a best value, and more is not better', async () => {
    // The other half of the same table, and the reason Smooth defaults to a
    // half octave rather than to as much as possible: past a point it is no
    // longer removing the arrangement, it is removing the tonality too.
    const closure = async (smoothOct: number): Promise<number> => spectralDistance(
      await throughDevice(mix, {
        ...curveParams(measured), amount: 1, smoothOct, limitDb: 18, length: 1,
      }),
      reference,
    );
    const little = await closure(0.2);
    const half = await closure(0.5);
    const lots = await closure(1);
    assert(lots > half,
      `an octave of smoothing closed ${lots.toFixed(2)} dB against half an octave's `
      + `${half.toFixed(2)} — if more smoothing is always better, the control has no top`);
    assert(half <= little + 0.01,
      `half an octave closed ${half.toFixed(2)} against ${little.toFixed(2)} at a fifth — the `
      + 'default is supposed to be at least as good as barely smoothing at all');
  });

  await check('the stored curve is not thirty-two knobs', () => {
    const descriptor = findPlugin('matcheq')!;
    const knobs = knobParams(descriptor.params);
    assert(knobs.length === 6,
      `the panel would show ${knobs.length} controls — ${knobs.map((k) => k.id).join(', ')}`);
    assert(descriptor.params.length === 6 + MATCH_BANDS,
      `the device stores ${descriptor.params.length - 6} bands, not ${MATCH_BANDS}`);
    for (const def of descriptor.params) {
      if (!def.curve) continue;
      assert(def.default === 0, `${def.id} rests at ${def.default}, so an untouched device is not unity`);
    }
  });

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} passed${passed === results.length ? '' : `, ${results.length - passed} FAILED`}`);
  if (passed !== results.length) process.exit(1);
}

void main();
