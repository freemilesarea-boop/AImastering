/**
 * fm-panel-selftest.ts — whether the FM panel's pictures are of this synth.
 *
 * The headline picture here is the ALGORITHM, and it is a different kind of
 * claim from the other two panels' curves.  A filter curve can be checked
 * against a measurement; a graph is checked against the connection list the
 * render loop actually walks — that every arrow the engine has is drawn, that
 * no arrow is drawn that the engine does not have, that carriers are the
 * boxes at the bottom, and that a deeper modulator is drawn higher.
 *
 * The spectrum is checked the other way round: it is rendered through the
 * engine, so what it has to prove is that it agrees with a full-rate render
 * about where the partials are, in spite of being a fifth of a second at
 * 16 kHz.
 *
 * Run via:  pnpm --filter @aimaster/desktop test:fm-panel
 */

import { readFileSync } from 'node:fs';
import {
  FM_WAVE_NAMES, SPECTRUM_RATE, algorithmLayout, layoutAt, operatorEnvPoints,
  operatorHz, operatorWavePoints, patchSpectrum,
} from '../src/renderer/daw/model/fm-views.js';
import {
  FM_ALGORITHMS, FM_OPERATORS, FM_WAVES, fmEnv, fmWave,
} from '../src/renderer/daw/engine/fm-core.js';
import { renderFmVoice } from '../src/renderer/daw/engine/fm-synth.js';
import { LFO_SHAPES } from '../src/renderer/daw/engine/mod-matrix.js';
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

// ── The algorithm diagram ───────────────────────────────────────────────────

check('every algorithm draws every operator, and every arrow it really has', () => {
  for (const a of FM_ALGORITHMS) {
    const L = algorithmLayout(a);
    assert(L.boxes.length === FM_OPERATORS, `${a.name} draws ${L.boxes.length} boxes`);
    const ops = new Set(L.boxes.map((b) => b.op));
    for (let i = 0; i < FM_OPERATORS; i++) assert(ops.has(i), `${a.name} never draws operator ${i + 1}`);

    // The arrows are the engine's connections, one for one — not a subset and
    // not a superset.  A diagram that dropped an arrow would be describing a
    // different instrument to the one making the sound.
    assert(L.edges.length === a.mods.length,
      `${a.name} draws ${L.edges.length} arrows for ${a.mods.length} connections`);
    for (const [from, to] of a.mods) {
      assert(L.edges.some((e) => e.from === from && e.to === to),
        `${a.name} never draws ${from + 1} → ${to + 1}`);
    }
    for (const e of L.edges) {
      assert(a.mods.some(([f, t]) => f === e.from && t === e.to),
        `${a.name} draws an arrow ${e.from + 1} → ${e.to + 1} the engine does not have`);
    }
  }
});

check('carriers sit at the bottom and modulators above what they feed', () => {
  for (const a of FM_ALGORITHMS) {
    const L = algorithmLayout(a);
    const box = (op: number) => L.boxes.find((b) => b.op === op)!;
    for (const c of a.carriers) {
      assert(box(c).carrier, `${a.name} does not mark operator ${c + 1} as a carrier`);
      assert(box(c).depth === 0, `${a.name} puts carrier ${c + 1} on row ${box(c).depth}`);
    }
    for (const [from, to] of a.mods) {
      assert(box(from).depth > box(to).depth,
        `${a.name} draws modulator ${from + 1} at or below its target ${to + 1}`);
      // Downward on screen means downward in the signal, so a modulator's y
      // has to be SMALLER — further up the picture.
      assert(box(from).y < box(to).y,
        `${a.name} draws modulator ${from + 1} below its target on screen`);
    }
    // A six-deep stack needs six rows, and a fully additive one needs one.
    if (a.mods.length === 0) assert(L.rows === 1, `${a.name} has no arrows but draws ${L.rows} rows`);
  }
  assert(layoutAt(0).rows === 6, 'the stack of six does not draw six rows');
  assert(layoutAt(31).rows === 1, 'the additive algorithm does not draw one row');
  assert(layoutAt(-9).rows === layoutAt(0).rows, 'the index is not clamped below');
  assert(layoutAt(500).rows === layoutAt(31).rows, 'the index is not clamped above');
});

check('no two boxes overlap, and none is drawn off the picture', () => {
  for (const a of FM_ALGORITHMS) {
    const L = algorithmLayout(a);
    for (const b of L.boxes) {
      assert(b.x - L.halfW > -0.001 && b.x + L.halfW < 1.001,
        `${a.name} draws operator ${b.op + 1} at x ${b.x.toFixed(3)}, outside the frame`);
      assert(b.y > 0 && b.y < 1, `${a.name} draws operator ${b.op + 1} at y ${b.y.toFixed(3)}`);
    }
    for (let i = 0; i < L.boxes.length; i++) {
      for (let j = i + 1; j < L.boxes.length; j++) {
        const p = L.boxes[i]!;
        const q = L.boxes[j]!;
        if (p.depth !== q.depth) continue;
        assert(Math.abs(p.x - q.x) >= L.halfW * 2 - 1e-9,
          `${a.name} overlaps operators ${p.op + 1} and ${q.op + 1} on row ${p.depth}`);
      }
    }
  }
});

check('a shared modulator is drawn between the things it shares', () => {
  // The one thing the layout is FOR beyond not overlapping: a modulator that
  // feeds two carriers has to sit between them, or the picture says it feeds
  // the one it happens to sit over.
  const shared = FM_ALGORITHMS[27]!;            // 28 · one modulator into all five
  const L = algorithmLayout(shared);
  const box = (op: number) => L.boxes.find((b) => b.op === op)!;
  const targets = shared.mods.filter(([f]) => f === 5).map(([, t]) => box(t).x);
  assert(targets.length === 5, 'the fixture algorithm is not the one this check is about');
  const lo = Math.min(...targets);
  const hi = Math.max(...targets);
  const mod = box(5).x;
  assert(mod > lo && mod < hi,
    `the shared modulator is drawn at ${mod.toFixed(3)}, outside its targets' ${lo.toFixed(3)}…${hi.toFixed(3)}`);
  assert(Math.abs(mod - (lo + hi) / 2) < 0.12,
    `the shared modulator is not centred on its targets (${mod.toFixed(3)} against ${((lo + hi) / 2).toFixed(3)})`);
});

// ── The operator ────────────────────────────────────────────────────────────

check('the envelope picture is fmEnv, curve and all', () => {
  const a = 0.05; const d = 0.4; const s = 0.35; const r = 0.3;
  const shape = operatorEnvPoints(a, d, s, r, 160);
  const held = 0.22;
  const span = a + d + r;
  const heldSec = span * (held / (1 - held));
  const total = span + heldSec;
  const gate = a + d + heldSec;
  for (let i = 0; i < shape.points.length; i += 7) {
    const t = (i / (shape.points.length - 1)) * total;
    const want = 1 - Math.max(0, Math.min(1, fmEnv(t, gate, a, d, s, r)));
    assert(Math.abs((shape.points[i]?.y ?? 0) - want) < 1e-9,
      `at t ${t.toFixed(3)} the picture draws ${(shape.points[i]?.y ?? 0).toFixed(5)}, fmEnv gives ${want.toFixed(5)}`);
  }
  assert(Math.abs(shape.releaseAt - gate / total) < 1e-9, 'the key-lift marker is in the wrong place');

  // It is EXPONENTIAL, and the picture has to show that rather than a line.
  // Halfway through the attack, an exponential is already above 0.79 where a
  // straight line would be at 0.5.
  const half = operatorEnvPoints(1, 8, 1, 1, 400);
  const mid = 1 - (half.points[Math.round((0.5 / (1 + 8 + 1 + (10 * 0.22 / 0.78))) * 399)]?.y ?? 0);
  assert(mid > 0.7, `halfway through the attack the picture is at ${mid.toFixed(3)} — it is drawing a straight line`);

  for (const p of operatorEnvPoints(0, 0, 0, 0).points) {
    assert(Number.isFinite(p.x) && Number.isFinite(p.y), 'an all-zero envelope drew a non-finite point');
  }
});

check('the wave picture is fmWave, and the eight are eight', () => {
  for (let k = 0; k < FM_WAVES.length; k++) {
    const pts = operatorWavePoints(k, 2, 192);
    let lo = 1; let hi = 0;
    for (const p of pts) {
      assert(Number.isFinite(p.y) && p.y > -0.01 && p.y < 1.01,
        `${FM_WAVES[k]} draws a point at ${p.y.toFixed(3)}`);
      lo = Math.min(lo, p.y); hi = Math.max(hi, p.y);
    }
    assert(hi - lo > 0.85, `${FM_WAVES[k]} draws at ${(hi - lo).toFixed(3)} of full height`);
    // Drawn from the engine's samples, fitted between its own extremes.
    const raw: number[] = [];
    let rlo = Infinity; let rhi = -Infinity;
    for (let i = 0; i < 192; i++) {
      const v = fmWave(k, (i / 192) * 2, 7919);
      raw.push(v); rlo = Math.min(rlo, v); rhi = Math.max(rhi, v);
    }
    const centre = (rhi + rlo) / 2;
    const halfSpan = Math.max(1e-9, (rhi - rlo) / 2);
    for (let i = 0; i < 192; i++) {
      const want = 0.5 - (((raw[i] ?? 0) - centre) / halfSpan) * 0.46;
      assert(Math.abs((pts[i]?.y ?? 0) - want) < 1e-9,
        `${FM_WAVES[k]} draws ${(pts[i]?.y ?? 0).toFixed(5)} where fmWave gives ${want.toFixed(5)}`);
    }
  }
  for (let a = 0; a < FM_WAVES.length; a++) {
    for (let b = a + 1; b < FM_WAVES.length; b++) {
      const pa = operatorWavePoints(a); const pb = operatorWavePoints(b);
      let diff = 0;
      for (let i = 0; i < pa.length; i++) diff = Math.max(diff, Math.abs((pa[i]?.y ?? 0) - (pb[i]?.y ?? 0)));
      assert(diff > 0.05, `${FM_WAVES[a]} and ${FM_WAVES[b]} draw the same line`);
    }
  }
});

check('the frequency readout is the frequency the operator runs at', () => {
  assert(Math.abs(operatorHz(261.63, 1, 0, false, 440) - 261.63) < 1e-9, 'ratio 1 is not the note');
  assert(Math.abs(operatorHz(261.63, 14, 0, false, 440) - 261.63 * 14) < 1e-6, 'ratio 14 is not 14 times the note');
  assert(Math.abs(operatorHz(261.63, 3, 0, true, 1200) - 1200) < 1e-9, 'a fixed operator followed the note');
  // Fine is in cents, the way the engine folds it into the ratio.
  assert(Math.abs(operatorHz(261.63, 1, 1200, false, 440) - 523.26) < 1e-3, 'fine is not in cents');
  assert(operatorHz(261.63, 0, 0, false, 440) > 0, 'a zero ratio produced a zero frequency');
});

// ── The spectrum ────────────────────────────────────────────────────────────

check('the spectrum is of this patch, and finds the partials a full render has', () => {
  // It is a fifth of a second at 16 kHz, which is the whole point — cheap
  // enough to redraw on every knob release.  What it has to prove is that the
  // shortcut did not move the partials.
  const base = defaultInstrumentParams('fm');
  const bins = patchSpectrum(base);
  assert(bins.length > 200, `the spectrum has only ${bins.length} bins`);
  assert(bins[0]!.hz < 20, `the first bin is at ${bins[0]!.hz.toFixed(1)} Hz`);
  const top = bins[bins.length - 1]!.hz;
  assert(Math.abs(top - SPECTRUM_RATE / 2) < SPECTRUM_RATE / 100,
    `the spectrum runs to ${top.toFixed(0)} Hz, not to half the render rate`);

  const dbAtHz = (hz: number): number => {
    let best = -999;
    for (const b of bins) if (Math.abs(b.hz - hz) < 30) best = Math.max(best, b.db);
    return best;
  };
  // The default patch is a tine electric piano: fundamental, second, and a
  // pair up at the thirteenth and fifteenth harmonic.  All three have to be
  // in the picture, and the noise between them has to be well below.
  // Normalised to the patch's loudest partial, so the picture is a shape and
  // not a level meter — the tallest bin is 0 dB by construction.
  let loudest = -999;
  for (const b of bins) loudest = Math.max(loudest, b.db);
  assert(Math.abs(loudest) < 1e-6, `the loudest bin reads ${loudest.toFixed(2)} dB, not 0`);
  const f = dbAtHz(261.63);
  assert(f > -12, `the fundamental reads ${f.toFixed(1)} dB below the loudest partial`);
  assert(f - dbAtHz(261.63 * 2) < 20, 'the second harmonic is missing from the picture');
  assert(f - Math.max(dbAtHz(261.63 * 13), dbAtHz(261.63 * 15)) < 25,
    'the tine partials are missing from the picture');
  // And a frequency the patch does not produce has to be far down.
  assert(f - dbAtHz(261.63 * 6.5) > 25,
    `the picture shows ${(f - dbAtHz(261.63 * 6.5)).toFixed(1)} dB at a frequency this patch does not make`);

  // Changing the patch changes the picture — a spectrum drawn from a cached
  // or constant source would not.
  const other = patchSpectrum({ ...base, algo: 4, o2ratio: 3.51, o2level: 0.6 });
  let diff = 0;
  for (let i = 0; i < bins.length; i++) diff = Math.max(diff, Math.abs(bins[i]!.db - other[i]!.db));
  assert(diff > 12, `two very different patches draw the same spectrum (max ${diff.toFixed(1)} dB apart)`);
});

check('the cheap spectrum agrees with a full-rate render about where the partials are', () => {
  const base = defaultInstrumentParams('fm');
  const bins = patchSpectrum(base);
  const near = (hz: number): number => {
    let best = -999;
    for (const b of bins) if (Math.abs(b.hz - hz) < 40) best = Math.max(best, b.db);
    return best;
  };
  // The reference: the same patch at 48 kHz, measured by Goertzel.
  const SR = 48000;
  const r = renderFmVoice({
    sampleRate: SR, seconds: 1, gateSec: 0.9, freqHz: 261.63, pitch: 60, velocity: 0.85,
    params: base, beatsPerSec: 2,
  });
  const mono = new Float32Array(r.left.length);
  for (let i = 0; i < mono.length; i++) mono[i] = ((r.left[i] ?? 0) + (r.right[i] ?? 0)) / 2;
  // The SAME window the picture uses — 128 ms starting 30 ms in.  The first
  // version of this compared a 200 ms reference against a 128 ms picture and
  // read 14 dB apart on the second harmonic, which was not a disagreement
  // about the partials: the modulators decay, so a longer window is a darker
  // average.  Comparing two different windows is not comparing two paths.
  const goertzel = (hz: number): number => {
    const from = Math.round(SR * 0.03);
    const n = Math.round((SR * 2048) / SPECTRUM_RATE);
    const w = (2 * Math.PI * hz) / SR;
    const c = 2 * Math.cos(w);
    let s1 = 0; let s2 = 0;
    for (let i = 0; i < n; i++) {
      const win = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
      const s0 = (mono[from + i] ?? 0) * win + c * s1 - s2;
      s2 = s1; s1 = s0;
    }
    return 20 * Math.log10(Math.max(1e-9, Math.hypot(s1 - s2 * Math.cos(w), s2 * Math.sin(w)) / n));
  };
  // Relative to each one's own fundamental, because the two paths window and
  // normalise differently and the claim is about the SHAPE.
  const pRef = goertzel(261.63);
  const pPic = near(261.63);
  for (const h of [2, 3, 13, 15]) {
    const hz = 261.63 * h;
    if (hz > SPECTRUM_RATE / 2 - 200) continue;
    const ref = goertzel(hz) - pRef;
    const pic = near(hz) - pPic;
    assert(Math.abs(ref - pic) < 9,
      `harmonic ${h}: the picture says ${pic.toFixed(1)} dB below the fundamental, a full render says ${ref.toFixed(1)}`);
  }
});

// ── The panel itself ────────────────────────────────────────────────────────

check('the panel exists, and reaches every control the instrument has', () => {
  // Everything above calls `fm-views.ts` directly and would stay green with
  // the panel deleted — the gap this repository has found by breaking a check
  // three times now.
  const strip = (src: string): string => src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').map((l) => { const i = l.indexOf('//'); return i >= 0 ? l.slice(0, i) : l; })
    .join('\n');
  const panel = strip(readFileSync('src/renderer/components/daw/instrument/FmPanel.tsx', 'utf8'));
  const canvas = strip(readFileSync('src/renderer/components/daw/instrument/FmCanvas.tsx', 'utf8'));
  const rack = strip(readFileSync('src/renderer/components/daw/InstrumentRack.tsx', 'utf8'));

  assert(/<FmPanel/.test(rack), 'the rack never renders FmPanel');
  assert(/slot\.instrumentId === 'fm'/.test(rack), 'the rack does not choose the panel by instrument');
  assert(/slot\.instrumentId !== 'fm'/.test(rack),
    'the generic knob grid still draws for the FM synth as well as the panel');
  assert(/<ParamKnobs/.test(rack), 'the rack lost the generic knob grid the other instruments use');

  for (const view of ['AlgorithmView', 'FmEnvView', 'FmWaveView', 'FmSpectrumView']) {
    assert(new RegExp(`<${view}`).test(panel), `the panel never draws ${view}`);
    assert(new RegExp(`export function ${view}`).test(canvas), `${view} is not exported`);
  }
  for (const fn of ['layoutAt', 'operatorEnvPoints', 'operatorWavePoints', 'patchSpectrum']) {
    assert(new RegExp(`${fn}\\s*\\(`).test(canvas), `the canvases never call ${fn}`);
  }

  // EVERY parameter has to be reachable, and the evidence has to be an EDIT
  // rather than a mention: the wavetable panel's version of this check once
  // passed with a knob deleted, because the id still appeared on the line
  // that fed its DISPLAY.  A control you can see and not move is not
  // reachable.
  const edits = (idText: string): boolean =>
    panel.includes('knob(' + idText)
    || panel.includes('set(' + idText)
    || panel.includes('onDrag(' + idText);

  const inst = findInstrument('fm')!;
  const covered = new Set<string>();
  for (const d of inst.params) if (edits("'" + d.id + "'")) covered.add(d.id);

  // The six operators are one description rendered six times, so their ids
  // never appear literally.  A family counts as covered only when the text
  // that BUILDS it is present and is being edited — no template, no excuse.
  const T = '`';
  for (const key of ['ratio', 'fine', 'fixed', 'hz', 'wave', 'level', 'a', 'd', 's', 'r', 'vel', 'key']) {
    if (edits(T + 'o${op}' + key + T)) {
      for (let i = 1; i <= FM_OPERATORS; i++) covered.add(`o${i}${key}`);
    }
  }

  const missing = inst.params.map((d) => d.id).filter((id) => !covered.has(id));
  assert(missing.length === 0,
    `${missing.length} parameter(s) the panel cannot reach: ${missing.join(', ')}`);

  // All six operators have to be selectable, or the template above covers
  // parameters the user cannot actually get to.
  for (let i = 1; i <= FM_OPERATORS; i++) {
    assert(panel.includes('setOp(' + i + ')') || /setOp\(n\)/.test(panel),
      `operator ${i} cannot be selected`);
  }
  assert(/onPick=\{\(k\) => setOp\(k \+ 1\)\}/.test(panel),
    'clicking a box in the diagram does not select that operator');

  // The lists it offers have to be the engine's lists.
  assert(/FM_ALGORITHMS\.map/.test(panel), 'the algorithm picker is not built from FM_ALGORITHMS');
  assert(/FM_WAVE_NAMES/.test(panel), 'the wave picker does not use the engine-derived name list');
  assert(FM_WAVE_NAMES.length === FM_WAVES.length,
    `the picker offers ${FM_WAVE_NAMES.length} waves and the engine plays ${FM_WAVES.length}`);
  assert(FM_ALGORITHMS.length === 32, `the engine has ${FM_ALGORITHMS.length} algorithms`);
  assert(/LFO_SHAPES/.test(panel), 'the LFO picker does not use LFO_SHAPES');
  assert(LFO_SHAPES.length > 4, 'the LFO shape list is suspiciously short');
  assert(inst.params.length > 80, `the instrument only has ${inst.params.length} parameters`);
});

console.log('');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
const bad = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - bad}/${results.length} passed${bad ? `, ${bad} FAILED` : ''}`);
if (bad) process.exit(1);
