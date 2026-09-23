/**
 * tape-selftest — whether the tape machine is a tape machine, or a soft
 * clipper with a wobble on it.
 *
 * Almost every "tape" plugin is the latter, and it passes a listening test
 * until you ask it for the one thing tape actually does that a clipper does
 * not.  The checks here are the claims that make it a machine:
 *
 *   · THE TOP RUNS OUT OF TAPE FIRST.  A recorder boosts the high end going
 *     on and cuts it coming off — flat end to end, so invisible in a response
 *     — but the tape is in the middle, so the top arrives at the magnetics
 *     ten decibels hotter and compresses long before the bottom.  That is why
 *     tape flatters cymbals and leaves a kick alone at the same meter reading.
 *   · SPEED IS ONE NUMBER, NOT THREE TONE SETTINGS.  Head bump, high end,
 *     hiss and pre-emphasis all move together because all of them are about
 *     wavelength, which is speed over frequency.
 *   · BIAS IS A TRADE.  Clean and dull one way, dirty and bright the other,
 *     monotone in both — a real knob rather than a "more tape" control.
 *   · WOW AND FLUTTER ARE TWO MECHANISMS.  A reel out of round and a bearing
 *     chattering are not one LFO, and two modulations at one rate are a
 *     chorus.
 *
 * Run:  pnpm --filter @aimaster/desktop test:tape
 */

import { OfflineAudioContext } from 'node-web-audio-api';

(globalThis as unknown as { OfflineAudioContext: unknown }).OfflineAudioContext = OfflineAudioContext;

import { defaultParams, findPlugin } from '../src/renderer/daw/engine/plugins.js';
import {
  TAPE_BASE_SEC, TAPE_SPEEDS, tapeCurve, tapeKink, tapeSpeedAt, tapeTopHz,
} from '../src/renderer/daw/engine/plugins-extended.js';
import {
  oversampleLatencySamples, probeRendererLatency, makeShaper,
} from '../src/renderer/daw/engine/plugin-kit.js';
import { filterPictureFor } from '../src/renderer/daw/model/plugin-shapes.js';

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

const DEVICE = findPlugin('tape');
const D = defaultParams('tape');
/** Off by default in every measurement: they are separate claims. */
const STILL = { wow: 0, flutter: 0, hiss: 0, crosstalk: 0 };

const db = (x: number): number => 20 * Math.log10(Math.max(1e-12, x));

async function render(
  over: Record<string, number>, hz: number, amp: number, sec = 1.0,
): Promise<readonly [Float32Array, Float32Array]> {
  const ctx = new OfflineAudioContext(2, Math.round(SR * sec), SR);
  const node = DEVICE!.create(ctx, { ...D, ...over });
  if (hz > 0) {
    const osc = ctx.createOscillator();
    osc.frequency.value = hz;
    const gain = ctx.createGain();
    gain.gain.value = amp;
    osc.connect(gain).connect(node.input);
    osc.start();
  }
  node.output.connect(ctx.destination);
  const buf = await ctx.startRendering();
  return [buf.getChannelData(0), buf.getChannelData(1)] as const;
}

/** One partial's amplitude over a settled window. */
function part(d: Float32Array, hz: number, from = 0.5, len = 0.4): number {
  const off = Math.round(from * SR);
  const n = Math.round(len * SR);
  let re = 0;
  let im = 0;
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));
    const ph = 2 * Math.PI * hz * i / SR;
    re += (d[off + i] ?? 0) * w * Math.cos(ph);
    im += (d[off + i] ?? 0) * w * Math.sin(ph);
  }
  return Math.hypot(re, im) / n * 4;
}

function rms(d: Float32Array, from: number, len: number): number {
  const off = Math.round(from * SR);
  const n = Math.round(len * SR);
  let s = 0;
  for (let i = 0; i < n; i++) s += (d[off + i] ?? 0) ** 2;
  return Math.sqrt(s / n);
}

/** The response at one frequency, small enough to stay linear. */
async function respDb(over: Record<string, number>, hz: number): Promise<number> {
  const [L] = await render({ ...STILL, drive: 0, out: 0, ...over }, hz, 0.02);
  return db(part(L, hz) / 0.02);
}

/** How much the device compresses this frequency, from quiet to loud. */
async function compressionDb(over: Record<string, number>, hz: number): Promise<number> {
  const quiet = await render({ ...STILL, ...over }, hz, 0.02);
  const loud = await render({ ...STILL, ...over }, hz, 0.8);
  return db(part(loud[0], hz) / 0.8) - db(part(quiet[0], hz) / 0.02);
}

/** Instantaneous frequency, from interpolated zero crossings. */
function pitchTrace(d: Float32Array, from: number, to: number): { t: number; hz: number }[] {
  const out: { t: number; hz: number }[] = [];
  let prev = -1;
  for (let i = Math.round(from * SR) + 1; i < Math.round(to * SR); i++) {
    const a = d[i - 1] ?? 0;
    const b = d[i] ?? 0;
    if (a < 0 && b >= 0) {
      const t = i - 1 + (-a) / (b - a);
      if (prev > 0) out.push({ t: t / SR, hz: SR / (t - prev) });
      prev = t;
    }
  }
  return out;
}

/** How much of a pitch trace sits at one modulation rate, in cents. */
function modulationCents(trace: { t: number; hz: number }[], rateHz: number, carrier: number): number {
  if (trace.length < 8) return 0;
  const mean = trace.reduce((a, s) => a + s.hz, 0) / trace.length;
  let re = 0;
  let im = 0;
  for (const s of trace) {
    re += (s.hz - mean) * Math.cos(2 * Math.PI * rateHz * s.t);
    im += (s.hz - mean) * Math.sin(2 * Math.PI * rateHz * s.t);
  }
  return 1200 * (2 * Math.hypot(re, im) / trace.length) / carrier;
}

async function main(): Promise<void> {
  // First, because every device built below delays its dry path by whatever
  // this renderer's oversampled shaper costs, and the un-probed default is
  // the OTHER renderer's number.  A test that skips this combs its own Mix.
  await probeRendererLatency(SR);

  await check('the device exists and its knobs are the machine\'s', () => {
    assert(DEVICE, 'no tape device');
    for (const id of ['speed', 'drive', 'bias', 'bump', 'wow', 'flutter', 'hiss',
      'crosstalk', 'mix', 'out']) {
      assert(DEVICE!.params.some((q) => q.id === id), `no ${id} knob`);
    }
    assert(TAPE_SPEEDS.length === 3, 'three speeds');
    // Every speed-derived number moves the same way, because all of them are
    // wavelength over speed.  A table where one of them went the other way
    // would be three tone presets wearing a speed knob.
    for (let i = 1; i < TAPE_SPEEDS.length; i++) {
      const slow = TAPE_SPEEDS[i - 1]!;
      const fast = TAPE_SPEEDS[i]!;
      assert(fast.ips > slow.ips, 'speeds out of order');
      assert(fast.bumpHz > slow.bumpHz, 'the head bump has to rise with speed');
      assert(fast.topHz > slow.topHz, 'the top has to rise with speed');
      assert(fast.hissDb < slow.hissDb, 'faster tape has to be quieter');
      assert(fast.preDb < slow.preDb, 'slower tape needs more pre-emphasis');
      assert(fast.preHz > slow.preHz, 'and needs it lower down');
    }
    assert(tapeSpeedAt(1).ips === 15 && tapeSpeedAt(-4).ips === 7.5 && tapeSpeedAt(9).ips === 30,
      'the speed knob does not land on the speeds');
  });

  await check('the top runs out of tape long before the bottom does', async () => {
    // The claim the whole device is built around, and the one a soft clipper
    // cannot make: at the same input level the high end compresses several
    // decibels more, because the record EQ put it there several decibels
    // hotter and the playback EQ takes the difference back out afterwards.
    const low = await compressionDb({ drive: 6 }, 100);
    const mid = await compressionDb({ drive: 6 }, 1000);
    const high = await compressionDb({ drive: 6 }, 6000);
    assert(high < low - 5,
      `at the same input the bottom lost ${(-low).toFixed(1)} dB and the top `
      + `${(-high).toFixed(1)} — tape has to squash the top first, and this is `
      + 'behaving like a plain waveshaper');
    assert(mid < low && high < mid,
      `compression is not monotone with frequency: ${low.toFixed(1)}, ${mid.toFixed(1)}, `
      + `${high.toFixed(1)} dB at 100 Hz, 1 kHz, 6 kHz`);

    // And the pair that does it is INVISIBLE in the response — which is why
    // it gets left out of plugins and why it has to be checked here.
    for (const hz of [100, 1000, 6000]) {
      const flat = await respDb({ bump: 0, bias: 0.05 }, hz);
      assert(Math.abs(flat) < 1.5,
        `with the head bump off the machine is ${flat.toFixed(1)} dB at ${hz} Hz — the record `
        + 'and playback EQs are supposed to cancel exactly, so any residual is a bug in one');
    }
  });

  await check('speed moves the head bump, the top and the hiss together', async () => {
    const bumps: number[] = [];
    const tops: number[] = [];
    for (let i = 0; i < TAPE_SPEEDS.length; i++) {
      const spec = TAPE_SPEEDS[i]!;
      bumps.push(await respDb({ speed: i }, spec.bumpHz));
      tops.push(await respDb({ speed: i }, 14_000));
      // The bump is where the table says it is, and stands out of both sides.
      const below = await respDb({ speed: i }, spec.bumpHz / 2.5);
      const above = await respDb({ speed: i }, spec.bumpHz * 2.5);
      assert(bumps[i]! > below + 2 && bumps[i]! > above + 1,
        `at ${spec.ips} ips the bump at ${spec.bumpHz} Hz is ${bumps[i]!.toFixed(1)} dB against `
        + `${below.toFixed(1)} below and ${above.toFixed(1)} above it`);
    }
    // Faster tape keeps more top.
    assert(tops[2]! > tops[1]! && tops[1]! > tops[0]!,
      `14 kHz reads ${tops.map((v) => v.toFixed(1)).join(', ')} dB at 7.5, 15 and 30 ips — `
      + 'faster tape has to hold the top better');

    // And the sub goes the other way, which is the answer to "why does 30 ips
    // sound thin": the fall below the bump moves up with it.
    const sub = [];
    for (let i = 0; i < TAPE_SPEEDS.length; i++) sub.push(await respDb({ speed: i }, 30));
    assert(sub[0]! > sub[2]! + 4,
      `30 Hz reads ${sub.map((v) => v.toFixed(1)).join(', ')} dB — slow tape is supposed to `
      + 'have the weight and fast tape the clarity');
  });

  await check('hiss is per inch of tape, and silent when it is off', async () => {
    for (let i = 0; i < TAPE_SPEEDS.length; i++) {
      const [off] = await render({ speed: i, ...STILL }, 0, 0, 1.2);
      assert(db(rms(off, 0.4, 0.6)) < -140,
        `at ${TAPE_SPEEDS[i]!.ips} ips the machine hisses with the knob at zero`);
    }
    const levels: number[] = [];
    for (let i = 0; i < TAPE_SPEEDS.length; i++) {
      const [on] = await render({ speed: i, ...STILL, hiss: 1 }, 0, 0, 1.2);
      levels.push(db(rms(on, 0.4, 0.6)));
    }
    for (let i = 1; i < levels.length; i++) {
      const step = levels[i - 1]! - levels[i]!;
      assert(step > 4 && step < 8,
        `doubling the speed changed the hiss by ${step.toFixed(1)} dB, not the 6 that running `
        + 'twice as much tape past the head buys');
    }
    // It is a fixed recording rather than a random one, because a bounce has
    // to be the same file every time.
    const [a] = await render({ ...STILL, hiss: 1 }, 0, 0, 1.2);
    const [b] = await render({ ...STILL, hiss: 1 }, 0, 0, 1.2);
    let worst = 0;
    for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i]! - b[i]!));
    assert(worst === 0,
      `two renders of the same hiss differ by ${worst.toExponential(2)} — a bounce would not `
      + 'match its own preview');
  });

  await check('bias is a trade, and it is monotone in both directions', async () => {
    // A knob that only ever made things better in one direction would be a
    // "more tape" control with a misleading name.
    const dirt: number[] = [];
    const top: number[] = [];
    for (const bias of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      const [L] = await render({ ...STILL, bias, drive: 12 }, 1000, 0.4);
      const f = part(L, 1000);
      let h = 0;
      for (let k = 2; k <= 9 && k * 1000 < SR * 0.45; k++) h += part(L, 1000 * k) ** 2;
      dirt.push(100 * Math.sqrt(h) / Math.max(1e-12, f));
      top.push(await respDb({ bias }, 14_000));
    }
    for (let i = 1; i < dirt.length; i++) {
      assert(dirt[i]! < dirt[i - 1]!,
        `distortion went ${dirt.map((v) => v.toFixed(1)).join(', ')} % as the bias came up — `
        + 'more bias has to mean less distortion at every step');
      assert(top[i]! < top[i - 1]!,
        `the top went ${top.map((v) => v.toFixed(1)).join(', ')} dB as the bias came up — `
        + 'more bias has to cost high end at every step');
    }
    assert(dirt[0]! > dirt[4]! * 1.3,
      `the whole bias knob only changes distortion from ${dirt[0]!.toFixed(1)} to `
      + `${dirt[4]!.toFixed(1)} %`);
    assert(top[0]! > top[4]! + 6,
      `the whole bias knob only changes 14 kHz by ${(top[0]! - top[4]!).toFixed(1)} dB`);

    // The curve itself: unit slope at the origin, so the knob is character
    // and not level, and a ceiling that falls as the tape is pushed further
    // into its own bend.
    for (const bias of [0.1, 0.5, 0.9]) {
      const curve = tapeCurve(tapeKink(bias));
      const mid = curve.length >> 1;
      const slope = (curve[mid + 1]! - curve[mid - 1]!) / (2 * (2 / (curve.length - 1)));
      assert(Math.abs(slope - 1) < 0.02,
        `at bias ${bias} the curve's slope at the origin is ${slope.toFixed(3)}, not 1 — `
        + 'the bias knob would be a volume control');
    }
    assert(tapeCurve(tapeKink(0.1))[4095]! < tapeCurve(tapeKink(0.9))[4095]!,
      'less bias has to mean a lower ceiling');
  });

  await check('wow and flutter are two mechanisms, not one LFO twice', async () => {
    // A reel out of round turns once a revolution; a bearing chatters tens of
    // times a second.  Two modulations at one rate are a chorus, and a chorus
    // is not what a transport does — so each knob has to move its own rate
    // and leave the other alone.
    const trace = async (over: Record<string, number>): Promise<{ t: number; hz: number }[]> => {
      const [L] = await render({ ...STILL, bias: 0.9, drive: -6, ...over }, 1000, 0.2, 3.0);
      return pitchTrace(L, 1.0, 2.8);
    };
    const none = await trace({});
    assert(modulationCents(none, 1.7, 1000) < 0.05 && modulationCents(none, 23.3, 1000) < 0.05,
      'the transport moves with both knobs at zero');

    const wowOnly = await trace({ wow: 1 });
    const flutterOnly = await trace({ flutter: 1 });
    assert(modulationCents(wowOnly, 1.7, 1000) > 1.2,
      `wow at full moved the pitch ${modulationCents(wowOnly, 1.7, 1000).toFixed(2)} cents at `
      + 'its own rate');
    assert(modulationCents(wowOnly, 23.3, 1000) < 0.15,
      'the wow knob is moving the flutter rate too — they are one oscillator');
    assert(modulationCents(flutterOnly, 23.3, 1000) > 1.2,
      `flutter at full moved the pitch ${modulationCents(flutterOnly, 23.3, 1000).toFixed(2)} `
      + 'cents at its own rate');
    assert(modulationCents(flutterOnly, 1.7, 1000) < 0.15,
      'the flutter knob is moving the wow rate too');

    // And the scale is a real machine's: the default is a tired transport
    // rather than a broken one.
    const both = await trace({ wow: D['wow'] ?? 0.25, flutter: D['flutter'] ?? 0.25 });
    let lo = Infinity;
    let hi = 0;
    for (const s of both) { lo = Math.min(lo, s.hz); hi = Math.max(hi, s.hz); }
    const spread = 1200 * Math.log2(hi / lo);
    assert(spread > 1 && spread < 6,
      `the default transport wanders ${spread.toFixed(1)} cents — a serviced machine is about `
      + 'one and a tired one about three and a half; this is neither');
  });

  await check('crosstalk leaks the other channel, and narrows rather than widens', async () => {
    const leak = async (amount: number): Promise<number> => {
      const ctx = new OfflineAudioContext(2, SR, SR);
      const node = DEVICE!.create(ctx, { ...D, ...STILL, crosstalk: amount, bias: 0.9, drive: 0 });
      const osc = ctx.createOscillator();
      osc.frequency.value = 1000;
      const gain = ctx.createGain();
      gain.gain.value = 0.2;
      const merge = ctx.createChannelMerger(2);
      osc.connect(gain).connect(merge, 0, 0);
      merge.connect(node.input);
      node.output.connect(ctx.destination);
      osc.start();
      const buf = await ctx.startRendering();
      return db(rms(buf.getChannelData(1), 0.4, 0.5)) - db(rms(buf.getChannelData(0), 0.4, 0.5));
    };
    assert(await leak(0) < -120, 'a machine with the crosstalk at zero still leaks');
    const some = await leak(0.2);
    const lots = await leak(1);
    assert(some < -55 && some > -80,
      `the default leaks ${some.toFixed(1)} dB — a real machine is between about −50 and −60`);
    assert(lots > some + 8,
      `turning it up only changed the leak from ${some.toFixed(1)} to ${lots.toFixed(1)} dB`);
    assert(lots < -45, `at full it leaks ${lots.toFixed(1)} dB, which is a broken machine`);
  });

  await check('the picture is the machine, at the speed it says', () => {
    for (let i = 0; i < TAPE_SPEEDS.length; i++) {
      const spec = TAPE_SPEEDS[i]!;
      const pic = filterPictureFor('tape', { ...D, speed: i });
      assert(pic, `no picture at ${spec.ips} ips`);
      assert(pic!.curves.length === 2, 'the picture needs both curves');
      assert(pic!.curves[0]!.label.includes(String(spec.ips)), 'the curve is not labelled');
      const machine = pic!.curves[0]!.specs;
      const bump = machine.find((q) => q.type === 'peaking');
      const low = machine.find((q) => q.type === 'highpass');
      const top = machine.find((q) => q.type === 'lowpass');
      assert(bump && Math.abs(bump.freq - spec.bumpHz) < 1e-9,
        `the drawn bump is at ${bump?.freq} and the engine's at ${spec.bumpHz}`);
      assert(low && low.freq < spec.bumpHz, 'the drawn fall is not below the bump');
      assert(top && Math.abs(top.freq - Math.min(20_000, tapeTopHz(spec, 0.5))) < 1e-9,
        'the drawn top is not the engine\'s');
      // The second curve is the one that is invisible in the response and is
      // most of why the device sounds like tape.
      const onTape = pic!.curves[1]!.specs;
      assert(onTape.length === 1 && Math.abs(onTape[0]!.gain - spec.preDb) < 1e-9
        && Math.abs(onTape[0]!.freq - spec.preHz) < 1e-9,
        'the picture is not drawing what the tape actually receives');
      assert(pic!.caption.includes(`${spec.ips} ips`) && pic!.caption.includes(String(spec.bumpHz)),
        `the caption does not say the speed and the bump: ${pic!.caption}`);
    }
    // The bias moves the drawn top, because it moves the real one.
    const dull = filterPictureFor('tape', { ...D, bias: 0.9 })!;
    const keen = filterPictureFor('tape', { ...D, bias: 0.1 })!;
    const topOf = (pic: typeof dull): number =>
      pic.curves[0]!.specs.find((q) => q.type === 'lowpass')!.freq;
    assert(topOf(keen) > topOf(dull) * 1.5,
      `the drawn top is ${topOf(keen)} Hz at low bias and ${topOf(dull)} at high — the picture `
      + 'is not following the bias knob');
  });

  await check('Mix and Out are gains, and the dry path is not delayed', async () => {
    // The transport adds three milliseconds; the dry side has to be able to
    // sit beside it without a comb, so the blend has to be measured and not
    // assumed.
    const [wet] = await render({ ...STILL, mix: 1, drive: 0, bias: 0.9, bump: 0 }, 1000, 0.2);
    const [dry] = await render({ ...STILL, mix: 0 }, 1000, 0.2);
    assert(Math.abs(db(part(dry, 1000) / 0.2)) < 0.05,
      `fully dry the device is ${db(part(dry, 1000) / 0.2).toFixed(2)} dB, not unity`);
    const [half] = await render({ ...STILL, mix: 0.5, drive: 0, bias: 0.9, bump: 0 }, 1000, 0.2);
    const mixed = db(part(half, 1000) / 0.2);
    const both = db((part(wet, 1000) + part(dry, 1000)) / 2 / 0.2);
    assert(Math.abs(mixed - both) < 1.5,
      `half wet reads ${mixed.toFixed(2)} dB where the two halves sum to ${both.toFixed(2)} — `
      + 'the dry path is arriving at a different time from the wet one and combing');

    for (const out of [-12, -6, 0, 6]) {
      const [L] = await render({ ...STILL, out, drive: 0, bias: 0.9, bump: 0 }, 1000, 0.2);
      assert(Math.abs(db(part(L, 1000) / 0.2) - out) < 0.3,
        `Out at ${out} dB gave ${db(part(L, 1000) / 0.2).toFixed(2)}`);
    }
  });

  await check('the machine declares the time it takes, and the renderer agrees', async () => {
    // Two things ride on this and both are silent when it is wrong: the DAW's
    // delay compensation, which would put this whole track behind the others,
    // and the dry side of Mix, which would comb against the wet one.
    //
    // The oversampled shaper is most of it, and its cost is a property of the
    // RENDERER rather than of the spec — so it is measured here instead of
    // trusted, by correlating broadband noise against itself.  An impulse
    // gives a different and wrong answer; see `probeRendererLatency`, which
    // measures it because the two renderers here do not agree about it.
    const seeded = (ctx: OfflineAudioContext, n: number): AudioBuffer => {
      const buf = ctx.createBuffer(1, n, SR);
      const d = buf.getChannelData(0);
      let seed = 12345;
      for (let i = 0; i < n; i++) {
        seed = (Math.imul(seed ^ (seed >>> 15), 1 | seed) + 0x6d2b79f5) >>> 0;
        d[i] = ((seed >>> 8) / 8388608 - 1) * 0.05;
      }
      return buf;
    };
    // The reference and the output are two channels of ONE render, not two
    // renders compared.  A render's source has been seen to start a few
    // quanta late, and a slip in the REFERENCE reads exactly like the machine
    // being early — the search locks onto the shifted noise, correlates with
    // it perfectly, and reports the slip as the latency.  One source and one
    // start means a slip moves both channels together and cancels.
    const lagOf = async (
      build: (ctx: OfflineAudioContext, input: AudioNode) => AudioNode,
    ): Promise<number> => {
      const ctx = new OfflineAudioContext(2, SR, SR);
      const src = ctx.createBufferSource();
      src.buffer = seeded(ctx, SR);
      const merge = ctx.createChannelMerger(2);
      src.connect(merge, 0, 0);
      build(ctx, src).connect(merge, 0, 1);
      merge.connect(ctx.destination);
      src.start(0);
      const rendered = await ctx.startRendering();
      const ref = rendered.getChannelData(0);
      const out = rendered.getChannelData(1);
      let best = 0;
      let bestCorr = -Infinity;
      for (let lag = -8; lag <= 600; lag++) {
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
      return best;
    };

    const shaperLag = await lagOf((ctx, i) => i.connect(makeShaper(ctx, tapeCurve(0.45), '4x')));
    assert(shaperLag === oversampleLatencySamples(SR),
      `this renderer's 4x shaper is ${shaperLag} samples late and the constant says `
      + `${oversampleLatencySamples(SR)} — every device that blends around one is now `
      + 'misaligned by the difference');

    const declared = DEVICE!.latencyFor(D, SR);
    assert(declared === Math.round(TAPE_BASE_SEC * SR) + oversampleLatencySamples(SR),
      'the declaration is not the transport plus the shaper');

    // And the whole device, end to end, against what it declares.  Not exact,
    // and cannot be: the last sample or two is the group delay of filters
    // whose corners move with Speed and Bias, so a declaration that tracked
    // them would be a number that changed when the tone did.
    const whole = await lagOf((ctx, i) => {
      const node = DEVICE!.create(ctx, {
        ...D, ...STILL, mix: 1, bias: 0.95, drive: 0, bump: 0,
      });
      i.connect(node.input);
      return node.output;
    });
    assert(Math.abs(whole - declared) <= 3,
      `the machine takes ${whole} samples and says ${declared}`);
  });

  let failed = 0;
  for (const r of results) {
    if (!r.pass) failed++;
    console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.pass ? '' : ` — ${r.detail}`}`);
  }
  console.log(`\n${results.length - failed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
  process.exit(failed ? 1 : 0);
}

void main();
