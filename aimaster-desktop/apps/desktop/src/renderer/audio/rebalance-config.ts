// rebalance-config — stem-aware rebalance (Phase 3, Master-Rebalance-style).
//
// Two tiers, one config:
//   • APPROXIMATION (always available, no ML): M/S + band moves that raise the
//     CENTRE vocal vs panned instruments, lift/cut the bass, and widen/narrow
//     the sides — an honest "rebalance-lite" heard live in the preview.
//   • PRECISE (Demucs via ONNX, opt-in plugin): true 4-stem separation +
//     per-stem gain, applied on the offline export.  Gated on the model being
//     present; falls back to the approximation otherwise.
//
// This module is the shared config + helpers (pure, headless-testable).

export type StemId = 'vocals' | 'drums' | 'bass' | 'other';
export const STEMS: StemId[] = ['vocals', 'drums', 'bass', 'other'];
export const STEM_LABEL: Record<StemId, string> = { vocals: '보컬', drums: '드럼', bass: '베이스', other: '기타' };

export interface RebalanceConfig {
  /** Approximation tier (M/S + band) — always available. */
  vocalDb: number;   // centre (vocal) gain
  bassDb: number;    // low-band gain
  sidePct: number;   // 0 = mono … 100 = neutral … 200 = wide
  /** Precise tier (Demucs/ONNX) — per-stem gain dB; applied on export when a
   *  real separation is available. */
  stemGainsDb: Record<StemId, number>;
  /** Whether to attempt the precise (Demucs) separation on export. */
  preciseEnabled: boolean;
}

export const REBAL_RANGES = {
  vocalDb: { min: -12, max: 12 },
  bassDb: { min: -12, max: 12 },
  sidePct: { min: 0, max: 200 },
  stemDb: { min: -24, max: 12 },
} as const;

const clamp = (v: number, lo: number, hi: number, fb: number): number => {
  const x = Number.isFinite(v) ? v : fb;
  return Math.min(hi, Math.max(lo, x));
};

export function defaultRebalanceConfig(): RebalanceConfig {
  return {
    vocalDb: 0, bassDb: 0, sidePct: 100,
    stemGainsDb: { vocals: 0, drums: 0, bass: 0, other: 0 },
    preciseEnabled: false,
  };
}

export function sanitizeRebalance(c: RebalanceConfig): RebalanceConfig {
  const g = (k: StemId): number => clamp(c.stemGainsDb?.[k] ?? 0, REBAL_RANGES.stemDb.min, REBAL_RANGES.stemDb.max, 0);
  return {
    vocalDb: clamp(c.vocalDb, REBAL_RANGES.vocalDb.min, REBAL_RANGES.vocalDb.max, 0),
    bassDb: clamp(c.bassDb, REBAL_RANGES.bassDb.min, REBAL_RANGES.bassDb.max, 0),
    sidePct: clamp(c.sidePct, REBAL_RANGES.sidePct.min, REBAL_RANGES.sidePct.max, 100),
    stemGainsDb: { vocals: g('vocals'), drums: g('drums'), bass: g('bass'), other: g('other') },
    preciseEnabled: !!c.preciseEnabled,
  };
}

/** True when the approximation tier would not alter the signal. */
export function isApproxRebalanceUnity(c: RebalanceConfig): boolean {
  return c.vocalDb === 0 && c.bassDb === 0 && c.sidePct === 100;
}

/** True when the precise tier carries any non-zero stem gain. */
export function isPreciseRebalanceActive(c: RebalanceConfig): boolean {
  return c.preciseEnabled && STEMS.some((s) => (c.stemGainsDb[s] ?? 0) !== 0);
}

// ── Pure stem remix (for the precise tier) ─────────────────────────────────

const db2lin = (db: number): number => Math.pow(10, db / 20);

export interface StereoStems {
  /** Each stem is interleaved-free: { left, right } same length. */
  vocals: { left: Float32Array; right: Float32Array };
  drums: { left: Float32Array; right: Float32Array };
  bass: { left: Float32Array; right: Float32Array };
  other: { left: Float32Array; right: Float32Array };
}

/**
 * Remix separated stems with per-stem gains → stereo.  Pure.  With all gains
 * at 0 dB the sum reconstructs the original mix (Demucs stems sum to the mix).
 */
export function remixStems(stems: StereoStems, gainsDb: Record<StemId, number>): { left: Float32Array; right: Float32Array } {
  const n = stems.vocals.left.length;
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  const g: Record<StemId, number> = {
    vocals: db2lin(gainsDb.vocals ?? 0), drums: db2lin(gainsDb.drums ?? 0),
    bass: db2lin(gainsDb.bass ?? 0), other: db2lin(gainsDb.other ?? 0),
  };
  for (const s of STEMS) {
    const gl = g[s];
    const sl = stems[s].left;
    const sr = stems[s].right;
    for (let i = 0; i < n; i++) { left[i]! += sl[i]! * gl; right[i]! += sr[i]! * gl; }
  }
  return { left, right };
}
