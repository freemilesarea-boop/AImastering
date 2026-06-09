// multiband-config — shared 4-band multiband compressor config + helpers.
//
// One source of truth for the multiband shape used by the store, the UI
// panel, the offline-render request, and the WASM `setMultibandConfig`
// binding.  Pure (no DOM / no engine) → unit-testable headlessly.
//
// Mirrors the Rust `MultibandConfig` / `MultibandBandConfig` (dsp-core).
// Default = bypassed with unity bands, so it is a no-op until enabled.

export interface MultibandBand {
  thresholdDb: number;
  /** 1.0 = no compression. */
  ratio: number;
  attackMs: number;
  releaseMs: number;
  makeupDb: number;
}

export interface MultibandConfig {
  bypass: boolean;
  xoverLoHz: number;
  xoverMidHz: number;
  xoverHiHz: number;
  /** [low, low-mid, high-mid, high]. */
  bands: [MultibandBand, MultibandBand, MultibandBand, MultibandBand];
}

export const MB_RANGES = {
  thresholdDb: { min: -60, max: 0 },
  ratio: { min: 1, max: 20 },
  attackMs: { min: 0.1, max: 200 },
  releaseMs: { min: 5, max: 2000 },
  makeupDb: { min: -12, max: 12 },
  xoverLoHz: { min: 20, max: 500 },
  xoverMidHz: { min: 200, max: 4000 },
  xoverHiHz: { min: 2000, max: 16000 },
} as const;

export const BAND_LABELS = ['저역', '저중역', '고중역', '고역'] as const;

const clamp = (v: number, lo: number, hi: number, fb: number): number => {
  const x = Number.isFinite(v) ? v : fb;
  return Math.min(hi, Math.max(lo, x));
};

export function defaultMultibandBand(): MultibandBand {
  return { thresholdDb: -24, ratio: 1, attackMs: 20, releaseMs: 150, makeupDb: 0 };
}

export function defaultMultibandConfig(): MultibandConfig {
  return {
    bypass: true,
    xoverLoHz: 120,
    xoverMidHz: 1000,
    xoverHiHz: 6000,
    bands: [defaultMultibandBand(), defaultMultibandBand(), defaultMultibandBand(), defaultMultibandBand()],
  };
}

function sanitizeBand(b: MultibandBand): MultibandBand {
  return {
    thresholdDb: clamp(b.thresholdDb, MB_RANGES.thresholdDb.min, MB_RANGES.thresholdDb.max, -24),
    ratio: clamp(b.ratio, MB_RANGES.ratio.min, MB_RANGES.ratio.max, 1),
    attackMs: clamp(b.attackMs, MB_RANGES.attackMs.min, MB_RANGES.attackMs.max, 20),
    releaseMs: clamp(b.releaseMs, MB_RANGES.releaseMs.min, MB_RANGES.releaseMs.max, 150),
    makeupDb: clamp(b.makeupDb, MB_RANGES.makeupDb.min, MB_RANGES.makeupDb.max, 0),
  };
}

/** Clamp every field + force xover_lo < xover_mid < xover_hi (ascending). */
export function sanitizeMultiband(cfg: MultibandConfig): MultibandConfig {
  let lo = clamp(cfg.xoverLoHz, MB_RANGES.xoverLoHz.min, MB_RANGES.xoverLoHz.max, 120);
  let mid = clamp(cfg.xoverMidHz, MB_RANGES.xoverMidHz.min, MB_RANGES.xoverMidHz.max, 1000);
  let hi = clamp(cfg.xoverHiHz, MB_RANGES.xoverHiHz.min, MB_RANGES.xoverHiHz.max, 6000);
  if (mid <= lo) mid = lo * 1.5;
  if (hi <= mid) hi = mid * 1.5;
  return {
    bypass: !!cfg.bypass,
    xoverLoHz: lo,
    xoverMidHz: mid,
    xoverHiHz: hi,
    bands: [sanitizeBand(cfg.bands[0]), sanitizeBand(cfg.bands[1]), sanitizeBand(cfg.bands[2]), sanitizeBand(cfg.bands[3])],
  };
}

/** True when the config would not alter the signal (bypassed or all unity). */
export function isMultibandUnity(cfg: MultibandConfig): boolean {
  return cfg.bypass || cfg.bands.every((b) => b.ratio <= 1 && b.makeupDb === 0);
}

/** Parallel Float64Arrays in band order, for the WASM `setMultibandConfig`. */
export function packMultibandArrays(cfg: MultibandConfig): {
  thresholds: Float64Array; ratios: Float64Array; attacks: Float64Array; releases: Float64Array; makeups: Float64Array;
} {
  const s = sanitizeMultiband(cfg);
  return {
    thresholds: Float64Array.from(s.bands.map((b) => b.thresholdDb)),
    ratios: Float64Array.from(s.bands.map((b) => b.ratio)),
    attacks: Float64Array.from(s.bands.map((b) => b.attackMs)),
    releases: Float64Array.from(s.bands.map((b) => b.releaseMs)),
    makeups: Float64Array.from(s.bands.map((b) => b.makeupDb)),
  };
}
