// deesser-config — adaptive de-esser, realised on top of the Dynamic EQ.
//
// A de-esser is a dynamic EQ band tuned for sibilance: a fast, downward
// (cut-when-loud) bell/high-shelf in the 4–10 kHz region.  Rather than add a
// new DSP module, the de-esser is a focused UI/config that is MERGED into the
// dynamic-EQ band list sent to the engine — so it reuses the Rust Dynamic EQ
// entirely and applies on export + the opt-in worklet.

import { type DynEqBand, type DynamicEqConfig, sanitizeDynamicEq, MAX_DYNEQ_BANDS } from './dyneq-config.js';

export interface DeesserConfig {
  enabled: boolean;
  /** Sibilance centre frequency (Hz). */
  freqHz: number;
  thresholdDb: number;
  /** Max reduction (dB). */
  rangeDb: number;
  q: number;
  /** 'bell' = narrow notch; 'highshelf' = tame the whole top. */
  filterType: 'bell' | 'highshelf';
}

export const DEESS_RANGES = {
  freqHz: { min: 3000, max: 12000 },
  thresholdDb: { min: -60, max: 0 },
  rangeDb: { min: 0, max: 18 },
  q: { min: 0.5, max: 10 },
} as const;

const clamp = (v: number, lo: number, hi: number, fb: number): number => {
  const x = Number.isFinite(v) ? v : fb;
  return Math.min(hi, Math.max(lo, x));
};

export function defaultDeesserConfig(): DeesserConfig {
  return { enabled: false, freqHz: 6500, thresholdDb: -28, rangeDb: 6, q: 3.5, filterType: 'bell' };
}

export function sanitizeDeesser(cfg: DeesserConfig): DeesserConfig {
  return {
    enabled: !!cfg.enabled,
    freqHz: clamp(cfg.freqHz, DEESS_RANGES.freqHz.min, DEESS_RANGES.freqHz.max, 6500),
    thresholdDb: clamp(cfg.thresholdDb, DEESS_RANGES.thresholdDb.min, DEESS_RANGES.thresholdDb.max, -28),
    rangeDb: clamp(cfg.rangeDb, DEESS_RANGES.rangeDb.min, DEESS_RANGES.rangeDb.max, 6),
    q: clamp(cfg.q, DEESS_RANGES.q.min, DEESS_RANGES.q.max, 3.5),
    filterType: cfg.filterType === 'highshelf' ? 'highshelf' : 'bell',
  };
}

export function isDeesserActive(cfg: DeesserConfig): boolean {
  return cfg.enabled && cfg.rangeDb > 0;
}

/** The dynamic-EQ band that realises the de-esser, or null when inactive. */
export function deesserToDynEqBand(cfg: DeesserConfig): DynEqBand | null {
  if (!isDeesserActive(cfg)) return null;
  const s = sanitizeDeesser(cfg);
  return {
    id: 'deesser-band',
    enabled: true,
    filterType: s.filterType,
    freqHz: s.freqHz,
    q: s.q,
    thresholdDb: s.thresholdDb,
    ratio: 4,
    attackMs: 1,
    releaseMs: 60,
    rangeDb: s.rangeDb,
    mode: 'downcut',
  };
}

/**
 * Merge the de-esser into a Dynamic EQ config for the engine.  The user's
 * manual bands are kept (unless their dynamic EQ is bypassed); the de-esser
 * band is appended.  Capped to MAX_DYNEQ_BANDS.
 */
export function combineDynamicEqWithDeesser(dynamicEq: DynamicEqConfig, deesser: DeesserConfig): DynamicEqConfig {
  const deBand = deesserToDynEqBand(deesser);
  const userBands = dynamicEq.bypass ? [] : dynamicEq.bands;
  const bands = (deBand ? [...userBands, deBand] : userBands).slice(0, MAX_DYNEQ_BANDS);
  return sanitizeDynamicEq({ bypass: bands.length === 0, bands });
}
