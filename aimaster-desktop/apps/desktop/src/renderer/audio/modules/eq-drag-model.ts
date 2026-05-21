// EQ drag model (OZONE-MODULE-NEXT-5).
//
// Pure geometry + value mapping for dragging EQ band points.  No React, no
// DSP — converts pointer position → a clamped/quantised parameter value
// the editor writes to the parameter state (which then flows live to the
// Rust chain via the existing rAF → updateConfig path).
//
// 1차 scope: frequency (Low Cut) + gain (shelves / bell / output).  No Q.

export type DragAxis = 'x' | 'y';
export type EqBandId = 'lowCut' | 'lowShelf' | 'presence' | 'air' | 'output';

export interface EqBandDragSpec {
  paramId: 'lowCutHz' | 'lowShelfDb' | 'presenceDb' | 'airDb' | 'outputGainDb';
  axis: DragAxis;
  min: number;
  max: number;
  step: number;
  /** Fixed display frequency for gain-only bands (x position). */
  fixedFreq?: number;
  defaultValue: number;
}

// Ranges mirror module-parameter-definitions.ts (kept in sync; the editor
// also clamps via the live param command path).
export const EQ_BAND_DRAG: Record<EqBandId, EqBandDragSpec> = {
  lowCut:   { paramId: 'lowCutHz',     axis: 'x', min: 20,  max: 120, step: 1,   defaultValue: 32 },
  lowShelf: { paramId: 'lowShelfDb',   axis: 'y', min: -6,  max: 6,   step: 0.1, fixedFreq: 120,   defaultValue: 0 },
  presence: { paramId: 'presenceDb',   axis: 'y', min: -6,  max: 6,   step: 0.1, fixedFreq: 3000,  defaultValue: 0 },
  air:      { paramId: 'airDb',        axis: 'y', min: -6,  max: 6,   step: 0.1, fixedFreq: 12000, defaultValue: 0 },
  output:   { paramId: 'outputGainDb', axis: 'y', min: -12, max: 12,  step: 0.1, defaultValue: 0 },
};

export interface EqGeom {
  width: number;
  height: number;
  minHz: number;
  maxHz: number;
  /** dB range mapped over the full height (±dbRange). */
  dbRange: number;
}

// ── Frequency ⇆ x (log) ─────────────────────────────────────────────────
export function freqToX(f: number, g: EqGeom): number {
  const t = (Math.log10(f) - Math.log10(g.minHz)) / (Math.log10(g.maxHz) - Math.log10(g.minHz));
  return t * g.width;
}
export function xToFreq(x: number, g: EqGeom): number {
  const t = Math.max(0, Math.min(1, x / g.width));
  return Math.pow(10, Math.log10(g.minHz) + t * (Math.log10(g.maxHz) - Math.log10(g.minHz)));
}

// ── Gain (dB) ⇆ y (linear, 0 dB at mid) ─────────────────────────────────
export function gainToY(db: number, g: EqGeom): number {
  return g.height / 2 - (db / g.dbRange) * (g.height / 2);
}
export function yToGain(y: number, g: EqGeom): number {
  return ((g.height / 2 - y) / (g.height / 2)) * g.dbRange;
}

export function quantize(value: number, step: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  const snapped = Math.round(value / step) * step;
  const clamped = Math.max(min, Math.min(max, snapped));
  // Avoid −0 and float dust.
  return Math.round(clamped / step) * step;
}

export interface DragResult {
  paramId: EqBandDragSpec['paramId'];
  value: number;
}

/**
 * Map a pointer position (px in the editor box) to a band's new parameter
 * value — clamped, quantised, NaN-guarded.
 */
export function dragToValue(bandId: EqBandId, px: number, py: number, g: EqGeom): DragResult {
  const spec = EQ_BAND_DRAG[bandId];
  const raw = spec.axis === 'x' ? xToFreq(px, g) : yToGain(py, g);
  return { paramId: spec.paramId, value: quantize(raw, spec.step, spec.min, spec.max) };
}

/** The dot's current (x, y) for a band given its values. */
export function bandDotXY(bandId: EqBandId, freq: number, gainDb: number, curveYAtFreq: number, g: EqGeom): { x: number; y: number } {
  const spec = EQ_BAND_DRAG[bandId];
  if (spec.axis === 'x') {
    // Low cut: x follows frequency, y sits on the curve.
    return { x: freqToX(Math.max(g.minHz, Math.min(g.maxHz, freq)), g), y: curveYAtFreq };
  }
  // Gain bands: x fixed at the band frequency, y follows the curve value there.
  const fx = spec.fixedFreq ?? freq;
  return { x: freqToX(fx, g), y: curveYAtFreq, ...(bandId === 'output' ? { y: gainToY(gainDb, g) } : {}) };
}
