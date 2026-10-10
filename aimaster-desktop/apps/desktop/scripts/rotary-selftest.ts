/**
 * rotary-selftest — whether the rotary speaker is a rotary speaker.
 *
 * The easy mistake with this effect is to build a chorus and a tremolo and
 * run them at the same rate.  That gets you a wobble, and it is not the same
 * thing, so the checks here are about the four claims that make it one:
 *
 *   · the pitch moves — a modulated delay IS a Doppler shift, because the
 *     delay is the time of flight and a changing time of flight is one
 *   · the level moves at the SAME rotation, ninety degrees out of phase with
 *     the pitch, because the horn is loudest as it passes you and that is
 *     exactly the moment its radial speed — and so its Doppler — is zero
 *   · the two microphones hear different phases of one rotation, which is
 *     where all the stereo comes from, the cabinet being mono
 *   · the bass drum runs slower than the treble horn and is not locked to it
 *
 * Run:  pnpm --filter @aimaster/desktop test:rotary
 */

import { OfflineAudioContext } from 'node-web-audio-api';

(globalThis as unknown as { OfflineAudioContext: unknown }).OfflineAudioContext = OfflineAudioContext;

import { defaultParams, findPlugin } from '../src/renderer/daw/engine/plugins.js';
import { lfoPictureFor } from '../src/renderer/daw/model/plugin-shapes.js';

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

/** A steady sine through the device, rendered offline. */
async function render(
  toneHz: number, overrides: Record<string, number> = {}, seconds = 4,
  after?: (set: (id: string, v: number) => void, ctx: OfflineAudioContext) => void,
): Promise<AudioBuffer> {
  const descriptor = findPlugin('rotary')!;
  const ctx = new OfflineAudioContext(2, SR * seconds, SR);
  const osc = ctx.createOscillator();
  osc.frequency.value = toneHz;
  const level = ctx.createGain();
  level.gain.value = 0.3;
  const params = { ...defaultParams('rotary'), ...overrides };
  const instance = descriptor.create(ctx as unknown as BaseAudioContext, params);
  osc.connect(level).connect(instance.input);
  instance.output.connect(ctx.destination as unknown as AudioNode);
  osc.start();
  after?.(instance.setParam, ctx);
  return (await ctx.startRendering()) as unknown as AudioBuffer;
}

/** A smoothed |x| envelope, one sample per `step` input samples. */
function envelope(data: Float32Array, step = 64): Float32Array {
  const n = Math.floor(data.length / step);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let peak = 0;
    for (let k = 0; k < step; k++) peak = Math.max(peak, Math.abs(data[i * step + k] ?? 0));
    out[i] = peak;
  }
  return out;
}

/** How much of a signal sits at `hz`, by Goertzel, with the mean removed. */
function atRate(env: Float32Array, hz: number, rate: number): number {
  let mean = 0;
  for (const v of env) mean += v;
  mean /= Math.max(1, env.length);
  const w = (2 * Math.PI * hz) / rate;
  const c = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < env.length; i++) {
    const win = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (env.length - 1));
    const s0 = ((env[i] ?? 0) - mean) * win + c * s1 - s2;
    s2 = s1; s1 = s0;
  }
  return Math.hypot(s1 - s2 * Math.cos(w), s2 * Math.sin(w)) / env.length;
}

/** The dominant modulation rate of an envelope, searched rather than assumed. */
function modRate(env: Float32Array, rate: number, lo = 0.2, hi = 12): number {
  let best = 0;
  let bestHz = 0;
  for (let hz = lo; hz <= hi; hz += 0.01) {
    const v = atRate(env, hz, rate);
    if (v > best) { best = v; bestHz = hz; }
  }
  return bestHz;
}

/**
 * Instantaneous frequency in short windows, from INTERPOLATED zero crossings.
 *
 * The right tool for a Doppler shift: the pitch is MOVING, which is exactly
 * what a transform smears into a band and what counting crossings does not.
 *
 * The interpolation is the part that matters, and the first version did not
 * have it.  Counting whole crossings in a 20 ms window at 1.2 kHz is 48
 * crossings, so the answer is quantised to ±2% — and the Doppler being
 * measured is ±0.33%.  It reported a 72-cent swing where the physics says 11,
 * and every one of those cents was the counter.  Taking the fractional
 * position of each crossing by linear interpolation between the two samples
 * either side gives sub-sample precision, and the measurement then agrees
 * with the arithmetic.
 */
function pitchTrack(data: Float32Array, windowSec: number): number[] {
  const w = Math.round(SR * windowSec);
  const out: number[] = [];
  for (let from = 0; from + w < data.length; from += w) {
    let first = -1;
    let last = -1;
    let count = 0;
    for (let i = 1; i < w; i++) {
      const a = data[from + i - 1] ?? 0;
      const b = data[from + i] ?? 0;
      if (a < 0 && b >= 0) {
        // Where between the two samples the line crosses zero.
        const t = from + i - 1 + (b === a ? 0 : -a / (b - a));
        if (first < 0) first = t; else { last = t; count++; }
      }
    }
    out.push(count > 0 && last > first ? (count * SR) / (last - first) : 0);
  }
  return out;
}

async function main(): Promise<void> {
  await check('the pitch moves, and the Doppler knob is what moves it', async () => {
    // Four kilohertz, not one: a two-pole crossover at 800 Hz still passes a
    // 1.2 kHz tone at about −9 dB, so the drum's slower, shallower Doppler
    // was landing on top of the horn's and the two together swung twice as
    // far as either.  That overlap is real and is how a crossover works —
    // it just makes 1.2 kHz the wrong place to measure ONE rotor.
    const buf = await render(4000, { rateHz: 1, throb: 0, mix: 100 });
    const track = pitchTrack(buf.getChannelData(0), 0.02).slice(20);
    const lo = Math.min(...track);
    const hi = Math.max(...track);
    const cents = 1200 * Math.log2(hi / lo);
    // The arithmetic: the delay swings ±0.52 ms at one turn a second, so its
    // rate of change is 0.52 ms × 2π × 1 Hz = 0.33%, and a 0.33% change in
    // the time of flight is a 0.33% change in pitch — 5.7 cents either side,
    // 11.4 peak to peak.  The check is stated against that number rather than
    // against a comfortable range, because a range wide enough to be safe was
    // wide enough to pass on the measurement's own noise.
    assert(cents > 8 && cents < 16,
      `the pitch swings ${cents.toFixed(1)} cents, not the 11.4 the geometry gives `
      + `— ${lo.toFixed(1)} to ${hi.toFixed(1)} Hz`);

    const flat = await render(4000, { rateHz: 1, throb: 0, doppler: 0, mix: 100 });
    const flatTrack = pitchTrack(flat.getChannelData(0), 0.02).slice(20);
    const flatCents = 1200 * Math.log2(Math.max(...flatTrack) / Math.min(...flatTrack));
    assert(flatCents < 1.5, `at Doppler 0 the pitch still swings ${flatCents.toFixed(1)} cents`);
    // And the knob scales it: twice the Doppler is twice the swing.
    const deep = await render(4000, { rateHz: 1, throb: 0, doppler: 200, mix: 100 });
    const deepTrack = pitchTrack(deep.getChannelData(0), 0.02).slice(20);
    const deepCents = 1200 * Math.log2(Math.max(...deepTrack) / Math.min(...deepTrack));
    assert(deepCents > cents * 1.7,
      `Doppler 200% swings ${deepCents.toFixed(1)} cents against ${cents.toFixed(1)} at 100%`);
  });

  await check('the level moves at the rotation rate, and Throb is what moves it', async () => {
    const rate = 1.4;
    const buf = await render(1200, { rateHz: rate, doppler: 0, mix: 100 });
    const env = envelope(buf.getChannelData(0));
    const found = modRate(env, SR / 64);
    assert(Math.abs(found - rate) < 0.12,
      `the level wobbles at ${found.toFixed(2)} Hz for a rotor set to ${rate}`);

    const still = await render(1200, { rateHz: rate, doppler: 0, throb: 0, mix: 100 });
    const stillEnv = envelope(still.getChannelData(0));
    const depth = atRate(stillEnv, rate, SR / 64) / Math.max(1e-9, atRate(env, rate, SR / 64));
    assert(depth < 0.25, `at Throb 0 the level still wobbles at ${(depth * 100).toFixed(0)}% of full`);
  });

  await check('the two microphones hear different phases of one rotation', async () => {
    // Everything stereo about a rotary speaker is this.  At 0° the mics are
    // in the same place and the output is mono; at 180° they are opposite and
    // one is loudest exactly when the other is quietest.
    const lr = async (angle: number): Promise<number> => {
      const buf = await render(1200, { rateHz: 1.2, micAngle: angle, doppler: 0, mix: 100 });
      const l = envelope(buf.getChannelData(0));
      const r = envelope(buf.getChannelData(1));
      // Correlation of the two envelopes about their means: +1 in step,
      // −1 opposite.
      let ml = 0;
      let mr = 0;
      for (let i = 0; i < l.length; i++) { ml += l[i] ?? 0; mr += r[i] ?? 0; }
      ml /= l.length; mr /= r.length;
      let num = 0;
      let dl = 0;
      let dr = 0;
      for (let i = 0; i < l.length; i++) {
        const a = (l[i] ?? 0) - ml;
        const b = (r[i] ?? 0) - mr;
        num += a * b; dl += a * a; dr += b * b;
      }
      return num / Math.sqrt(Math.max(1e-12, dl * dr));
    };
    const same = await lr(0);
    const quarter = await lr(90);
    const opposite = await lr(180);
    assert(same > 0.97, `at 0° the microphones are not in step (correlation ${same.toFixed(3)})`);
    assert(Math.abs(quarter) < 0.35, `at 90° the microphones correlate ${quarter.toFixed(3)}`);
    assert(opposite < -0.9, `at 180° the microphones are not opposite (${opposite.toFixed(3)})`);
  });

  await check('the pitch and the level are the same rotation, a quarter turn apart', async () => {
    // The claim that separates this from a chorus and a tremolo running side
    // by side.  The horn is loudest as it passes the microphone, and that is
    // precisely when its radial speed — and so its Doppler — is zero.  So the
    // level peaks where the pitch crosses its centre: a quarter turn apart.
    const rate = 1;
    const buf = await render(4000, { rateHz: rate, mix: 100 });
    const data = buf.getChannelData(0);
    const window = 0.02;
    const pitch = pitchTrack(data, window);
    const env = envelope(data, Math.round(SR * window));
    const n = Math.min(pitch.length, env.length) - 10;
    // Correlate the level against the pitch, and against the pitch shifted a
    // quarter turn.  In step means the same phase; the claim is the shifted
    // one wins by a long way.
    // Truncated to the SHORTER of the two, which the first version did not
    // do.  Shifting one series by a quarter turn makes it three samples
    // shorter, and reading past its end gave three terms of (0 − 4000 Hz)
    // against a signal whose whole variation is ±12 Hz.  Those three swamped
    // the other hundred and seventy-six and the answer came out zero, for a
    // device whose real correlation at that lag is 0.993.
    const corr = (a: number[], b: number[]): number => {
      const m = Math.min(a.length, b.length);
      let ma = 0;
      let mb = 0;
      for (let i = 0; i < m; i++) { ma += a[i] ?? 0; mb += b[i] ?? 0; }
      ma /= m; mb /= m;
      let num = 0;
      let da = 0;
      let db = 0;
      for (let i = 0; i < m; i++) {
        const p = (a[i] ?? 0) - ma;
        const q = (b[i] ?? 0) - mb;
        num += p * q; da += p * p; db += q * q;
      }
      return num / Math.sqrt(Math.max(1e-12, da * db));
    };
    const quarter = Math.round(0.25 / (rate * window));
    const level = Array.from(env.slice(10, n));
    const inPhase = corr(level, pitch.slice(10, n));
    const shifted = corr(level, pitch.slice(10 + quarter, n + quarter));
    // Measured: 0.993 a quarter turn apart and −0.015 in phase, which is as
    // clean a statement of "one rotation drives both" as this device can make.
    assert(Math.abs(shifted) > 0.9,
      `level against pitch correlates ${shifted.toFixed(3)} a quarter turn apart — `
      + 'they are not one rotation');
    assert(Math.abs(inPhase) < 0.3,
      `level against pitch correlates ${inPhase.toFixed(3)} IN PHASE — the level and the `
      + 'pitch are peaking together, which is a tremolo and a chorus rather than a rotor');
  });

  await check('the bass runs slower than the treble, and the crossover decides which', async () => {
    const rate = 2;
    const treble = await render(3000, { rateHz: rate, xoverHz: 800, doppler: 0, mix: 100 });
    const bass = await render(200, { rateHz: rate, xoverHz: 800, doppler: 0, mix: 100 });
    const hornRate = modRate(envelope(treble.getChannelData(0)), SR / 64);
    const drumRate = modRate(envelope(bass.getChannelData(0)), SR / 64);
    assert(Math.abs(hornRate - rate) < 0.15,
      `a 3 kHz tone wobbles at ${hornRate.toFixed(2)} Hz, not the horn's ${rate}`);
    assert(Math.abs(drumRate - rate * 0.78) < 0.15,
      `a 200 Hz tone wobbles at ${drumRate.toFixed(2)} Hz, not the drum's ${(rate * 0.78).toFixed(2)}`);
    assert(drumRate < hornRate - 0.2, 'the drum is not slower than the horn');

    // And the crossover moves the boundary: the same 3 kHz tone above a
    // 1600 Hz crossover is still the horn, but a 1 kHz tone changes hands.
    const midLow = await render(1000, { rateHz: rate, xoverHz: 1600, doppler: 0, mix: 100 });
    const midHigh = await render(1000, { rateHz: rate, xoverHz: 400, doppler: 0, mix: 100 });
    const asDrum = modRate(envelope(midLow.getChannelData(0)), SR / 64);
    const asHorn = modRate(envelope(midHigh.getChannelData(0)), SR / 64);
    assert(asDrum < asHorn - 0.2,
      `a 1 kHz tone wobbles at ${asDrum.toFixed(2)} Hz below the crossover and `
      + `${asHorn.toFixed(2)} above it — the crossover does not move it`);
  });

  await check('a speed change ramps rather than jumping', async () => {
    // A real rotor has mass.  The ramp is half of what people recognise about
    // the effect — it is the reason the switch is worth pressing.
    //
    // Stated comparatively, because the absolute numbers are not intuitive:
    // an exponential approach is 63% of the way there after ONE time
    // constant, and the time constant is a third of the stated accel, so a
    // 2.5-second accel is most of the way up in under a second.  The claim
    // that matters is that the knob changes how long it takes.
    const arrival = async (accelSec: number): Promise<number> => {
      const buf = await render(1200, { rateHz: 0.8, accelSec, doppler: 0, mix: 100 }, 9,
        (set) => { set('rateHz', 7); });
      const env = envelope(buf.getChannelData(0));
      const per = SR / 64;
      return modRate(env.slice(0, Math.round(per * 1.5)), per);
    };
    const quick = await arrival(0.05);
    const slow = await arrival(4);
    assert(quick > 5.5, `with no accel the rotor reads ${quick.toFixed(2)} Hz in the first second and a half`);
    assert(slow < quick - 1.5,
      `a four-second accel arrives at ${slow.toFixed(2)} Hz where an instant one reads ${quick.toFixed(2)}`);

    // And it does get there in the end.
    const buf = await render(1200, { rateHz: 0.8, accelSec: 4, doppler: 0, mix: 100 }, 12,
      (set) => { set('rateHz', 7); });
    const late = modRate(envelope(buf.getChannelData(0)).slice(Math.round((SR / 64) * 9)), SR / 64);
    assert(Math.abs(late - 7) < 0.5, `nine seconds after the change the rotor is at ${late.toFixed(2)} Hz`);
  });

  await check('Mix at zero is the dry signal, delayed and nothing else', async () => {
    const wet = await render(1200, { mix: 100 });
    const dry = await render(1200, { mix: 0 });
    const env = envelope(dry.getChannelData(0));
    const wobble = atRate(env, 0.8, SR / 64) / Math.max(1e-9, atRate(envelope(wet.getChannelData(0)), 0.8, SR / 64));
    assert(wobble < 0.1, `at Mix 0 the output still wobbles at ${(wobble * 100).toFixed(0)}% of full`);
    let peak = 0;
    for (let i = SR; i < dry.length; i++) peak = Math.max(peak, Math.abs(dry.getChannelData(0)[i] ?? 0));
    assert(Math.abs(20 * Math.log10(peak / 0.3)) < 1.5,
      `at Mix 0 the level is ${(20 * Math.log10(peak / 0.3)).toFixed(1)} dB from the input`);
  });

  await check('the picture on the panel is this device', () => {
    const picture = lfoPictureFor('rotary', defaultParams('rotary'));
    assert(picture, 'the rotary has no LFO picture');
    const labels = picture!.traces.map((t) => t.label);
    assert(labels.includes('HORN L') && labels.includes('HORN R') && labels.includes('DRUM'),
      `the picture draws ${labels.join(', ')}`);
    const rate = defaultParams('rotary')['rateHz'] ?? 0.8;
    // The drum trace has to run at the drum's rate and the horn at the
    // horn's, or the picture is telling the user they are locked.
    const horn = picture!.traces.find((t) => t.label === 'HORN L')!;
    const drum = picture!.traces.find((t) => t.label === 'DRUM')!;
    const period = (trace: { at: (t: number) => number }, guess: number): number => {
      // Where the trace comes back to its maximum.
      let best = 0;
      let bestT = 0;
      for (let t = guess * 0.5; t < guess * 1.8; t += 0.001) {
        const v = trace.at(t);
        if (v > best) { best = v; bestT = t; }
      }
      return bestT;
    };
    assert(Math.abs(period(horn, 1 / rate) - 1 / rate) < 0.05 / rate,
      'the horn trace does not run at the horn\'s rate');
    assert(Math.abs(period(drum, 1 / (rate * 0.78)) - 1 / (rate * 0.78)) < 0.05 / rate,
      'the drum trace does not run at the drum\'s rate');
    // And the two mics have to be out of step by the mic angle.
    const hornR = picture!.traces.find((t) => t.label === 'HORN R')!;
    assert(Math.abs(horn.at(0) - hornR.at(0)) > 0.1,
      'the two microphone traces are drawn in step at 90°');
  });

  console.log('');
  for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  const bad = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - bad}/${results.length} passed${bad ? `, ${bad} FAILED` : ''}`);
  if (bad) process.exit(1);
}

void main();
