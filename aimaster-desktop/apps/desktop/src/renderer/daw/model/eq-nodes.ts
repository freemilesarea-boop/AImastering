// A parametric EQ as points you can grab.
//
// Knobs tell you a number.  A parametric EQ is not about numbers — its whole
// point is that any band can sit at any frequency with any width, and the way
// you find that is by looking at the curve and moving it.  Fifteen knobs in a
// grid is the same EQ with the one thing that makes it parametric taken away.
//
// So: every band the engine builds is described here as a NODE — where it sits,
// how loud it is, how wide it is, and which parameter each of those three
// writes to.  The editor then only has to do geometry; it never has to know
// that `b2Hz` is a bell and `hpfHz` is a corner.
//
// Pure, so the mapping is tested without a canvas or an AudioContext.

import type { BiquadSpec } from './plugin-curves.js';

export interface EqNode {
  /** Stable across renders, so a drag survives a re-render. */
  id: string;
  /** Drawn on the handle. */
  label: string;
  type: BiquadSpec['type'];
  freq: number;
  /** dB, as the curve shows it. */
  gainDb: number;
  q: number;
  /** The parameter the horizontal axis writes, or null when the band is fixed. */
  freqParam: string | null;
  /** The parameter the vertical axis writes, or null for a cut with no gain. */
  gainParam: string | null;
  /** The parameter width writes, or null when the band has a fixed Q. */
  qParam: string | null;
}

function num(params: Record<string, number>, id: string, fallback: number): number {
  const v = params[id];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * The bands of an EQ device, in the order the engine chains them.
 *
 * Empty for anything that is not a band-per-node EQ, which is the signal to
 * the window that this device draws a picture rather than an editor.
 */
export function eqNodes(pluginId: string, params: Record<string, number>): EqNode[] {
  if (pluginId === 'eq8') {
    const bell = (n: 1 | 2 | 3, freq: number): EqNode => ({
      id: `b${n}`, label: String(n), type: 'peaking',
      freq: num(params, `b${n}Hz`, freq),
      gainDb: num(params, `b${n}Db`, 0),
      q: num(params, `b${n}Q`, 1),
      freqParam: `b${n}Hz`, gainParam: `b${n}Db`, qParam: `b${n}Q`,
    });
    return [
      {
        id: 'hpf', label: 'HP', type: 'highpass',
        freq: num(params, 'hpfHz', 20), gainDb: 0, q: 1,
        freqParam: 'hpfHz', gainParam: null, qParam: null,
      },
      {
        id: 'low', label: 'LS', type: 'lowshelf',
        freq: num(params, 'lowHz', 120), gainDb: num(params, 'lowDb', 0), q: 0.707,
        freqParam: 'lowHz', gainParam: 'lowDb', qParam: null,
      },
      bell(1, 300), bell(2, 1200), bell(3, 4000),
      {
        id: 'high', label: 'HS', type: 'highshelf',
        freq: num(params, 'highHz', 8000), gainDb: num(params, 'highDb', 0), q: 0.707,
        freqParam: 'highHz', gainParam: 'highDb', qParam: null,
      },
      {
        id: 'lpf', label: 'LP', type: 'lowpass',
        freq: num(params, 'lpfHz', 20_000), gainDb: 0, q: 1,
        freqParam: 'lpfHz', gainParam: null, qParam: null,
      },
    ];
  }

  if (pluginId === 'eq3') {
    // The engine pins the shelves at 120 Hz and 8 kHz and the bell's Q at 1;
    // those handles move vertically only, and saying so here is what stops the
    // editor from writing a parameter the device does not have.
    return [
      {
        id: 'hpf', label: 'HP', type: 'highpass',
        freq: num(params, 'hpfHz', 20), gainDb: 0, q: 1,
        freqParam: 'hpfHz', gainParam: null, qParam: null,
      },
      {
        id: 'low', label: 'LS', type: 'lowshelf',
        freq: 120, gainDb: num(params, 'lowDb', 0), q: 0.707,
        freqParam: null, gainParam: 'lowDb', qParam: null,
      },
      {
        id: 'mid', label: 'M', type: 'peaking',
        freq: num(params, 'midHz', 1000), gainDb: num(params, 'midDb', 0), q: 1,
        freqParam: 'midHz', gainParam: 'midDb', qParam: null,
      },
      {
        id: 'high', label: 'HS', type: 'highshelf',
        freq: 8000, gainDb: num(params, 'highDb', 0), q: 0.707,
        freqParam: null, gainParam: 'highDb', qParam: null,
      },
    ];
  }

  // The exciter and the de-esser are filed under `eq` but neither is one: the
  // exciter GENERATES harmonics above a corner and blends them back in, and the
  // de-esser is a compressor on a band.  Neither has a gain in decibels to put
  // a handle on.  The curve they used to be drawn with read `amountDb` — a
  // parameter neither device has — so it was a flat line pretending to be a
  // filter, for as long as it has existed.  They show their level instead.

  if (pluginId === 'dyneq') {
    return [{
      id: 'dyn', label: 'D', type: 'peaking',
      freq: num(params, 'freqHz', 300), gainDb: num(params, 'rangeDb', 0), q: num(params, 'q', 1),
      freqParam: 'freqHz', gainParam: 'rangeDb', qParam: 'q',
    }];
  }

  return [];
}

/** The filters to draw, from the nodes — so the curve cannot drift from the handles. */
export function nodeSpecs(nodes: readonly EqNode[]): BiquadSpec[] {
  return nodes.map((n) => ({ type: n.type, freq: n.freq, gain: n.gainDb, q: n.q }));
}

export interface ParamRange { min: number; max: number }

/** Clamp to the device's own limits, and refuse a value the device cannot hold. */
export function clampToRange(value: number, range: ParamRange | undefined): number {
  if (!range) return value;
  if (!Number.isFinite(value)) return range.min;
  return Math.max(range.min, Math.min(range.max, value));
}

export interface NodeEdit { paramId: string; value: number }

/**
 * A node dragged to (freq, gainDb) as the parameter writes it causes.
 *
 * Clamped to the device's declared range, so the handle stops where the device
 * stops rather than sliding past it and leaving the pointer somewhere the band
 * can never go.
 */
export function nodeDragEdits(
  node: EqNode,
  freq: number,
  gainDb: number,
  ranges: Readonly<Record<string, ParamRange>>,
): NodeEdit[] {
  const edits: NodeEdit[] = [];
  if (node.freqParam) {
    edits.push({ paramId: node.freqParam, value: clampToRange(freq, ranges[node.freqParam]) });
  }
  if (node.gainParam) {
    edits.push({ paramId: node.gainParam, value: clampToRange(gainDb, ranges[node.gainParam]) });
  }
  return edits;
}

/** A node's Q after a wheel notch, clamped to the device's range. */
export function nodeQEdit(
  node: EqNode, deltaNotches: number, ranges: Readonly<Record<string, ParamRange>>,
): NodeEdit | null {
  if (!node.qParam) return null;
  // Multiplicative, because Q is heard as a ratio: one notch is the same
  // proportion of width at 0.3 as at 6.
  const next = node.q * Math.pow(1.15, deltaNotches);
  return { paramId: node.qParam, value: clampToRange(next, ranges[node.qParam]) };
}

/** Which node a click at (x, y) grabbed, or null when it grabbed empty canvas. */
export function nodeAt(
  points: ReadonlyArray<{ id: string; x: number; y: number }>,
  x: number, y: number, radius = 14,
): string | null {
  let best: string | null = null;
  let bestDist = radius * radius;
  for (const p of points) {
    const d = (p.x - x) ** 2 + (p.y - y) ** 2;
    if (d <= bestDist) { bestDist = d; best = p.id; }
  }
  return best;
}
