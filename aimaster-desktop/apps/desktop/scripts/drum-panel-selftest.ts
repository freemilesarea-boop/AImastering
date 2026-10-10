/**
 * drum-panel-selftest.ts — whether the drum panel's pictures are of this
 * machine.
 *
 * There is no filter in this instrument, so there is no curve to check
 * against a measurement.  What a drum voice IS, is a shape a couple of
 * hundred milliseconds long, so the picture is the rendered hit — and what
 * has to be proved is that it is the SAME hit the engine plays, that it moves
 * when the controls move, and that the one thing a waveform cannot show, the
 * kick's falling pitch, is drawn from the expression the render loop runs.
 *
 * Run via:  pnpm --filter @aimaster/desktop test:drum-panel
 */

import { readFileSync } from 'node:fs';
import {
  PREVIEW_RATE, columnStart, hitShape, kickSweep,
} from '../src/renderer/daw/model/drum-views.js';
import {
  DRUM_MAX_DECAY, DRUM_VOICES, DRUM_VOICE_NAMES, drumTail, drumWindow,
  renderDrumVoice, type DrumVoice,
} from '../src/renderer/daw/engine/drum-machine.js';
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

const BASE = defaultInstrumentParams('drummachine');

check('every voice draws, inside its box, and the picture is its own length', () => {
  for (const v of DRUM_VOICES) {
    const shape = hitShape(v, BASE, 200);
    assert(shape.top.length === 200 && shape.bottom.length === 200,
      `${DRUM_VOICE_NAMES[v]} drew ${shape.top.length} columns`);
    // A FIXED window per voice, not this hit's length.  Turning the decay
    // down has to visibly shorten the picture, and it cannot if the axis
    // shrinks with it.
    assert(Math.abs(shape.seconds - drumWindow(v)) < 1e-9,
      `${DRUM_VOICE_NAMES[v]} draws ${shape.seconds.toFixed(3)} s for a ${drumWindow(v).toFixed(3)} s window`);
    assert(shape.seconds >= drumTail(v, BASE) - 1e-9,
      `${DRUM_VOICE_NAMES[v]}'s window is shorter than its default hit`);
    for (let i = 0; i < shape.top.length; i++) {
      const t = shape.top[i]!;
      const b = shape.bottom[i]!;
      assert(Number.isFinite(t.y) && Number.isFinite(b.y), `${v} drew a non-finite point`);
      assert(t.y >= 0.03 && t.y <= 0.97 && b.y >= 0.03 && b.y <= 0.97,
        `${DRUM_VOICE_NAMES[v]} draws outside its box at column ${i}`);
      // The top half is above the bottom half, always — they are the
      // largest and smallest sample of the same column.
      assert(t.y <= b.y + 1e-9, `${DRUM_VOICE_NAMES[v]} crosses itself at column ${i}`);
    }
    // It has to fill its box: normalised to its own peak, the largest
    // excursion reaches the edge.  EITHER edge — the first version of this
    // asked the positive side to reach the top, and the mid tom's biggest
    // swing is negative, so a perfectly correct picture failed.
    let up = 0.5;
    let down = 0.5;
    for (const p of shape.top) up = Math.max(up, 0.5 - p.y);
    for (const p of shape.bottom) down = Math.max(down, p.y - 0.5);
    assert(Math.max(up, down) > 0.44,
      `${DRUM_VOICE_NAMES[v]} only reaches ${Math.max(up, down).toFixed(3)} of half height`);
  }
});

check('the picture is the engine\'s samples, column for column', () => {
  // Not a second description of a drum: the same render, reduced the same
  // way.  This is what stops the display and the sound drifting apart.
  for (const v of DRUM_VOICES) {
    const columns = 120;
    const shape = hitShape(v, BASE, columns);
    const seconds = drumWindow(v);
    const r = renderDrumVoice({
      sampleRate: PREVIEW_RATE, seconds, voice: v, velocity: 1, seed: 1, params: BASE,
    });
    const n = r.left.length;
    let peak = 1e-9;
    for (let i = 0; i < n; i++) {
      const s = ((r.left[i] ?? 0) + (r.right[i] ?? 0)) / 2;
      if (Math.abs(s) > peak) peak = Math.abs(s);
    }
    for (let c = 0; c < columns; c += 7) {
      const from = columnStart(c, columns, n);
      const to = Math.min(n, Math.max(from + 1, columnStart(c + 1, columns, n)));
      let hi = 0;
      let lo = 0;
      for (let i = from; i < to; i++) {
        const s = ((r.left[i] ?? 0) + (r.right[i] ?? 0)) / 2;
        if (s > hi) hi = s;
        if (s < lo) lo = s;
      }
      assert(Math.abs((shape.top[c]?.y ?? 0) - (0.5 - (hi / peak) * 0.46)) < 1e-9,
        `${DRUM_VOICE_NAMES[v]} column ${c} draws a top the engine does not have`);
      assert(Math.abs((shape.bottom[c]?.y ?? 0) - (0.5 - (lo / peak) * 0.46)) < 1e-9,
        `${DRUM_VOICE_NAMES[v]} column ${c} draws a bottom the engine does not have`);
    }
  }
});

check('the time axis is a square root, so the attack is visible at all', () => {
  // A fixed linear window long enough for a six-second cymbal puts the clap's
  // four bursts inside two per cent of the width.  The bursts are what a clap
  // IS, so the axis is square-root — fine at the attack, coarse in the tail.
  const columns = 300;
  const n = 10000;
  assert(columnStart(0, columns, n) === 0, 'the axis does not start at zero');
  assert(columnStart(columns, columns, n) === n, 'the axis does not end at the last sample');
  // Monotonic, and expanding: every column covers more time than the one
  // before it.
  let prev = 0;
  let prevWidth = -1;
  for (let c = 1; c <= columns; c++) {
    const at = columnStart(c, columns, n);
    assert(at >= prev, `the axis goes backwards at column ${c}`);
    const width = at - prev;
    assert(width >= prevWidth - 1, `the axis narrows at column ${c}`);
    prev = at;
    prevWidth = width;
  }
  // The specific thing it buys: the first 36 ms of a 1.64 s window.
  const window = 1.64;
  const samples = Math.round(PREVIEW_RATE * window);
  let atBursts = 0;
  for (let c = 0; c <= columns; c++) {
    if (columnStart(c, columns, samples) <= PREVIEW_RATE * 0.036) atBursts = c;
  }
  const fraction = atBursts / columns;
  assert(fraction > 0.1,
    `the clap's bursts still occupy ${(fraction * 100).toFixed(1)}% of the width`);
  // On a linear axis they would be 2.2%, which is what this replaced.
  assert(fraction < 0.4, `the attack now takes ${(fraction * 100).toFixed(0)}% — the tail is gone`);
});

check('the picture is of the settings, and changes when they do', () => {
  const moved = (v: DrumVoice, over: Record<string, number>): number => {
    const a = hitShape(v, BASE, 160);
    const b = hitShape(v, { ...BASE, ...over }, 160);
    let diff = 0;
    for (let i = 0; i < a.top.length; i++) {
      diff = Math.max(diff, Math.abs((a.top[i]?.y ?? 0) - (b.top[i]?.y ?? 0)));
    }
    return diff;
  };
  // Decay changes the shape of every voice.
  for (const v of DRUM_VOICES) {
    const def = findInstrument('drummachine')!.params.find((d) => d.id === `${v}dec`)!;
    assert(moved(v, { [`${v}dec`]: def.max * 0.8 }) > 0.02,
      `${DRUM_VOICE_NAMES[v]}'s picture does not move when its decay does`);
  }
  assert(moved('sd', { sdtone: 1 }) > 0.02, 'the snare picture ignores Tone');
  assert(moved('cp', { cpspread: 2.5 }) > 0.02, 'the clap picture ignores Spread');
  assert(moved('bd', { bdsnap: 1, bddrive: 6 }) > 0.02, 'the kick picture ignores Snap and Drive');

  // And it is a picture of the VOICE, not of one hit: it must not change
  // between repaints.
  const a = hitShape('sd', BASE, 100);
  const b = hitShape('sd', BASE, 100);
  for (let i = 0; i < a.top.length; i++) {
    assert(a.top[i]?.y === b.top[i]?.y, `the snare picture changed between two draws at column ${i}`);
  }
});

check('the kick sweep is the engine\'s own expression, on a fixed scale', () => {
  const tune = 52;
  const decay = 0.55;
  const bend = 26;
  const sweep = kickSweep(tune, bend, decay, 0);
  assert(Math.abs(sweep.baseHz - tune) < 1e-9, `the sweep settles at ${sweep.baseHz}, not the tuning`);
  assert(Math.abs(sweep.topHz - tune * Math.pow(2, bend / 12)) < 1e-6,
    'the sweep does not start a Bend above the tuning');
  // The same arithmetic the render loop runs, sampled.
  const bendDec = decay * 0.09;
  const ceiling = tune * Math.pow(2, 4);
  for (let i = 0; i < sweep.points.length; i += 5) {
    const t = (i / (sweep.points.length - 1)) * 0.25;
    const hz = tune * Math.pow(2, (bend / 12) * Math.exp(-t / bendDec));
    const want = Math.max(0, Math.min(1, 1 - Math.log2(hz / tune) / Math.log2(ceiling / tune)));
    assert(Math.abs((sweep.points[i]?.y ?? 0) - want) < 1e-9,
      `at t ${t.toFixed(3)} the sweep draws ${(sweep.points[i]?.y ?? 0).toFixed(5)}, the engine gives ${want.toFixed(5)}`);
  }
  // It falls, and it settles.
  assert((sweep.points[0]?.y ?? 1) < (sweep.points[sweep.points.length - 1]?.y ?? 0),
    'the sweep does not fall');
  assert((sweep.points[sweep.points.length - 1]?.y ?? 0) > 0.98, 'the sweep does not settle at the tuning');

  // The scale is FIXED at the knob's maximum, so Bend 0 and Bend 48 do not
  // draw the same line — the mistake the analogue panel's drift display was
  // written to avoid.
  const flat = kickSweep(tune, 0, decay, 0);
  const deep = kickSweep(tune, 48, decay, 0);
  const span = (s: { points: Array<{ y: number }> }): number => {
    let lo = 1;
    let hi = 0;
    for (const p of s.points) { lo = Math.min(lo, p.y); hi = Math.max(hi, p.y); }
    return hi - lo;
  };
  assert(span(flat) < 0.02, `at Bend 0 the sweep still spans ${span(flat).toFixed(3)}`);
  assert(span(deep) > 0.9, `at Bend 48 the sweep only spans ${span(deep).toFixed(3)}`);
  // Master tune moves it too, or the picture disagrees with the sound.
  assert(kickSweep(tune, bend, decay, 12).baseHz > sweep.baseHz * 1.9,
    'the master tune does not reach the sweep');
});

check('the panel exists, and reaches every control the instrument has', () => {
  const strip = (src: string): string => src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').map((l) => { const i = l.indexOf('//'); return i >= 0 ? l.slice(0, i) : l; })
    .join('\n');
  const panel = strip(readFileSync('src/renderer/components/daw/instrument/DrumPanel.tsx', 'utf8'));
  const canvas = strip(readFileSync('src/renderer/components/daw/instrument/DrumCanvas.tsx', 'utf8'));
  const rack = strip(readFileSync('src/renderer/components/daw/InstrumentRack.tsx', 'utf8'));

  assert(/<DrumPanel/.test(rack), 'the rack never renders DrumPanel');
  assert(/slot\.instrumentId === 'drummachine'/.test(rack),
    'the rack does not choose the panel by instrument');
  assert(/slot\.instrumentId !== 'drummachine'/.test(rack),
    'the generic knob grid still draws for the drum machine as well as the panel');
  assert(/<ParamKnobs/.test(rack), 'the rack lost the generic knob grid the other instruments use');

  for (const view of ['HitView', 'SweepView']) {
    assert(new RegExp(`<${view}`).test(panel), `the panel never draws ${view}`);
    assert(new RegExp(`export function ${view}`).test(canvas), `${view} is not exported`);
  }
  for (const fn of ['hitShape', 'kickSweep']) {
    assert(new RegExp(`${fn}\\s*\\(`).test(canvas), `the canvases never call ${fn}`);
  }

  // The evidence has to be an EDIT and not a mention: the wavetable panel's
  // version of this check once passed with a knob deleted, because the id
  // still appeared on the line that fed its display.
  const edits = (idText: string): boolean =>
    panel.includes('knob(' + idText)
    || panel.includes('set(' + idText)
    || panel.includes('onDrag(' + idText);

  const inst = findInstrument('drummachine')!;
  const ids = new Set(inst.params.map((d) => d.id));
  const covered = new Set<string>();
  for (const d of inst.params) if (edits("'" + d.id + "'")) covered.add(d.id);

  // The per-voice controls are one description rendered eleven times, so a
  // family counts only when the text that BUILDS it is being edited.  Only
  // ids the instrument actually declares are added — not every voice has a
  // tune or a bend, and the open hat deliberately shares the closed hat's.
  const T = '`';
  for (const key of ['tune', 'dec', 'bend', 'lvl']) {
    if (edits(T + '${voice}' + key + T) || edits(T + '${v}' + key + T)) {
      for (const v of DRUM_VOICES) if (ids.has(`${v}${key}`)) covered.add(`${v}${key}`);
    }
  }

  const missing = inst.params.map((d) => d.id).filter((id) => !covered.has(id));
  assert(missing.length === 0,
    `${missing.length} parameter(s) the panel cannot reach: ${missing.join(', ')}`);

  // Every voice has to be selectable, or the templates above cover
  // parameters nobody can get to.
  assert(/setVoice\(v\)/.test(panel), 'the pads do not select a voice');
  assert(/DRUM_VOICES\.map/.test(panel), 'the pads are not built from the engine\'s voice list');
  assert(inst.params.length > 40, `the instrument only has ${inst.params.length} parameters`);

  // The window the panel draws over is the longest each voice can be set to,
  // so the two have to be the same table rather than two tables that agree
  // today.
  for (const v of DRUM_VOICES) {
    const def = inst.params.find((d) => d.id === `${v}dec`)!;
    assert(def.max === DRUM_MAX_DECAY[v],
      `${DRUM_VOICE_NAMES[v]}'s decay goes to ${def.max} but the panel draws ${DRUM_MAX_DECAY[v]}`);
  }
});

console.log('');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
const bad = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - bad}/${results.length} passed${bad ? `, ${bad} FAILED` : ''}`);
if (bad) process.exit(1);
