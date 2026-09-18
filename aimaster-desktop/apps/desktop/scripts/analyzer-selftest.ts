/**
 * analyzer-selftest — the two things a standalone analyser adds, measured.
 *
 * The spectrum arithmetic already has its own file and its own checks; what
 * is new here is the average and the goniometer, and both have a way of being
 * subtly wrong that still looks plausible on screen:
 *
 *   · an average taken in DECIBELS is the geometric mean, which is always
 *     lower than the level of the energy that was there, and unboundedly so
 *     when the signal is quiet part of the time.  A meter reading a level the
 *     signal never had is worse than no meter.
 *   · a goniometer plotted RAW is a diagonal for mono, and "diagonal" is not
 *     a shape anyone reads at speed.  The rotation is what makes up-down mean
 *     level and left-right mean width.
 *
 * And the ballistics are checked against the clock rather than against the
 * frame counter, because a meter that reads differently on a loaded machine
 * is a meter that cannot be compared with anything.
 *
 * Run: pnpm --filter @aimaster/desktop test:analyzer
 */

import { OfflineAudioContext } from 'node-web-audio-api';

(globalThis as unknown as { OfflineAudioContext: unknown }).OfflineAudioContext = OfflineAudioContext;

import { defaultParams, findPlugin } from '../src/renderer/daw/engine/plugins.js';
import {
  AVERAGE_LABELS, AVERAGE_NOTES, AVERAGE_SECONDS, advanceAverage, averageSeconds,
  correlationNote, goniometerPoints, peakBand, scopeReading,
} from '../src/renderer/daw/model/analyzer-view.js';
import { DEFAULT_SCALE, columnHz } from '../src/renderer/daw/model/spectrum-view.js';
import { filterPictureFor } from '../src/renderer/daw/model/plugin-shapes.js';

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

/** Run an average over a sequence of frames and return where it ended. */
function runAverage(
  levelsDb: readonly number[], dtSec: number, tauSec: number, startDb = -96,
): number {
  const average = new Float32Array([startDb]);
  const target = new Float32Array(1);
  for (const db of levelsDb) {
    target[0] = db;
    advanceAverage(average, target, dtSec, tauSec, -96);
  }
  return average[0]!;
}

async function main(): Promise<void> {
  await check('the average is taken in power, not in decibels', () => {
    // The fact the whole file turns on.  A band that is -20 dB half the time
    // and -60 dB the other half carries the energy of -23.0 dB; averaging the
    // DECIBELS gives -40, which is a level this signal never had at any
    // instant and is 17 dB from the truth.
    const frames: number[] = [];
    for (let i = 0; i < 4000; i++) frames.push(i % 2 === 0 ? -20 : -60);
    const got = runAverage(frames, 1 / 60, 1, -20);

    const power = 10 * Math.log10(0.5 * (10 ** -2 + 10 ** -6));
    assert(Math.abs(power - -23.01) < 0.02, `the arithmetic itself moved — ${power.toFixed(2)}`);
    assert(Math.abs(got - power) < 0.2,
      `the average read ${got.toFixed(2)} dB where the energy is ${power.toFixed(2)} — a mean of `
      + `decibels would read ${((-20 + -60) / 2).toFixed(1)}`);
    assert(Math.abs(got - -40) > 10, 'it is reading the mean of the decibels');
  });

  await check('the average converges at the rate its label claims', () => {
    // A one-pole is not a box.  The picker says "time constant", and this is
    // what that has to mean: 63 % of a step in one of them, 95 % in three.
    for (const tau of AVERAGE_SECONDS) {
      const step = (seconds: number): number => {
        const dt = 1 / 60;
        const frames = Array.from({ length: Math.round(seconds / dt) }, () => 0);
        return runAverage(frames, dt, tau, -40);
      };
      // From -40 dB to 0 dB, in power: 63 % of the way is 10·log10(0.63) up
      // from the difference in power, not 63 % of the decibels.
      const at1 = 10 ** (step(tau) / 10);
      const at3 = 10 ** (step(tau * 3) / 10);
      const from = 10 ** (-40 / 10);
      const to = 1;
      const f1 = (at1 - from) / (to - from);
      const f3 = (at3 - from) / (to - from);
      assert(Math.abs(f1 - 0.632) < 0.02,
        `${tau}s reached ${(f1 * 100).toFixed(1)}% of the step in one time constant, not 63%`);
      assert(Math.abs(f3 - 0.950) < 0.02,
        `${tau}s reached ${(f3 * 100).toFixed(1)}% in three, not 95%`);
    }
    // And the notes say exactly that, so the picker is not making a different
    // promise from the code.
    AVERAGE_SECONDS.forEach((sec, i) => {
      assert(AVERAGE_NOTES[i]!.includes(`${sec}초`), `note ${i} does not name its window`);
      assert(AVERAGE_NOTES[i]!.includes('63%') && AVERAGE_NOTES[i]!.includes('95%'),
        `note ${i} does not say what a time constant means — ${AVERAGE_NOTES[i]}`);
      assert(AVERAGE_LABELS[i]!.includes(String(sec)), `label ${i} and window ${sec} disagree`);
    });
  });

  await check('the average reads the same on a fast machine and a slow one', () => {
    // `exp(-dt/tau)` rather than the `1 - dt/tau` approximation, and the
    // measurement has to be taken where the two differ or the check is
    // decoration.  They agree to four decimals at sixty frames a second; at
    // EIGHT, with the shortest window, the approximation has decayed 6.6 %
    // further than the pole has by the time one time constant is up.
    //
    // Written first as a comparison of two frame rates at three seconds, and
    // that version passed with the approximation in place — the difference
    // there is 0.1 dB and the tolerance was 0.2.  What discriminates is the
    // fraction of the step taken after exactly one time constant, which is
    // 63.2 % for a pole and nothing else.
    const fraction = (fps: number, tau: number): number => {
      const dt = 1 / fps;
      const frames = Array.from({ length: Math.round(tau / dt) }, () => 0);
      const ended = 10 ** (runAverage(frames, dt, tau, -40) / 10);
      const from = 10 ** (-40 / 10);
      return (ended - from) / (1 - from);
    };
    for (const fps of [120, 60, 30, 8, 3]) {
      const f = fraction(fps, 1);
      assert(Math.abs(f - 0.632) < 0.005,
        `at ${fps} frames a second one time constant took ${(f * 100).toFixed(1)}% of the step, `
        + 'not 63.2% — the pole is being approximated, so the meter reads differently '
        + 'depending on how busy the computer is');
    }
    // And the same reading after a fixed wall-clock time, which is what two
    // people comparing meters would actually be comparing.
    const after = (fps: number): number => runAverage(
      Array.from({ length: Math.round(4 * fps) }, () => -10), 1 / fps, 1, -60,
    );
    assert(Math.abs(after(120) - after(3)) < 0.01,
      `four seconds read ${after(120).toFixed(4)} at 120 fps and ${after(3).toFixed(4)} at 3`);
  });

  await check('the goniometer puts mono upright and antiphase flat', () => {
    // The rotation, which is the whole readability of the display.  Plotted
    // raw these three cases are a diagonal, the other diagonal, and a square
    // — three shapes that all have to be decoded before they mean anything.
    const n = 2048;
    const a = new Float32Array(n);
    const b = new Float32Array(n);
    let seed = 7;
    for (let i = 0; i < n; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      a[i] = (seed / 0x7fffffff) * 2 - 1;
    }

    const spread = (left: Float32Array, right: Float32Array): { x: number; y: number } => {
      const out = new Float32Array(512 * 2);
      const count = goniometerPoints(left, right, out);
      assert(count > 0, 'no points were written');
      let x = 0;
      let y = 0;
      for (let p = 0; p < count; p++) {
        x = Math.max(x, Math.abs(out[p * 2] ?? 0));
        y = Math.max(y, Math.abs(out[p * 2 + 1] ?? 0));
      }
      return { x, y };
    };

    const mono = spread(a, a);
    assert(mono.x < 1e-6,
      `mono drew ${mono.x.toFixed(4)} wide — it is supposed to be a vertical line`);
    // And it reaches the EDGE and no further.  The orthonormal rotation puts
    // full-scale mono at 1.414, which is drawn outside a picture whose edge
    // means full scale — measured in the app doing exactly that.
    let peak = 0;
    for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(a[i] ?? 0));
    // Reaches the edge and never passes it.  Not equality: the scope takes
    // every fourth sample, so the tallest point it draws is the tallest of
    // the ones it took, which is a shade under the block's own peak.
    assert(mono.y <= peak + 1e-6,
      `mono at a peak of ${peak.toFixed(3)} drew ${mono.y.toFixed(3)} tall — it is outside a `
      + 'picture whose edge means full scale, so the scaling is the orthonormal rotation '
      + 'rather than mid/side');
    assert(mono.y > peak * 0.95,
      `mono only reached ${(mono.y / peak * 100).toFixed(1)}% of the way to the edge`);

    for (let i = 0; i < n; i++) b[i] = -(a[i] ?? 0);
    const flipped = spread(a, b);
    assert(flipped.y < 1e-6 && flipped.x > peak * 0.99,
      `antiphase drew ${flipped.x.toFixed(3)} wide and ${flipped.y.toFixed(4)} tall — it is `
      + 'supposed to be a horizontal line, which is the one reading that is a fault');

    let other = 99;
    for (let i = 0; i < n; i++) {
      other = (other * 1103515245 + 12345) & 0x7fffffff;
      b[i] = (other / 0x7fffffff) * 2 - 1;
    }
    const wide = spread(a, b);
    assert(wide.x > 0.3 && wide.y > 0.3,
      `uncorrelated drew ${wide.x.toFixed(2)} by ${wide.y.toFixed(2)} — it is supposed to fill `
      + 'the picture in both directions');
  });

  await check('the scope reads the whole block, not the start of it', () => {
    // A scope that took its points from the first 512 samples of a 2048
    // sample block would show a quarter of the audio and miss the rest — and
    // it would look perfectly normal doing it.
    const n = 2048;
    const left = new Float32Array(n);
    const right = new Float32Array(n);
    // Silent for the first three quarters, loud for the last.
    for (let i = (n * 3) / 4; i < n; i++) { left[i] = 0.8; right[i] = 0.8; }
    const out = new Float32Array(512 * 2);
    const count = goniometerPoints(left, right, out);
    let seen = 0;
    for (let p = 0; p < count; p++) if (Math.abs(out[p * 2 + 1] ?? 0) > 0.5) seen++;
    assert(seen > count * 0.2,
      `only ${seen} of ${count} points landed in the loud quarter — the scope is reading the `
      + 'front of the block instead of across it');
  });

  await check('correlation and width say the same thing two ways', () => {
    const n = 4096;
    const a = new Float32Array(n);
    const b = new Float32Array(n);
    let seed = 31;
    for (let i = 0; i < n; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      a[i] = (seed / 0x7fffffff) * 2 - 1;
    }
    const mono = scopeReading(a, a);
    assert(Math.abs(mono.correlation - 1) < 1e-6 && mono.widthPct < 1e-3,
      `mono read correlation ${mono.correlation.toFixed(4)} and width ${mono.widthPct.toFixed(2)}%`);

    for (let i = 0; i < n; i++) b[i] = -(a[i] ?? 0);
    const flipped = scopeReading(a, b);
    assert(Math.abs(flipped.correlation + 1) < 1e-6 && Math.abs(flipped.widthPct - 200) < 1e-3,
      `antiphase read ${flipped.correlation.toFixed(4)} and ${flipped.widthPct.toFixed(1)}%`);

    let other = 12_345;
    for (let i = 0; i < n; i++) {
      other = (other * 1103515245 + 12345) & 0x7fffffff;
      b[i] = (other / 0x7fffffff) * 2 - 1;
    }
    const wide = scopeReading(a, b);
    assert(Math.abs(wide.correlation) < 0.1 && Math.abs(wide.widthPct - 100) < 10,
      `uncorrelated read ${wide.correlation.toFixed(3)} and ${wide.widthPct.toFixed(0)}%`);

    // Peak is across BOTH channels, or a scope on a signal that is only in one
    // of them would scale itself to silence.
    const oneSided = scopeReading(a, new Float32Array(n));
    assert(oneSided.peak > 0.5, `one channel alone read a peak of ${oneSided.peak.toFixed(3)}`);
  });

  await check('the readout names a frequency somebody can act on', () => {
    // Read off the TILTED columns: untilted, the loudest column of almost any
    // music is in the bottom octave every single time, and a readout that
    // always says the same thing is one nobody looks at twice.
    const width = 400;
    const columns = new Float32Array(width).fill(-80);
    const want = 3150;
    let at = 0;
    for (let x = 0; x < width; x++) {
      if (Math.abs(columnHz(x, width, DEFAULT_SCALE) - want)
        < Math.abs(columnHz(at, width, DEFAULT_SCALE) - want)) at = x;
    }
    columns[at] = -18;
    const peak = peakBand(columns, DEFAULT_SCALE);
    assert(peak.column === at && Math.abs(peak.db - -18) < 1e-6,
      `the readout found column ${peak.column} at ${peak.db.toFixed(1)} dB, not ${at} at -18`);
    assert(Math.abs(peak.hz - want) < want * 0.02,
      `it named ${peak.hz.toFixed(0)} Hz where the peak is at ${want}`);
  });

  await check('the one correlation reading that is a fault says so', () => {
    // Every other reading on this meter is a choice.  Below zero is not: it
    // means the two channels are cancelling, and a mix that does that loses
    // the cancelled part the moment anything sums it.
    assert(correlationNote(1).includes('모노'), correlationNote(1));
    assert(correlationNote(0.7).includes('호환'), correlationNote(0.7));
    assert(correlationNote(0).includes('3 dB'), correlationNote(0));
    assert(correlationNote(-0.8).includes('사라집니다'), correlationNote(-0.8));
    assert(correlationNote(Number.NaN) === '신호 없음', correlationNote(Number.NaN));
  });

  await check('it does not touch the audio, and says it is not late', async () => {
    // An analyser that coloured what it measured would be measuring itself.
    const n = SR;
    const ctx = new OfflineAudioContext(1, n, SR);
    const buffer = ctx.createBuffer(1, n, SR);
    const data = buffer.getChannelData(0);
    let seed = 4242;
    for (let i = 0; i < n; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      data[i] = ((seed / 0x7fffffff) * 2 - 1) * 0.3;
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const device = findPlugin('analyzer')!.create(
      ctx as unknown as BaseAudioContext, defaultParams('analyzer'),
    );
    src.connect(device.input);
    device.output.connect(ctx.destination as unknown as AudioNode);
    src.start(0);
    const out = (await ctx.startRendering()).getChannelData(0);
    let worst = 0;
    for (let i = 0; i < n; i++) worst = Math.max(worst, Math.abs((out[i] ?? 0) - (data[i] ?? 0)));
    assert(worst === 0,
      `the analyser changed the signal by ${worst.toExponential(2)} — it is a wire with a `
      + 'picture attached, and a wire is bit-identical');
    assert(findPlugin('analyzer')!.latencyFor(defaultParams('analyzer'), SR) === 0,
      'it declares a latency it does not have');
    assert((findPlugin('analyzer')!.automatableParams ?? []).length === 0,
      'it offers an automation lane for a setting that only changes the picture');
  });

  await check('the still picture is the tilt, and the tilt is what it says', () => {
    // The device does nothing to the sound, so the only honest still picture
    // is what the DISPLAY adds — and that is the setting that decides whether
    // a flat reading means balanced or means nothing.
    for (let i = 0; i < AVERAGE_SECONDS.length; i++) {
      const picture = filterPictureFor('analyzer', {
        ...defaultParams('analyzer'), slope: 2, average: i,
      });
      assert(picture !== null, 'the analyser draws no picture');
      assert(picture!.caption.includes(`${averageSeconds(i)}초`),
        `the caption does not say the averaging window — ${picture!.caption}`);
    }
    const drawn = filterPictureFor('analyzer', { ...defaultParams('analyzer'), slope: 2 })!;
    const curve = drawn.curves[0]!;
    assert(curve.dbAt !== undefined, 'the tilt is not drawn as a sampled curve');
    // 4.5 dB per octave, pivoting at 1 kHz: four octaves up is +18, and the
    // pivot itself does not move.
    assert(Math.abs(curve.dbAt!(1000)) < 1e-9, `the pivot moved — ${curve.dbAt!(1000)}`);
    assert(Math.abs(curve.dbAt!(16_000) - 18) < 0.01,
      `four octaves above the pivot reads ${curve.dbAt!(16_000).toFixed(2)}, not 18`);
    assert(Math.abs(curve.dbAt!(62.5) + 18) < 0.01,
      `four octaves below reads ${curve.dbAt!(62.5).toFixed(2)}, not -18`);

    const flat = filterPictureFor('analyzer', { ...defaultParams('analyzer'), slope: 0 })!;
    assert(Math.abs(flat.curves[0]!.dbAt!(16_000)) < 1e-9, 'the no-tilt setting still tilts');
    assert(flat.caption.includes('우하향'),
      `the untilted caption does not say what it costs — ${flat.caption}`);
  });

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} passed${passed === results.length ? '' : `, ${results.length - passed} FAILED`}`);
  if (passed !== results.length) process.exit(1);
}

void main();
