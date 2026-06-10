// dyneq-config — shared fully-parametric dynamic-EQ config + helpers.
//
// One source of truth for the dynamic EQ used by the store, the UI band-list
// editor, the offline-render request, and the WASM `setDynamicEqBands` binding.
// Mirrors the Rust DynamicEqConfig (dsp-core).  Default = bypassed → no-op.
//
// No faithful WebAudio-node approximation (needs per-sample coeff modulation),
// so the always-on preview does NOT reflect it — Rust export + opt-in worklet do.

export type DynEqFilterType = 'bell' | 'lowshelf' | 'highshelf';
export type DynEqMode = 'downcut' | 'upboost';

export const FILTER_CODE: Record<DynEqFilterType, number> = { bell: 0, lowshelf: 1, highshelf: 2 };
export const MODE_CODE: Record<DynEqMode, number> = { downcut: 0, upboost: 1 };
export const FILTER_TYPES: DynEqFilterType[] = ['bell', 'lowshelf', 'highshelf'];
export const FILTER_LABEL: Record<DynEqFilterType, string> = { bell: '벨', lowshelf: '로우셸프', highshelf: '하이셸프' };
export const MODE_LABEL: Record<DynEqMode, string> = { downcut: '컷(라우드 시)', upboost: '부스트(콰이엇 시)' };

export const MAX_DYNEQ_BANDS = 6;

export interface DynEqBand {
  id: string;
  enabled: boolean;
  filterType: DynEqFilterType;
  freqHz: number;
  q: number;
  thresholdDb: number;
  ratio: number;
  attackMs: number;
  releaseMs: number;
  rangeDb: number;
  mode: DynEqMode;
}

export interface DynamicEqConfig {
  bypass: boolean;
  bands: DynEqBand[];
}

export const DYNEQ_RANGES = {
  freqHz: { min: 20, max: 20000 },
  q: { min: 0.3, max: 12 },
  thresholdDb: { min: -60, max: 0 },
  ratio: { min: 1, max: 20 },
  attackMs: { min: 0.1, max: 200 },
  releaseMs: { min: 5, max: 2000 },
  rangeDb: { min: 0, max: 24 },
} as const;

const clamp = (v: number, lo: number, hi: number, fb: number): number => {
  const x = Number.isFinite(v) ? v : fb;
  return Math.min(hi, Math.max(lo, x));
};

let nextId = 1;
export function makeDynEqBandId(): string {
  return `dyneq-${nextId++}-${Math.random().toString(36).slice(2, 6)}`;
}

export function defaultDynEqBand(freqHz = 1000): DynEqBand {
  return {
    id: makeDynEqBandId(), enabled: true, filterType: 'bell', freqHz, q: 2,
    thresholdDb: -24, ratio: 2, attackMs: 5, releaseMs: 80, rangeDb: 6, mode: 'downcut',
  };
}

export function defaultDynamicEqConfig(): DynamicEqConfig {
  return { bypass: true, bands: [] };
}

function sanBand(b: DynEqBand): DynEqBand {
  return {
    id: b.id,
    enabled: !!b.enabled,
    filterType: FILTER_TYPES.includes(b.filterType) ? b.filterType : 'bell',
    freqHz: clamp(b.freqHz, DYNEQ_RANGES.freqHz.min, DYNEQ_RANGES.freqHz.max, 1000),
    q: clamp(b.q, DYNEQ_RANGES.q.min, DYNEQ_RANGES.q.max, 2),
    thresholdDb: clamp(b.thresholdDb, DYNEQ_RANGES.thresholdDb.min, DYNEQ_RANGES.thresholdDb.max, -24),
    ratio: clamp(b.ratio, DYNEQ_RANGES.ratio.min, DYNEQ_RANGES.ratio.max, 2),
    attackMs: clamp(b.attackMs, DYNEQ_RANGES.attackMs.min, DYNEQ_RANGES.attackMs.max, 5),
    releaseMs: clamp(b.releaseMs, DYNEQ_RANGES.releaseMs.min, DYNEQ_RANGES.releaseMs.max, 80),
    rangeDb: clamp(b.rangeDb, DYNEQ_RANGES.rangeDb.min, DYNEQ_RANGES.rangeDb.max, 6),
    mode: b.mode === 'upboost' ? 'upboost' : 'downcut',
  };
}

export function sanitizeDynamicEq(cfg: DynamicEqConfig): DynamicEqConfig {
  return { bypass: !!cfg.bypass, bands: cfg.bands.slice(0, MAX_DYNEQ_BANDS).map(sanBand) };
}

/** True when the stage would not alter the signal. */
export function isDynamicEqUnity(cfg: DynamicEqConfig): boolean {
  if (cfg.bypass) return true;
  return cfg.bands.every((b) => !b.enabled || b.rangeDb <= 0);
}

/** Parallel typed arrays for the WASM `setDynamicEqBands`. */
export function packDynamicEq(cfg: DynamicEqConfig): {
  enableds: Uint8Array; types: Uint8Array; freqs: Float64Array; qs: Float64Array;
  thresholds: Float64Array; ratios: Float64Array; attacks: Float64Array; releases: Float64Array;
  ranges: Float64Array; modes: Uint8Array;
} {
  const bands = sanitizeDynamicEq(cfg).bands;
  const n = bands.length;
  const enableds = new Uint8Array(n);
  const types = new Uint8Array(n);
  const freqs = new Float64Array(n);
  const qs = new Float64Array(n);
  const thresholds = new Float64Array(n);
  const ratios = new Float64Array(n);
  const attacks = new Float64Array(n);
  const releases = new Float64Array(n);
  const ranges = new Float64Array(n);
  const modes = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const b = bands[i]!;
    enableds[i] = b.enabled ? 1 : 0;
    types[i] = FILTER_CODE[b.filterType];
    freqs[i] = b.freqHz;
    qs[i] = b.q;
    thresholds[i] = b.thresholdDb;
    ratios[i] = b.ratio;
    attacks[i] = b.attackMs;
    releases[i] = b.releaseMs;
    ranges[i] = b.rangeDb;
    modes[i] = MODE_CODE[b.mode];
  }
  return { enableds, types, freqs, qs, thresholds, ratios, attacks, releases, ranges, modes };
}
