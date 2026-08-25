/**
 * plugin-shapes-selftest.ts — the pictures the non-EQ devices draw.
 *
 * A drawing is the easiest thing in an audio app to get quietly wrong, because
 * nothing fails when it does: the canvas still fills, the numbers still move,
 * and the picture is simply of a device nobody is listening to.  That is
 * exactly how the exciter and the de-esser spent their whole existence drawing
 * a flat line from a parameter neither of them has.
 *
 * So these checks are about agreement with the engine, not about pixels:
 *
 *   · the curve drawn is the array the WaveShaperNode is loaded with
 *   · it is read the way WaveShaperNode reads it
 *   · the gains sit where the graph puts them, not all in one place
 *   · a knob that changes the sound changes the picture
 *   · a device that only ducks cannot be drawn boosting
 *
 * Run via:  pnpm --filter @aimaster/desktop test:plugin-shapes
 */

import {
  shaperFor, detectorFor, shaperOutput, readCurve, detectorGainDb, expanderGainCurve,
  filterPictureFor, widthPictureFor, FILTER_DEVICES, WIDTH_DEVICES,
  lfoPictureFor, combPictureFor, LFO_DEVICES, COMB_DEVICES,
  delayPictureFor, bandPictureFor, DELAY_DEVICES, BAND_DEVICES,
} from '../src/renderer/daw/model/plugin-shapes.js';
import {
  biquadMagnitudeDb, chainMagnitudeDb, compressorOutputDb,
} from '../src/renderer/daw/model/plugin-curves.js';
import {
  bitCurve, clipCurve, gateGainCurve, tubeCurve,
} from '../src/renderer/daw/engine/plugins-extended.js';
import { tanhCurve, makeExpanderCurve } from '../src/renderer/daw/engine/plugin-kit.js';
import { defaultParams, PLUGINS } from '../src/renderer/daw/engine/plugins.js';

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }
function near(a: number, b: number, eps: number, m: string): void {
  if (!(Math.abs(a - b) <= eps)) throw new Error(`${m} — ${a} vs ${b}`);
}
function sameArray(a: Float32Array, b: Float32Array, m: string): void {
  assert(a.length === b.length, `${m}: length ${a.length} vs ${b.length}`);
  for (let i = 0; i < a.length; i++) {
    if (Math.abs((a[i] ?? 0) - (b[i] ?? 0)) > 1e-9) {
      throw new Error(`${m}: differs at ${i} — ${a[i]} vs ${b[i]}`);
    }
  }
}

const SHAPERS = ['trim', 'saturation', 'tube', 'clipper', 'bitcrush'] as const;
const DETECTORS = ['gate', 'denoise'] as const;

// ── The picture is the engine's own array ───────────────────────────────────

check('the saturator draws the array its shaper is loaded with', () => {
  const spec = shaperFor('saturation', { ...defaultParams('saturation'), bias: 0.4 });
  assert(spec, 'no spec');
  sameArray(spec!.curves[0]!, tanhCurve(0.4), 'saturation curve');
});

check('the tube draws the array its shaper is loaded with', () => {
  const spec = shaperFor('tube', { ...defaultParams('tube'), drive: 0.7, bias: 0.3 });
  sameArray(spec!.curves[0]!, tubeCurve(0.7, 0.3), 'tube curve');
});

check('the bit crusher draws the array its shaper is loaded with', () => {
  const spec = shaperFor('bitcrush', { ...defaultParams('bitcrush'), bits: 5 });
  sameArray(spec!.curves[0]!, bitCurve(5), 'bit curve');
});

check('the clipper draws BOTH its stages, so the ceiling drawn is the real one', () => {
  const ceiling = Math.pow(10, -3 / 20);
  const spec = shaperFor('clipper', { ...defaultParams('clipper'), ceilingDb: -3, hardness: 0.2 });
  assert(spec!.curves.length === 2, `two stages, got ${spec!.curves.length}`);
  sameArray(spec!.curves[0]!, clipCurve(ceiling, 0.2), 'clipper shaper');
  sameArray(spec!.curves[1]!, clipCurve(ceiling, 1), 'clipper guard');
});

check('the gate draws the array its shaper is loaded with', () => {
  const spec = detectorFor('gate', { ...defaultParams('gate'), thresholdDb: -30, rangeDb: 25 });
  sameArray(spec!.curve, gateGainCurve(-30, 25), 'gate curve');
});

check("the denoiser's drawn expander matches plugin-kit's, ratio mapping included", () => {
  // The engine maps amount 0..1 to ratio 1..6; if the drawing used a different
  // mapping the picture would be of a device with a different ratio.
  const spec = detectorFor('denoise', { ...defaultParams('denoise'), thresholdDb: -50, amount: 0.6 });
  const ratio = 1 + 0.6 * 5;
  sameArray(spec!.curve, expanderGainCurve(-50, ratio), 'denoise curve');
  sameArray(expanderGainCurve(-50, ratio), makeExpanderCurve(-50, ratio), 'copy has not drifted from plugin-kit');
});

// ── Read the way Web Audio reads ────────────────────────────────────────────

check('a curve is read the way WaveShaperNode reads it', () => {
  const curve = new Float32Array([-1, 0, 1]);
  near(readCurve(curve, -1), -1, 1e-9, 'x=-1 is the first entry');
  near(readCurve(curve, 0), 0, 1e-9, 'x=0 is the middle');
  near(readCurve(curve, 1), 1, 1e-9, 'x=+1 is the last');
  near(readCurve(curve, 0.5), 0.5, 1e-9, 'interpolated between');
  near(readCurve(curve, 9), 1, 1e-9, 'clamped above');
  near(readCurve(curve, -9), -1, 1e-9, 'clamped below');
});

// ── The gains sit where the graph puts them ─────────────────────────────────

check("the saturator's compensation is inside its wet path, so mix uncovers the dry signal", () => {
  const spec = shaperFor('saturation', { driveDb: 18, bias: 0, mix: 0 })!;
  // Fully dry: whatever the drive and compensation are, nothing may change.
  near(shaperOutput(spec, 0.5), 0.5, 1e-6, 'mix 0 passes the input through');
  assert(spec.postGain === 1, 'the saturator has no gain after the blend');
  assert(spec.wetGain < 1, `18 dB of drive must be compensated — ${spec.wetGain}`);
});

check("the tube's output trim is AFTER the blend, so it moves the dry signal too", () => {
  const spec = shaperFor('tube', { drive: 0.3, bias: 0.15, toneHz: 8000, mix: 0, outDb: 6 })!;
  const expected = 0.5 * Math.pow(10, 6 / 20);
  near(shaperOutput(spec, 0.5), expected, 1e-6, 'fully dry still takes the output trim');
});

check('trim is a straight line whose slope is the knob', () => {
  const spec = shaperFor('trim', { gainDb: -6 })!;
  assert(spec.curves.length === 0, 'a gain is not a shaper');
  const g = Math.pow(10, -6 / 20);
  for (const x of [-0.8, -0.2, 0.3, 0.9]) near(shaperOutput(spec, x), x * g, 1e-6, `x=${x}`);
});

// ── A knob that changes the sound changes the picture ───────────────────────

check('drive bends the curve away from the diagonal', () => {
  const flat = shaperFor('saturation', { driveDb: 0, bias: 0, mix: 1 })!;
  const hot = shaperFor('saturation', { driveDb: 18, bias: 0, mix: 1 })!;
  const bend = (s: ReturnType<typeof shaperFor>): number =>
    Math.abs(shaperOutput(s!, 0.3) / 0.3 - shaperOutput(s!, 0.9) / 0.9);
  assert(bend(hot) > bend(flat) + 0.05,
    `18 dB of drive did not bend the curve — ${bend(flat).toFixed(3)} vs ${bend(hot).toFixed(3)}`);
});

check('bias makes the curve asymmetric — that is what even harmonics are', () => {
  const symmetric = shaperFor('saturation', { driveDb: 12, bias: 0, mix: 1 })!;
  const leaning = shaperFor('saturation', { driveDb: 12, bias: 0.8, mix: 1 })!;
  const asym = (s: ReturnType<typeof shaperFor>): number =>
    Math.abs(shaperOutput(s!, 0.6) + shaperOutput(s!, -0.6));
  near(asym(symmetric), 0, 1e-3, 'no bias is symmetric');
  assert(asym(leaning) > 0.02, `bias did not lean the curve — ${asym(leaning)}`);
});

check('the bit crusher has exactly the steps the bit depth has', () => {
  // Count PLATEAUS, not distinct sampled values: Web Audio interpolates
  // between curve entries, so every step edge also yields a handful of
  // in-between values, and counting those would be counting the ramp.
  for (const bits of [3, 4, 6]) {
    const spec = shaperFor('bitcrush', { bits, mix: 100 })!;
    const seen = new Map<number, number>();
    const N = 20_000;
    for (let i = 0; i <= N; i++) {
      const key = Math.round(shaperOutput(spec, (i / N) * 2 - 1) * 1e6);
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    // A plateau is a value the curve rests on; a ramp value appears once or
    // twice in twenty thousand samples.
    const plateaus = [...seen.values()].filter((n) => n > 20).length;
    // 2^bits/2 levels each side of zero, plus zero itself.
    near(plateaus, Math.pow(2, bits) / 2 * 2 + 1, 0, `${bits} bit`);
  }
});

check('the crusher stops crushing when the blend is dry', () => {
  const wet = shaperFor('bitcrush', { bits: 3, mix: 100 })!;
  const dry = shaperFor('bitcrush', { bits: 3, mix: 0 })!;
  assert(Math.abs(shaperOutput(wet, 0.31) - 0.31) > 0.02, 'wet must quantise');
  near(shaperOutput(dry, 0.31), 0.31, 1e-6, 'dry must not');
});

check('the clipper cannot be drawn going above its ceiling', () => {
  for (const ceilingDb of [-1, -6, -12]) {
    const spec = shaperFor('clipper', { driveDb: 24, ceilingDb, hardness: 0.5 })!;
    const ceiling = Math.pow(10, ceilingDb / 20);
    for (const x of [0.2, 0.6, 1]) {
      assert(Math.abs(shaperOutput(spec, x)) <= ceiling + 1e-6,
        `${ceilingDb} dB ceiling exceeded at x=${x}: ${shaperOutput(spec, x)}`);
    }
  }
});

// ── A device that only ducks cannot be drawn boosting ───────────────────────

check('a gate never gives back more than it was given', () => {
  const spec = detectorFor('gate', { thresholdDb: -40, rangeDb: 40 })!;
  for (const db of [-70, -50, -40, -30, -10, -1]) {
    assert(detectorGainDb(spec, db) <= 0.01, `gate boosted at ${db} dB: ${detectorGainDb(spec, db)}`);
  }
});

check('the gate is open above the threshold and closed below it', () => {
  const spec = detectorFor('gate', { thresholdDb: -30, rangeDb: 40 })!;
  assert(detectorGainDb(spec, -6) > -0.5, `should be open at -6 dB: ${detectorGainDb(spec, -6)}`);
  assert(detectorGainDb(spec, -60) < -20, `should be shut at -60 dB: ${detectorGainDb(spec, -60)}`);
  // And the threshold is where it turns, not somewhere else.
  assert(detectorGainDb(spec, -25) > detectorGainDb(spec, -40), 'the curve runs the wrong way');
});

check('raising the range digs the closed gate deeper, and zero range is no gate at all', () => {
  const shallow = detectorFor('gate', { thresholdDb: -30, rangeDb: 6 })!;
  const deep = detectorFor('gate', { thresholdDb: -30, rangeDb: 50 })!;
  assert(detectorGainDb(deep, -70) < detectorGainDb(shallow, -70) - 10,
    'range did not deepen the gate');
  const off = detectorFor('gate', { thresholdDb: -30, rangeDb: 0 })!;
  near(detectorGainDb(off, -70), 0, 0.01, 'zero range passes everything');
});

// ── Coverage ────────────────────────────────────────────────────────────────

check('every shaping device has a spec, and nothing else claims one', () => {
  for (const id of SHAPERS) assert(shaperFor(id, defaultParams(id)), `${id} has no shaper spec`);
  for (const id of DETECTORS) assert(detectorFor(id, defaultParams(id)), `${id} has no detector spec`);
  for (const p of PLUGINS) {
    const isShaper = (SHAPERS as readonly string[]).includes(p.id);
    const isDetector = (DETECTORS as readonly string[]).includes(p.id);
    if (!isShaper) assert(!shaperFor(p.id, defaultParams(p.id)), `${p.id} claims a transfer curve`);
    if (!isDetector) assert(!detectorFor(p.id, defaultParams(p.id)), `${p.id} claims a detector curve`);
  }
});

check('every caption says something, at the defaults and at the extremes', () => {
  for (const id of SHAPERS) {
    for (const params of [defaultParams(id), {}]) {
      const spec = shaperFor(id, params)!;
      assert(spec.caption.trim().length > 0, `${id}: empty caption`);
      assert(!spec.caption.includes('NaN'), `${id}: NaN in caption — ${spec.caption}`);
    }
  }
  for (const id of DETECTORS) {
    const spec = detectorFor(id, defaultParams(id))!;
    assert(spec.caption.trim().length > 0, `${id}: empty caption`);
    assert(!spec.caption.includes('NaN'), `${id}: NaN in caption — ${spec.caption}`);
  }
});

check('a device with no parameters set draws its defaults rather than NaN', () => {
  for (const id of SHAPERS) {
    const spec = shaperFor(id, {})!;
    for (const x of [-1, -0.4, 0, 0.4, 1]) {
      assert(Number.isFinite(shaperOutput(spec, x)), `${id}: not finite at x=${x}`);
    }
  }
  for (const id of DETECTORS) {
    const spec = detectorFor(id, {})!;
    for (const db of [-80, -40, -6]) {
      assert(Number.isFinite(detectorGainDb(spec, db)), `${id}: not finite at ${db} dB`);
    }
  }
});


// ── Devices whose behaviour is a filter ─────────────────────────────────────

check('the mid/side EQ draws two curves, not their sum', () => {
  const pic = filterPictureFor('mseq', {
    midLowDb: 6, midHighDb: 0, sideLowDb: 0, sideHighDb: 6,
  })!;
  assert(pic.curves.length === 2, `two curves, got ${pic.curves.length}`);
  const [mid, side] = pic.curves;
  assert(mid!.label === 'MID' && side!.label === 'SIDE', 'both are named');
  assert(mid!.colour !== side!.colour, 'two curves in one picture must not share a colour');
  // The whole information is that they differ; a sum would hide it.
  near(chainMagnitudeDb(mid!.specs, 60), 6, 0.6, 'the centre is lifted low');
  near(chainMagnitudeDb(mid!.specs, 12_000), 0, 0.2, 'the centre is flat up top');
  near(chainMagnitudeDb(side!.specs, 60), 0, 0.2, 'the sides are flat low');
  near(chainMagnitudeDb(side!.specs, 12_000), 6, 0.6, 'the sides are lifted up top');
});

check('the mid/side shelves sit where the engine pins them', () => {
  const pic = filterPictureFor('mseq', { midLowDb: 6, midHighDb: 6, sideLowDb: 0, sideHighDb: 0 })!;
  const freqs = pic.curves[0]!.specs.map((s) => s.freq).sort((a, b) => a - b);
  assert(freqs[0] === 200 && freqs[1] === 6000, `200 Hz and 6 kHz, got ${freqs.join(', ')}`);
});

check('the hum remover notches the mains frequency and its harmonics', () => {
  const pic = filterPictureFor('hum', { baseHz: 50, harmonics: 3, q: 30 })!;
  const specs = pic.curves[0]!.specs;
  // Eight filters always, because the engine builds eight and parks the spare
  // ones rather than bypassing them — a parked notch is still in the path.
  assert(specs.length === 8, `8 notches in the graph, got ${specs.length}`);
  const active = specs.filter((s) => s.freq < 20_000).map((s) => s.freq);
  assert(active.join(',') === '50,100,150', `50/100/150, got ${active.join(',')}`);
  // And they are notches, not a shelf that looks like one from a distance.
  for (const hz of active) {
    assert(chainMagnitudeDb(specs, hz) < -20, `no notch at ${hz} Hz: ${chainMagnitudeDb(specs, hz)}`);
  }
  near(chainMagnitudeDb(specs, 400), 0, 0.6, 'unity away from the harmonics');
});

check('more harmonics means more notches, and the count is the knob', () => {
  for (const n of [1, 4, 8]) {
    const specs = filterPictureFor('hum', { baseHz: 60, harmonics: n, q: 30 })!.curves[0]!.specs;
    const active = specs.filter((s) => s.freq < 20_000).length;
    assert(active === n, `harmonics ${n} gave ${active} notches`);
  }
});

check('a higher Q makes a narrower notch, which is what the knob claims', () => {
  const wide = filterPictureFor('hum', { baseHz: 60, harmonics: 1, q: 6 })!.curves[0]!.specs;
  const tight = filterPictureFor('hum', { baseHz: 60, harmonics: 1, q: 60 })!.curves[0]!.specs;
  // Probe 2 Hz off centre, which is inside the WIDE notch's skirt and outside
  // the tight one's: a 60 Hz notch is 10 Hz across at Q 6 and 1 Hz at Q 60.
  // Measured there, the two are 8.5 dB apart; twenty hertz off centre both have
  // recovered to within a third of a decibel and the check would not bite.
  const off = 62;
  assert(chainMagnitudeDb(tight, off) > chainMagnitudeDb(wide, off) + 6,
    `Q did not narrow the notch — ${chainMagnitudeDb(wide, off).toFixed(1)} vs ${chainMagnitudeDb(tight, off).toFixed(1)}`);
});

check('the DC blocker is drawn doing nothing you can hear, which is its job', () => {
  const pic = filterPictureFor('dcblock', {})!;
  const specs = pic.curves[0]!.specs;
  for (const hz of [20, 100, 1000, 10_000]) {
    near(chainMagnitudeDb(specs, hz), 0, 0.6, `${hz} Hz should be untouched`);
  }
  // But it does something, and the picture has to reach far enough down to show it.
  assert(pic.fromHz <= 2, `a 5 Hz corner needs an axis that goes below it, not ${pic.fromHz} Hz`);
  assert(chainMagnitudeDb(specs, 2) < -3, `no corner at 2 Hz: ${chainMagnitudeDb(specs, 2)}`);
});

check('a notch really is a notch — deep at centre, unity away from it', () => {
  const spec = { type: 'notch' as const, freq: 1000, gain: 0, q: 20 };
  assert(biquadMagnitudeDb(spec, 1000) < -30, `centre: ${biquadMagnitudeDb(spec, 1000)}`);
  near(biquadMagnitudeDb(spec, 100), 0, 0.2, 'two decades below');
  near(biquadMagnitudeDb(spec, 10_000), 0, 0.2, 'a decade above');
});

// ── Devices that set width per frequency ────────────────────────────────────

check('both wideners leave the bottom mono, whatever the width knob says', () => {
  for (const [id, params] of [
    ['widener', { width: 2, lowMonoHz: 200 }],
    ['monomaker', { widthPct: 200, freqHz: 200 }],
  ] as const) {
    const pic = widthPictureFor(id, params)!;
    assert(pic.widthAt(25) < 0.2, `${id}: 25 Hz is not mono — ${pic.widthAt(25)}`);
    near(pic.widthAt(8000), 2, 0.05, `${id}: the top should be the full width`);
  }
});

check('the mono maker is twice as steep as the widener — two highpasses against one', () => {
  const one = widthPictureFor('widener', { width: 1, lowMonoHz: 120 })!;
  const two = widthPictureFor('monomaker', { widthPct: 100, freqHz: 120 })!;
  // An octave and a half below the corner, where the skirts have separated.
  const oneDb = 20 * Math.log10(one.widthAt(40));
  const twoDb = 20 * Math.log10(two.widthAt(40));
  assert(twoDb < oneDb - 8,
    `the 12 dB/oct skirt is not steeper — ${oneDb.toFixed(1)} vs ${twoDb.toFixed(1)} dB`);
});

check('width zero is mono everywhere, which is the one setting that must be exact', () => {
  for (const [id, params] of [
    ['widener', { width: 0, lowMonoHz: 20 }],
    ['monomaker', { widthPct: 0, freqHz: 20 }],
  ] as const) {
    const pic = widthPictureFor(id, params)!;
    for (const hz of [30, 300, 3000]) {
      near(pic.widthAt(hz), 0, 1e-9, `${id} at ${hz} Hz`);
    }
  }
});

check('the corner drawn is the corner the knob sets', () => {
  for (const corner of [40, 120, 300]) {
    near(widthPictureFor('widener', { width: 1, lowMonoHz: corner })!.cornerHz, corner, 1e-9, 'widener');
    near(widthPictureFor('monomaker', { widthPct: 100, freqHz: corner })!.cornerHz, corner, 1e-9, 'mono maker');
  }
});

check('the width axis always has room for the width that is set', () => {
  for (const width of [0, 1, 1.7, 2]) {
    const pic = widthPictureFor('widener', { width, lowMonoHz: 20 })!;
    assert(pic.maxWidth >= width, `${width}x would be drawn off the top of a ${pic.maxWidth}x axis`);
    assert(pic.maxWidth >= 1, 'the "unchanged" line must be on the picture');
  }
});

check('only the devices that are filters or wideners claim to be', () => {
  for (const p of PLUGINS) {
    const isFilter = FILTER_DEVICES.includes(p.id);
    const isWidth = WIDTH_DEVICES.includes(p.id);
    if (!isFilter) assert(!filterPictureFor(p.id, defaultParams(p.id)), `${p.id} claims a filter picture`);
    if (!isWidth) assert(!widthPictureFor(p.id, defaultParams(p.id)), `${p.id} claims a width picture`);
  }
  for (const id of FILTER_DEVICES) assert(filterPictureFor(id, defaultParams(id)), `${id} has no filter picture`);
  for (const id of WIDTH_DEVICES) assert(widthPictureFor(id, defaultParams(id)), `${id} has no width picture`);
});

check('every filter and width caption says something real', () => {
  for (const id of [...FILTER_DEVICES, ...WIDTH_DEVICES]) {
    const caption = filterPictureFor(id, defaultParams(id))?.caption
      ?? widthPictureFor(id, defaultParams(id))!.caption;
    assert(caption.trim().length > 0, `${id}: empty caption`);
    assert(!caption.includes('NaN'), `${id}: NaN — ${caption}`);
  }
});


// ── Modulation over time ────────────────────────────────────────────────────

check('the tremolo ducks and never boosts, between 1 - depth and 1', () => {
  for (const depth of [0.2, 0.6, 1]) {
    const pic = lfoPictureFor('tremolo', { rateHz: 5, depth, shape: 0 })!;
    const at = pic.traces[0]!.at;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i <= 2000; i++) {
      const v = at((i / 2000) * pic.spanSec);
      lo = Math.min(lo, v); hi = Math.max(hi, v);
    }
    near(hi, 1, 1e-6, `depth ${depth}: the top of the swing is unity`);
    near(lo, 1 - depth, 1e-6, `depth ${depth}: the bottom is 1 - depth`);
  }
});

check('the tremolo shape knob really changes the wave', () => {
  const sineP = lfoPictureFor('tremolo', { rateHz: 4, depth: 1, shape: 0 })!.traces[0]!.at;
  const squareP = lfoPictureFor('tremolo', { rateHz: 4, depth: 1, shape: 1 })!.traces[0]!.at;
  // A square only ever sits at the two ends; a sine spends most of its time between.
  let sineMid = 0, squareMid = 0;
  for (let i = 0; i < 1000; i++) {
    const t = (i / 1000) * 0.5;
    if (sineP(t) > 0.2 && sineP(t) < 0.8) sineMid++;
    if (squareP(t) > 0.2 && squareP(t) < 0.8) squareMid++;
  }
  assert(squareMid === 0, `a square must not linger in the middle — ${squareMid} samples did`);
  assert(sineMid > 300, `a sine must — only ${sineMid} samples did`);
});

check('the auto pan swings exactly as far as the depth knob', () => {
  for (const depth of [0.3, 1]) {
    const pic = lfoPictureFor('autopan', { rateHz: 1, depth })!;
    const at = pic.traces[0]!.at;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i <= 2000; i++) {
      const v = at((i / 2000) * pic.spanSec);
      lo = Math.min(lo, v); hi = Math.max(hi, v);
    }
    near(hi, depth, 1e-3, 'right');
    near(lo, -depth, 1e-3, 'left');
  }
});

check('the two chorus voices drift apart — identical ones would just be vibrato', () => {
  const pic = lfoPictureFor('chorus', { rateHz: 0.6, depthMs: 4, delayMs: 18, mix: 40 })!;
  assert(pic.traces.length === 2, 'two voices');
  const [l, r] = pic.traces;
  assert(l!.colour !== r!.colour, 'two traces in one picture must not share a colour');
  let apart = 0;
  for (let i = 0; i <= 500; i++) {
    const t = (i / 500) * pic.spanSec;
    apart = Math.max(apart, Math.abs(l!.at(t) - r!.at(t)));
  }
  assert(apart > 2, `the voices barely separate — ${apart.toFixed(2)} ms apart at most`);
});

check('the chorus axis has room for the excursion it draws', () => {
  const pic = lfoPictureFor('chorus', { rateHz: 0.6, depthMs: 4, delayMs: 18, mix: 40 })!;
  for (const trace of pic.traces) {
    for (let i = 0; i <= 500; i++) {
      const v = trace.at((i / 500) * pic.spanSec);
      assert(v >= pic.min && v <= pic.max, `${trace.label} reaches ${v} outside ${pic.min}..${pic.max}`);
    }
  }
});

check('a slow modulator and a fast one are drawn the same width, in cycles not seconds', () => {
  for (const rate of [0.1, 1, 12]) {
    const pic = lfoPictureFor('tremolo', { rateHz: rate, depth: 1, shape: 0 })!;
    near(pic.spanSec * rate, 2, 1e-9, `rate ${rate} should span two cycles`);
  }
});

// ── Comb and phase interference ─────────────────────────────────────────────

check('the flanger notches land where a comb of that delay puts them', () => {
  const delayMs = 3;
  const pic = combPictureFor('flanger', { delayMs, depthMs: 0.0001, feedback: 0, mix: 50 })!;
  // A delay of T summed with dry cancels at the odd multiples of 1/(2T).
  const T = delayMs / 1000;
  for (const k of [0, 1, 2]) {
    const notch = (2 * k + 1) / (2 * T);
    const peak = (k + 1) / T;
    assert(pic.db(notch) < -20, `no notch at ${notch.toFixed(0)} Hz: ${pic.db(notch).toFixed(1)} dB`);
    // Half wet against half dry adds to exactly unity where they agree, so a
    // 50% flanger only ever cuts.  Asserting a BOOST here would be asserting
    // gain the device cannot make without feedback.
    near(pic.db(peak), 0, 0.01, `the tooth top at ${peak.toFixed(0)} Hz is unity`);
    assert(pic.db(peak) - pic.db(notch) > 20, `no tooth between ${notch.toFixed(0)} and ${peak.toFixed(0)} Hz`);
  }
});

check('a longer delay packs the teeth closer together', () => {
  const count = (delayMs: number): number => {
    const pic = combPictureFor('flanger', { delayMs, depthMs: 0.0001, feedback: 0, mix: 50 })!;
    let n = 0, was = pic.db(100);
    for (let hz = 100; hz < 2000; hz += 1) {
      const now = pic.db(hz);
      if (was > -6 && now <= -6) n++;
      was = now;
    }
    return n;
  };
  assert(count(8) > count(2) * 2, `8 ms should have far more teeth than 2 ms — ${count(2)} vs ${count(8)}`);
});

check('feedback raises the peaks — it resonates, it does not deepen the nulls', () => {
  // A comb without feedback already nulls completely where wet and dry cancel;
  // there is nothing left to deepen.  What feedback does is resonate, and the
  // measured behaviour is the opposite of the intuition: the peaks climb from
  // 0 to +15 dB while the nulls FILL IN from -120 to -12, because the fed-back
  // path no longer cancels the dry one exactly.
  const band = (feedback: number): { hi: number; lo: number } => {
    const pic = combPictureFor('flanger', { delayMs: 3, depthMs: 0.0001, feedback, mix: 50 })!;
    let hi = -Infinity, lo = Infinity;
    for (let hz = 100; hz < 3000; hz += 0.5) { hi = Math.max(hi, pic.db(hz)); lo = Math.min(lo, pic.db(hz)); }
    return { hi, lo };
  };
  const quiet = band(0.1);
  const loud = band(0.9);
  assert(loud.hi > quiet.hi + 10, `feedback did not resonate — peaks ${quiet.hi.toFixed(1)} vs ${loud.hi.toFixed(1)} dB`);
  assert(loud.lo > quiet.lo, `feedback should fill the null in, not deepen it — ${quiet.lo.toFixed(1)} vs ${loud.lo.toFixed(1)} dB`);
});

check('a fully dry flanger or phaser is drawn doing nothing', () => {
  for (const [id, params] of [
    ['flanger', { delayMs: 3, depthMs: 2, feedback: 0.9, mix: 0 }],
    ['phaser', { centreHz: 900, depth: 0.7, feedback: 0.9, mix: 0 }],
  ] as const) {
    const pic = combPictureFor(id, params)!;
    for (const hz of [80, 400, 2000, 9000]) {
      near(pic.db(hz), 0, 1e-6, `${id} at ${hz} Hz must be untouched when fully dry`);
    }
  }
});

check('the phaser makes notches out of phase alone, and they follow the centre knob', () => {
  // Four allpass stages put four notches either side of the centre, and each
  // one is a near-perfect null — so sampling for "the deepest point" lands on
  // whichever null the step happened to fall closest to, not on the lowest
  // one.  Find every local minimum instead and compare the sets.
  const notchesFor = (centreHz: number): number[] => {
    const pic = combPictureFor('phaser', { centreHz, depth: 0.0001, feedback: 0, mix: 50 })!;
    const found: number[] = [];
    let prev = pic.db(50), prev2 = prev, prevHz = 50;
    for (let hz = 50 * 1.004; hz < 16_000; hz *= 1.004) {
      const now = pic.db(hz);
      if (prev < prev2 && prev < now && prev < -6) found.push(prevHz);
      prev2 = prev; prev = now; prevHz = hz;
    }
    return found;
  };
  const low = notchesFor(300);
  const high = notchesFor(900);
  assert(low.length === 4, `four allpass stages make four notches, found ${low.length}`);
  assert(high.length === 4, `four notches at 900 Hz too, found ${high.length}`);
  // Tripling the centre triples every one of them.
  low.forEach((hz, i) => {
    near(high[i]! / hz, 3, 0.15, `notch ${i + 1} did not follow the centre (${hz.toFixed(0)} -> ${high[i]!.toFixed(0)} Hz)`);
  });
});

check('the sweep band contains the response, everywhere', () => {
  for (const [id, params] of [
    ['flanger', { delayMs: 3, depthMs: 2, feedback: 0.5, mix: 50 }],
    ['phaser', { centreHz: 900, depth: 0.7, feedback: 0.4, mix: 50 }],
  ] as const) {
    const pic = combPictureFor(id, params)!;
    for (let hz = 25; hz < 18_000; hz *= 1.02) {
      const { lo, hi } = pic.sweep(hz);
      assert(lo <= hi, `${id}: sweep inverted at ${hz.toFixed(0)} Hz`);
      assert(Number.isFinite(lo) && Number.isFinite(hi), `${id}: sweep not finite at ${hz.toFixed(0)} Hz`);
    }
  }
});

check('an allpass is flat on its own — the notches are the dry sum, not filtering', () => {
  for (const hz of [50, 500, 5000]) {
    near(biquadMagnitudeDb({ type: 'allpass', freq: 900, gain: 0, q: 0.7 }, hz), 0, 1e-6,
      `an allpass must not change the level at ${hz} Hz`);
  }
});

check('only the modulation devices claim these pictures', () => {
  for (const p of PLUGINS) {
    if (!LFO_DEVICES.includes(p.id)) {
      assert(!lfoPictureFor(p.id, defaultParams(p.id)), `${p.id} claims an LFO picture`);
    }
    if (!COMB_DEVICES.includes(p.id)) {
      assert(!combPictureFor(p.id, defaultParams(p.id)), `${p.id} claims a comb picture`);
    }
  }
  for (const id of LFO_DEVICES) assert(lfoPictureFor(id, defaultParams(id)), `${id} has no LFO picture`);
  for (const id of COMB_DEVICES) assert(combPictureFor(id, defaultParams(id)), `${id} has no comb picture`);
});

check('every modulation caption says something real', () => {
  for (const id of LFO_DEVICES) {
    const c = lfoPictureFor(id, defaultParams(id))!.caption;
    assert(c.trim().length > 0 && !c.includes('NaN'), `${id}: ${c}`);
  }
  for (const id of COMB_DEVICES) {
    const c = combPictureFor(id, defaultParams(id))!.caption;
    assert(c.trim().length > 0 && !c.includes('NaN'), `${id}: ${c}`);
  }
});


// ── Delays ──────────────────────────────────────────────────────────────────

check('the repeats land on the beat the time knob sets', () => {
  for (const [id, key] of [['delay', 'timeMs'], ['pingpong', 'timeMs'], ['tapedelay', 'timeMs']] as const) {
    const ms = 250;
    const pic = delayPictureFor(id, { ...defaultParams(id), [key]: ms, feedback: 0.5 })!;
    pic.taps.forEach((tap, i) => {
      near(tap.timeSec, (ms / 1000) * (i + 1), 1e-9, `${id}: repeat ${i + 1}`);
    });
  }
});

check('the repeats die at the rate the feedback knob sets', () => {
  const pic = delayPictureFor('delay', { timeMs: 300, feedback: 0.5 })!;
  pic.taps.forEach((tap, i) => near(tap.gain, Math.pow(0.5, i + 1), 1e-9, `repeat ${i + 1}`));
  // And more feedback means more of them.
  const few = delayPictureFor('delay', { timeMs: 300, feedback: 0.2 })!.taps.length;
  const many = delayPictureFor('delay', { timeMs: 300, feedback: 0.8 })!.taps.length;
  assert(many > few, `feedback did not lengthen the tail — ${few} vs ${many}`);
});

check('the ping-pong alternates sides and the others do not', () => {
  const pp = delayPictureFor('pingpong', { timeMs: 350, feedback: 0.5, toneHz: 6000, mix: 30 })!;
  assert(pp.taps.length >= 3, 'need a few repeats to see them alternate');
  pp.taps.forEach((tap, i) => {
    assert(tap.pan === (i % 2 === 0 ? -1 : 1), `repeat ${i + 1} is on the wrong side: ${tap.pan}`);
  });
  // Drawn as one row of bars a ping-pong is any other delay; these two must not
  // come out the same shape.
  for (const id of ['delay', 'tapedelay'] as const) {
    const pic = delayPictureFor(id, defaultParams(id))!;
    assert(pic.taps.every((t) => t.pan === 0), `${id} must not claim to alternate`);
  }
});

check("the tape delay's saturator does not secretly lengthen its tail", () => {
  // The engine normalises the drive so the loop gain stays at the feedback
  // knob; a picture that ignored that would draw a tail that never ends.
  const quiet = delayPictureFor('tapedelay', { ...defaultParams('tapedelay'), drive: 0, feedback: 0.5 })!;
  const hot = delayPictureFor('tapedelay', { ...defaultParams('tapedelay'), drive: 1, feedback: 0.5 })!;
  assert(quiet.taps.length === hot.taps.length,
    `drive changed the tail length — ${quiet.taps.length} vs ${hot.taps.length}`);
});

check('the picture is wide enough for the last repeat it draws', () => {
  for (const id of DELAY_DEVICES) {
    for (const feedback of [0.1, 0.5, 0.9]) {
      const pic = delayPictureFor(id, { ...defaultParams(id), feedback })!;
      for (const tap of pic.taps) {
        assert(tap.timeSec <= pic.spanSec, `${id}: a repeat at ${tap.timeSec}s falls off a ${pic.spanSec}s picture`);
      }
    }
  }
});

// ── Compressors that work on a band ─────────────────────────────────────────

check('the multiband draws three bands, split where the crossovers are', () => {
  const pic = bandPictureFor('mbcomp', {
    ...defaultParams('mbcomp'), lowXHz: 200, highXHz: 4000,
  })!;
  assert(pic.bands.length === 3, `three bands, got ${pic.bands.length}`);
  const [low, mid, high] = pic.bands;
  near(low!.toHz, 200, 1e-9, 'the low band ends at the first crossover');
  near(mid!.fromHz, 200, 1e-9, 'and the mid starts there');
  near(mid!.toHz, 4000, 1e-9, 'the mid ends at the second');
  near(high!.fromHz, 4000, 1e-9, 'and the high starts there');
  // No gaps and no overlaps: every frequency belongs to exactly one band.
  for (let i = 1; i < pic.bands.length; i++) {
    near(pic.bands[i]!.fromHz, pic.bands[i - 1]!.toHz, 1e-9, `gap before band ${i + 1}`);
  }
});

check('each band draws its own threshold and ratio, not a shared one', () => {
  const pic = bandPictureFor('mbcomp', {
    ...defaultParams('mbcomp'),
    lowThrDb: -36, lowRatio: 8, midThrDb: -18, midRatio: 2, hiThrDb: -9, hiRatio: 5,
  })!;
  const [low, mid, high] = pic.bands;
  near(low!.thresholdDb, -36, 1e-9, 'low threshold');
  near(low!.ratio, 8, 1e-9, 'low ratio');
  near(mid!.thresholdDb, -18, 1e-9, 'mid threshold');
  near(mid!.ratio, 2, 1e-9, 'mid ratio');
  near(high!.thresholdDb, -9, 1e-9, 'high threshold');
  near(high!.ratio, 5, 1e-9, 'high ratio');
  // Which means the curves are visibly different, which is the whole point.
  const at = (b: typeof low, db: number): number =>
    compressorOutputDb({ thresholdDb: b!.thresholdDb, ratio: b!.ratio, kneeDb: b!.kneeDb, makeupDb: b!.makeupDb }, db);
  assert(at(low, -6) < at(mid, -6) - 6, `the low band should squeeze far harder — ${at(low, -6).toFixed(1)} vs ${at(mid, -6).toFixed(1)}`);
});

check("all three bands share the engine's 6 dB knee and its one makeup", () => {
  const pic = bandPictureFor('mbcomp', { ...defaultParams('mbcomp'), makeupDb: 4 })!;
  for (const band of pic.bands) {
    near(band.kneeDb, 6, 1e-9, `${band.label}: the engine sets knee 6 on every band`);
    near(band.makeupDb, 4, 1e-9, `${band.label}: there is one makeup knob, not three`);
  }
});

check('the de-esser draws the band it passes and the band it ducks', () => {
  const pic = bandPictureFor('deesser', { freqHz: 7000, thresholdDb: -30, amount: 0.5 })!;
  assert(pic.bands.length === 2, `two bands, got ${pic.bands.length}`);
  const [pass, ess] = pic.bands;
  near(pass!.ratio, 1, 1e-9, 'below the split nothing happens');
  near(pass!.toHz, 7000, 1e-9, 'the split is where the knob says');
  near(ess!.fromHz, 7000, 1e-9, 'and the ducked band starts there');
  // The engine maps amount 0..1 to a ratio of 1..12.
  near(ess!.ratio, 1 + 0.5 * 11, 1e-9, 'ratio follows the amount knob');
  near(ess!.thresholdDb, -30, 1e-9, 'threshold');
});

check('a de-esser at zero amount is drawn doing nothing', () => {
  const pic = bandPictureFor('deesser', { freqHz: 6500, thresholdDb: -24, amount: 0 })!;
  for (const band of pic.bands) near(band.ratio, 1, 1e-9, `${band.label} must be flat`);
});

check('only the delays and band compressors claim these pictures', () => {
  for (const p of PLUGINS) {
    if (!DELAY_DEVICES.includes(p.id)) {
      assert(!delayPictureFor(p.id, defaultParams(p.id)), `${p.id} claims a delay picture`);
    }
    if (!BAND_DEVICES.includes(p.id)) {
      assert(!bandPictureFor(p.id, defaultParams(p.id)), `${p.id} claims a band picture`);
    }
  }
  for (const id of DELAY_DEVICES) assert(delayPictureFor(id, defaultParams(id)), `${id} has no delay picture`);
  for (const id of BAND_DEVICES) assert(bandPictureFor(id, defaultParams(id)), `${id} has no band picture`);
});

check('every delay and band caption says something real', () => {
  for (const id of [...DELAY_DEVICES, ...BAND_DEVICES]) {
    const c = delayPictureFor(id, defaultParams(id))?.caption
      ?? bandPictureFor(id, defaultParams(id))!.caption;
    assert(c.trim().length > 0 && !c.includes('NaN'), `${id}: ${c}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log('\n=== Plugin shapes ===');
console.log(`${SHAPERS.length} transfer curves, ${DETECTORS.length} detector curves, `
  + `${FILTER_DEVICES.length} filter responses, ${WIDTH_DEVICES.length} width curves, `
  + `${LFO_DEVICES.length} modulators, ${COMB_DEVICES.length} combs, `
  + `${DELAY_DEVICES.length} delays, ${BAND_DEVICES.length} band compressors\n`);
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
if (failed > 0) process.exit(1);
