/**
 * spectrum-view-selftest.ts — whether the analyser shows what is there.
 *
 * The four decisions in `spectrum-view.ts` are all ones a plausible
 * implementation gets wrong, and three of them fail SILENTLY: the picture
 * still looks like a spectrum, it is just not this signal's spectrum.  So
 * each one is checked against a frame built to contain a known thing, and the
 * naive alternative is computed alongside and shown to lose it.
 *
 *   · a one-bin resonance at 15 kHz survives being drawn  (max, not mean)
 *   · no bin anywhere is skipped by the columns             (tiling)
 *   · the bottom of the range is a line, not a staircase    (interpolation)
 *   · the tilt is a tilt and pivots where it says            (slope)
 *   · the line rises at once and falls at the stated rate    (ballistics)
 *   · the hold line holds, and then lets go                  (hold)
 *
 * Run via:  pnpm --filter @aimaster/desktop test:spectrum-view
 */

import { readFileSync } from 'node:fs';
import {
  DEFAULT_SCALE, SLOPE_PIVOT_HZ, SPECTRUM_FALL_DB_PER_SEC, SPECTRUM_HOLD_SEC,
  SPECTRUM_HOLD_FALL_DB_PER_SEC, SPECTRUM_SLOPES, advanceHold, advanceSpectrum,
  columnHz, dbToY, slopeDbAt, spectrumColumns,
} from '../src/renderer/daw/model/spectrum-view.js';

const results: Array<{ name: string; pass: boolean; detail?: string }> = [];
function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true }); } catch (err) {
    results.push({ name, pass: false, detail: (err as Error).message });
  }
}

const SR = 48_000;
const BINS = 4096;                 // an 8192-point FFT
const BIN_HZ = SR / (2 * BINS);
const FLOOR = -120;

/** A frame at a flat level, with optional single-bin spikes. */
function frame(level: number, spikes: ReadonlyArray<[number, number]> = []): Float32Array {
  const bins = new Float32Array(BINS).fill(level);
  for (const [hz, db] of spikes) {
    const k = Math.round(hz / BIN_HZ);
    if (k >= 0 && k < BINS) bins[k] = db;
  }
  return bins;
}

check('the axis is logarithmic, so an octave is an octave anywhere', () => {
  const width = 600;
  const xOf = (hz: number): number => {
    let best = 0; let bestErr = Infinity;
    for (let x = 0; x < width; x++) {
      const err = Math.abs(columnHz(x, width, DEFAULT_SCALE) - hz);
      if (err < bestErr) { bestErr = err; best = x; }
    }
    return best;
  };
  const low = xOf(80) - xOf(40);
  const high = xOf(10_000) - xOf(5000);
  assert(Math.abs(low - high) <= 2,
    `the octave 40–80 Hz is ${low} px and 5–10 kHz is ${high} px`);
  assert(columnHz(0, width, DEFAULT_SCALE) === DEFAULT_SCALE.minHz, 'the left edge is not minHz');
  assert(Math.abs(columnHz(width - 1, width, DEFAULT_SCALE) - DEFAULT_SCALE.maxHz) < 1,
    'the right edge is not maxHz');
});

check('a one-bin resonance at 15 kHz is still there after it is drawn', () => {
  // THE check.  At 15 kHz a 600-pixel log axis puts about 70 bins in one
  // column, so a mean would divide this spike by seventy and draw nothing.
  const width = 600;
  const bins = frame(-80, [[15_000, -20]]);
  const out = spectrumColumns(bins, SR, new Float32Array(width), DEFAULT_SCALE, 0);
  let loudest = -Infinity; let at = 0;
  for (let x = 0; x < width; x++) {
    const v = out[x] ?? -Infinity;
    if (v > loudest) { loudest = v; at = x; }
  }
  assert(loudest > -21,
    `the 15 kHz spike reads ${loudest.toFixed(1)} dB where the bin says −20`);
  const hz = columnHz(at, width, DEFAULT_SCALE);
  assert(Math.abs(hz - 15_000) < 15_000 * 0.03,
    `the spike was drawn at ${hz.toFixed(0)} Hz instead of 15 kHz`);

  // What the naive version would have shown, computed here so the number in
  // the claim above is a comparison and not an assertion about nothing.
  const lower = columnHz(at - 0.5, width, DEFAULT_SCALE) / BIN_HZ;
  const upper = columnHz(at + 0.5, width, DEFAULT_SCALE) / BIN_HZ;
  let sum = 0; let n = 0;
  for (let k = Math.ceil(lower); k <= Math.floor(upper); k++) {
    sum += Math.pow(10, (bins[k] ?? FLOOR) / 20); n += 1;
  }
  const meanDb = 20 * Math.log10(sum / Math.max(1, n));
  assert(meanDb < loudest - 10,
    `averaging that column gives ${meanDb.toFixed(1)} dB, not far enough below the peak `
    + 'for this check to be about anything');
});

check('no bin anywhere is skipped by the columns', () => {
  // The columns have to TILE the axis.  Sampling the spectrum at one
  // frequency per column instead leaves gaps between them, and a resonance
  // that lands in a gap is invisible — intermittently, depending on the
  // window width, which is the worst way for a bug like this to behave.
  const width = 480;
  const out = new Float32Array(width);
  const audible = Math.floor(DEFAULT_SCALE.maxHz / BIN_HZ);
  let missed = 0; let firstMiss = -1;
  for (let k = Math.ceil(DEFAULT_SCALE.minHz / BIN_HZ); k <= audible; k++) {
    const bins = frame(-100);
    bins[k] = -10;
    spectrumColumns(bins, SR, out, DEFAULT_SCALE, 0);
    let loudest = -Infinity;
    for (let x = 0; x < width; x++) loudest = Math.max(loudest, out[x] ?? -Infinity);
    if (loudest < -30) { missed += 1; if (firstMiss < 0) firstMiss = k; }
  }
  assert(missed === 0,
    `${missed} of ${audible} bins are drawn nowhere — the first is bin ${firstMiss} `
    + `(${(firstMiss * BIN_HZ).toFixed(1)} Hz)`);
});

check('the bottom of the range is a line and not a staircase', () => {
  // Below about 100 Hz there are fewer bins than columns.  A ramp across the
  // bins has to come out as a ramp across the columns, not as flat runs with
  // steps between them.
  const width = 600;
  const bins = new Float32Array(BINS);
  for (let k = 0; k < BINS; k++) bins[k] = -100 + k * 0.5;
  const out = spectrumColumns(bins, SR, new Float32Array(width), DEFAULT_SCALE, 0);
  // Columns covering 25–90 Hz, which is the region with under one bin each.
  let flat = 0; let total = 0;
  for (let x = 1; x < width; x++) {
    const hz = columnHz(x, width, DEFAULT_SCALE);
    if (hz < 25 || hz > 90) continue;
    total += 1;
    if (Math.abs((out[x] ?? 0) - (out[x - 1] ?? 0)) < 1e-9) flat += 1;
  }
  assert(total > 20, `only ${total} columns fall in the interpolated region`);
  assert(flat === 0,
    `${flat} of ${total} columns below 90 Hz repeat the one before them — that is a staircase`);
});

check('the tilt pivots at 1 kHz and is the slope it says', () => {
  for (const slope of SPECTRUM_SLOPES) {
    assert(Math.abs(slopeDbAt(SLOPE_PIVOT_HZ, slope)) < 1e-9,
      `slope ${slope} moves 1 kHz by ${slopeDbAt(SLOPE_PIVOT_HZ, slope).toFixed(3)} dB`);
    assert(Math.abs(slopeDbAt(2000, slope) - slope) < 1e-9,
      `slope ${slope} lifts the octave above the pivot by ${slopeDbAt(2000, slope).toFixed(2)} dB`);
    assert(Math.abs(slopeDbAt(500, slope) + slope) < 1e-9,
      `slope ${slope} does not drop the octave below the pivot by the same amount`);
  }
  // And it reaches the picture: a flat frame drawn tilted must not be flat.
  const width = 300;
  const flat = spectrumColumns(frame(-40), SR, new Float32Array(width), DEFAULT_SCALE, 0);
  const tilted = spectrumColumns(frame(-40), SR, new Float32Array(width), DEFAULT_SCALE, 4.5);
  assert(Math.abs((flat[10] ?? 0) - (flat[width - 10] ?? 0)) < 0.5,
    'an untilted flat frame is not flat');
  assert((tilted[width - 10] ?? 0) - (tilted[10] ?? 0) > 30,
    'a tilted flat frame did not come out tilted');
});

check('the line jumps up at once and comes down at the stated rate', () => {
  const display = new Float32Array(4).fill(-90);
  advanceSpectrum(display, new Float32Array([-10, -10, -10, -10]), 1 / 60, FLOOR);
  for (const v of display) assert(v === -10, `a rise was smoothed to ${v.toFixed(1)} dB`);

  advanceSpectrum(display, new Float32Array(4).fill(-90), 0.1, FLOOR);
  const want = -10 - SPECTRUM_FALL_DB_PER_SEC * 0.1;
  assert(Math.abs((display[0] ?? 0) - want) < 1e-6,
    `after 100 ms of silence the line is at ${(display[0] ?? 0).toFixed(2)}, not ${want.toFixed(2)}`);

  // A frame that arrives late must not make the line fall off a cliff — a
  // dropped frame would otherwise blank the display.
  const slow = new Float32Array(1).fill(0);
  advanceSpectrum(slow, new Float32Array([-90]), 5, FLOOR);
  assert((slow[0] ?? 0) > -90,
    'a five-second gap between frames dropped the line straight to the floor');
});

check('the hold line holds, and then lets go', () => {
  const hold = new Float32Array(1).fill(-90);
  const ages = new Float32Array(1);
  advanceHold(hold, ages, new Float32Array([-20]), 1 / 60, FLOOR);
  assert(hold[0] === -20, 'the hold did not take the peak');

  // Quiet again, but not for long enough yet.
  let elapsed = 0;
  while (elapsed < SPECTRUM_HOLD_SEC - 0.2) {
    advanceHold(hold, ages, new Float32Array([-90]), 0.05, FLOOR);
    elapsed += 0.05;
  }
  assert(hold[0] === -20,
    `the hold slipped to ${(hold[0] ?? 0).toFixed(1)} dB after ${elapsed.toFixed(2)}s, `
    + `inside its ${SPECTRUM_HOLD_SEC}s`);

  // And then it does let go, at its own slower rate — which is the point of
  // there being two lines.  A hold that fell as fast as the live line would
  // be the live line, drawn twice.
  for (let i = 0; i < 20; i++) advanceHold(hold, ages, new Float32Array([-90]), 0.05, FLOOR);
  assert((hold[0] ?? 0) < -20, 'the hold never let go');
  assert((hold[0] ?? 0) > -90, 'the hold dropped to the floor instead of sliding');

  const before = hold[0] ?? 0;
  advanceHold(hold, ages, new Float32Array([-90]), 0.1, FLOOR);
  const fell = before - (hold[0] ?? 0);
  assert(Math.abs(fell - SPECTRUM_HOLD_FALL_DB_PER_SEC * 0.1) < 1e-4,
    `the hold fell ${fell.toFixed(3)} dB in 100 ms, not the `
    + `${(SPECTRUM_HOLD_FALL_DB_PER_SEC * 0.1).toFixed(3)} its rate says`);
  assert(SPECTRUM_HOLD_FALL_DB_PER_SEC < SPECTRUM_FALL_DB_PER_SEC,
    'the hold falls at least as fast as the live line, so it is not a hold');

  // Each column holds on its own clock: a peak in one band must not reset the
  // countdown in another.
  //
  // The defect this is written against resets every column's age whenever ANY
  // column is beaten, so the frame below has to contain both events at once —
  // column 0 quiet and long overdue, column 1 rising.  The first version of
  // this check sent a frame where nothing rose, which never reached the line
  // that does the resetting: it was found by making that exact break and
  // watching all nine checks stay green.
  // It also has to run for SEVERAL frames.  Inside one call the columns are
  // visited in order, so a shared reset performed while handling column 1
  // arrives too late to affect column 0 in that same call — it is the NEXT
  // call that reads the wiped age.  A single-call version of this check
  // passed the broken code twice before this was noticed.
  const h2 = new Float32Array([-20, -20]);
  const a2 = new Float32Array([0, 0]);
  const loud = new Float32Array([-90, -10]);      // column 0 quiet, column 1 always rising
  for (let i = 0; i < Math.ceil(SPECTRUM_HOLD_SEC / 0.05) + 6; i++) {
    advanceHold(h2, a2, loud, 0.05, FLOOR);
  }
  assert(h2[1] === -10, 'the rising column did not keep its peak');
  assert((h2[0] ?? 0) < -20,
    'the quiet column never let go while its neighbour was peaking — the ages are shared');
});

check('the vertical scale is monotone and clamped', () => {
  const h = 200;
  assert(dbToY(DEFAULT_SCALE.topDb, h, DEFAULT_SCALE) === 0, 'the top of the scale is not the top');
  assert(dbToY(DEFAULT_SCALE.bottomDb, h, DEFAULT_SCALE) === h, 'the bottom is not the bottom');
  assert(dbToY(50, h, DEFAULT_SCALE) === 0, 'a value above the top was drawn off the picture');
  assert(dbToY(-400, h, DEFAULT_SCALE) === h, 'a value below the bottom was drawn off the picture');
  let previous = -1;
  for (let db = DEFAULT_SCALE.bottomDb; db <= DEFAULT_SCALE.topDb; db += 1) {
    const y = dbToY(db, h, DEFAULT_SCALE);
    assert(previous < 0 || y <= previous, `the scale turned back on itself at ${db} dB`);
    previous = y;
  }
});

check('a silent frame draws the floor rather than NaN', () => {
  const width = 120;
  const out = spectrumColumns(
    new Float32Array(BINS).fill(-Infinity), SR, new Float32Array(width), DEFAULT_SCALE, 4.5);
  for (let x = 0; x < width; x++) {
    assert(Number.isFinite(out[x] ?? NaN), `column ${x} came out ${String(out[x])}`);
  }
  // And a zero-length analyser does not divide by zero.
  const empty = spectrumColumns(new Float32Array(0), SR, new Float32Array(10));
  for (const v of empty) assert(Number.isFinite(v), 'an empty analyser produced a non-finite column');
});

check('the EQ editor actually draws it, and the window actually feeds it', () => {
  // Everything above this check calls `spectrum-view.ts` itself, so all of it
  // would stay green with the analyser disconnected from the UI entirely —
  // it would prove the arithmetic works and say nothing about whether
  // anything reaches a canvas.  That gap has been found by breaking a check
  // twice in this repository now (the voice-preset chip row, and the hold
  // line in this very file), so it is closed here by reading the source.
  //
  // Comment-stripped, because the surest way to write a check that passes on
  // a deleted feature is to let it match the comment DESCRIBING the feature.
  const strip = (src: string): string => src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').map((l) => { const i = l.indexOf('//'); return i >= 0 ? l.slice(0, i) : l; })
    .join('\n');

  const editor = strip(readFileSync(
    'src/renderer/components/daw/plugin/EqCurveEditor.tsx', 'utf8'));
  assert(/useInsertSpectrum\s*\(/.test(editor),
    'EqCurveEditor never calls useInsertSpectrum');
  assert(/spectrum\.display/.test(editor) && /spectrum\.hold/.test(editor),
    'EqCurveEditor reads neither the live line nor the hold line');
  // Gated on `live` and on nothing else.  Replacing that condition with
  // `false` leaves both reads above in the file and passed this check until
  // this line was added — which is the limit of what reading source can do,
  // and the reason the claim that the picture MOVES is measured in the
  // running app (pixels changing between frames) rather than asserted here.
  assert(/if\s*\(\s*spectrum\.live\s*\)/.test(editor),
    'the spectrum is not drawn under `if (spectrum.live)` — it may be behind a dead condition');
  assert(/onFrame\s*\(/.test(editor),
    'EqCurveEditor never subscribes to the frame loop, so the picture cannot move');

  const hook = strip(readFileSync('src/renderer/hooks/useInsertSpectrum.ts', 'utf8'));
  assert(/insertSpectrum\s*\(/.test(hook), 'the hook never asks the runtime for a frame');
  assert(/requestAnimationFrame/.test(hook), 'the hook does not run at frame rate');
  assert(/advanceSpectrum\s*\(/.test(hook) && /advanceHold\s*\(/.test(hook),
    'the hook does not apply the ballistics, so the picture will strobe');

  const win = strip(readFileSync(
    'src/renderer/components/daw/plugin/PluginWindow.tsx', 'utf8'));
  assert(/insertId=\{insertId\}/.test(win),
    'PluginWindow does not tell the editor which insert to analyse');
  assert(/playing=\{isPlaying\}/.test(win),
    'PluginWindow does not tell the editor whether the transport is running');

  const engine = strip(readFileSync('src/renderer/daw/engine/mixer-engine.ts', 'utf8'));
  assert(/insertSpectra\.set\s*\(/.test(engine),
    'the mixer never builds a spectrum tap, so there is nothing to read');
  assert(/getFloatFrequencyData/.test(engine),
    'the mixer never reads frequency data');
});

console.log('');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
const bad = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - bad}/${results.length} passed${bad ? `, ${bad} FAILED` : ''}`);
if (bad) process.exit(1);
