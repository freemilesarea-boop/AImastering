// transient-config — shared transient/impact shaper config + helpers.
//
// One source of truth for the transient shape used by the store, the UI panel,
// the offline-render request, and the WASM `setTransient` binding.  Mirrors the
// Rust TransientConfig (dsp-core).  Default = bypassed → no-op until enabled.
//
// Note: there is no faithful WebAudio-node approximation for a transient
// designer (it needs per-sample envelope math), so the always-on preview does
// NOT reflect it — the Rust export + opt-in worklet do.

export interface TransientBand {
  /** Attack emphasis %, [-100, 100]. */
  attackPct: number;
  /** Sustain emphasis %, [-100, 100]. */
  sustainPct: number;
}

export interface TransientConfig {
  bypass: boolean;
  attackPct: number;
  sustainPct: number;
  multibandEnabled: boolean;
  bands: [TransientBand, TransientBand, TransientBand, TransientBand];
  xoverLoHz: number;
  xoverMidHz: number;
  xoverHiHz: number;
}

export const TR_RANGES = {
  amountPct: { min: -100, max: 100 },
  xoverLoHz: { min: 20, max: 500 },
  xoverMidHz: { min: 200, max: 4000 },
  xoverHiHz: { min: 2000, max: 16000 },
} as const;

export const TR_BAND_LABELS = ['저역', '저중역', '고중역', '고역'] as const;

const clamp = (v: number, lo: number, hi: number, fb: number): number => {
  const x = Number.isFinite(v) ? v : fb;
  return Math.min(hi, Math.max(lo, x));
};

export function defaultTransientBand(): TransientBand {
  return { attackPct: 0, sustainPct: 0 };
}

export function defaultTransientConfig(): TransientConfig {
  return {
    bypass: true, attackPct: 0, sustainPct: 0, multibandEnabled: false,
    bands: [defaultTransientBand(), defaultTransientBand(), defaultTransientBand(), defaultTransientBand()],
    xoverLoHz: 120, xoverMidHz: 1000, xoverHiHz: 6000,
  };
}

function sanBand(b: TransientBand): TransientBand {
  return {
    attackPct: clamp(b.attackPct, TR_RANGES.amountPct.min, TR_RANGES.amountPct.max, 0),
    sustainPct: clamp(b.sustainPct, TR_RANGES.amountPct.min, TR_RANGES.amountPct.max, 0),
  };
}

export function sanitizeTransient(cfg: TransientConfig): TransientConfig {
  let lo = clamp(cfg.xoverLoHz, TR_RANGES.xoverLoHz.min, TR_RANGES.xoverLoHz.max, 120);
  let mid = clamp(cfg.xoverMidHz, TR_RANGES.xoverMidHz.min, TR_RANGES.xoverMidHz.max, 1000);
  let hi = clamp(cfg.xoverHiHz, TR_RANGES.xoverHiHz.min, TR_RANGES.xoverHiHz.max, 6000);
  if (mid <= lo) mid = lo * 1.5;
  if (hi <= mid) hi = mid * 1.5;
  return {
    bypass: !!cfg.bypass,
    attackPct: clamp(cfg.attackPct, TR_RANGES.amountPct.min, TR_RANGES.amountPct.max, 0),
    sustainPct: clamp(cfg.sustainPct, TR_RANGES.amountPct.min, TR_RANGES.amountPct.max, 0),
    multibandEnabled: !!cfg.multibandEnabled,
    bands: [sanBand(cfg.bands[0]), sanBand(cfg.bands[1]), sanBand(cfg.bands[2]), sanBand(cfg.bands[3])],
    xoverLoHz: lo, xoverMidHz: mid, xoverHiHz: hi,
  };
}

/** True when the stage would not alter the signal. */
export function isTransientUnity(cfg: TransientConfig): boolean {
  if (cfg.bypass) return true;
  if (cfg.multibandEnabled) return cfg.bands.every((b) => b.attackPct === 0 && b.sustainPct === 0);
  return cfg.attackPct === 0 && cfg.sustainPct === 0;
}

/** Parallel per-band attack/sustain arrays for the WASM `setTransient`. */
export function packTransientBands(cfg: TransientConfig): { attacks: Float64Array; sustains: Float64Array } {
  const s = sanitizeTransient(cfg);
  return {
    attacks: Float64Array.from(s.bands.map((b) => b.attackPct)),
    sustains: Float64Array.from(s.bands.map((b) => b.sustainPct)),
  };
}
