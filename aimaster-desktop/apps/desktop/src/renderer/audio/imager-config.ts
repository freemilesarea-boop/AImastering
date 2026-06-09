// imager-config — shared 4-band M/S stereo-imager config + helpers.
//
// One source of truth for the per-band stereo width used by the store, the UI
// panel, the offline-render request, and the WASM `setImagerMultiband`
// binding.  Mirrors the Rust ImagerConfig multiband fields (dsp-core).
// Default = disabled with unity widths → no-op until enabled.

export interface ImagerMultibandConfig {
  enabled: boolean;
  xoverLoHz: number;
  xoverMidHz: number;
  xoverHiHz: number;
  /** Per-band Side width %, [low, low-mid, high-mid, high].  100 = unchanged, 0 = mono. */
  widthsPct: [number, number, number, number];
}

export const IMG_RANGES = {
  widthPct: { min: 0, max: 200 },
  xoverLoHz: { min: 20, max: 500 },
  xoverMidHz: { min: 200, max: 4000 },
  xoverHiHz: { min: 2000, max: 16000 },
} as const;

export const IMG_BAND_LABELS = ['저역', '저중역', '고중역', '고역'] as const;

const clamp = (v: number, lo: number, hi: number, fb: number): number => {
  const x = Number.isFinite(v) ? v : fb;
  return Math.min(hi, Math.max(lo, x));
};

export function defaultImagerMultiband(): ImagerMultibandConfig {
  return { enabled: false, xoverLoHz: 120, xoverMidHz: 1000, xoverHiHz: 6000, widthsPct: [100, 100, 100, 100] };
}

export function sanitizeImagerMultiband(cfg: ImagerMultibandConfig): ImagerMultibandConfig {
  let lo = clamp(cfg.xoverLoHz, IMG_RANGES.xoverLoHz.min, IMG_RANGES.xoverLoHz.max, 120);
  let mid = clamp(cfg.xoverMidHz, IMG_RANGES.xoverMidHz.min, IMG_RANGES.xoverMidHz.max, 1000);
  let hi = clamp(cfg.xoverHiHz, IMG_RANGES.xoverHiHz.min, IMG_RANGES.xoverHiHz.max, 6000);
  if (mid <= lo) mid = lo * 1.5;
  if (hi <= mid) hi = mid * 1.5;
  const w = cfg.widthsPct.map((x) => clamp(x, IMG_RANGES.widthPct.min, IMG_RANGES.widthPct.max, 100)) as [number, number, number, number];
  return { enabled: !!cfg.enabled, xoverLoHz: lo, xoverMidHz: mid, xoverHiHz: hi, widthsPct: w };
}

/** True when the config would not alter the signal (disabled or all 100%). */
export function isImagerMultibandUnity(cfg: ImagerMultibandConfig): boolean {
  return !cfg.enabled || cfg.widthsPct.every((w) => w === 100);
}

/** Per-band widths as a Float64Array for the WASM `setImagerMultiband`. */
export function packImagerWidths(cfg: ImagerMultibandConfig): Float64Array {
  return Float64Array.from(sanitizeImagerMultiband(cfg).widthsPct);
}
