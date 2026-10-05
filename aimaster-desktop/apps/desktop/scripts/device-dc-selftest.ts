/**
 * device-dc-selftest — what an asymmetric curve does to the average.
 *
 * Every saturator here is asymmetric ON PURPOSE: a symmetric curve makes only
 * odd harmonics, which is why pure tanh sounds like a fuzz pedal and not like
 * a preamp.  What nobody had asked is what that does to the MEAN.  A curve
 * that is asymmetric about zero has one, and a constant is not audible on its
 * own — it eats headroom where no meter shows it, it biases the peak a
 * limiter sees (an asymmetric waveform reaches its ceiling on one side
 * first), and inside a feedback loop it accumulates.
 *
 * Measured by sweeping every device in the rack and both ends of every one of
 * its knobs — 576 renders of a 220 Hz tone at 0.3 — DC against the output's
 * own RMS:
 *
 *     tube          -5.3 dB at its DEFAULTS, -4.5 at full drive
 *     amp           -9.2 dB with the cabinet switched off
 *     tapedelay    -18.7 dB, and that one is inside its feedback loop
 *     saturation   -20.5 dB with Bias at either end
 *
 * Real valve and tape circuits are capacitor-coupled at every stage for
 * exactly this reason, and now these are too — see `dcBlock` in plugin-kit.
 * Afterwards the worst in the whole rack is -69 dB.
 *
 * TWO MEASUREMENTS THAT ARE NOT DEFECTS, and how they are told apart from the
 * ones that are.  A delay at 0.95 feedback reads -51 dB of "DC" over two
 * settled seconds, and a harmonizer pitched down an octave -58 — neither has
 * a saturator in it.  What they have is slow movement: a feedback line still
 * filling, a grain crossfade.  A CONSTANT does not average away as the
 * window grows and movement does, so that is the test:
 *
 *                    2 s window   6 s      10 s
 *     delay           -51.0 dB   -56.2    -64.5
 *     harmonizer      -57.6 dB   -75.1    -80.2
 *     tube, fixed    -183.1 dB  -183.1    (a real zero does not move)
 *
 * So anything over the bar on the short sweep is re-measured over a twenty
 * second render, and has to be under it there.  A threshold alone would
 * either wave the saturators through or fail the delay for ever.
 *
 * Run:  pnpm --filter @aimaster/desktop test:device-dc
 */

import { OfflineAudioContext } from 'node-web-audio-api';
(globalThis as unknown as { OfflineAudioContext: unknown }).OfflineAudioContext = OfflineAudioContext;

import { PLUGINS, defaultParams } from '../src/renderer/daw/engine/plugins.js';
import { tanhCurve } from '../src/renderer/daw/engine/plugin-kit.js';
import {
  tapeCurve, tubeCurve, tubeSmallSignalGain,
} from '../src/renderer/daw/engine/plugins-extended.js';

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }

const SR = 48_000;
const SECONDS = 4;
/** How far below the signal's own RMS a device's offset has to sit. */
const DC_FLOOR_DB = -60;

/** A tone through one device, and what its output averages to. */
async function through(
  id: string, over: Record<string, number>, seconds = SECONDS,
): Promise<{ dc: number; rms: number; rel: number; h2: number }> {
  const device = PLUGINS.find((p) => p.id === id);
  assert(device, `no device ${id}`);
  const n = SR * seconds;
  const ctx = new OfflineAudioContext(2, n, SR);
  const buf = ctx.createBuffer(1, n, SR);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i += 1) d[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / SR);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const node = device!.create(
    ctx as unknown as BaseAudioContext, { ...defaultParams(id), ...over });
  src.connect(node.input as AudioNode);
  (node.output as AudioNode).connect(ctx.destination as unknown as AudioNode);
  src.start(0);
  const out = await ctx.startRendering();
  const ch = out.getChannelData(0);
  // The settled half: a feedback device is still filling up before that.
  const from = Math.round(n / 2);
  let sum = 0, sq = 0;
  for (let i = from; i < ch.length; i += 1) { sum += ch[i]!; sq += ch[i]! * ch[i]!; }
  const m = ch.length - from;
  const dc = sum / m;
  const rms = Math.sqrt(sq / m);
  const at = (hz: number): number => {
    let re = 0, im = 0;
    for (let i = from; i < ch.length; i += 1) {
      re += ch[i]! * Math.cos((2 * Math.PI * hz * (i - from)) / SR);
      im += ch[i]! * Math.sin((2 * Math.PI * hz * (i - from)) / SR);
    }
    return (2 * Math.sqrt(re * re + im * im)) / m;
  };
  return {
    dc, rms,
    rel: 20 * Math.log10(Math.abs(dc) / Math.max(1e-30, rms)),
    h2: 20 * Math.log10(at(440) / Math.max(1e-30, at(220))),
  };
}

/** What a WaveShaper hands back for an input of exactly zero. */
function atZero(curve: Float32Array): number {
  const idx = (curve.length - 1) / 2;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return curve[lo]! * (1 - (idx - lo)) + curve[hi]! * (idx - lo);
}

async function main(): Promise<void> {
  await check('no device leaves DC on the bus, at its defaults or either end of any knob',
    async () => {
      const bad: string[] = [];
      let worst = { what: '', rel: -999 };
      for (const device of PLUGINS) {
        // A Mix that rests at zero means the device is BYPASSED at its
        // defaults, and a sweep that leaves it there measures nothing.  The
        // first run of this sweep gave the Saturation device a clean bill for
        // exactly that reason.
        const mix = device.params.find((p) => p.id === 'mix');
        const wet: Record<string, number> = mix ? { mix: mix.max } : {};
        const cases: Array<[string, Record<string, number>]> = [[mix ? 'mix max' : 'defaults', wet]];
        for (const p of device.params) {
          if (p.id === 'mix') continue;
          cases.push([`${p.id}=${p.min}`, { ...wet, [p.id]: p.min }]);
          cases.push([`${p.id}=${p.max}`, { ...wet, [p.id]: p.max }]);
        }
        for (const [what, params] of cases) {
          const got = await through(device.id, params);
          if (got.rms < 1e-5) continue;                  // nothing came out to measure
          if (got.rel > worst.rel) worst = { what: `${device.id} ${what}`, rel: got.rel };
          if (got.rel <= DC_FLOOR_DB) continue;
          // Over the bar on the short sweep: give it a window five times as
          // long.  An offset stays where it is; movement averages down.
          const settled = await through(device.id, params, SECONDS * 5);
          if (settled.rel > DC_FLOOR_DB) {
            bad.push(`${device.id} ${what} at ${got.rel.toFixed(1)} dB, `
              + `still ${settled.rel.toFixed(1)} over five times the window`);
          }
        }
      }
      assert(bad.length === 0, `DC on the bus: ${bad.slice(0, 6).join(', ')}`);
      console.log(`      (worst ${worst.what} at ${worst.rel.toFixed(1)} dB of its own RMS)`);
    });

  await check('the tube\'s Bias changes its harmonics, not its level', async () => {
    // It used to change both, and mostly the level: the bias was added
    // straight to the sample while the knee sits at 1/k, so by the top of
    // the knob the whole positive half was past saturation.  Measured at the
    // default drive — RMS 0.878 at Bias 0.15, 0.398 at 0.3 and 0.026 at its
    // maximum, which is 30 dB of mute, while the second harmonic ran level
    // with the third.  A knob that silences the device at one end of its
    // travel is wrong whatever else it does.
    const biasParam = PLUGINS.find((p) => p.id === 'tube')!.params
      .find((p) => p.id === 'bias')!;
    const rows: Array<{ bias: number; rms: number; h2: number }> = [];
    for (const bias of [0, biasParam.default, 0.3, biasParam.max]) {
      const got = await through('tube', { mix: 100, bias });
      rows.push({ bias, rms: got.rms, h2: got.h2 });
    }
    const levels = rows.map((r) => 20 * Math.log10(r.rms));
    const spread = Math.max(...levels) - Math.min(...levels);
    assert(spread < 1.5,
      `Bias moves the level by ${spread.toFixed(1)} dB across its travel — `
      + rows.map((r) => `${r.bias}: ${r.rms.toFixed(3)}`).join(', '));
    // And it still does what it is for: more second harmonic as it opens.
    assert(rows[rows.length - 1]!.h2 > rows[0]!.h2 + 12,
      `Bias took the second harmonic from ${rows[0]!.h2.toFixed(1)} to `
      + `${rows[rows.length - 1]!.h2.toFixed(1)} dB — that is not an asymmetry control`);
    console.log(`      (level spread ${spread.toFixed(2)} dB, h2 `
      + `${rows[0]!.h2.toFixed(0)} → ${rows[rows.length - 1]!.h2.toFixed(0)} dB)`);
  });

  await check('a shaper fed silence gives silence back', async () => {
    // Decided by the SHAPE first and the point count second, which is the
    // other way round from what this comment used to say.  A WaveShaper maps
    // x in [−1, 1] onto index (x + 1) / 2 * (n - 1) and interpolates, and
    // that grid is symmetric at ANY length: index i and n − 1 − i hold
    // exactly opposite inputs.  So a smooth odd function gives zero whatever
    // the count — measured, `tapeCurve` does at 4096 and a biased tanh does
    // at 2048, the latter to 5e-8.
    //
    // The count bites where the SLOPE jumps at the origin.  `pickupCurve`'s
    // gain differs by polarity, so its neighbours are −1.489e-3 and
    // +2.385e-3 and an even length hands back their midpoint: 4.48e-4 at
    // amount 0.35, a constant on the bus for as long as the voice played.
    // curve-silence-selftest sweeps every curve the app builds; these are
    // the ones this file's devices are made of.
    for (const [name, curve] of [
      ['tubeCurve(0.3, 0.15)', tubeCurve(0.3, 0.15)],
      ['tubeCurve(1, 0.5)', tubeCurve(1, 0.5)],
      ['tanhCurve(0.15)', tanhCurve(0.15)],
      ['tanhCurve(1)', tanhCurve(1)],
      ['tapeCurve(1)', tapeCurve(1)],
    ] as Array<[string, Float32Array]>) {
      const dc = atZero(curve);
      assert(Math.abs(dc) < 1e-6, `${name} maps silence to ${dc.toExponential(2)}`);
    }
    await Promise.resolve();
  });

  await check('the tube still reports the gain it gives a quiet signal', async () => {
    // The tape delay divides by this to keep its loop gain under one, so it
    // has to follow the curve rather than the arithmetic the curve used to
    // have.  Read off the curve the device builds, as a WaveShaper reads it.
    for (const [drive, bias] of [[0, 0.05], [0.3, 0.15], [1, 0.5]] as Array<[number, number]>) {
      const curve = tubeCurve(drive, bias);
      const sample = (x: number): number => {
        const idx = ((x + 1) / 2) * (curve.length - 1);
        const lo = Math.floor(idx), hi = Math.min(curve.length - 1, lo + 1);
        return curve[lo]! * (1 - (idx - lo)) + curve[hi]! * (idx - lo);
      };
      const measured = (sample(0.002) - sample(-0.002)) / 0.004;
      const claimed = tubeSmallSignalGain(drive, bias);
      assert(Math.abs(measured - claimed) / Math.max(1, claimed) < 0.01,
        `drive ${drive} bias ${bias}: curve slope ${measured.toFixed(3)} vs claimed ${claimed.toFixed(3)}`);
    }
    await Promise.resolve();
  });

  console.log('');
  for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  const bad = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - bad}/${results.length} passed${bad ? `, ${bad} FAILED` : ''}`);
  if (bad) process.exit(1);
}

void main();
