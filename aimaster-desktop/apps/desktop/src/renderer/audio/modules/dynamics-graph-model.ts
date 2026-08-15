// dynamics-graph-model — what a compressor does to level, as a curve.
//
// A row of sliders reading "threshold −5, ratio 8.3, attack 71 ms" does not
// tell you what the compressor is doing. A transfer curve does: input level
// along one axis, output level along the other, the bend at the threshold,
// the slope past it. That is the display every hardware-modelled compressor
// puts in the middle of its panel, and this is the model behind it.
//
// The curve must be the same arithmetic the DSP runs, or it becomes a
// decoration that happens to move. These functions mirror the static gain
// computers in `dsp-core/.../mastering/{dynamics,multiband,vintage}.rs`.
// They describe the STEADY STATE only — attack and release decide how long
// the audio takes to arrive at this curve, and no static plot can show that.

import type { ParameterValue } from '../parameters/index.js';

export type DynamicsMode = 'compress' | 'expand';

/** One compressor's gain computer, in the units the panels use. */
export interface DynamicsCurve {
  thresholdDb: number;
  /** n:1.  1 means no processing at all. */
  ratio: number;
  /** Soft-knee width in dB, centred on the threshold.  0 = hard knee. */
  kneeDb: number;
  /** Fixed gain applied after the computer. */
  makeupDb: number;
  /** Parallel blend, 0..100 % wet. */
  mixPct: number;
  /** Compress reduces above the threshold; expand reduces below it. */
  mode: DynamicsMode;
  /** Cap on how far the computer may move, in dB.  0 = uncapped. */
  rangeDb?: number;
}

/** Where the graph starts and ends, in dBFS. */
export const DYN_MIN_DB = -60;
export const DYN_MAX_DB = 0;

function num(v: Record<string, ParameterValue>, id: string, fallback: number): number {
  const x = v[id];
  return typeof x === 'number' && Number.isFinite(x) ? x : fallback;
}

/**
 * Output level for an input level, in dB.
 *
 * The knee is the quadratic interpolation from the RBJ-era cookbook that
 * every soft-knee compressor uses: below `threshold - knee/2` the signal is
 * untouched, above `threshold + knee/2` the full ratio applies, and between
 * them the slope eases in.
 */
export function outputDbFor(curve: DynamicsCurve, inputDb: number): number {
  const { thresholdDb, kneeDb, mode } = curve;
  const ratio = Math.max(1, curve.ratio);
  const over = inputDb - thresholdDb;

  let compressed: number;
  if (mode === 'expand') {
    // Downward expansion: quiet material is pushed further down.
    const under = thresholdDb - inputDb;
    if (kneeDb > 0 && under > -kneeDb / 2 && under < kneeDb / 2) {
      const x = under + kneeDb / 2;
      compressed = inputDb - ((ratio - 1) * x * x) / (2 * kneeDb);
    } else if (under <= 0) {
      compressed = inputDb;
    } else {
      compressed = thresholdDb - under * ratio;
    }
  } else if (kneeDb > 0 && over > -kneeDb / 2 && over < kneeDb / 2) {
    const x = over + kneeDb / 2;
    compressed = inputDb + ((1 / ratio - 1) * x * x) / (2 * kneeDb);
  } else if (over <= 0) {
    compressed = inputDb;
  } else {
    compressed = thresholdDb + over / ratio;
  }

  // A band that declares a range cannot move further than that, however
  // far past the threshold the signal goes — the curve has to flatten out
  // there or it would promise reduction the module refuses to apply.
  if (curve.rangeDb && curve.rangeDb > 0) {
    compressed = Math.max(compressed, inputDb - curve.rangeDb);
  }

  // Parallel mix sums the wet and dry SIGNALS, not their levels.  They are
  // the same signal scaled, so they are perfectly correlated and add in the
  // linear domain — blending the dB values instead reads several dB low,
  // which the measured test caught.
  const mix = Math.min(1, Math.max(0, curve.mixPct / 100));
  const lin = mix * Math.pow(10, compressed / 20) + (1 - mix) * Math.pow(10, inputDb / 20);
  return 20 * Math.log10(Math.max(lin, 1e-12)) + curve.makeupDb;
}

/** Gain reduction at an input level: how far below unity the curve sits. */
export function reductionDbAt(curve: DynamicsCurve, inputDb: number): number {
  return inputDb - (outputDbFor(curve, inputDb) - curve.makeupDb);
}

/**
 * The input level that would produce a given gain reduction.
 *
 * Used to place a live marker on the curve. The chain reports how much it
 * is reducing but not the level it is reducing — and rather than add a
 * second meter to the audio thread for something the curve already
 * determines, the reduction is inverted through the curve itself. Monotone
 * in the compress direction, so a bisection is exact enough for a dot.
 */
export function inputDbForReduction(curve: DynamicsCurve, reductionDb: number): number | null {
  if (!(reductionDb > 0.01)) return null;
  const maxReduction = reductionDbAt(curve, DYN_MAX_DB);
  if (reductionDb > maxReduction + 0.01) return null;
  let lo = DYN_MIN_DB;
  let hi = DYN_MAX_DB;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (reductionDbAt(curve, mid) < reductionDb) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

// ── Adapters ─────────────────────────────────────────────────────────────

/** Modules that show a transfer curve, and which GR metric belongs to each. */
export type DynamicsGraphKind = 'dynamics' | 'vintage-comp' | 'multiband';

export interface DynamicsGraphSpec {
  kind: DynamicsGraphKind;
  /** One curve per column.  Multiband has four; the others have one. */
  curves: Array<{ label: string; curve: DynamicsCurve }>;
}

/**
 * The glue compressor.  Its knee is fixed in the DSP, so the number here is
 * not a parameter the user can move — it is stated so the drawn bend is the
 * bend the audio has.
 */
const GLUE_KNEE_DB = 6;

export function buildDynamicsGraph(
  moduleId: string,
  v: Record<string, ParameterValue>,
): DynamicsGraphSpec | null {
  if (moduleId === 'dynamics') {
    return {
      kind: 'dynamics',
      curves: [{
        label: 'Glue',
        curve: {
          thresholdDb: num(v, 'thresholdDb', -18),
          ratio: num(v, 'ratio', 2),
          kneeDb: GLUE_KNEE_DB,
          makeupDb: 0,
          mixPct: num(v, 'mixPct', 100),
          mode: 'compress',
        },
      }],
    };
  }

  if (moduleId === 'vintage-comp') {
    // A vari-mu's ratio rises with how hard it is driven; the panel control
    // is the maximum, which is what the curve's slope shows.
    return {
      kind: 'vintage-comp',
      curves: [{
        label: 'Vari-Mu',
        curve: {
          thresholdDb: num(v, 'thresholdDb', -18),
          ratio: num(v, 'ratio', 2),
          kneeDb: 12,
          makeupDb: num(v, 'makeupDb', 0),
          mixPct: num(v, 'mixPct', 100),
          mode: 'compress',
        },
      }],
    };
  }

  if (moduleId === 'multiband') {
    const labels = ['Low', 'Low mid', 'High mid', 'High'];
    return {
      kind: 'multiband',
      curves: labels.map((label, i) => ({
        label,
        curve: {
          thresholdDb: num(v, `band${i}ThresholdDb`, 0),
          ratio: num(v, `band${i}Ratio`, 1),
          kneeDb: 6,
          makeupDb: num(v, `band${i}MakeupDb`, 0),
          mixPct: num(v, `band${i}MixPct`, 100),
          // `range_db` defaults to 24 in the engine and the UI does not
          // expose it; drawing without it would show reduction past 24 dB
          // that the band will not apply.
          rangeDb: 24,
          mode: v[`band${i}Mode`] === 'expand' ? 'expand' : 'compress',
        },
      })),
    };
  }

  return null;
}
