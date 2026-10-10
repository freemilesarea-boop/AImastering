// The pictures the FM synth's panel draws, as arithmetic.
//
// Same rule as `synth-views.ts` and `analog-views.ts`: a drawing that lives
// inside a canvas callback can only be checked by looking at it, so the maths
// comes out here and `fm-panel-selftest` measures it against the engine.
//
// The picture that matters here has no equivalent in the other two panels.
// A wavetable synth's sound is a table you can see and an analogue synth's is
// a filter curve you can see, but an FM patch's sound is its ALGORITHM — six
// boxes and the arrows between them — and there is no number that conveys it.
// "Algorithm 15" is a page reference, not a description.  So the panel draws
// the graph, and it draws it from the same connection list the render loop
// walks rather than from a picture kept alongside.
//
// Everything returns coordinates in 0…1, y measured downwards.

import { fft, hannWindow } from '../audio/fft.js';
import {
  FM_OPERATORS, FM_WAVES, algorithmAt, fmEnv, fmWave, type FmAlgorithm,
} from '../engine/fm-core.js';
import { renderFmVoice } from '../engine/fm-synth.js';
import type { Point } from './synth-views.js';

/**
 * The operator waves, spelled for a dropdown.
 *
 * Derived from the engine's own list rather than typed again beside it, and
 * exported from here rather than kept in the panel, so that a ninth wave
 * cannot appear in the engine and be unreachable in the picker — the selftest
 * checks the two lists are the same length.
 */
export const FM_WAVE_NAMES: readonly string[] = FM_WAVES.map(
  (w) => w.charAt(0).toUpperCase() + w.slice(1),
);

export interface OperatorBox {
  /** 0-based operator index. */
  op: number;
  /** Centre of the box, 0…1. */
  x: number;
  y: number;
  /** How many stages above a carrier this operator sits. */
  depth: number;
  carrier: boolean;
}

export interface AlgorithmEdge {
  from: number;
  to: number;
}

export interface AlgorithmLayout {
  boxes: OperatorBox[];
  edges: AlgorithmEdge[];
  /** How many rows the graph needed, so the caller can size the boxes. */
  rows: number;
  /** Half-width and half-height of a box in the same 0…1 space. */
  halfW: number;
  halfH: number;
}

/**
 * Where each operator sits in the diagram.
 *
 * Three rules, in order:
 *
 *   1. A carrier is on the bottom row.  Everything else is one row above the
 *      highest thing it feeds, so a six-deep stack draws six rows and reads
 *      as a stack.
 *   2. Horizontally, a carrier takes its place in the carrier order; a
 *      modulator centres itself over everything it feeds.  That is what makes
 *      a shared modulator visibly shared — it sits between its targets rather
 *      than over one of them.
 *   3. Two boxes on the same row are then pushed apart until they do not
 *      overlap, from the middle outwards, so rule 2's ties do not stack
 *      boxes on top of each other.
 *
 * The result is deterministic — no layout solver, no randomness — which is
 * what lets the selftest state exactly where things ought to be.
 */
export function algorithmLayout(alg: FmAlgorithm): AlgorithmLayout {
  const carriers = new Set(alg.carriers);
  const targets: number[][] = [];
  for (let i = 0; i < FM_OPERATORS; i++) targets.push([]);
  for (const [from, to] of alg.mods) targets[from]?.push(to);

  // Depth.  Every connection runs from a higher-numbered operator to a lower
  // one, so walking upward by index computes each depth after the ones it
  // depends on — no traversal and no cycle to worry about.
  const depth = new Int32Array(FM_OPERATORS);
  for (let i = 0; i < FM_OPERATORS; i++) {
    if (carriers.has(i)) { depth[i] = 0; continue; }
    let d = 0;
    for (const t of targets[i] ?? []) d = Math.max(d, (depth[t] ?? 0) + 1);
    depth[i] = d;
  }
  let rows = 1;
  for (let i = 0; i < FM_OPERATORS; i++) rows = Math.max(rows, (depth[i] ?? 0) + 1);

  // Horizontal.
  const x = new Float64Array(FM_OPERATORS);
  const order = alg.carriers;
  order.forEach((c, i) => {
    x[c] = order.length === 1 ? 0.5 : 0.12 + (i / (order.length - 1)) * 0.76;
  });
  for (let i = 0; i < FM_OPERATORS; i++) {
    if (carriers.has(i)) continue;
    const list = targets[i] ?? [];
    if (list.length === 0) { x[i] = 0.5; continue; }
    let sum = 0;
    for (const t of list) sum += x[t] ?? 0.5;
    x[i] = sum / list.length;
  }

  const halfW = 0.5 / (FM_OPERATORS + 1);
  const halfH = 0.5 / (rows + 1);
  const gap = halfW * 2.3;

  // Collision resolution, per row.
  //
  // Push apart to a minimum gap, then fit the row inside the picture.  The
  // fitting matters: algorithm 14 puts four modulators on one row, two over
  // each carrier, and pushing them apart ran the rightmost box off the edge.
  // Shifting the row back then ran the leftmost off the other edge, because
  // the row was simply wider than the frame — so a row whose extent will not
  // fit is rescaled into it, which keeps the order and the relative spacing
  // and keeps every box visible.
  const available = 1 - 2 * halfW;
  for (let r = 0; r < rows; r++) {
    const here: number[] = [];
    for (let i = 0; i < FM_OPERATORS; i++) if ((depth[i] ?? 0) === r) here.push(i);
    if (here.length === 0) continue;
    here.sort((a, b) => (x[a] ?? 0) - (x[b] ?? 0));

    for (let k = 1; k < here.length; k++) {
      const prev = here[k - 1] ?? 0;
      const cur = here[k] ?? 0;
      const need = (x[prev] ?? 0) + gap;
      if ((x[cur] ?? 0) < need) x[cur] = need;
    }
    const first = here[0] ?? 0;
    const last = here[here.length - 1] ?? 0;
    const lo = x[first] ?? 0;
    const extent = (x[last] ?? 0) - lo;
    if (extent > available) {
      // Wider than the frame even after pushing, because the carriers it is
      // centred over are themselves spread across the whole width.  Rescale
      // the row into the frame, keeping the order and the relative spacing.
      const k = available / extent;
      for (const i of here) x[i] = halfW + ((x[i] ?? 0) - lo) * k;
    } else {
      const over = (x[last] ?? 0) + halfW - 1;
      if (over > 0) for (const i of here) x[i] = (x[i] ?? 0) - over;
      const under = halfW - (x[first] ?? 0);
      if (under > 0) for (const i of here) x[i] = (x[i] ?? 0) + under;
    }
  }

  const boxes: OperatorBox[] = [];
  for (let i = 0; i < FM_OPERATORS; i++) {
    const d = depth[i] ?? 0;
    boxes.push({
      op: i,
      x: x[i] ?? 0.5,
      // Row 0 at the bottom, so signal flows downward the way the diagram is
      // read and the way the audio actually travels.
      y: 1 - (d + 0.5) / rows,
      depth: d,
      carrier: carriers.has(i),
    });
  }
  return { boxes, edges: alg.mods.map(([from, to]) => ({ from, to })), rows, halfW, halfH };
}

/** The layout for an algorithm index, clamped like the engine clamps it. */
export function layoutAt(index: number): AlgorithmLayout {
  return algorithmLayout(algorithmAt(index));
}

// ── The operator ────────────────────────────────────────────────────────────

export interface EnvShape {
  points: Point[];
  /** Where the key lifts, in 0…1 across the picture. */
  releaseAt: number;
}

/**
 * One operator's envelope, sampled from `fmEnv` itself.
 *
 * The window is the envelope's own length plus a held section, for the reason
 * the other two panels give: an envelope on a fixed time axis is either a
 * vertical line or a flat one.
 *
 * What is worth seeing here that the other panels' envelopes do not show is
 * the CURVE.  These are exponential in both directions because an FM
 * operator's envelope is heard as brightness rather than volume, and a
 * straight line would be a different instrument.
 */
export function operatorEnvPoints(
  attack: number, decay: number, sustain: number, release: number,
  points = 160, heldFraction = 0.22,
): EnvShape {
  const a = Math.max(0, attack);
  const d = Math.max(0, decay);
  const r = Math.max(0, release);
  const s = Math.max(0, Math.min(1, sustain));
  const moving = a + d + r;
  const span = moving > 1e-6 ? moving : 1;
  const held = span * (heldFraction / Math.max(0.05, 1 - heldFraction));
  const total = span + held;
  const gate = a + d + held;

  const out: Point[] = [];
  for (let i = 0; i < points; i++) {
    const t = (i / (points - 1)) * total;
    const v = fmEnv(t, gate, a, d, s, r);
    out.push({ x: i / (points - 1), y: 1 - Math.max(0, Math.min(1, v)) });
  }
  return { points: out, releaseAt: gate / total };
}

/** Two cycles of an operator wave, from the engine's own `fmWave`. */
export function operatorWavePoints(wave: number, cycles = 2, points = 192): Point[] {
  const out: Point[] = [];
  let lo = Infinity;
  let hi = -Infinity;
  const raw: number[] = [];
  for (let i = 0; i < points; i++) {
    const v = fmWave(Math.round(wave), (i / points) * cycles, 7919);
    raw.push(v);
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  // Fitted between its own extremes, because four of the eight waves are
  // one-sided and peak-scaling would draw them at half height.
  const centre = (hi + lo) / 2;
  const half = Math.max(1e-9, (hi - lo) / 2);
  for (let i = 0; i < points; i++) {
    out.push({ x: i / (points - 1), y: 0.5 - (((raw[i] ?? 0) - centre) / half) * 0.46 });
  }
  return out;
}

/**
 * What one operator's frequency comes out at, and how to write it down.
 *
 * A ratio is relative and a fixed frequency is not, and the panel has to show
 * which one an operator is in — a ratio of 14 and a fixed 440 Hz look like
 * the same kind of number and are not.
 */
export function operatorHz(
  noteHz: number, ratio: number, fine: number, fixed: boolean, hz: number,
): number {
  if (fixed) return Math.max(0.5, hz);
  return noteHz * Math.max(0.0625, ratio) * Math.pow(2, fine / 1200);
}

// ── The patch's own spectrum ────────────────────────────────────────────────

export interface SpectrumBin { hz: number; db: number }

/**
 * What the patch actually sounds like, as a spectrum.
 *
 * The one thing about an FM patch that cannot be read off its controls.  Six
 * ratios and six levels do not tell anybody where the partials will land —
 * that is the whole difficulty of the instrument — so the panel renders a
 * short note through the ENGINE and shows the result.
 *
 * Deliberately cheap: a fifth of a second at 16 kHz is 3 200 samples, which
 * costs about a millisecond and a half.  Two prices, both stated on the
 * picture rather than hidden.  Nothing above 8 kHz is drawn, because nothing
 * above 8 kHz was rendered.  And the window is 128 ms starting 30 ms in, so
 * what it shows is the note's FIRST moment — which for an FM patch is the
 * bright one, and is also the only moment a static picture could honestly
 * claim to be of.
 */
export const SPECTRUM_RATE = 16000;
export const SPECTRUM_SECONDS = 0.2;
const SPECTRUM_FFT = 2048;

export function patchSpectrum(
  params: Readonly<Record<string, number>>, noteHz = 261.63, pitch = 60,
): SpectrumBin[] {
  const r = renderFmVoice({
    sampleRate: SPECTRUM_RATE,
    seconds: SPECTRUM_SECONDS,
    gateSec: SPECTRUM_SECONDS,
    freqHz: noteHz,
    pitch,
    velocity: 0.85,
    params,
    beatsPerSec: 2,
  });
  const re = new Float64Array(SPECTRUM_FFT);
  const im = new Float64Array(SPECTRUM_FFT);
  const win = hannWindow(SPECTRUM_FFT);
  const n = Math.min(SPECTRUM_FFT, r.left.length);
  // From a fifth of the way in, so the attack transient is not the picture.
  const from = Math.max(0, Math.min(r.left.length - n, Math.round(SPECTRUM_RATE * 0.03)));
  for (let i = 0; i < n; i++) {
    re[i] = (((r.left[from + i] ?? 0) + (r.right[from + i] ?? 0)) / 2) * (win[i] ?? 0);
  }
  fft(re, im);
  // Relative to the patch's own loudest partial, not to full scale.
  //
  // A spectrum display is about SHAPE, and normalising to the peak is what
  // makes it one: without it the whole picture slides up and down with the
  // Level knob, and a quiet patch draws a flat line at the bottom of the
  // frame while sounding perfectly good.  The level has a meter of its own.
  let peak = 1e-9;
  const mags: number[] = [];
  for (let k = 1; k < SPECTRUM_FFT / 2; k++) {
    const mag = Math.hypot(re[k] ?? 0, im[k] ?? 0);
    mags.push(mag);
    if (mag > peak) peak = mag;
  }
  const out: SpectrumBin[] = [];
  for (let k = 1; k < SPECTRUM_FFT / 2; k++) {
    const mag = (mags[k - 1] ?? 0) / peak;
    out.push({ hz: (k * SPECTRUM_RATE) / SPECTRUM_FFT, db: 20 * Math.log10(Math.max(1e-9, mag)) });
  }
  return out;
}
