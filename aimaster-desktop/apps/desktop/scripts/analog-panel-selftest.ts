/**
 * analog-panel-selftest.ts — whether the analogue panel's pictures are of
 * this synth.
 *
 * A picture that disagrees with the engine is worse than no picture, because
 * it is believed.  Everything the panel draws therefore comes out of
 * `analog-views.ts` as arithmetic, and each drawing is checked against the
 * thing it claims to describe — the LADDER against the ladder class the
 * render loop runs, the waveforms against `analogSample`, the envelope
 * against `analogEnv`, the drift against `driftCents`, and the voice spread
 * against the four tolerances the render loop actually asks for.
 *
 * The filter check is the one worth reading.  It does not compare two
 * formulas: it runs a sine through the engine's own `Ladder` at a set of
 * frequencies and compares what comes out with what the panel draws.  Two
 * formulas agreeing proves they are each other, not that either is the
 * filter — this repository has shipped that mistake and caught it.
 *
 * Run via:  pnpm --filter @aimaster/desktop test:analog-panel
 */

import { readFileSync } from 'node:fs';
import {
  ANALOG_SHAPE_NAMES, analogEnvPoints, analogWavePoints, driftPoints,
  ladderResponseDb, voiceRows,
} from '../src/renderer/daw/model/analog-views.js';
import { cutoffHz } from '../src/renderer/daw/model/synth-views.js';
import {
  ANALOG_SHAPES, Ladder, analogEnv, analogSample, driftCents, voiceTolerance,
} from '../src/renderer/daw/engine/analog-model.js';
import { LFO_SHAPES } from '../src/renderer/daw/engine/mod-matrix.js';
import { findInstrument } from '../src/renderer/daw/engine/instruments.js';

const results: Array<{ name: string; pass: boolean; detail?: string }> = [];
function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true }); } catch (err) {
    results.push({ name, pass: false, detail: (err as Error).message });
  }
}

const SR = 48000;

/** Goertzel: the amplitude of one frequency in a buffer. */
function tone(buf: Float32Array, hz: number, from: number, len: number): number {
  const n = Math.min(len, buf.length - from);
  const w = (2 * Math.PI * hz) / SR;
  const c = 2 * Math.cos(w);
  let s1 = 0; let s2 = 0;
  for (let i = 0; i < n; i++) {
    const win = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    const s0 = (buf[from + i] ?? 0) * win + c * s1 - s2;
    s2 = s1; s1 = s0;
  }
  return Math.hypot(s1 - s2 * Math.cos(w), s2 * Math.sin(w)) / n;
}

/**
 * What the engine's ladder really does to a tone at `hz`, in dB.
 *
 * A pure sine in — not the oscillator — because this is a measurement of the
 * FILTER, and a saw would put energy at every harmonic into the same probe.
 * The reference is the SAME window over the SAME input buffer rather than a
 * derived amplitude: the first version divided by `amp/2` and read 6 dB low
 * everywhere, because a Hann-windowed Goertzel returns a quarter of the peak
 * and not a half.  Measuring the input the same way cannot be wrong about
 * that, whatever the window is.
 *
 * ── The ceiling on what can be measured at all ─────────────────────────────
 *
 * `MAX_LINEAR_RES` is where this stops, and it is not a tolerance: above
 * about k = 3.5 the ladder self-oscillates, and a self-oscillating filter has
 * no magnitude response — its own tone drives the `tanh` and compresses the
 * probe through it.  Measured at k = 3.8, the loop rings at 0.28 with no
 * input at all, and every probe reads 1.3 dB low across the whole band with
 * 6 dB missing at the peak.  That is not a drawing error; it is the filter
 * being an oscillator.  So the drawing is checked where a response exists,
 * and `ladderResponseDb` says in its own comment what it is doing above that.
 */
const MAX_LINEAR_RES = 0.85;

function measuredLadderDb(
  poles: number, fcHz: number, res: number, comp: number, hz: number,
): number {
  const amp = 1e-4;
  const L = new Ladder();
  const g = Math.tan((Math.PI * fcHz) / SR);
  const k = 4 * Math.min(0.999, Math.max(0, res));
  const n = 96000;
  const out = new Float32Array(n);
  const ref = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = Math.sin((2 * Math.PI * hz * i) / SR) * amp;
    ref[i] = x;
    out[i] = L.step(x, g, k, comp, poles, 1);
  }
  const from = SR;
  return 20 * Math.log10(
    Math.max(1e-16, tone(out, hz, from, n - from)) / Math.max(1e-16, tone(ref, hz, from, n - from)),
  );
}

check('the ladder picture is the ladder, measured through the engine', () => {
  const cut = 84;
  const fc = cutoffHz(cut);
  for (const poles of [2, 3, 4]) {
    for (const res of [0, 0.35, 0.6, MAX_LINEAR_RES]) {
      for (const ratio of [0.1, 0.25, 0.5, 1, 2, 4]) {
        const hz = fc * ratio;
        const drawn = ladderResponseDb(poles, fc, res, 0, hz, SR);
        const real = measuredLadderDb(poles, fc, res, 0, hz);
        // A tenth of a decibel, not a couple.  The drawing is the engine's
        // own difference equation solved on the unit circle, so anything
        // looser than this would pass with the analogue prototype that was
        // here first and 15 dB out at the peak.
        assert(Math.abs(drawn - real) < 0.1,
          `${poles * 6} dB, res ${res}, ${ratio}× cutoff: the panel draws ${drawn.toFixed(2)} dB, `
          + `the engine does ${real.toFixed(2)} dB`);
      }
    }
  }
});

check('the resonance draws as the peak it really is, at every slope', () => {
  // The bug this panel was written on top of: the resonance only worked at
  // 24 dB.  If the drawing had existed then it would have shown a peak at
  // every slope while two of them were flat, so the picture has to be checked
  // per slope and not only at the default.
  const fc = cutoffHz(84);
  for (const poles of [2, 3, 4]) {
    const drawnLift = ladderResponseDb(poles, fc, MAX_LINEAR_RES, 0, fc, SR)
      - ladderResponseDb(poles, fc, 0, 0, fc, SR);
    const realLift = measuredLadderDb(poles, fc, MAX_LINEAR_RES, 0, fc)
      - measuredLadderDb(poles, fc, 0, 0, fc);
    assert(drawnLift > 6, `at ${poles * 6} dB the picture only lifts ${drawnLift.toFixed(1)} dB`);
    assert(Math.abs(drawnLift - realLift) < 0.1,
      `at ${poles * 6} dB the picture lifts ${drawnLift.toFixed(1)} dB and the engine ${realLift.toFixed(1)}`);
  }
});

check('the picture shows the bass the feedback takes, and BASS COMP putting it back', () => {
  // This is the one thing a ladder does that a clean filter cannot be made to
  // do afterwards, and the panel draws the resonance-off curve behind the
  // live one so it is visible.  If the drawing ignored `compensation` the
  // faint curve would be right and the knob would appear to do nothing.
  const fc = cutoffHz(84);
  const low = 40;
  const R = MAX_LINEAR_RES;
  const drawnLoss = ladderResponseDb(4, fc, 0, 0, low, SR) - ladderResponseDb(4, fc, R, 0, low, SR);
  const realLoss = measuredLadderDb(4, fc, 0, 0, low) - measuredLadderDb(4, fc, R, 0, low);
  assert(drawnLoss > 8, `the picture only loses ${drawnLoss.toFixed(1)} dB of bass at high resonance`);
  assert(Math.abs(drawnLoss - realLoss) < 0.1,
    `the picture loses ${drawnLoss.toFixed(2)} dB and the engine ${realLoss.toFixed(2)}`);

  const withComp = ladderResponseDb(4, fc, R, 1, low, SR) - ladderResponseDb(4, fc, 0, 0, low, SR);
  assert(Math.abs(withComp) < 1.5,
    `at BASS COMP 1 the picture still shows the low end ${withComp.toFixed(1)} dB from where it started`);
  const realComp = measuredLadderDb(4, fc, R, 1, low) - measuredLadderDb(4, fc, 0, 0, low);
  assert(Math.abs(withComp - realComp) < 0.1,
    `with compensation the picture says ${withComp.toFixed(2)} dB and the engine ${realComp.toFixed(2)}`);
});

check('the waveform picture is analogSample and not a textbook shape', () => {
  for (let shape = 0; shape < ANALOG_SHAPES.length; shape++) {
    const pts = analogWavePoints(shape, 0.5);
    for (const p of pts) {
      assert(Number.isFinite(p.x) && Number.isFinite(p.y) && p.y >= -0.01 && p.y <= 1.01,
        `${ANALOG_SHAPES[shape]} draws a point at ${p.x.toFixed(2)},${p.y.toFixed(2)}`);
    }
    // Normalised to the same height, so a flat line means a flat oscillator.
    let lo = 1; let hi = 0;
    for (const p of pts) { lo = Math.min(lo, p.y); hi = Math.max(hi, p.y); }
    assert(hi - lo > 0.8, `${ANALOG_SHAPES[shape]} draws a nearly flat line (${(hi - lo).toFixed(3)})`);
  }
  // No two shapes may draw the same line.
  for (let a = 0; a < ANALOG_SHAPES.length; a++) {
    for (let b = a + 1; b < ANALOG_SHAPES.length; b++) {
      const pa = analogWavePoints(a, 0.5); const pb = analogWavePoints(b, 0.5);
      let diff = 0;
      for (let i = 0; i < pa.length; i++) diff = Math.max(diff, Math.abs((pa[i]?.y ?? 0) - (pb[i]?.y ?? 0)));
      assert(diff > 0.05, `${ANALOG_SHAPES[a]} and ${ANALOG_SHAPES[b]} draw the same line`);
    }
  }
  // And the drawing is the engine's samples, not a second description of a
  // saw: the same call sequence, normalised, has to land on the same points.
  const points = 256; const cycles = 2; const dt = cycles / points;
  for (let shape = 0; shape < ANALOG_SHAPES.length; shape++) {
    const tri = { value: 0 };
    let ph = 0;
    for (let i = 0; i < points * 3; i++) { analogSample(shape, ph, dt, 0.35, tri); ph += dt; }
    const raw: number[] = [];
    let lo = Infinity; let hi = -Infinity;
    for (let i = 0; i < points; i++) {
      const v = analogSample(shape, ph, dt, 0.35, tri);
      raw.push(v); lo = Math.min(lo, v); hi = Math.max(hi, v); ph += dt;
    }
    const centre = (hi + lo) / 2;
    const half = Math.max(1e-9, (hi - lo) / 2);
    const pts = analogWavePoints(shape, 0.35, cycles, points);
    for (let i = 0; i < points; i++) {
      const want = 0.5 - (((raw[i] ?? 0) - centre) / half) * 0.46;
      assert(Math.abs((pts[i]?.y ?? 0) - want) < 1e-9,
        `${ANALOG_SHAPES[shape]} draws ${(pts[i]?.y ?? 0).toFixed(5)} where the engine gives ${want.toFixed(5)}`);
    }
  }
});

check('the pulse width moves the shapes it moves, and not the ones it does not', () => {
  // The triangle is the integral of the pulse rather than a shape of its own,
  // which is the reason its width control does anything at all.  A panel that
  // drew a textbook triangle would show a knob that does nothing — so the
  // claim is checked per shape, including the two it must NOT move.
  const spread = (shape: number): number => {
    const a = analogWavePoints(shape, 0.2); const b = analogWavePoints(shape, 0.8);
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff = Math.max(diff, Math.abs((a[i]?.y ?? 0) - (b[i]?.y ?? 0)));
    return diff;
  };
  assert(spread(1) > 0.2, `the pulse looks the same at width 0.2 and 0.8 (${spread(1).toFixed(3)})`);
  assert(spread(2) > 0.05, `the triangle's width does nothing (${spread(2).toFixed(3)})`);
  assert(spread(3) < 0.01, `the sine changed with the width knob (${spread(3).toFixed(3)})`);
  assert(spread(0) < 0.01, `the saw changed with the width knob (${spread(0).toFixed(3)})`);
});

check('the envelope picture is analogEnv, and the curve knob is visible in it', () => {
  const a = 0.05; const d = 0.3; const s = 0.5; const r = 0.4;
  for (const curve of [0, 0.5, 1]) {
    const shape = analogEnvPoints(a, d, s, r, curve, 160);
    const held = 0.22;
    const span = a + d + r;
    const heldSec = span * (held / (1 - held));
    const total = span + heldSec;
    const gate = a + d + heldSec;
    for (let i = 0; i < shape.points.length; i += 7) {
      const t = (i / (shape.points.length - 1)) * total;
      const want = 1 - Math.max(0, Math.min(1, analogEnv(t, gate, a, d, s, r, curve)));
      assert(Math.abs((shape.points[i]?.y ?? 0) - want) < 1e-9,
        `at curve ${curve}, t ${t.toFixed(3)}: the picture draws ${(shape.points[i]?.y ?? 0).toFixed(5)}, `
        + `the engine gives ${want.toFixed(5)}`);
    }
    assert(Math.abs(shape.releaseAt - gate / total) < 1e-9, 'the key-lift marker is in the wrong place');
  }
  // The straight line and the capacitor have to LOOK different, or the knob
  // the panel puts beside this picture is drawing nothing.
  const straight = analogEnvPoints(a, d, s, r, 0);
  const curved = analogEnvPoints(a, d, s, r, 1);
  let diff = 0;
  for (let i = 0; i < straight.points.length; i++) {
    diff = Math.max(diff, Math.abs((straight.points[i]?.y ?? 0) - (curved.points[i]?.y ?? 0)));
  }
  assert(diff > 0.1, `curve 0 and curve 1 draw the same envelope (${diff.toFixed(3)})`);
  for (const p of analogEnvPoints(0, 0, 0, 0, 1).points) {
    assert(Number.isFinite(p.x) && Number.isFinite(p.y), 'an all-zero envelope drew a non-finite point');
  }
});

check('the drift picture is driftCents, on a scale that does not auto-fit', () => {
  const pts = driftPoints(10, 3, 10, 25, 240);
  for (let i = 0; i < pts.length; i++) {
    const t = (i / (pts.length - 1)) * 10;
    const want = Math.max(0, Math.min(1, 0.5 - (driftCents(t, 10, 3) / 25) * 0.46));
    assert(Math.abs((pts[i]?.y ?? 0) - want) < 1e-9,
      `at t ${t.toFixed(2)} the picture draws ${(pts[i]?.y ?? 0).toFixed(5)}, driftCents gives ${want.toFixed(5)}`);
  }
  // A small drift and a large one must not draw the same line.  An auto-fitted
  // axis would make them identical, which is exactly backwards for a control
  // whose whole meaning is HOW FAR.
  const small = driftPoints(1, 3); const large = driftPoints(25, 3);
  let spanS = 0; let spanL = 0;
  let loS = 1; let hiS = 0; let loL = 1; let hiL = 0;
  for (let i = 0; i < small.length; i++) {
    loS = Math.min(loS, small[i]?.y ?? 0); hiS = Math.max(hiS, small[i]?.y ?? 0);
    loL = Math.min(loL, large[i]?.y ?? 0); hiL = Math.max(hiL, large[i]?.y ?? 0);
  }
  spanS = hiS - loS; spanL = hiL - loL;
  assert(spanL > spanS * 5, `drift 1 spans ${spanS.toFixed(3)} and drift 25 spans ${spanL.toFixed(3)}`);
  // Different oscillators wander differently, which is why two at the same
  // pitch beat at all.
  const other = driftPoints(10, 101);
  let diff = 0;
  for (let i = 0; i < pts.length; i++) diff = Math.max(diff, Math.abs((pts[i]?.y ?? 0) - (other[i]?.y ?? 0)));
  assert(diff > 0.05, 'two seeds draw the same drift');
});

check('the voice table is the tolerances the render loop asks for', () => {
  // Not "some tolerances": the render loop asks for four, with four different
  // spreads, and the panel claims to be showing that hardware.  The spreads
  // are read out of the engine's source so that changing one there and not
  // here fails rather than quietly making the picture a decoration.
  const src = readFileSync('src/renderer/daw/engine/analog-synth.ts', 'utf8');
  for (const [which, mult] of [[0, ''], [1, ' * 0.5'], [2, ' * 0.6'], [3, ' * 0.4']] as const) {
    assert(src.includes(`voiceTolerance(spec.slot, spread${mult}, ${which})`),
      `the render loop no longer asks for tolerance ${which} at spread${mult || ' × 1'}`);
  }
  const rows = voiceRows(6, 0.05);
  assert(rows.length === 6, `six voices drew ${rows.length} rows`);
  for (const row of rows) {
    assert(Math.abs(row.cutoff - voiceTolerance(row.slot, 0.05, 0)) < 1e-12, 'the cutoff column is not voiceTolerance');
    assert(Math.abs(row.amp - voiceTolerance(row.slot, 0.025, 1)) < 1e-12, 'the amp column has the wrong spread');
    assert(Math.abs(row.env - voiceTolerance(row.slot, 0.03, 2)) < 1e-12, 'the env column has the wrong spread');
    assert(Math.abs(row.res - voiceTolerance(row.slot, 0.02, 3)) < 1e-12, 'the res column has the wrong spread');
  }
  // The rows have to differ from each other, or the picture is telling the
  // user the voices are identical when they are not.
  const cuts = rows.map((r) => r.cutoff);
  assert(Math.max(...cuts) - Math.min(...cuts) > 0.01,
    `six voices at 5% tolerance span ${(Math.max(...cuts) - Math.min(...cuts)).toFixed(4)}`);
  // At zero tolerance they are identical, because that is what zero means.
  const same = voiceRows(6, 0).map((r) => r.cutoff);
  assert(Math.max(...same) - Math.min(...same) < 1e-12, 'at tolerance 0 the voices still differ');
  assert(voiceRows(99, 0.05).length === 8, 'the table is not clamped to the voice count the engine allows');
});

check('the panel exists, and reaches every control the instrument has', () => {
  // Everything above calls `analog-views.ts` directly and would stay green
  // with the panel deleted — the gap this repository has found by breaking a
  // check three times now.
  const strip = (s: string): string => s
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').map((l) => { const i = l.indexOf('//'); return i >= 0 ? l.slice(0, i) : l; })
    .join('\n');
  const panel = strip(readFileSync(
    'src/renderer/components/daw/instrument/AnalogPanel.tsx', 'utf8'));
  const canvas = strip(readFileSync(
    'src/renderer/components/daw/instrument/AnalogCanvas.tsx', 'utf8'));
  const rack = strip(readFileSync('src/renderer/components/daw/InstrumentRack.tsx', 'utf8'));

  assert(/<AnalogPanel/.test(rack), 'the rack never renders AnalogPanel');
  assert(/slot\.instrumentId === 'analog'/.test(rack), 'the rack does not choose the panel by instrument');
  assert(/slot\.instrumentId !== 'analog'/.test(rack),
    'the generic knob grid still draws for the analogue synth as well as the panel');
  assert(/<ParamKnobs/.test(rack), 'the rack lost the generic knob grid the other instruments use');

  for (const view of ['AnalogWaveView', 'LadderView', 'AnalogEnvView', 'AnalogCharacterView']) {
    assert(new RegExp(`<${view}`).test(panel), `the panel never draws ${view}`);
    assert(new RegExp(`export function ${view}`).test(canvas), `${view} is not exported`);
  }
  for (const fn of ['analogWavePoints', 'ladderResponseDb', 'analogEnvPoints', 'driftPoints', 'voiceRows']) {
    assert(new RegExp(`${fn}\\s*\\(`).test(canvas), `the canvases never call ${fn}`);
  }

  // EVERY parameter has to be reachable, and the evidence has to be an EDIT
  // rather than a mention: the wavetable panel's version of this check passed
  // with a knob deleted, because the id still appeared on the line that fed
  // its DISPLAY.  A control you can see and not move is not reachable.
  const edits = (idText: string): boolean =>
    panel.includes('knob(' + idText)
    || panel.includes('set(' + idText)
    || panel.includes('onDrag(' + idText);

  const inst = findInstrument('analog')!;
  const covered = new Set<string>();
  for (const d of inst.params) if (edits("'" + d.id + "'")) covered.add(d.id);

  // A family counts as covered only when the text that BUILDS it is present.
  // No template, no excuse.
  const T = '`';
  const family = (idText: string, ids: readonly string[]): void => {
    if (edits(idText)) for (const id of ids) covered.add(id);
  };
  for (const key of ['shape', 'width', 'oct', 'semi', 'fine', 'level']) {
    family(T + '${o}' + key + T, ['o1' + key, 'o2' + key]);
  }
  for (const key of ['a', 'd', 's', 'r']) {
    family(T + 'e${n}' + key + T, [1, 2].map((n) => 'e' + n + key));
  }
  for (const key of ['shape', 'sync', 'beats', 'rate', 'delay']) {
    family(T + 'l${n}' + key + T, [1, 2].map((n) => 'l' + n + key));
  }

  const missing = inst.params.map((d) => d.id).filter((id) => !covered.has(id));
  assert(missing.length === 0,
    `${missing.length} parameter(s) the panel cannot reach: ${missing.join(', ')}`);

  // The lists it offers have to be the engine's lists.
  assert(/ANALOG_SHAPE_NAMES/.test(panel), 'the wave picker does not use the shape list');
  assert(ANALOG_SHAPE_NAMES.length === ANALOG_SHAPES.length,
    `the panel offers ${ANALOG_SHAPE_NAMES.length} shapes and the engine plays ${ANALOG_SHAPES.length}`);
  assert(/LFO_SHAPES/.test(panel), 'the LFO picker does not use LFO_SHAPES');
  assert(LFO_SHAPES.length > 4, 'the LFO shape list is suspiciously short');
  assert(inst.params.length > 50, `the instrument only has ${inst.params.length} parameters`);
});

console.log('');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
const bad = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - bad}/${results.length} passed${bad ? `, ${bad} FAILED` : ''}`);
if (bad) process.exit(1);
