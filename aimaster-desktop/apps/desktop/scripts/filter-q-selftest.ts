/**
 * filter-q-selftest — the two things Web Audio measures in units nobody
 * expects, checked against the renderer rather than against a memory of the
 * spec.
 *
 * Both were found by building a tape machine, both were wrong in devices
 * that had shipped, and both are the kind of wrong that never looks wrong:
 *
 *   · `Q` ON A LOWPASS OR HIGHPASS IS IN DECIBELS.  The 0.707 everybody
 *     types, meaning maximally flat, is 10^(0.707/20) = 1.085 and puts a
 *     resonant peak just under the corner.  In a crossover that is summed
 *     back it means the split alone colours the signal; in a feedback loop it
 *     multiplies the loop gain at one frequency.
 *   · SOME NODES ARE LATE.  An oversampled `WaveShaper` costs a render
 *     quantum and a `DynamicsCompressorNode` looks ahead, both whether or not
 *     they are doing anything.  A device that declares zero latency puts its
 *     whole track that far behind the mix, and a device that blends a dry
 *     path around one combs.
 *
 * Every number here is measured from the renderer in front of it, so a
 * renderer that behaves differently fails this rather than silently
 * mis-tuning every filter in the rack.
 *
 * Run:  pnpm --filter @aimaster/desktop test:filter-q
 */

import { OfflineAudioContext } from 'node-web-audio-api';

(globalThis as unknown as { OfflineAudioContext: unknown }).OfflineAudioContext = OfflineAudioContext;

import { PLUGINS, defaultParams } from '../src/renderer/daw/engine/plugins.js';
import {
  BUTTERWORTH_Q, DYNAMICS_LOOKAHEAD_SEC, oversampleLatencySamples,
  probeRendererLatency, probedLatency,
  dynamicsLatencySamples,
} from '../src/renderer/daw/engine/plugin-kit.js';

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

const db = (x: number): number => 20 * Math.log10(Math.max(1e-12, x));

/** A steady tone through a graph, as a level in dB relative to the input. */
async function respDb(
  build: (ctx: OfflineAudioContext, input: AudioNode) => AudioNode, hz: number, sr = SR,
): Promise<number> {
  const ctx = new OfflineAudioContext(1, Math.round(sr * 0.6), sr);
  const osc = ctx.createOscillator();
  osc.frequency.value = hz;
  const gain = ctx.createGain();
  gain.gain.value = 0.02;
  osc.connect(gain);
  build(ctx, gain).connect(ctx.destination);
  osc.start();
  const d = (await ctx.startRendering()).getChannelData(0);
  const off = Math.round(0.3 * sr);
  const n = Math.round(0.25 * sr);
  let re = 0;
  let im = 0;
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));
    const ph = 2 * Math.PI * hz * i / sr;
    re += (d[off + i] ?? 0) * w * Math.cos(ph);
    im += (d[off + i] ?? 0) * w * Math.sin(ph);
  }
  return db(Math.hypot(re, im) / n * 4 / 0.02);
}

function seeded(ctx: OfflineAudioContext, n: number, channels: number): AudioBuffer {
  const buf = ctx.createBuffer(channels, n, ctx.sampleRate);
  let seed = 12345;
  for (let c = 0; c < channels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < n; i++) {
      seed = (Math.imul(seed ^ (seed >>> 15), 1 | seed) + 0x6d2b79f5) >>> 0;
      d[i] = ((seed >>> 8) / 8388608 - 1) * 0.05;
    }
  }
  return buf;
}

/**
 * How late a graph is, by correlating broadband noise against itself.
 *
 * Not by impulse: an oversampler's up and down filters are minimum-phase, so
 * the peak of their response arrives ahead of the group delay and an impulse
 * reports a number twenty samples short.
 */
async function lagOf(
  build: ((ctx: OfflineAudioContext, input: AudioNode) => AudioNode) | null,
  sr = SR, channels = 1,
): Promise<{ lag: number; corr: number }> {
  const render = async (
    b: ((ctx: OfflineAudioContext, input: AudioNode) => AudioNode) | null,
  ): Promise<Float32Array> => {
    const ctx = new OfflineAudioContext(channels, sr, sr);
    const src = ctx.createBufferSource();
    src.buffer = seeded(ctx, sr, channels);
    (b ? b(ctx, src) : src).connect(ctx.destination);
    src.start(0);
    return (await ctx.startRendering()).getChannelData(0);
  };
  const ref = await render(null);
  const out = await render(build);
  let best = 0;
  let bestCorr = -Infinity;
  for (let lag = -8; lag <= 1400; lag++) {
    let sum = 0;
    let a = 0;
    let b = 0;
    for (let i = 4000; i < 40_000; i++) {
      const x = ref[i] ?? 0;
      const y = out[i + lag] ?? 0;
      sum += x * y; a += x * x; b += y * y;
    }
    const c = sum / Math.sqrt(a * b + 1e-30);
    if (c > bestCorr) { bestCorr = c; best = lag; }
  }
  return { lag: best, corr: bestCorr };
}

const biquad = (
  type: BiquadFilterType, hz: number, q: number,
) => (ctx: OfflineAudioContext, input: AudioNode): AudioNode => {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = hz;
  f.Q.value = q;
  return input.connect(f);
};

async function main(): Promise<void> {
  // Before any device is built: the dry paths inside them are delayed by what
  // this renderer's oversampled shaper costs, and the un-probed default is
  // the other renderer's number.
  await probeRendererLatency(SR);

  await check('Q on a lowpass is decibels, and BUTTERWORTH_Q is the flat one', async () => {
    // The whole finding, in one measurement: a Butterworth filter is −3.01 dB
    // at its own corner, and the value that produces that is not 0.707.
    const atCorner = await respDb(biquad('lowpass', 8000, BUTTERWORTH_Q), 8000);
    assert(Math.abs(atCorner + 3.01) < 0.15,
      `a lowpass at BUTTERWORTH_Q reads ${atCorner.toFixed(2)} dB at its corner, and `
      + 'Butterworth is −3.01 — this renderer does not read Q in decibels, so every filter '
      + 'in the rack is now tuned to the wrong thing');

    const naive = await respDb(biquad('lowpass', 8000, 0.707), 8000);
    assert(naive > 0.4,
      `a lowpass written Q = 0.707 reads ${naive.toFixed(2)} dB at its corner — if that is `
      + 'now flat the units have changed and the constant should go back');

    // And flat means flat: no peak anywhere.
    let worst = -Infinity;
    for (const hz of [500, 1000, 2000, 3000, 4000, 5000, 6000, 7000]) {
      worst = Math.max(worst, await respDb(biquad('lowpass', 8000, BUTTERWORTH_Q), hz));
    }
    assert(worst < 0.1, `the flat lowpass peaks at ${worst.toFixed(2)} dB in its passband`);

    // A highpass too, and at a second rate, because the units could have been
    // a coincidence of one corner.
    const hp = await respDb(biquad('highpass', 200, BUTTERWORTH_Q), 200, 44_100);
    assert(Math.abs(hp + 3.01) < 0.2,
      `a highpass at BUTTERWORTH_Q reads ${hp.toFixed(2)} dB at its corner at 44.1 kHz`);
  });

  await check('a crossover that is summed back adds up to one', async () => {
    // Why the units matter, and a correction to what I first wrote here.
    //
    // A single Butterworth lowpass and highpass at the same corner do NOT
    // sum flat.  I asserted they did — "two second-order sections sum to an
    // all-pass" — and this check disproved it on its first run: their sum is
    // (s² + ω0²)/(s² + ω0 s/Q + ω0²), whose numerator is zero at the corner
    // for ANY Q.  The two halves arrive ninety degrees either side of the
    // input and cancel completely.  Measured below, and measured again at
    // the Q that was there before, because the hole is not a tuning error —
    // it is the topology, and no Q closes it.
    //
    // Making the Q correct without changing the topology made it WORSE: the
    // dip half an octave out went from 6.9 dB to 10.3.  Two cascaded
    // sections a side — Linkwitz-Riley — is what sums flat, and now does.
    const split = (q: number, order: number) =>
      (ctx: OfflineAudioContext, input: AudioNode): AudioNode => {
        const sum = ctx.createGain();
        for (const type of ['lowpass', 'highpass'] as const) {
          let node: AudioNode = input;
          for (let i = 0; i < order; i++) {
            const f = ctx.createBiquadFilter();
            f.type = type; f.frequency.value = 2000; f.Q.value = q;
            node = node.connect(f);
          }
          node.connect(sum);
        }
        return sum;
      };
    let worst = 0;
    for (const hz of [250, 500, 1000, 1600, 2000, 2500, 4000, 8000]) {
      worst = Math.max(worst, Math.abs(await respDb(split(BUTTERWORTH_Q, 2), hz)));
    }
    assert(worst < 0.3,
      `Linkwitz-Riley sums to ${worst.toFixed(2)} dB of error — it is supposed to be the one `
      + 'arrangement that adds up to one');

    // And the single pair really does cancel, at both Qs, so nobody puts it
    // back believing a number will fix it.
    for (const q of [BUTTERWORTH_Q, 0.707, 1]) {
      const atCorner = await respDb(split(q, 1), 2000);
      assert(atCorner < -30,
        `a single lowpass-plus-highpass pair at Q = ${q} reads ${atCorner.toFixed(1)} dB at its `
        + 'own corner — if that is now flat, this whole check is wrong about the topology');
    }

    // The devices that do it, measured through their own graphs with nothing
    // turned on, because a split that colours the signal before the device
    // acts is the thing that hid for so long.
    for (const [id, corner, off] of [
      ['deesser', 6500, { amount: 0 }],
      ['rotary', 800, { doppler: 0, throb: 0, drive: 0, mix: 1 }],
      ['mbcomp', 180, { lowThrDb: 0, midThrDb: 0, hiThrDb: 0, lowRatio: 1, midRatio: 1, hiRatio: 1 }],
    ] as const) {
      const device = dev(id);
      const params = { ...defaultParams(id), ...off };
      const at = async (hz: number): Promise<number> => respDb((ctx, input) => {
        const node = device.create(ctx, params);
        input.connect(node.input);
        return node.output;
      }, hz);
      for (const hz of [corner, corner * 0.8, corner * 1.25]) {
        const level = await at(hz);
        assert(level > -3,
          `${id} reads ${level.toFixed(1)} dB at ${Math.round(hz)} Hz with nothing turned on — `
          + 'its crossover is putting a hole in the signal before the device does anything');
      }
    }
  });

  await check('what the devices align to is what this renderer really costs', async () => {
    // Not a constant any more, and that is the finding.  The two renderers
    // this code runs in disagree about both numbers — Chromium's 4x shaper is
    // 192 samples late and node's is 128, and Chromium truncates the
    // compressor's six milliseconds where node rounds them up to a whole
    // render quantum.  Hardcoding either one mis-aligns the other's dry
    // paths, so the host is measured and `probeRendererLatency` installs what
    // it finds.
    //
    // Which makes this check the one that matters: whatever the host does,
    // the number the devices delay their dry paths by has to BE that.
    const straight = (ctx: OfflineAudioContext, input: AudioNode): AudioNode => {
      const w = ctx.createWaveShaper();
      const curve = new Float32Array(2048);
      for (let i = 0; i < 2048; i++) curve[i] = (i / 2047) * 2 - 1;
      w.curve = curve;
      w.oversample = '4x';
      return input.connect(w);
    };
    for (const sr of [44_100, 48_000, 96_000]) {
      await probeRendererLatency(sr);
      const { lag, corr } = await lagOf(straight, sr);
      assert(corr > 0.8, `the shaper did not correlate with its input at ${sr} Hz`);
      assert(lag === oversampleLatencySamples(sr),
        `at ${sr} Hz the 4x shaper is ${lag} samples late and the devices align to `
        + `${oversampleLatencySamples(sr)}`);
      const probe = probedLatency(sr);
      assert(probe !== null && probe.oversample4x === lag,
        `the probe read ${probe?.oversample4x ?? 'nothing'} where the shaper is ${lag}`);
    }

    // And the un-probed default is CHROMIUM's, which is not this renderer's —
    // stated so that anyone who "simplifies" the two back into one number
    // finds out here rather than in a mix.
    assert(oversampleLatencySamples(22_050) === 192,
      `the default is ${oversampleLatencySamples(22_050)}, and Chromium measured 192`);
    assert(oversampleLatencySamples(48_000) !== 192,
      'this renderer measured 192 as well — if that is now true, say so here');
  });

  await check('a compressor looks ahead even when it is not compressing', async () => {
    const flat = (ctx: OfflineAudioContext, input: AudioNode): AudioNode => {
      const c = ctx.createDynamicsCompressor();
      c.threshold.value = 0;
      c.ratio.value = 1;
      c.knee.value = 0;
      return input.connect(c);
    };
    // Under node, 44.1 and 48 land on the same count and 88.2 and 96 on the
    // next one up, which is what says the rule there is QUANTA rather than
    // time or samples.  Chromium truncates the same six milliseconds to whole
    // samples instead — 264, 288, 529, 576 — so the rule is the renderer's,
    // not the spec's, and what is checked is that the declaration follows
    // whichever host is running.
    for (const sr of [44_100, 48_000, 88_200, 96_000]) {
      await probeRendererLatency(sr);
      const { lag, corr } = await lagOf(flat, sr);
      assert(corr > 0.99,
        `at ${sr} Hz a compressor doing nothing correlated only ${corr.toFixed(3)} with its `
        + 'input — it is supposed to be a pure delay there');
      assert(lag === dynamicsLatencySamples(sr),
        `at ${sr} Hz it is ${lag} samples late and the device declares `
        + `${dynamicsLatencySamples(sr)}`);
      // What the two renderers DO agree on, stated so the shared fact is not
      // lost among the differences: six milliseconds, rounded up by less than
      // one render quantum.  Chromium truncates and lands on the floor of it;
      // node rounds up to the next whole quantum and overshoots by up to 128.
      const floorSamples = Math.floor(DYNAMICS_LOOKAHEAD_SEC * sr);
      assert(lag >= floorSamples && lag < floorSamples + 128,
        `at ${sr} Hz the look-ahead is ${lag} samples (${((lag / sr) * 1000).toFixed(2)} ms), `
        + `outside [${floorSamples}, ${floorSamples + 128}) — six milliseconds rounded up by `
        + 'less than a quantum is what both renderers were supposed to be doing');
    }
  });

  await check('every device declares the time it takes', async () => {
    // The check that stops this coming back.  A device that says zero and is
    // not puts its whole track behind the mix, and nothing sounds wrong — the
    // track is just late, which reads as a bad performance.
    //
    // Measured at settings that keep each device close to linear, so the lag
    // is a delay rather than a change of shape.  Anything that will not
    // correlate at all is named rather than skipped silently.
    const QUIET: Record<string, number> = {
      drive: 0, amount: 0, hardness: 0, sag: 0, bump: 0,
      wow: 0, flutter: 0, hiss: 0, crosstalk: 0, bias: 0.95,
    };
    const unmeasurable: string[] = [];
    const wrong: string[] = [];
    for (const dev of PLUGINS) {
      const params = { ...defaultParams(dev.id) };
      for (const [k, v] of Object.entries(QUIET)) if (k in params) params[k] = v;
      let measured: { lag: number; corr: number };
      try {
        measured = await lagOf((ctx, input) => {
          const node = dev.create(ctx, params);
          input.connect(node.input);
          return node.output;
        }, SR, 2);
      } catch { unmeasurable.push(`${dev.id} (threw)`); continue; }
      if (measured.corr < 0.35) { unmeasurable.push(`${dev.id} (corr ${measured.corr.toFixed(2)})`); continue; }
      const declared = dev.latencyFor(params, SR);
      if (Math.abs(measured.lag - declared) > 8) {
        wrong.push(`${dev.id}: takes ${measured.lag}, says ${declared}`);
      }
    }
    assert(wrong.length === 0, `devices that mis-declare their latency — ${wrong.join('; ')}`);
    // The list of devices this cannot measure is stated, so it cannot quietly
    // grow into a hole: a modulated or heavily nonlinear device does not
    // correlate with its input and has to be checked by its own suite.
    const EXPECTED_UNMEASURABLE = [
      'gate', 'ducker', 'limiter', 'delay', 'reverb', 'transient', 'denoise',
      'deesser', 'dyneq', 'pitchcorrect', 'spacereverb', 'plate', 'spring',
      'shimmer', 'chorus', 'flanger', 'phaser', 'tremolo', 'autopan',
      'pingpong', 'tapedelay', 'monomaker', 'haas', 'phase', 'dcblock',
      'dither', 'hum', 'loudness', 'rotary', 'tape', 'amp', 'mbcomp', 'clipper',
    ];
    const surprises = unmeasurable.filter((u) => !EXPECTED_UNMEASURABLE.includes(u.split(' ')[0]!));
    assert(surprises.length === 0,
      `these stopped correlating with their input and are no longer covered — ${surprises.join('; ')}`);
  });

  await check('a parallel saturator blends instead of combing', async () => {
    // Three devices put a dry path around an oversampled shaper, and all
    // three were a render quantum out.  At fifty per cent that is not a
    // subtle blend error: the two sides cancel.
    for (const [id, mixParam, mixValue] of [
      ['saturation', 'mix', 0.5], ['tube', 'mix', 50], ['exciter', 'mix', 50],
    ] as const) {
      const at = async (mix: number): Promise<number> => {
        const params = { ...defaultParams(id), [mixParam]: mix };
        if ('drive' in params) params['drive'] = 0.05;
        if ('amount' in params) params['amount'] = 5;
        return respDb((ctx, input) => {
          const node = dev(id).create(ctx, params);
          input.connect(node.input);
          return node.output;
        }, 1000);
      };
      const dryOnly = await at(0);
      const half = await at(mixValue);
      assert(half > dryOnly - 1.5,
        `${id} at half wet reads ${half.toFixed(2)} dB against ${dryOnly.toFixed(2)} dry — the `
        + 'dry side is arriving at a different time from the wet one and cancelling');
    }
  });

  function dev(id: string): typeof PLUGINS[number] {
    const found = PLUGINS.find((d) => d.id === id);
    if (!found) throw new Error(`no device ${id}`);
    return found;
  }

  let failed = 0;
  for (const r of results) {
    if (!r.pass) failed++;
    console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.pass ? '' : ` — ${r.detail}`}`);
  }
  console.log(`\n${results.length - failed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
  process.exit(failed ? 1 : 0);
}

void main();
