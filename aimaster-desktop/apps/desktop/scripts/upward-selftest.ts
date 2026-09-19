/**
 * upward-selftest — the compressor that pushes the other way.
 *
 * Every other dynamics device in this app pushes DOWN.  `comp`, `mbcomp` and
 * `limiter` all start their ratio at 1:1, `gate` and `dyneq` only cut, and
 * nothing at all lifts what is quiet.  This one does, which puts it in a part
 * of the level range nothing else here had to work in — −20 to −60 dBFS —
 * and that turned out to be where the shared machinery was broken.
 *
 * So these checks are in two halves.  The first half is the DETECTOR, which
 * everything downstream rests on and which nothing was watching:
 *
 *   · the rectifier answers the same thing at −80 dBFS as at −60      (it did)
 *   · a detector's attack and release are one control                 (they were)
 *   · a knob marked 30 ms takes 30 ms                                 (it took 101)
 *
 * The second half is the device: that its transfer curve is the curve it
 * advertises, that its defaults do nothing, and that both of the things that
 * stop it eating a noise floor — the depth ceiling and the floor — actually
 * stop it.
 *
 * Run via:  pnpm --filter @aimaster/desktop test:upward
 */

import { OfflineAudioContext } from 'node-web-audio-api';
(globalThis as unknown as { OfflineAudioContext: unknown }).OfflineAudioContext = OfflineAudioContext;

import {
  TWO_POLE_63_PERCENT, absShaper, envelopeFollower, smoother, twoPoleLag,
} from '../src/renderer/daw/engine/plugin-kit.js';
import { findPlugin } from '../src/renderer/daw/engine/plugins.js';
import {
  UPWARD_CURVE_POINTS, UPWARD_KNEE_DB, upwardCurve, upwardGainDb, upwardOutputDb,
  upwardPeakGainDb,
} from '../src/renderer/daw/engine/upward.js';
import { detectorFor, readCurve } from '../src/renderer/daw/model/plugin-shapes.js';

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }
function close(a: number, b: number, tol: number, m: string): void {
  if (!(Math.abs(a - b) <= tol)) throw new Error(`${m} — got ${a.toFixed(3)}, want ${b.toFixed(3)} ±${tol}`);
}

const SR = 48_000;
const desc = findPlugin('upward')!;
const defaults = (): Record<string, number> => {
  const q: Record<string, number> = {};
  for (const d of desc.params) q[d.id] = d.default;
  return q;
};

/** A steady tone through a detector, read once it has settled. */
async function detectorLevel(
  levelDb: number, build: (ctx: OfflineAudioContext, from: AudioNode) => AudioNode,
): Promise<number> {
  const ctx = new OfflineAudioContext(1, SR * 4, SR);
  const osc = ctx.createOscillator();
  osc.frequency.value = 220;
  const amp = ctx.createGain();
  amp.gain.value = Math.pow(10, levelDb / 20);
  osc.connect(amp);
  build(ctx, amp as unknown as AudioNode).connect(ctx.destination);
  osc.start(0);
  const out = (await ctx.startRendering()).getChannelData(0);
  let sum = 0;
  const a = Math.round(SR * 3.4), b = Math.round(SR * 3.9);
  for (let i = a; i < b; i++) sum += out[i]!;
  return 20 * Math.log10(Math.abs(sum / (b - a)));
}

/** A steady tone through the whole device, as decibels out. */
async function through(levelDb: number, over: Record<string, number>): Promise<number> {
  const ctx = new OfflineAudioContext(1, SR * 4, SR);
  const inst = desc.create(ctx as unknown as BaseAudioContext, { ...defaults(), ...over });
  const osc = ctx.createOscillator();
  osc.frequency.value = 220;
  const amp = ctx.createGain();
  amp.gain.value = Math.pow(10, levelDb / 20);
  osc.connect(amp).connect(inst.input);
  inst.output.connect(ctx.destination);
  osc.start(0);
  const out = (await ctx.startRendering()).getChannelData(0);
  let sum = 0;
  const a = Math.round(SR * 3.4), b = Math.round(SR * 3.9);
  for (let i = a; i < b; i++) sum += out[i]! * out[i]!;
  return 20 * Math.log10(Math.sqrt(sum / (b - a)) * Math.SQRT2);
}

async function main(): Promise<void> {
  // ── The detector ──────────────────────────────────────────────────────────

  await check('the rectifier can still tell quiet from quieter', async () => {
    // It could not.  `absShaper` held |x| at 1024 points, which is an EVEN
    // count, so there is no point at x = 0 — the two either side both hold
    // 9.77e-4 and a WaveShaper interpolates a flat line between them.  Every
    // detector in this app therefore reported −60.2 dBFS for anything
    // quieter than −60.2 dBFS, which is most of where an upward compressor
    // lives.  Measured before the fix: −60, −70 and −80 dBFS all read −60.2.
    const read = async (db: number): Promise<number> => detectorLevel(db, (ctx, from) => {
      const rect = absShaper(ctx as unknown as BaseAudioContext);
      const env = smoother(ctx as unknown as BaseAudioContext, 40);
      from.connect(rect).connect(env.input);
      return env.output;
    });
    // A rectified sine averages to 2A/π, which is 3.92 dB under its
    // amplitude — that offset is expected and is what the follower calibrates
    // out.  What is being checked here is that the SLOPE is still one.
    const offset = 20 * Math.log10(2 / Math.PI);
    for (const db of [-40, -60, -70, -80]) {
      close(await read(db), db + offset, 0.1, `a ${db} dBFS tone rectifies`);
    }
    const quiet = await read(-80), less = await read(-70);
    close(less - quiet, 10, 0.1, 'ten decibels apart stay ten decibels apart');
  });

  await check('the rectifier is exact, not merely finer', () => {
    // |x| is piecewise linear, so a curve with a point AT zero reproduces it
    // exactly at every level — there is no resolution left to buy.  The odd
    // count is the whole mechanism, so it is what gets asserted.
    const ctx = new OfflineAudioContext(1, 128, SR);
    for (const asked of [1024, 1025, 32_768]) {
      const shaper = absShaper(ctx as unknown as BaseAudioContext, asked);
      const curve = shaper.curve!;
      assert(curve.length % 2 === 1, `${asked} points came back even (${curve.length})`);
      const middle = curve[(curve.length - 1) / 2]!;
      assert(middle === 0, `the point at zero holds ${middle}, not 0`);
      for (const x of [1e-6, 1e-4, 0.01, 0.5, -0.3]) {
        close(readCurve(curve, x), Math.abs(x), 1e-7, `|${x}|`);
      }
    }
  });

  await check('attack and release are two controls, not one', async () => {
    // `smoother` has one time constant, and the two devices that advertise
    // both knobs hand them both to it — so whichever was touched last is the
    // only one doing anything.  A maximum of two smoothers gives both:
    // rising, the fast one is on top; falling, the slow one is.
    const step = async (attackMs: number, releaseMs: number): Promise<{ rise: number; fall: number }> => {
      const ctx = new OfflineAudioContext(1, SR * 4, SR);
      const buffer = ctx.createBuffer(1, SR * 4, SR);
      const d = buffer.getChannelData(0);
      for (let i = 0; i < d.length; i++) {
        const t = i / SR;
        d[i] = t >= 1 && t < 2.5 ? 1 : 0.01;
      }
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      const env = envelopeFollower(ctx as unknown as BaseAudioContext, attackMs, releaseMs);
      src.connect(env.input);
      env.output.connect(ctx.destination);
      src.start(0);
      const out = (await ctx.startRendering()).getChannelData(0);
      const at = (t: number): number => out[Math.round(t * SR)]!;
      const find = (fromSec: number, target: number, up: boolean): number => {
        for (let i = Math.round(fromSec * SR); i < out.length; i++) {
          if (up ? out[i]! >= target : out[i]! <= target) return (i / SR - fromSec) * 1000;
        }
        return Number.NaN;
      };
      const low = at(0.99), high = at(2.49), rest = at(3.99);
      return {
        rise: find(1, low + 0.632 * (high - low), true),
        fall: find(2.5, high - 0.632 * (high - rest), false),
      };
    };
    for (const [a, r] of [[10, 400], [100, 150]] as const) {
      const got = await step(a, r);
      // 12% because a step's 63.2% point is read off a rendered buffer at one
      // sample's resolution and the two poles are not quite a single
      // exponential; the point is that the two numbers are DIFFERENT and each
      // follows its own knob.
      close(got.rise, a, a * 0.12, `attack ${a} ms`);
      close(got.fall, r, r * 0.12, `release ${r} ms`);
    }
    const fastUp = await step(10, 400), slowUp = await step(100, 400);
    assert(slowUp.rise > fastUp.rise * 3,
      `moving attack from 10 to 100 ms moved the rise from ${fastUp.rise.toFixed(0)} to `
      + `${slowUp.rise.toFixed(0)} ms — the knob is not connected`);
    assert(Math.abs(slowUp.fall - fastUp.fall) < fastUp.fall * 0.25,
      'moving the attack moved the release too — they are still one control');
  });

  await check('a knob marked in milliseconds takes that many milliseconds', async () => {
    // Two lags reach 63.2% at 2.1456 τ rather than at τ, so a detector built
    // from two has to be given a τ that much shorter or its panel lies.  The
    // rest of this app's detectors are built on `timeConstantToHz`, which
    // does not do this, and are 3.379× slower than they say.
    const settle = async (ms: number): Promise<number> => {
      const n = Math.round(SR * Math.max(4, (ms / 1000) * 8));
      const ctx = new OfflineAudioContext(1, n, SR);
      const buffer = ctx.createBuffer(1, n, SR);
      buffer.getChannelData(0).fill(1);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      const lag = twoPoleLag(ctx as unknown as BaseAudioContext, ms);
      src.connect(lag.input);
      lag.output.connect(ctx.destination);
      src.start(0);
      const out = (await ctx.startRendering()).getChannelData(0);
      for (let i = 0; i < n; i++) if (out[i]! >= 0.632) return (i / SR) * 1000;
      return Number.NaN;
    };
    for (const ms of [5, 40, 400, 1500]) {
      close(await settle(ms), ms, Math.max(0.05, ms * 0.005), `a ${ms} ms lag`);
    }
    assert(Math.abs(TWO_POLE_63_PERCENT - 2.1456) < 1e-9, 'the cascade factor moved');
  });

  await check('the lag passes DC untouched at every speed it offers', async () => {
    // The reason this device's detector is an IIR filter and not a biquad.
    // Measured in the browser, ONE lowpass biquad's DC gain: ×18.49 at
    // 1.34 Hz, ×12.66 at 1 Hz, ×5.49 at 0.5 Hz — and a 400 ms release asks
    // for 1.34 Hz.  A detector that multiplies DC by eighteen is not a
    // detector.
    for (const ms of [5, 40, 400, 1500]) {
      const n = Math.round(SR * Math.max(4, (ms / 1000) * 10));
      const ctx = new OfflineAudioContext(1, n, SR);
      const buffer = ctx.createBuffer(1, n, SR);
      buffer.getChannelData(0).fill(0.25);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      const lag = twoPoleLag(ctx as unknown as BaseAudioContext, ms);
      src.connect(lag.input);
      lag.output.connect(ctx.destination);
      src.start(0);
      const out = (await ctx.startRendering()).getChannelData(0);
      close(out[n - 1]! / 0.25, 1, 0.002, `a ${ms} ms lag's DC gain`);
    }
  });

  // ── The device ────────────────────────────────────────────────────────────

  await check('the curve it runs is the curve it advertises', async () => {
    const over = { depthDb: 12, thresholdDb: -20, ratio: 2, floorDb: -55 };
    for (const db of [-5, -20, -25, -30, -40, -50, -55, -60, -70]) {
      const out = await through(db, over);
      const want = upwardOutputDb(db, over.thresholdDb, over.ratio, over.depthDb, over.floorDb);
      close(out, want, 0.15, `a ${db} dBFS tone`);
    }
  });

  await check('at its defaults it does nothing at all', async () => {
    // Depth starts at zero, so an insert dropped on a playing track is
    // silent about it.  Checked at two levels because "does nothing" that is
    // only true at one level is a curve that happens to cross unity there.
    for (const db of [-10, -40]) {
      close(await through(db, {}), db, 0.01, `${db} dBFS through the defaults`);
    }
  });

  await check('the depth ceiling is a ceiling', () => {
    // Without it the lift grows without bound as the signal falls — and the
    // first thing it finds on the way down is the room.
    for (const depth of [3, 6, 12]) {
      const most = upwardPeakGainDb(-20, 8, depth, -80);
      assert(most <= depth + 0.01, `depth ${depth} reached ${most.toFixed(2)} dB`);
      assert(most > depth - 0.5, `depth ${depth} only ever reached ${most.toFixed(2)} dB`);
    }
    // A ratio of 1:1 is a straight line whatever else is set.
    assert(upwardPeakGainDb(-20, 1, 24, -80) === 0, '1:1 lifted something');
  });

  await check('the floor lets go, and the threshold cannot be crossed', () => {
    const [thr, ratio, depth, floor] = [-20, 3, 18, -50] as const;
    close(upwardGainDb(floor - UPWARD_KNEE_DB - 1, thr, ratio, depth, floor), 0, 1e-9,
      'below the knee the lift is gone');
    assert(upwardGainDb(floor, thr, ratio, depth, floor)
      > upwardGainDb(floor - UPWARD_KNEE_DB / 2, thr, ratio, depth, floor),
      'the floor does not fade — it is a step');
    close(upwardGainDb(thr, thr, ratio, depth, floor), 0, 1e-9, 'at the threshold, nothing');
    close(upwardGainDb(thr + 10, thr, ratio, depth, floor), 0, 1e-9, 'above it, nothing');

    // A floor set above the threshold leaves no region to work in.  It is
    // pushed back down rather than being allowed to cancel the device out.
    const crossed = upwardGainDb(-25, -20, 3, 12, -10);
    assert(crossed > 0, `a floor above the threshold silently disabled the device (${crossed})`);
  });

  await check('the picture is the engine\'s own curve, not a second copy', () => {
    const params = { thresholdDb: -22, ratio: 2.5, depthDb: 8, floorDb: -52 };
    const spec = detectorFor('upward', params);
    assert(spec !== null, 'the device draws nothing');
    const mine = upwardCurve(params.thresholdDb, params.ratio, params.depthDb, params.floorDb);
    assert(spec!.curve.length === mine.length, 'the drawn curve is a different size');
    for (let i = 0; i < mine.length; i += 97) {
      assert(spec!.curve[i] === mine[i], `the drawing and the engine part company at ${i}`);
    }
    assert(spec!.caption.includes('8.0') && spec!.caption.includes('-52'),
      `the caption does not say what it is doing: ${spec!.caption}`);
    // And at its defaults it says so rather than drawing a flat line with a
    // confident caption over it.
    const idle = detectorFor('upward', { ...params, depthDb: 0 })!;
    assert(idle.caption.includes('아무것도'), `an idle device claims ${idle.caption}`);
  });

  await check('the curve is fine enough where the device works', () => {
    // A WaveShaper's curve is indexed by amplitude, linearly, while this
    // device does its work at −20 to −60 dBFS where linear indexing is
    // sparse.  Measured worst error over −70…0 dBFS: 1.115 dB at 2048 points,
    // 0.061 dB at the 32768 it uses.
    const [thr, ratio, depth, floor] = [-20, 2, 12, -55] as const;
    const curve = upwardCurve(thr, ratio, depth, floor);
    assert(curve.length === UPWARD_CURVE_POINTS, 'the curve changed size');
    let worst = 0, worstAt = 0;
    for (let db = -70; db <= 0; db += 0.25) {
      const got = 20 * Math.log10(readCurve(curve, Math.pow(10, db / 20)));
      const err = Math.abs(got - upwardGainDb(db, thr, ratio, depth, floor));
      if (err > worst) { worst = err; worstAt = db; }
    }
    assert(worst < 0.1,
      `the curve is off by ${worst.toFixed(3)} dB at ${worstAt} dBFS`);

    // And the point of the size: a smaller one is genuinely worse, so this is
    // not 128 KiB spent on nothing.
    const small = new Float32Array(2048);
    for (let i = 0; i < 2048; i++) {
      const env = Math.abs((i / 2047) * 2 - 1);
      const level = 20 * Math.log10(env);
      small[i] = Math.pow(10, upwardGainDb(level, thr, ratio, depth, floor) / 20);
    }
    let coarse = 0;
    for (let db = -70; db <= 0; db += 0.25) {
      const got = 20 * Math.log10(readCurve(small, Math.pow(10, db / 20)));
      coarse = Math.max(coarse, Math.abs(got - upwardGainDb(db, thr, ratio, depth, floor)));
    }
    assert(coarse > worst * 5,
      `2048 points are only ${coarse.toFixed(3)} dB off against ${worst.toFixed(3)} — `
      + 'the extra 30720 are not buying anything');
  });

  await check('a quiet passage comes up and a loud one does not move', async () => {
    // The whole claim, on one signal rather than on the curve: a tone that
    // steps from loud to quiet comes out with the step smaller than it went
    // in, and the loud half is where it was.
    const over = { depthDb: 10, thresholdDb: -20, ratio: 3, floorDb: -60, attackMs: 20, releaseMs: 150 };
    const loudIn = -10, quietIn = -34;
    const loudOut = await through(loudIn, over);
    const quietOut = await through(quietIn, over);
    close(loudOut, loudIn, 0.05, 'the loud half is left alone');
    assert(quietOut > quietIn + 6,
      `the quiet half only came up ${(quietOut - quietIn).toFixed(1)} dB`);
    assert(loudOut - quietOut < (loudIn - quietIn) - 6,
      `the step went in at ${(loudIn - quietIn).toFixed(0)} dB and came out at `
      + `${(loudOut - quietOut).toFixed(0)} — nothing was evened out`);
  });

  console.log('\n=== Upward compression ===');
  for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  const bad = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - bad}/${results.length} passed${bad ? `, ${bad} FAILED` : ''}`);
  if (bad > 0) process.exit(1);
}

void main();
