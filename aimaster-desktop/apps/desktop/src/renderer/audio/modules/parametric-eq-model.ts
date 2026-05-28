// parametric-eq-model — free parametric EQ (Phase 1: visualization model).
//
// A simple list-of-bands data structure for a user-defined parametric EQ.
// Each band has type / frequency / gainDb / Q.  Curve evaluation reuses
// the RBJ-cookbook biquad coefficients from eq-curve-model.ts, so the
// visual curve here will match the audible chain once Phase 2 wires the
// bands into the native DSP via WebAudio BiquadFilter nodes.
//
// Phase 1 status: this state is renderer-only.  It produces a curve on
// the spectrum canvas but does NOT yet affect the audible audio — that
// arrives in Phase 2 (DSP integration).  The UI labels this honestly.

export type ParametricBandType = 'highpass' | 'lowshelf' | 'bell' | 'highshelf' | 'lowpass';

export interface ParametricEqBand {
  /** Stable id for React keys + selection. */
  id: string;
  type: ParametricBandType;
  /** Centre / corner frequency in Hz (20–20000). */
  frequencyHz: number;
  /** Gain in dB (-24 to +24).  Ignored for highpass / lowpass. */
  gainDb: number;
  /** Bandwidth: bell uses peaking Q; shelves use slope (0.3–2). */
  q: number;
  /** When false, the band is muted (skipped in curve + DSP). */
  enabled: boolean;
}

export const MIN_FREQ_HZ = 20;
export const MAX_FREQ_HZ = 20000;
export const MIN_GAIN_DB = -24;
export const MAX_GAIN_DB = 24;
export const MIN_Q = 0.3;
export const MAX_Q = 12;
export const MAX_BANDS = 7;

let nextBandId = 1;
export function makeBandId(): string {
  return `band-${nextBandId++}-${Math.random().toString(36).slice(2, 6)}`;
}

export function defaultBand(frequencyHz = 1000, gainDb = 0): ParametricEqBand {
  return {
    id: makeBandId(),
    type: 'bell',
    frequencyHz,
    gainDb,
    q: 1.0,
    enabled: true,
  };
}

export function clampFrequency(hz: number): number {
  if (!Number.isFinite(hz)) return 1000;
  return Math.max(MIN_FREQ_HZ, Math.min(MAX_FREQ_HZ, hz));
}
export function clampGainDb(db: number): number {
  if (!Number.isFinite(db)) return 0;
  return Math.max(MIN_GAIN_DB, Math.min(MAX_GAIN_DB, db));
}
export function clampQ(q: number): number {
  if (!Number.isFinite(q)) return 1;
  return Math.max(MIN_Q, Math.min(MAX_Q, q));
}

// ── RBJ cookbook biquad magnitude (mirrors eq-curve-model.ts) ──────────
//
// Kept local so this model has no dependency on the legacy 5-band model.

interface Coeffs { b0: number; b1: number; b2: number; a0: number; a1: number; a2: number; }

function coeffsFor(type: ParametricBandType, fs: number, f0: number, q: number, gainDb: number): Coeffs | null {
  const w0 = (2 * Math.PI * Math.min(f0, fs / 2 - 1)) / fs;
  const cw = Math.cos(w0);
  const sw = Math.sin(w0);
  const alpha = sw / (2 * q);
  const A = Math.pow(10, gainDb / 40);
  const sqA = Math.sqrt(A);
  switch (type) {
    case 'highpass':
      return { b0: (1 + cw) / 2, b1: -(1 + cw), b2: (1 + cw) / 2, a0: 1 + alpha, a1: -2 * cw, a2: 1 - alpha };
    case 'lowpass':
      return { b0: (1 - cw) / 2, b1: 1 - cw, b2: (1 - cw) / 2, a0: 1 + alpha, a1: -2 * cw, a2: 1 - alpha };
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
      return {
        b0: 1 + alpha * A, b1: -2 * cw, b2: 1 - alpha * A,
        a0: 1 + alpha / A, a1: -2 * cw, a2: 1 - alpha / A,
      };
  }
}

function bandMagnitudeDb(c: Coeffs, f: number, fs: number): number {
  const w = (2 * Math.PI * f) / fs;
  const cw = Math.cos(w), c2w = Math.cos(2 * w), sw = Math.sin(w), s2w = Math.sin(2 * w);
  const nr = c.b0 + c.b1 * cw + c.b2 * c2w;
  const ni = -(c.b1 * sw + c.b2 * s2w);
  const dr = c.a0 + c.a1 * cw + c.a2 * c2w;
  const di = -(c.a1 * sw + c.a2 * s2w);
  const num = Math.sqrt(nr * nr + ni * ni);
  const den = Math.sqrt(dr * dr + di * di) || 1e-9;
  return 20 * Math.log10((num / den) || 1e-9);
}

/** Total parametric EQ curve in dB at frequency f, summed over enabled bands. */
export function parametricEqCurveDb(bands: ParametricEqBand[], f: number, sampleRate = 48000): number {
  let db = 0;
  for (const band of bands) {
    if (!band.enabled) continue;
    const c = coeffsFor(band.type, sampleRate, band.frequencyHz, band.q, band.gainDb);
    if (c) db += bandMagnitudeDb(c, Math.max(10, f), sampleRate);
  }
  return db;
}

/** Curve dB at a band's own frequency (for placing its dot at the curve line). */
export function bandPointDb(band: ParametricEqBand, allBands: ParametricEqBand[], sampleRate = 48000): number {
  return parametricEqCurveDb(allBands, band.frequencyHz, sampleRate);
}
