// eq-graph-model — the band description a graph editor drags, and the
// magnitude curve it draws.
//
// The Studio's EQ modules are fixed-layout: the EQ has a high-pass, a low
// shelf, a bell and an air shelf; the Vintage EQ has a Pultec's boost/cut
// pairs.  A Pro-Q-style editor wants none of that structure — it wants a
// list of nodes, each with a frequency, a gain and a width, and a way to
// write a moved node back to whichever parameter actually controls it.
// This module is that translation layer, and the only place it lives.
//
// Two properties matter more than anything else here:
//
//   1. **The curve must be the truth.**  These coefficients are the RBJ
//      cookbook forms used by `dsp-core/.../mastering/{eq,vintage}.rs`, at
//      the same frequencies and Qs.  A curve drawn from a different model
//      than the one processing audio is a lie that looks like a feature.
//
//   2. **A derived node still writes a real parameter.**  The Pultec's
//      attenuation bell sits a fixed 1.6 octaves above its boost shelf, so
//      dragging it sideways moves the low section as a whole — which is
//      what the hardware does.  `toParam` carries that inverse.

import { EQ_BAND_DEFAULTS } from '../chain-config.js';
import type { ParameterValue } from '../parameters/index.js';

export type GraphBandType = 'highpass' | 'lowshelf' | 'bell' | 'highshelf';

/**
 * One draggable axis of a node.  `min`/`max` are in DISPLAY units (what the
 * user sees on the graph); `toParam` converts a display value into the
 * parameter's own units when the two differ.
 */
export interface AxisMap {
  param: string;
  min: number;
  max: number;
  /** Display → parameter.  Identity when omitted. */
  toParam?: (displayValue: number) => number;
}

export interface GraphBand {
  id: string;
  label: string;
  /** Two-letter badge drawn on the node. */
  short: string;
  type: GraphBandType;
  color: string;
  /** Current position, in display units. */
  hz: number;
  gainDb: number;
  q: number;
  /** Absent axes are locked — the node will not move along them. */
  freq?: AxisMap;
  gain?: AxisMap;
  /** Bandwidth.  `q` display units are always Q, even when the parameter
   *  underneath is something else (the Pultec's front-panel bandwidth). */
  qAxis?: AxisMap;
  /** False when the band is doing nothing — drawn faint. */
  active: boolean;
  /** Not draggable and not listed; drawn so the curve stays honest. */
  readOnly?: boolean;
}

// Band accents, shared with the legacy curve overlay so the two never
// disagree about which colour "air" is.
const COLOR = {
  lowCut: '#60A5FA',
  lowShelf: '#FBBF24',
  presence: '#A78BFA',
  air: '#22D3EE',
  harsh: '#94A3B8',
} as const;

/** The `adaptive` harshness dip, mirroring `HARSH_HZ` / `HARSH_DIP_DB`. */
const HARSH_HZ = 4000;
const HARSH_DIP_DB = -1.5;
const HARSH_Q = 1.4;

/** The Pultec geometry, mirroring `vintage.rs`. */
const LOW_CUT_OFFSET = Math.pow(2, 1.6);
const LOW_BOOST_Q = 0.7;
const LOW_CUT_Q = 0.8;
const HIGH_CUT_FREQ_RATIO = 1.5;
const HIGH_CUT_Q = 0.6;

/** Vintage bandwidth ↔ Q, mirroring `q = 1.6 - bandwidth * 1.2`. */
export function bandwidthToQ(bw: number): number {
  return Math.max(0.4, 1.6 - clamp(bw, 0, 1) * 1.2);
}
export function qToBandwidth(q: number): number {
  return clamp((1.6 - q) / 1.2, 0, 1);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function num(values: Record<string, ParameterValue>, id: string, fallback: number): number {
  const v = values[id];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function bool(values: Record<string, ParameterValue>, id: string, fallback: boolean): boolean {
  const v = values[id];
  return typeof v === 'boolean' ? v : fallback;
}

// ── Adapters ─────────────────────────────────────────────────────────────

/** Module ids this editor can drive. */
export const GRAPH_EQ_MODULES = new Set(['eq', 'vintage-eq']);

function eqBands(v: Record<string, ParameterValue>): GraphBand[] {
  const lowCutHz = num(v, 'lowCutHz', 20);
  const bands: GraphBand[] = [
    {
      id: 'lowCut', label: 'Low Cut', short: 'HP', type: 'highpass', color: COLOR.lowCut,
      hz: lowCutHz, gainDb: 0, q: num(v, 'lowCutQ', EQ_BAND_DEFAULTS.lowCutQ),
      freq: { param: 'lowCutHz', min: 20, max: 120 },
      qAxis: { param: 'lowCutQ', min: 0.3, max: 6 },
      // At 20 Hz the DSP skips the filter entirely, so the node is honest
      // about being off rather than drawing a corner that is not running.
      active: lowCutHz > 20,
    },
    {
      id: 'lowShelf', label: 'Low Shelf', short: 'LS', type: 'lowshelf', color: COLOR.lowShelf,
      hz: num(v, 'lowShelfHz', EQ_BAND_DEFAULTS.lowShelfHz),
      gainDb: num(v, 'lowShelfDb', 0),
      q: num(v, 'lowShelfQ', EQ_BAND_DEFAULTS.lowShelfQ),
      freq: { param: 'lowShelfHz', min: 20, max: 1000 },
      gain: { param: 'lowShelfDb', min: -18, max: 18 },
      qAxis: { param: 'lowShelfQ', min: 0.3, max: 2 },
      active: Math.abs(num(v, 'lowShelfDb', 0)) > 0.05,
    },
    {
      id: 'presence', label: 'Presence', short: 'PK', type: 'bell', color: COLOR.presence,
      hz: num(v, 'presenceHz', EQ_BAND_DEFAULTS.presenceHz),
      gainDb: num(v, 'presenceDb', 0),
      q: num(v, 'presenceQ', EQ_BAND_DEFAULTS.presenceQ),
      freq: { param: 'presenceHz', min: 100, max: 16_000 },
      gain: { param: 'presenceDb', min: -18, max: 18 },
      qAxis: { param: 'presenceQ', min: 0.3, max: 12 },
      active: Math.abs(num(v, 'presenceDb', 0)) > 0.05,
    },
    {
      id: 'air', label: 'Air', short: 'HS', type: 'highshelf', color: COLOR.air,
      hz: num(v, 'airHz', EQ_BAND_DEFAULTS.airHz),
      gainDb: num(v, 'airDb', 0),
      q: num(v, 'airQ', EQ_BAND_DEFAULTS.airQ),
      freq: { param: 'airHz', min: 2000, max: 20_000 },
      gain: { param: 'airDb', min: -18, max: 18 },
      qAxis: { param: 'airQ', min: 0.3, max: 2 },
      active: Math.abs(num(v, 'airDb', 0)) > 0.05,
    },
  ];

  if (bool(v, 'adaptive', false)) {
    // Drawn but not draggable: it is the switch's doing, not a band.
    bands.push({
      id: 'harsh', label: 'Harshness', short: 'AD', type: 'bell', color: COLOR.harsh,
      hz: HARSH_HZ, gainDb: HARSH_DIP_DB, q: HARSH_Q, active: true, readOnly: true,
    });
  }
  return bands;
}

function vintageBands(v: Record<string, ParameterValue>): GraphBand[] {
  const lowHz = num(v, 'lowFrequencyHz', 60);
  const highHz = num(v, 'highFrequencyHz', 10_000);
  const lowBoost = num(v, 'lowBoostDb', 0);
  const lowCut = num(v, 'lowCutDb', 0);
  const highBoost = num(v, 'highBoostDb', 0);
  const highCut = num(v, 'highCutDb', 0);
  const bw = num(v, 'highBandwidth', 0.5);

  return [
    {
      id: 'lowBoost', label: 'Low boost', short: 'LS', type: 'lowshelf', color: COLOR.lowShelf,
      hz: lowHz, gainDb: lowBoost, q: LOW_BOOST_Q,
      freq: { param: 'lowFrequencyHz', min: 20, max: 200 },
      // One-sided, like the hardware: this control boosts or does nothing.
      gain: { param: 'lowBoostDb', min: 0, max: 12 },
      active: lowBoost > 0.05,
    },
    {
      id: 'lowAtten', label: 'Low atten', short: 'PK', type: 'bell', color: COLOR.lowCut,
      // Derived: the scoop sits a fixed 1.6 octaves above the boost.
      hz: lowHz * LOW_CUT_OFFSET, gainDb: -lowCut, q: LOW_CUT_Q,
      freq: { param: 'lowFrequencyHz', min: 20 * LOW_CUT_OFFSET, max: 200 * LOW_CUT_OFFSET, toParam: (hz) => hz / LOW_CUT_OFFSET },
      gain: { param: 'lowCutDb', min: -12, max: 0, toParam: (db) => -db },
      active: lowCut > 0.05,
    },
    {
      id: 'highBoost', label: 'High boost', short: 'PK', type: 'bell', color: COLOR.presence,
      hz: highHz, gainDb: highBoost, q: bandwidthToQ(bw),
      freq: { param: 'highFrequencyHz', min: 2000, max: 20_000 },
      gain: { param: 'highBoostDb', min: 0, max: 12 },
      // The front panel says "bandwidth"; the graph says Q.  One inverse.
      qAxis: { param: 'highBandwidth', min: 0.4, max: 1.6, toParam: qToBandwidth },
      active: highBoost > 0.05,
    },
    {
      id: 'highAtten', label: 'High atten', short: 'HS', type: 'highshelf', color: COLOR.air,
      hz: highHz * HIGH_CUT_FREQ_RATIO, gainDb: -highCut, q: HIGH_CUT_Q,
      freq: {
        param: 'highFrequencyHz',
        min: 2000 * HIGH_CUT_FREQ_RATIO, max: 20_000 * HIGH_CUT_FREQ_RATIO,
        toParam: (hz) => hz / HIGH_CUT_FREQ_RATIO,
      },
      gain: { param: 'highCutDb', min: -12, max: 0, toParam: (db) => -db },
      active: highCut > 0.05,
    },
  ];
}

/** Bands for a module, or null when the module has no graph. */
export function buildGraphBands(
  moduleId: string,
  values: Record<string, ParameterValue>,
): GraphBand[] | null {
  if (moduleId === 'eq') return eqBands(values);
  if (moduleId === 'vintage-eq') return vintageBands(values);
  return null;
}

/**
 * Parameter writes for a node moved to (hz, gainDb, q), in display units.
 * Axes the band does not own are dropped, and every value is clamped to its
 * own range — a drag that leaves the graph must not write a nonsense config.
 */
export function bandEdits(
  band: GraphBand,
  next: { hz?: number; gainDb?: number; q?: number },
): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  const push = (axis: AxisMap | undefined, display: number | undefined) => {
    if (!axis || display === undefined || !Number.isFinite(display)) return;
    const v = clamp(display, axis.min, axis.max);
    out.push([axis.param, axis.toParam ? axis.toParam(v) : v]);
  };
  push(band.freq, next.hz);
  push(band.gain, next.gainDb);
  push(band.qAxis, next.q);
  return out;
}

// ── RBJ cookbook magnitude, matching the Rust coefficients ───────────────

interface Coeffs { b0: number; b1: number; b2: number; a0: number; a1: number; a2: number }

function coeffsFor(type: GraphBandType, fs: number, f0: number, q: number, gainDb: number): Coeffs {
  const w0 = (2 * Math.PI * Math.min(f0, fs / 2 - 1)) / fs;
  const cw = Math.cos(w0);
  const sw = Math.sin(w0);
  const alpha = sw / (2 * Math.max(q, 0.05));
  const A = Math.pow(10, gainDb / 40);
  const sqA = Math.sqrt(A);
  switch (type) {
    case 'highpass':
      return { b0: (1 + cw) / 2, b1: -(1 + cw), b2: (1 + cw) / 2, a0: 1 + alpha, a1: -2 * cw, a2: 1 - alpha };
    case 'lowshelf':
      return {
        b0: A * ((A + 1) - (A - 1) * cw + 2 * sqA * alpha),
        b1: 2 * A * ((A - 1) - (A + 1) * cw),
        b2: A * ((A + 1) - (A - 1) * cw - 2 * sqA * alpha),
        a0: (A + 1) + (A - 1) * cw + 2 * sqA * alpha,
        a1: -2 * ((A - 1) + (A + 1) * cw),
        a2: (A + 1) + (A - 1) * cw - 2 * sqA * alpha,
      };
    case 'highshelf':
      return {
        b0: A * ((A + 1) + (A - 1) * cw + 2 * sqA * alpha),
        b1: -2 * A * ((A - 1) + (A + 1) * cw),
        b2: A * ((A + 1) + (A - 1) * cw - 2 * sqA * alpha),
        a0: (A + 1) - (A - 1) * cw + 2 * sqA * alpha,
        a1: 2 * ((A - 1) - (A + 1) * cw),
        a2: (A + 1) - (A - 1) * cw - 2 * sqA * alpha,
      };
    case 'bell':
    default:
      return { b0: 1 + alpha * A, b1: -2 * cw, b2: 1 - alpha * A, a0: 1 + alpha / A, a1: -2 * cw, a2: 1 - alpha / A };
  }
}

/** |H(f)| in dB for one band. */
export function bandGainDbAt(band: GraphBand, hz: number, sampleRate = 48_000): number {
  if (!band.active) return 0;
  const c = coeffsFor(band.type, sampleRate, band.hz, band.q, band.gainDb);
  const w = (2 * Math.PI * hz) / sampleRate;
  const cw = Math.cos(w);
  const c2w = Math.cos(2 * w);
  const sw = Math.sin(w);
  const s2w = Math.sin(2 * w);
  const nr = c.b0 + c.b1 * cw + c.b2 * c2w;
  const ni = -(c.b1 * sw + c.b2 * s2w);
  const dr = c.a0 + c.a1 * cw + c.a2 * c2w;
  const di = -(c.a1 * sw + c.a2 * s2w);
  const n2 = nr * nr + ni * ni;
  const d2 = dr * dr + di * di;
  if (d2 <= 0 || !Number.isFinite(n2) || !Number.isFinite(d2)) return 0;
  const db = 10 * Math.log10(n2 / d2);
  return Number.isFinite(db) ? db : 0;
}

/** Summed response of every band at one frequency. */
export function combinedGainDbAt(bands: readonly GraphBand[], hz: number, sampleRate = 48_000): number {
  let sum = 0;
  for (const b of bands) sum += bandGainDbAt(b, hz, sampleRate);
  return sum;
}
