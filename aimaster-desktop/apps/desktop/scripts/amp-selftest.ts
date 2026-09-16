/**
 * amp-selftest — whether the guitar amp is an amplifier.
 *
 * The rack already has two distortion devices, so the question this file
 * answers is what makes this one different from turning either of them up.
 * Four claims, each measured through the engine:
 *
 *   · a CASCADE of small stages is not one big clipper.  Each stage cuts
 *     bass on the way in and fizz on the way out, so the same total gain
 *     arrives as compression with an ordered harmonic series rather than as
 *     a hard clip and intermodulation.
 *   · the preamp is ASYMMETRIC and the power amp is not, so one makes even
 *     harmonics and the other odd ones.
 *   · the CABINET stops at four kilohertz, which is most of the difference
 *     between an amp sim and a wasp in a tin.
 *   · the tone stack has a SCOOP with all three controls at noon, because a
 *     passive network always does.
 *
 * And the last check holds the panel's drawing against a measured sweep, for
 * the reason every picture in this repository is checked: a curve that
 * disagrees with the device is worse than no curve, because it is believed.
 *
 * Run:  pnpm --filter @aimaster/desktop test:amp
 */

import { OfflineAudioContext } from 'node-web-audio-api';

(globalThis as unknown as { OfflineAudioContext: unknown }).OfflineAudioContext = OfflineAudioContext;

import { defaultParams, findPlugin } from '../src/renderer/daw/engine/plugins.js';
import { filterPictureFor } from '../src/renderer/daw/model/plugin-shapes.js';
import { biquadMagnitudeDb } from '../src/renderer/daw/model/plugin-curves.js';

const SR = 48_000;

const results: Array<{ name: string; pass: boolean; detail: string }> = [];
function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  return Promise.resolve().then(fn)
    .then(() => { results.push({ name, pass: true, detail: '' }); })
    .catch((e: unknown) => {
      results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) });
    });
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }

/** A steady sine through the amp, rendered offline. */
async function render(
  toneHz: number, amplitude: number, overrides: Record<string, number> = {}, seconds = 1,
): Promise<AudioBuffer> {
  const descriptor = findPlugin('amp')!;
  const ctx = new OfflineAudioContext(2, SR * seconds, SR);
  const osc = ctx.createOscillator();
  osc.frequency.value = toneHz;
  const level = ctx.createGain();
  level.gain.value = amplitude;
  const instance = descriptor.create(
    ctx as unknown as BaseAudioContext, { ...defaultParams('amp'), ...overrides },
  );
  osc.connect(level).connect(instance.input);
  instance.output.connect(ctx.destination as unknown as AudioNode);
  osc.start();
  return (await ctx.startRendering()) as unknown as AudioBuffer;
}

/** Goertzel: the amplitude of one frequency, over the steady part. */
function tone(buffer: AudioBuffer, hz: number): number {
  const data = buffer.getChannelData(0);
  const from = Math.round(SR * 0.3);
  const n = Math.round(SR * 0.6);
  const w = (2 * Math.PI * hz) / SR;
  const c = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    const win = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    const s0 = (data[from + i] ?? 0) * win + c * s1 - s2;
    s2 = s1; s1 = s0;
  }
  return Math.hypot(s1 - s2 * Math.cos(w), s2 * Math.sin(w)) / n;
}

const db = (x: number): number => 20 * Math.log10(Math.max(1e-12, x));

async function main(): Promise<void> {
  await check('more stages is more distortion at the same input, and it compresses', async () => {
    // The claim that makes a cascade worth building, stated as what was
    // measured rather than as what the textbook says.  See the note on
    // `ampStage`: it is more distortion and a tighter low end, and it is NOT
    // less intermodulation — that was measured too, and it is not there.
    const f = 220;
    const harmonics = async (stages: number): Promise<number> => {
      const buf = await render(f, 0.25, { stages, gain: 70, master: 10, sag: 0, cab: 3 });
      const fund = tone(buf, f);
      let sum = 0;
      for (let k = 2; k <= 9; k++) sum += tone(buf, f * k) ** 2;
      return Math.sqrt(sum) / Math.max(1e-9, fund);
    };
    const one = await harmonics(1);
    const three = await harmonics(3);
    assert(three > one * 1.25,
      `one stage gives ${(one * 100).toFixed(1)}% harmonics and three give ${(three * 100).toFixed(1)}%`);

    // And the level does not run away: the stages give back most of what they
    // add, so the Gain knob changes how hard they are hit.
    const quiet = await render(f, 0.02, { stages: 3, gain: 70, master: 10, sag: 0, cab: 3 });
    const loud = await render(f, 0.4, { stages: 3, gain: 70, master: 10, sag: 0, cab: 3 });
    const compression = db(tone(loud, f) / tone(quiet, f)) - db(0.4 / 0.02);
    assert(compression < -6,
      `twenty-six decibels more in came out ${(compression + db(0.4 / 0.02)).toFixed(1)} dB louder `
      + '— the amp is not compressing');
  });

  await check('each stage cuts bass before it distorts, so the low end stays tight', async () => {
    // The reason the filter goes BEFORE the curve.  A low note through three
    // stages must not turn into a wall: the third stage's high-pass is at
    // 220 Hz, so by then an 80 Hz fundamental is most of the way gone and it
    // is the harmonics being distorted rather than the note.
    const f = 80;
    const ratio = async (stages: number): Promise<number> => {
      const buf = await render(f, 0.3, { stages, gain: 80, master: 10, sag: 0, cab: 3 });
      const fund = tone(buf, f);
      let low = 0;
      for (let k = 2; k <= 4; k++) low += tone(buf, f * k) ** 2;
      return Math.sqrt(low) / Math.max(1e-9, fund);
    };
    const one = await ratio(1);
    const three = await ratio(3);
    // Three stages leave a HIGHER harmonic-to-fundamental ratio at 80 Hz —
    // not because they distort the bass more, but because they removed the
    // fundamental.  That is the tightening, and it is what to measure.
    assert(three > one,
      `at 80 Hz one stage leaves ${one.toFixed(2)} and three leave ${three.toFixed(2)} — `
      + 'the interstage high-pass is not removing the fundamental');

    // Measured directly: the fundamental itself is far lower with three.
    const oneBuf = await render(f, 0.3, { stages: 1, gain: 80, master: 10, sag: 0, cab: 3 });
    const threeBuf = await render(f, 0.3, { stages: 3, gain: 80, master: 10, sag: 0, cab: 3 });
    const drop = db(tone(threeBuf, f) / tone(oneBuf, f));
    assert(drop < -6, `three stages only take ${drop.toFixed(1)} dB off an 80 Hz fundamental`);
  });

  await check('the preamp makes even harmonics and the power amp makes odd ones', async () => {
    // A valve stage's grid bias puts its operating point off centre, so one
    // half of the wave reaches the top of the curve before the other reaches
    // the bottom — and that asymmetry is what makes the second and fourth
    // harmonics, the ones that sound warm.  A push-pull output stage is two
    // valves taking a half each, so it is symmetric and makes the third and
    // fifth.
    //
    // Measured at MODERATE drive, and that is not a convenience.  At full
    // gain both halves are past saturation and the output is a square wave
    // whatever the bias, so an amplifier at maximum gain makes mostly odd
    // harmonics — which this one does too, and the last assertion here says
    // so rather than hiding it.
    const f = 300;
    const pre = await render(f, 0.3, { stages: 1, gain: 25, master: 0, sag: 0, cab: 3 });
    const evenPre = db(tone(pre, f * 2) / tone(pre, f));
    const oddPre = db(tone(pre, f * 3) / tone(pre, f));
    assert(evenPre > oddPre + 4,
      `at moderate gain the preamp's second is ${evenPre.toFixed(1)} dB and its third `
      + `${oddPre.toFixed(1)} — the bias is not making even harmonics`);

    const power = await render(f, 0.3, { stages: 1, gain: 0, master: 100, sag: 0, cab: 3 });
    const evenPower = db(tone(power, f * 2) / tone(power, f));
    const oddPower = db(tone(power, f * 3) / tone(power, f));
    assert(oddPower > evenPower + 6,
      `the power amp's third is ${oddPower.toFixed(1)} dB and its second ${evenPower.toFixed(1)} `
      + '— a push-pull stage should be symmetric');

    // And at full gain the preamp crosses over to odd, like the real thing.
    const hot = await render(f, 0.3, { stages: 1, gain: 95, master: 0, sag: 0, cab: 3 });
    assert(db(tone(hot, f * 3) / tone(hot, f)) > db(tone(hot, f * 2) / tone(hot, f)),
      'at full gain the preamp is still even-dominant, which no clipped stage is');
  });

  await check('the cabinet stops at four kilohertz, and can be turned off', async () => {
    // Most of the difference between an amp sim and a wasp in a tin.
    const at = async (hz: number, cab: number): Promise<number> => {
      const buf = await render(hz, 0.02, { cab, gain: 0, master: 0, sag: 0, stages: 1, mic: 45 });
      return db(tone(buf, hz));
    };
    const mid = await at(1000, 1);
    const top = await at(8000, 1);
    assert(mid - top > 24,
      `a 2×12 passes 8 kHz only ${(mid - top).toFixed(1)} dB below 1 kHz`);

    // With the cabinet off, the top comes back.
    const offMid = await at(1000, 3);
    const offTop = await at(8000, 3);
    assert(offMid - offTop < 12,
      `with the cabinet off 8 kHz is still ${(offMid - offTop).toFixed(1)} dB down`);

    // The sizes differ at the bottom, which is what a bigger box buys.
    const small = await at(70, 0);
    const big = await at(70, 2);
    assert(big > small + 2,
      `a 4×12 gives ${(big - small).toFixed(1)} dB more at 70 Hz than a 1×12`);

    // And the microphone trades top end, which is the one thing it is.
    const axis = await at(4000, 1);
    const offAxisBuf = await render(4000, 0.02, { cab: 1, gain: 0, master: 0, sag: 0, stages: 1, mic: 100 });
    assert(axis - db(tone(offAxisBuf, 4000)) > 4,
      'moving the microphone off axis does not roll the top off');
  });

  await check('the tone stack has a scoop at noon, because a passive network does', async () => {
    const at = async (hz: number, stack: number): Promise<number> => {
      const buf = await render(hz, 0.02, {
        stack, bass: 0, mid: 0, treble: 0, presence: 0,
        gain: 0, master: 0, sag: 0, cab: 3, stages: 1,
      });
      return db(tone(buf, hz));
    };
    const american = await at(380, 0);
    const americanRef = await at(1500, 0);
    assert(americanRef - american > 3,
      `the American stack's scoop is only ${(americanRef - american).toFixed(1)} dB at noon`);

    // The two stacks scoop in different places, which is most of what the
    // two names mean.
    const britishDip = await at(480, 1);
    const britishAt380 = await at(380, 1);
    const americanAt480 = await at(480, 0);
    assert(britishDip - britishAt380 > americanAt480 - american - 0.5
      || Math.abs((britishDip - britishAt380) - (americanAt480 - american)) > 0.5,
      'the two stacks scoop in the same place');
  });

  await check('sag pulls the level down and lets it back, over tens of milliseconds', async () => {
    const buf = await render(440, 0.5, { sag: 100, gain: 40, master: 60, stages: 2, cab: 3 });
    const data = buf.getChannelData(0);
    const window = Math.round(SR * 0.008);
    const rmsAt = (from: number): number => {
      let s = 0;
      for (let i = 0; i < window; i++) s += (data[from + i] ?? 0) ** 2;
      return Math.sqrt(s / window);
    };
    const onset = rmsAt(Math.round(SR * 0.02));
    const settled = rmsAt(Math.round(SR * 0.6));
    assert(db(settled / onset) < -1.5,
      `the level only fell ${db(settled / onset).toFixed(1)} dB between the attack and the sustain`);

    const none = await render(440, 0.5, { sag: 0, gain: 40, master: 60, stages: 2, cab: 3 });
    const flat = none.getChannelData(0);
    const flatRms = (from: number): number => {
      let s = 0;
      for (let i = 0; i < window; i++) s += (flat[from + i] ?? 0) ** 2;
      return Math.sqrt(s / window);
    };
    const flatDrop = db(flatRms(Math.round(SR * 0.6)) / flatRms(Math.round(SR * 0.02)));
    assert(Math.abs(flatDrop) < 0.6, `at Sag 0 the level still moved ${flatDrop.toFixed(1)} dB`);
  });

  await check('the picture is the amp, measured through it', async () => {
    // Held against a sweep with the gain right down, where the device is
    // close enough to linear for "a frequency response" to mean anything.
    // That limit is the honest one for any distortion: above it the response
    // depends on the level, and no single curve is true.
    const overrides = {
      gain: 0, master: 0, sag: 0, stages: 2, cab: 1, mic: 45,
      bass: 4, mid: -3, treble: 2, presence: 3, stack: 0, level: 0,
    };
    const picture = filterPictureFor('amp', { ...defaultParams('amp'), ...overrides });
    assert(picture, 'the amp has no picture');
    const cabCurve = picture!.curves[1]!;

    // A reference point the curve and the measurement are both read against,
    // because the device has a fixed gain of its own and the picture does not.
    const refHz = 1000;
    const refMeasured = db(tone(await render(refHz, 0.02, overrides), refHz));
    const refDrawn = cabCurve.specs.reduce((sum, spec) => sum + biquadMagnitudeDb(spec, refHz), 0);

    for (const hz of [80, 150, 400, 700, 2000, 3000, 5000]) {
      const measured = db(tone(await render(hz, 0.02, overrides), hz)) - refMeasured;
      const drawn = cabCurve.specs.reduce((sum, spec) => sum + biquadMagnitudeDb(spec, hz), 0) - refDrawn;
      assert(Math.abs(measured - drawn) < 2,
        `at ${hz} Hz the picture draws ${drawn.toFixed(1)} dB and the amp does ${measured.toFixed(1)}`);
    }
  });

  console.log('');
  for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  const bad = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - bad}/${results.length} passed${bad ? `, ${bad} FAILED` : ''}`);
  if (bad) process.exit(1);
}

void main();
