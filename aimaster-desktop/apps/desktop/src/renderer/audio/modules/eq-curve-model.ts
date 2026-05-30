// EQ curve model (OZONE-MODULE-NEXT-2).
//
// Computes a *visualization* magnitude curve for the Loui preview EQ.  The
// band layout + RBJ-cookbook biquad coefficients mirror the real Rust EQ
// (dsp-core/.../mastering/eq.rs):
//   • high-pass @ lowCut   (Q 0.707)
//   • low shelf @ 120 Hz   (Q 0.707)
//   • presence  @ 3 kHz     (peak, Q 1.1)
//   • air shelf @ 12 kHz   (Q 0.707)
//   • output gain → flat offset
//
// So the curve tracks the actual preview tone direction.  It is still a
// *visual* model (it overlays a dBFS spectrum and omits the adaptive
// harshness dip) — labelled "approximate" in the UI, never presented as a
// measured response.

export type BandType = 'highpass' | 'lowshelf' | 'bell' | 'highshelf' | 'output';

export interface BandModel {
  id: 'lowCut' | 'lowShelf' | 'presence' | 'air' | 'output';
  label: string;
  type: BandType;
  /** Centre / corner frequency (Hz).  For 'output', unused. */
  frequency: number;
  gainDb: number;
  q: number;
  /** Whether the band meaningfully shapes the curve (drives dot emphasis). */
  enabled: boolean;
  color: string;
}

export interface EqBandsInput {
  lowCutHz: number;
  lowShelfDb: number;
  presenceDb: number;
  airDb: number;
  outputGainDb: number;
}

export interface EqCurveModel {
  bands: BandModel[];
  outputGainDb: number;
  bypassed: boolean;
  sampleRate: number;
}

// Band accent palette (charcoal/lavender system).
const COLOR = {
  lowCut: '#60A5FA',
  lowShelf: '#FBBF24',
  presence: '#A78BFA',
  air: '#22D3EE',
  output: '#34D399',
} as const;

const LOW_SHELF_HZ = 120;
const PRESENCE_HZ = 3000;
const AIR_HZ = 12000;

export function buildEqCurveModel(b: EqBandsInput, bypassed = false, sampleRate = 48000): EqCurveModel {
  return {
    sampleRate,
    bypassed,
    outputGainDb: b.outputGainDb,
    bands: [
      { id: 'lowCut',   label: 'Low Cut',  type: 'highpass',  frequency: Math.max(20, b.lowCutHz), gainDb: 0,            q: 0.707, enabled: b.lowCutHz > 22, color: COLOR.lowCut },
      { id: 'lowShelf', label: 'Low',      type: 'lowshelf',  frequency: LOW_SHELF_HZ,              gainDb: b.lowShelfDb, q: 0.707, enabled: Math.abs(b.lowShelfDb) > 0.05, color: COLOR.lowShelf },
      { id: 'presence', label: 'Presence', type: 'bell',      frequency: PRESENCE_HZ,               gainDb: b.presenceDb, q: 1.1,   enabled: Math.abs(b.presenceDb) > 0.05, color: COLOR.presence },
      { id: 'air',      label: 'Air',      type: 'highshelf', frequency: AIR_HZ,                    gainDb: b.airDb,      q: 0.707, enabled: Math.abs(b.airDb) > 0.05, color: COLOR.air },
      { id: 'output',   label: 'Out',      type: 'output',    frequency: 0,                          gainDb: b.outputGainDb, q: 0,   enabled: Math.abs(b.outputGainDb) > 0.05, color: COLOR.output },
    ],
  };
}

// ── RBJ cookbook biquad magnitude (matches the Rust coeffs) ────────────

interface Coeffs { b0: number; b1: number; b2: number; a0: number; a1: number; a2: number; }

function coeffsFor(type: BandType, fs: number, f0: number, q: number, gainDb: number): Coeffs | null {
  if (type === 'output') return null;
  const w0 = (2 * Math.PI * Math.min(f0, fs / 2 - 1)) / fs;
  const cw = Math.cos(w0);
  const sw = Math.sin(w0);
  const alpha = sw / (2 * q);
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
      return {
        b0: 1 + alpha * A, b1: -2 * cw, b2: 1 - alpha * A,
        a0: 1 + alpha / A, a1: -2 * cw, a2: 1 - alpha / A,
      };
    default:
      return null;
  }
}

/** |H(e^jw)| in dB for one biquad at frequency f. */
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

/** Total curve magnitude (dB) at frequency f — sum of enabled bands + output. */
export function eqCurveDb(f: number, model: EqCurveModel): number {
  if (model.bypassed) return 0;
  let db = model.outputGainDb;
  for (const band of model.bands) {
    if (band.type === 'output') continue;
    const c = coeffsFor(band.type, model.sampleRate, band.frequency, band.q, band.gainDb);
    if (c) db += bandMagnitudeDb(c, Math.max(10, f), model.sampleRate);
  }
  return db;
}

/** The curve's dB value AT a band's own frequency (for placing its dot). */
export function bandPointDb(band: BandModel, model: EqCurveModel): number {
  if (band.type === 'output') return model.outputGainDb;
  return eqCurveDb(band.frequency, model);
}
