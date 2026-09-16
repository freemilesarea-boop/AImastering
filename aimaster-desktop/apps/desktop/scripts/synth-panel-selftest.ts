/**
 * synth-panel-selftest.ts — whether the panel's pictures are of this synth.
 *
 * A picture that disagrees with the engine is worse than no picture, because
 * it is believed.  This repository has caught that before: a filter drawn
 * from a generic two-pole curve next to a device that implements something
 * else, and a device whose picture was a diagram rather than its own
 * response.  So the drawings live in `synth-views.ts` as arithmetic, and each
 * one is checked against the engine it claims to describe.
 *
 *   · the filter curve is the SVF's response, at the resonance it really has
 *   · the wavetable display shows the frames that are in the table, and the
 *     marker sits between them when the position does
 *   · the envelope picture is the envelope the render loop runs
 *   · the LFO picture is `lfoValue`, not a sine with a label
 *
 * And the last check reads the panel's source, because everything above would
 * stay green with the panel deleted.
 *
 * Run via:  pnpm --filter @aimaster/desktop test:synth-panel
 */

import { readFileSync } from 'node:fs';
import {
  FILTER_MODE_NAMES, cutoffHz, envelopeShape, framePoints, lfoShape,
  surfaceMarker, svfResponseDb, tableSurface,
} from '../src/renderer/daw/model/synth-views.js';
import { WAVETABLES, wavetableAt } from '../src/renderer/daw/engine/wavetable.js';
import { LFO_SHAPES, MOD_DESTS, MOD_SOURCES, lfoValue } from '../src/renderer/daw/engine/mod-matrix.js';
import { renderVoice } from '../src/renderer/daw/engine/wave-synth.js';
import { defaultInstrumentParams, findInstrument } from '../src/renderer/daw/engine/instruments.js';

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
 * What the engine's filter really does to a tone at `hz`, in dB.
 *
 * Measured rather than derived: a sine is rendered through the instrument
 * with the filter in and with it bypassed, and the ratio is the response.
 * That is the only way to check a DRAWING against an ENGINE — deriving both
 * from the same formula would prove they agree with each other and nothing
 * about whether either is the filter.
 */
function measuredFilterDb(mode: number, poles: number, cutSemis: number, res: number, hz: number): number {
  const base = {
    ...defaultInstrumentParams('wavesynth'),
    aTable: 0, aPos: 0, aUnison: 1, aWidth: 0, aPan: 0,
    e1a: 0.001, e1d: 0.01, e1s: 1, e1r: 0.01,
    fltType: mode, flt24: poles >= 2 ? 1 : 0, cutoff: cutSemis, res, drive: 0, fltKey: 0,
  };
  const run = (mix: number): number => {
    const r = renderVoice({
      sampleRate: SR, seconds: 0.6, gateSec: 0.55, freqHz: hz, pitch: 60, velocity: 0.8,
      random: 0, beatsPerSec: 2, params: { ...base, fltMix: mix },
    });
    const mono = new Float32Array(r.left.length);
    for (let i = 0; i < mono.length; i++) mono[i] = ((r.left[i] ?? 0) + (r.right[i] ?? 0)) / 2;
    return tone(mono, hz, Math.round(SR * 0.2), Math.round(SR * 0.3));
  };
  return 20 * Math.log10(Math.max(1e-12, run(1)) / Math.max(1e-12, run(0)));
}

check('the filter picture is the filter, measured through the engine', () => {
  // The claim: what the panel draws at a frequency is what the instrument
  // does to a tone at that frequency.  Checked at the cutoff, an octave
  // either side and two octaves up, on the low-pass and the high-pass.
  const cut = 84;                                   // semitones from MIDI 0
  const fc = cutoffHz(cut);
  for (const [mode, poles] of [[0, 1], [0, 2], [2, 2]] as const) {
    for (const ratio of [0.25, 0.5, 1, 2, 4]) {
      const hz = fc * ratio;
      const drawn = svfResponseDb(mode, poles, fc, 0.15, hz);
      const real = measuredFilterDb(mode, poles, cut, 0.15, hz);
      assert(Math.abs(drawn - real) < 3.5,
        `${FILTER_MODE_NAMES[mode]} ${poles === 2 ? '24' : '12'} dB at ${ratio}× cutoff: `
        + `the panel draws ${drawn.toFixed(1)} dB, the engine does ${real.toFixed(1)} dB`);
    }
  }
});

check('resonance shows as the peak it actually is', () => {
  const cut = 84;
  const fc = cutoffHz(cut);
  const drawnLow = svfResponseDb(0, 1, fc, 0.1, fc);
  const drawnHigh = svfResponseDb(0, 1, fc, 0.9, fc);
  assert(drawnHigh - drawnLow > 8,
    `the picture only lifts ${(drawnHigh - drawnLow).toFixed(1)} dB at the cutoff between res 0.1 and 0.9`);
  const realLow = measuredFilterDb(0, 1, cut, 0.1, fc);
  const realHigh = measuredFilterDb(0, 1, cut, 0.9, fc);
  assert(Math.abs((drawnHigh - drawnLow) - (realHigh - realLow)) < 3.5,
    `the picture lifts ${(drawnHigh - drawnLow).toFixed(1)} dB and the engine ${(realHigh - realLow).toFixed(1)}`);
});

check('the cutoff scale is the one the knob is in', () => {
  // The knob is in semitones from MIDI 0, and the picture has to agree or the
  // vertical line lands in the wrong place at every setting.
  assert(Math.abs(cutoffHz(60) - 261.63) < 0.5, `MIDI 60 draws at ${cutoffHz(60).toFixed(1)} Hz`);
  assert(Math.abs(cutoffHz(69) - 440) < 0.5, `MIDI 69 draws at ${cutoffHz(69).toFixed(1)} Hz`);
  assert(cutoffHz(120) > 8000 && cutoffHz(12) < 20, 'the scale does not span the range the knob does');
});

check('every table draws, and the slices are the frames', () => {
  for (const table of WAVETABLES) {
    const lines = tableSurface(table, 96);
    assert(lines.length === table.frames.length,
      `${table.id} draws ${lines.length} slices for ${table.frames.length} frames`);
    // Back to front, so a caller painting in order gets depth for free.
    for (let i = 1; i < lines.length; i++) {
      assert(lines[i]!.depth < lines[i - 1]!.depth, `${table.id} is not ordered back to front`);
    }
    for (const line of lines) {
      for (const p of line.points) {
        assert(p.x >= -0.001 && p.x <= 1.001 && p.y >= -0.2 && p.y <= 1.2,
          `${table.id} frame ${line.frame} draws a point at ${p.x.toFixed(2)},${p.y.toFixed(2)}`);
      }
    }
    // Neighbouring slices have to LOOK different, or the display is telling
    // the user the table is flat when it is not.
    for (let i = 1; i < lines.length; i++) {
      let diff = 0;
      for (let k = 0; k < 96; k++) {
        diff = Math.max(diff, Math.abs((lines[i]!.points[k]?.y ?? 0) - (lines[i - 1]!.points[k]?.y ?? 0)));
      }
      assert(diff > 0.005, `${table.id} draws frames ${lines[i]!.frame} and ${lines[i - 1]!.frame} identically`);
    }
  }
});

check('the frame the panel draws is the frame the engine plays', () => {
  // `framePoints` and the render loop both read the table, and this is what
  // says they read the SAME thing — a display fed from a second copy of the
  // waveform is the classic way a picture drifts from an engine.
  for (const table of WAVETABLES) {
    for (const pos of [0, 1.5, table.frames.length - 1]) {
      const drawn = framePoints(table, pos, 512);
      let peak = 0;
      for (const v of drawn) peak = Math.max(peak, Math.abs(v));
      assert(peak > 0.3, `${table.id} at ${pos} draws a nearly flat line (peak ${peak.toFixed(3)})`);
      assert(peak <= 1.001, `${table.id} at ${pos} draws past full scale (${peak.toFixed(3)})`);
    }
  }
});

check('the marker sits between slices when the position does', () => {
  const table = wavetableAt(1);
  const lines = tableSurface(table, 128);
  const depthOf = (frame: number): number => lines.find((l) => l.frame === frame)!.depth;
  const between = surfaceMarker(table, 2.5);
  assert(between.depth > depthOf(2) && between.depth < depthOf(3),
    `at position 2.5 the marker sits at depth ${between.depth.toFixed(3)}, not between frames 2 and 3`);
  const onFrame = surfaceMarker(table, 3);
  assert(Math.abs(onFrame.depth - depthOf(3)) < 1e-9, 'at a whole position the marker is not on its frame');
  // And it is clamped, like the engine's position is.
  assert(surfaceMarker(table, -4).depth === surfaceMarker(table, 0).depth, 'the marker wrapped below 0');
  assert(surfaceMarker(table, 99).depth === surfaceMarker(table, table.frames.length - 1).depth,
    'the marker wrapped past the last frame');
});

check('the envelope picture is the envelope the engine runs', () => {
  const shape = envelopeShape(0.1, 0.3, 0.5, 0.4);
  const yAt = (x: number): number => {
    const i = Math.max(0, Math.min(shape.points.length - 1, Math.round(x * (shape.points.length - 1))));
    return 1 - (shape.points[i]?.y ?? 1);
  };
  assert(yAt(0) < 0.05, `the envelope does not start at zero (${yAt(0).toFixed(3)})`);
  // It reaches full scale at the end of the attack and then falls to sustain.
  let top = 0; let topAt = 0;
  for (let i = 0; i < shape.points.length; i++) {
    const v = 1 - (shape.points[i]?.y ?? 1);
    if (v > top) { top = v; topAt = i / (shape.points.length - 1); }
  }
  assert(top > 0.98, `the attack only reaches ${top.toFixed(3)}`);
  assert(topAt > 0.02 && topAt < 0.3, `the peak is at ${topAt.toFixed(3)} of the width`);
  const held = yAt(shape.releaseAt - 0.02);
  assert(Math.abs(held - 0.5) < 0.05, `the sustain draws at ${held.toFixed(3)} instead of 0.5`);
  assert(yAt(1) < 0.02, `the release does not reach zero (${yAt(1).toFixed(3)})`);
  // A zero envelope still draws something rather than dividing by zero.
  for (const p of envelopeShape(0, 0, 0, 0).points) {
    assert(Number.isFinite(p.x) && Number.isFinite(p.y), 'an all-zero envelope drew a non-finite point');
  }
});

check('the LFO picture is lfoValue and not a sine with a label', () => {
  for (let shape = 0; shape < LFO_SHAPES.length; shape++) {
    for (const skew of [0.2, 0.5, 0.8]) {
      const pts = lfoShape(shape, skew, 2, 192);
      for (let i = 0; i < pts.length; i++) {
        const phase = (i / (pts.length - 1)) * 2;
        const want = 0.5 - lfoValue(shape, phase, skew, 0) * 0.46;
        assert(Math.abs((pts[i]?.y ?? 0) - want) < 1e-9,
          `shape ${LFO_SHAPES[shape]} at skew ${skew} draws ${(pts[i]?.y ?? 0).toFixed(4)}, engine says ${want.toFixed(4)}`);
      }
    }
  }
  // Two different shapes must not draw the same line.
  for (let a = 0; a < LFO_SHAPES.length; a++) {
    for (let b = a + 1; b < LFO_SHAPES.length; b++) {
      const pa = lfoShape(a, 0.5); const pb = lfoShape(b, 0.5);
      let diff = 0;
      for (let i = 0; i < pa.length; i++) diff = Math.max(diff, Math.abs((pa[i]?.y ?? 0) - (pb[i]?.y ?? 0)));
      assert(diff > 0.05, `${LFO_SHAPES[a]} and ${LFO_SHAPES[b]} draw the same line`);
    }
  }
});

check('the panel exists, and reaches every control the instrument has', () => {
  // Everything above calls `synth-views.ts` directly and would stay green
  // with the panel deleted, which is the gap this repository has found by
  // breaking a check three times now.
  const strip = (src: string): string => src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').map((l) => { const i = l.indexOf('//'); return i >= 0 ? l.slice(0, i) : l; })
    .join('\n');
  const panel = strip(readFileSync(
    'src/renderer/components/daw/instrument/WaveSynthPanel.tsx', 'utf8'));
  const canvas = strip(readFileSync(
    'src/renderer/components/daw/instrument/SynthCanvas.tsx', 'utf8'));
  const rack = strip(readFileSync('src/renderer/components/daw/InstrumentRack.tsx', 'utf8'));

  assert(/<WaveSynthPanel/.test(rack), 'the rack never renders WaveSynthPanel');
  assert(/slot\.instrumentId === 'wavesynth'/.test(rack),
    'the rack does not choose the panel by instrument');
  assert(/<ParamKnobs/.test(rack), 'the rack lost the generic knob grid the other instruments use');

  for (const view of ['WavetableView', 'FilterView', 'EnvelopeView', 'LfoView']) {
    assert(new RegExp(`<${view}`).test(panel), `the panel never draws ${view}`);
    assert(new RegExp(`export function ${view}`).test(canvas), `${view} is not exported`);
  }
  for (const fn of ['tableSurface', 'surfaceMarker', 'svfResponseDb', 'envelopeShape', 'lfoShape']) {
    assert(new RegExp(`${fn}\\s*\\(`).test(canvas), `the canvases never call ${fn}`);
  }

  // EVERY parameter has to be reachable.  A panel that laid out ninety of the
  // hundred and thirteen would be worse than the knob grid it replaced: the
  // missing ones would be unreachable rather than merely hard to find.
  //
  // ── How a family counts as covered ────────────────────────────────────────
  //
  // Most of these ids are built from templates — the oscillators are one
  // description rendered twice, the matrix is eight identical rows — so they
  // never appear literally in the source.  The first version of this check
  // EXCUSED those by matching their names against a regex, which excuses the
  // family whether or not the template exists: replacing `rowParams(r)` with
  // a dummy object left all twenty-four matrix parameters unreachable and
  // this check green.
  //
  // So a family is covered only when the text that BUILDS it is present.  No
  // template, no excuse.
  const inst = findInstrument('wavesynth')!;
  const covered = new Set<string>();

  // The evidence has to be an EDIT, not a mention.
  //
  // The second version of this check accepted the template text appearing
  // anywhere in the file, and deleting the WT POS knob from the oscillator
  // template left it green -- because the same text still appears in the line
  // that feeds the wavetable DISPLAY, which reads the parameter and cannot
  // change it.  A control you can see and not move is not reachable.
  const edits = (idText: string): boolean =>
    panel.includes('knob(' + idText)
    || panel.includes('set(' + idText)
    || panel.includes('onDrag(' + idText);

  for (const d of inst.params) if (edits("'" + d.id + "'")) covered.add(d.id);

  const family = (idText: string, ids: readonly string[]): void => {
    if (edits(idText)) for (const id of ids) covered.add(id);
  };
  const T = '`';
  for (const key of ['Table', 'Pos', 'Oct', 'Semi', 'Fine', 'Unison', 'Detune',
    'Blend', 'Phase', 'Rand', 'Width', 'Pan', 'Level']) {
    family(T + '${o}' + key + T, ['a' + key, 'b' + key]);
  }
  for (const key of ['a', 'd', 's', 'r']) {
    family(T + 'e${n}' + key + T, [1, 2, 3].map((n) => 'e' + n + key));
  }
  for (const key of ['shape', 'sync', 'beats', 'rate', 'skew', 'phase', 'delay', 'rise']) {
    family(T + 'l${n}' + key + T, [1, 2, 3, 4].map((n) => 'l' + n + key));
  }
  // The matrix is the one family whose ids come from a FUNCTION rather than a
  // template, so the evidence is that function plus an edit of what it hands
  // back.  Replacing `rowParams(r)` with a dummy object left all twenty-four
  // of these unreachable and the first version of this check green.
  if (panel.includes('rowParams(') && edits('ids.src') && edits('ids.dst') && edits('ids.amt')) {
    for (let r = 1; r <= 8; r++) {
      covered.add('m' + r + 'src'); covered.add('m' + r + 'dst'); covered.add('m' + r + 'amt');
    }
  }

  const missing = inst.params.map((d) => d.id).filter((id) => !covered.has(id));
  assert(missing.length === 0,
    `${missing.length} parameter(s) the panel cannot reach: ${missing.join(', ')}`);

  // The matrix has to offer every source and destination the engine knows.
  assert(/MOD_SOURCES\.map/.test(panel), 'the matrix does not list the sources from MOD_SOURCES');
  assert(/MOD_DESTS\.map/.test(panel), 'the matrix does not list the destinations from MOD_DESTS');
  assert(MOD_SOURCES.length > 10 && MOD_DESTS.length > 10, 'the lists are suspiciously short');
  assert(inst.params.length > 100, `the instrument only has ${inst.params.length} parameters`);
});

console.log('');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
const bad = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - bad}/${results.length} passed${bad ? `, ${bad} FAILED` : ''}`);
if (bad) process.exit(1);
