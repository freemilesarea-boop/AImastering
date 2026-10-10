/**
 * linphase-selftest — whether the linear-phase EQ's phase is actually linear.
 *
 * Every other EQ in this rack is biquads, and a biquad cannot move a
 * magnitude without moving the phase with it.  This device exists to do the
 * first without the second, which is one claim and it is measurable: the
 * group delay has to be the SAME at every frequency, and it has to be the
 * number the device declares, or the delay compensation puts the track in
 * the wrong place.
 *
 * What is measured here, in order of what would be worst to get wrong:
 *
 *   · the phase is linear, and eq8 making the same magnitude is not
 *   · the device is late by exactly half its response, and says so
 *   · the magnitude is the curve the editor drags and the picture draws
 *   · length buys detail and pays in delay, with the numbers
 *   · it PRE-RINGS, which is the cost of all of the above and is not hidden
 *
 * Run: pnpm --filter @aimaster/desktop test:linphase
 */

import { OfflineAudioContext } from 'node-web-audio-api';

(globalThis as unknown as { OfflineAudioContext: unknown }).OfflineAudioContext = OfflineAudioContext;

import { defaultParams, findPlugin } from '../src/renderer/daw/engine/plugins.js';
import {
  LINPHASE_LENGTHS, LINPHASE_LENGTH_NOTES, designLinearPhase, firMagnitudeDb,
  linphaseImpulse, linphaseLatency, linphaseResolutionHz, linphaseSpecs,
} from '../src/renderer/daw/engine/linear-phase.js';
import { chainMagnitudeDb } from '../src/renderer/daw/model/plugin-curves.js';
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

const CURVE: Record<string, number> = {
  lowDb: 4, lowHz: 120, b1Db: -5, b1Hz: 400, b1Q: 1.4,
  b2Db: 3, b2Hz: 3000, b2Q: 1, highDb: 2, highHz: 8000,
};

/** An impulse through a device, so magnitude AND phase are both available. */
async function impulseThrough(
  id: string, over: Record<string, number>, frames = 16_384,
): Promise<Float32Array> {
  const ctx = new OfflineAudioContext(1, frames, SR);
  const buffer = ctx.createBuffer(1, frames, SR);
  buffer.getChannelData(0)[0] = 1;
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const device = findPlugin(id)!.create(
    ctx as unknown as BaseAudioContext, { ...defaultParams(id), ...over },
  );
  src.connect(device.input);
  device.output.connect(ctx.destination as unknown as AudioNode);
  src.start(0);
  return (await ctx.startRendering()).getChannelData(0) as Float32Array;
}

/** The response of a recorded impulse, as magnitude and unwrapped phase. */
function response(h: Float32Array, hz: number): { db: number; phase: number } {
  let re = 0;
  let im = 0;
  for (let k = 0; k < h.length; k++) {
    const w = (2 * Math.PI * hz * k) / SR;
    re += h[k]! * Math.cos(w);
    im -= h[k]! * Math.sin(w);
  }
  return { db: 20 * Math.log10(Math.max(1e-12, Math.hypot(re, im))), phase: Math.atan2(im, re) };
}

/**
 * Group delay in samples, from the phase slope between two near frequencies.
 *
 * −dφ/dω, differenced rather than differentiated, and the difference is taken
 * small enough that the phase cannot wrap between the two points.
 */
function groupDelay(h: Float32Array, hz: number): number {
  const d = 2;
  const a = response(h, hz - d).phase;
  const b = response(h, hz + d).phase;
  let dphi = b - a;
  while (dphi > Math.PI) dphi -= 2 * Math.PI;
  while (dphi < -Math.PI) dphi += 2 * Math.PI;
  return -dphi / ((2 * Math.PI * (2 * d)) / SR);
}

async function main(): Promise<void> {
  await check('the phase is linear, and the same curve in biquads is not', async () => {
    // The whole claim, and it is one number per frequency: group delay.  A
    // linear phase is a constant group delay by definition, so "linear phase"
    // and "every frequency arrives together" are the same statement.
    const lin = await impulseThrough('linphase', { ...CURVE, length: 1 });
    const want = linphaseLatency({ ...defaultParams('linphase'), ...CURVE, length: 1 });
    let worst = 0;
    for (const hz of [80, 150, 300, 400, 700, 1500, 3000, 6000, 10_000]) {
      worst = Math.max(worst, Math.abs(groupDelay(lin, hz) - want));
    }
    assert(worst < 1.5,
      `group delay wanders by ${worst.toFixed(2)} samples across the band — it is supposed `
      + `to be ${want} at every frequency`);

    // And the comparison that makes the number mean something: eq8, set to
    // the same bands, moves its group delay by whole milliseconds.
    const iir = await impulseThrough('eq8', {
      lowDb: 4, lowHz: 120, b1Db: -5, b1Hz: 400, b1Q: 1.4,
      b2Db: 3, b2Hz: 3000, b2Q: 1, highDb: 2, highHz: 8000,
    });
    let min = Infinity;
    let max = -Infinity;
    for (const hz of [80, 150, 300, 400, 700, 1500, 3000, 6000, 10_000]) {
      const g = groupDelay(iir, hz);
      min = Math.min(min, g);
      max = Math.max(max, g);
    }
    assert(max - min > 20,
      `the biquad EQ's group delay only moved ${(max - min).toFixed(1)} samples — if a `
      + 'cascade of biquads is now phase-linear, this device has no reason to exist');
  });

  await check('it is late by exactly half its response, and declares that', async () => {
    for (const { taps } of LINPHASE_LENGTHS) {
      const h = await impulseThrough('linphase', { ...CURVE, length: LINPHASE_LENGTHS.findIndex((l) => l.taps === taps) }, 16_384);
      let at = 0;
      let peak = 0;
      for (let i = 0; i < h.length; i++) {
        if (Math.abs(h[i]!) > peak) { peak = Math.abs(h[i]!); at = i; }
      }
      const declared = findPlugin('linphase')!.latencyFor(
        { ...defaultParams('linphase'), ...CURVE, length: LINPHASE_LENGTHS.findIndex((l) => l.taps === taps) },
        SR,
      );
      assert(declared === (taps - 1) / 2,
        `${taps} taps declares ${declared}, and half of it is ${(taps - 1) / 2}`);
      assert(at === declared,
        `${taps} taps: the response peaks at ${at} and the device declares ${declared} — `
        + 'the convolver is adding latency of its own');
    }
  });

  await check('with the controls at zero it is exactly unity', async () => {
    // Not "close to unity".  A flat target is a single impulse, the window
    // weight at the centre of a Blackman is exactly 1, and anything else here
    // would mean the designer is leaking.
    const h = await impulseThrough('linphase', {});
    for (const hz of [30, 100, 440, 1000, 5000, 15_000]) {
      const db = response(h, hz).db;
      assert(Math.abs(db) < 0.01, `${hz} Hz reads ${db.toFixed(4)} dB with every band at zero`);
    }
  });

  await check('the filter is the curve the editor drags', async () => {
    // One description, three consumers: the handles, the picture and the FIR.
    // A linear-phase EQ that drew one curve and convolved another would look
    // right, which is the worst way to be wrong.
    const params = { ...defaultParams('linphase'), ...CURVE, length: 2 };
    const specs = linphaseSpecs(params);
    const h = await impulseThrough('linphase', { ...CURVE, length: 2 }, 32_768);
    let worst = 0;
    for (const hz of [60, 120, 250, 400, 800, 1500, 3000, 6000, 12_000]) {
      worst = Math.max(worst, Math.abs(response(h, hz).db - chainMagnitudeDb(specs, hz, SR)));
    }
    assert(worst < 0.15,
      `the rendered response is ${worst.toFixed(3)} dB from the curve the editor shows`);
  });

  await check('length buys detail and pays in delay, and the numbers are real', () => {
    // The Resolution control is a trade or it is three arbitrary numbers, so
    // both halves are measured here.
    //
    // The DELAY is arithmetic: half the response.  The RESOLUTION is the rate
    // over the length, and what it means is that a band NARROWER than that
    // cannot be built — so the way to measure it is to ask for one and see
    // how much of it arrives.
    // 150 Hz wide, which the longest length resolves (91 Hz) and the other
    // two do not (368 and 1492) — so both halves of the claim below are live.
    const BAND_HZ = 150;
    const narrow = {
      ...defaultParams('linphase'),
      b1Db: 12, b1Hz: 1000, b1Q: 1000 / BAND_HZ,
    };
    const specs = linphaseSpecs(narrow);
    const wanted = chainMagnitudeDb(specs, 1000, SR);
    assert(wanted > 11, `the test's own band only asks for ${wanted.toFixed(1)} dB`);

    const got = LINPHASE_LENGTHS.map(({ taps }) => {
      const h = designLinearPhase((hz) => chainMagnitudeDb(specs, Math.max(1, hz), SR), taps, SR);
      return firMagnitudeDb(h, 1000, SR);
    });

    // Monotonic: every step up in length gets closer to the band asked for.
    for (let i = 1; i < got.length; i++) {
      assert(got[i]! > got[i - 1]!,
        `${LINPHASE_LENGTHS[i]!.taps} taps builds no more of the band than `
        + `${LINPHASE_LENGTHS[i - 1]!.taps}: ${got[i]!.toFixed(2)} against ${got[i - 1]!.toFixed(2)} dB`);
    }

    // And the claim the picker makes is the one that holds: a length whose
    // resolution is COARSER than the band is wide loses part of it, and one
    // finer than it builds the whole thing to within half a decibel.  That is
    // what "builds a band down to N Hz wide" means, and it is the number the
    // Resolution notes print.
    LINPHASE_LENGTHS.forEach((l, i) => {
      const resolves = linphaseResolutionHz(l.taps, SR) < BAND_HZ;
      const built = got[i]!;
      if (resolves) {
        assert(wanted - built < 0.5,
          `${l.taps} taps resolves ${linphaseResolutionHz(l.taps, SR).toFixed(0)} Hz, finer than `
          + `the ${BAND_HZ} Hz band, and still only built ${built.toFixed(1)} of `
          + `${wanted.toFixed(1)} dB — the advertised resolution is optimistic`);
      } else {
        assert(wanted - built > 1,
          `${l.taps} taps only resolves ${linphaseResolutionHz(l.taps, SR).toFixed(0)} Hz and `
          + `built ${built.toFixed(1)} of ${wanted.toFixed(1)} dB anyway — if a response can hold `
          + 'detail finer than its own length, this control has nothing to trade');
      }
    });

    // The delay is exactly half, and the notes say so in milliseconds.
    LINPHASE_LENGTHS.forEach((l, i) => {
      const note = LINPHASE_LENGTH_NOTES[i]!;
      assert(note.includes(`${l.taps}탭`), `the note does not name the length — ${note}`);
      assert(note.includes(`${((l.taps - 1) / 2 / 48_000 * 1000).toFixed(1)} ms`),
        `the note does not say what it costs — ${note}`);
      assert(note.includes(`${linphaseResolutionHz(l.taps).toFixed(0)} Hz`),
        `the note does not say what it buys — ${note}`);
    });
  });

  await check('it pre-rings, and the ringing is the mirror of the ring-out', async () => {
    // The cost of a symmetric response, stated rather than left as folklore.
    // A steep cut is what provokes it, so this is measured with one.
    const h = await impulseThrough('linphase', { hpfHz: 120, length: 2 }, 32_768);
    const centre = linphaseLatency({ ...defaultParams('linphase'), hpfHz: 120, length: 2 });
    let before = 0;
    let after = 0;
    for (let i = 1; i < centre; i++) {
      before += (h[centre - i] ?? 0) ** 2;
      after += (h[centre + i] ?? 0) ** 2;
    }
    assert(before > 1e-9, 'nothing arrives before the centre — this is not a symmetric response');
    const ratioDb = 10 * Math.log10(before / Math.max(1e-30, after));
    assert(Math.abs(ratioDb) < 0.5,
      `there is ${ratioDb.toFixed(2)} dB more energy on one side of the centre than the other `
      + '— a zero-phase response is even, so the two halves are the same energy');

    // And the comparison: a biquad high-pass puts nothing at all in front.
    const iir = await impulseThrough('eq8', { hpfHz: 120 }, 32_768);
    let firstAt = 0;
    for (let i = 0; i < iir.length; i++) {
      if (Math.abs(iir[i]!) > 1e-6) { firstAt = i; break; }
    }
    assert(firstAt === 0,
      `the biquad EQ's response starts at sample ${firstAt} — it is supposed to be causal `
      + 'and start immediately, which is the thing this device gives up');
  });

  await check('Mix is a blend and not a comb', async () => {
    // The dry side is delayed by the same half-response, so half wet is the
    // arithmetic average of the two.  Unaligned it would be a comb with a
    // percentage on it, which on this device would be a joke.
    const level = async (mix: number): Promise<number> => {
      const ctx = new OfflineAudioContext(1, SR, SR);
      const osc = ctx.createOscillator();
      osc.frequency.value = 400;
      const device = findPlugin('linphase')!.create(
        ctx as unknown as BaseAudioContext,
        { ...defaultParams('linphase'), ...CURVE, length: 2, mix },
      );
      osc.connect(device.input);
      device.output.connect(ctx.destination as unknown as AudioNode);
      osc.start(0);
      const x = (await ctx.startRendering()).getChannelData(0);
      let peak = 0;
      for (let i = Math.round(SR * 0.5); i < Math.round(SR * 0.95); i++) {
        peak = Math.max(peak, Math.abs(x[i]!));
      }
      return peak;
    };
    const dry = await level(0);
    const wet = await level(1);
    const half = await level(0.5);
    assert(Math.abs(20 * Math.log10(dry)) < 0.01, `Mix at zero reads ${(20 * Math.log10(dry)).toFixed(3)} dB`);
    const expected = 0.5 * dry + 0.5 * wet;
    const errorDb = 20 * Math.log10(half / expected);
    assert(Math.abs(errorDb) < 0.05,
      `half wet reads ${errorDb.toFixed(3)} dB away from the sum of the two halves — the dry `
      + 'path is not aligned with the wet one');
  });

  await check('the picture is the response the device convolves', () => {
    // Drawn from `linphaseImpulse`, the same function the device loads into
    // its convolver — so the picture cannot be of a different filter.
    const params = { ...defaultParams('linphase'), ...CURVE, length: 1 };
    const picture = lfoPictureFor('linphase', params);
    assert(picture !== null, 'the linear-phase EQ draws no picture');
    const h = linphaseImpulse(params, SR);
    let peak = 0;
    for (let i = 0; i < h.length; i++) peak = Math.max(peak, Math.abs(h[i]!));
    const trace = picture!.traces[0]!;
    let worst = 0;
    for (let i = 0; i < h.length; i += 7) {
      worst = Math.max(worst, Math.abs(trace.at(i / SR) - (h[i]! / peak)));
    }
    assert(worst < 1e-6, `the drawn trace differs from the response by ${worst.toExponential(2)}`);
    assert(picture!.caption.includes('탭') && !picture!.caption.includes('NaN'),
      `the caption says nothing useful — ${picture!.caption}`);
  });

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} passed${passed === results.length ? '' : `, ${results.length - passed} FAILED`}`);
  if (passed !== results.length) process.exit(1);
}

void main();
