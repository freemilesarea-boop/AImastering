// surround-beds — per-bed tone/level offsets for the multichannel chain (P4).
//
// Each surround "bed" (front L/R, centre, surround L/R, LFE) can carry its own
// gain + low/high-shelf trim, layered on top of the shared chain config when the
// per-bed full chain runs.  LFE is band-limited → gain only.
//
// Pure (type-only dependency on the chain config); fully headless-testable.

import type { ChannelRole } from './surround.js';
import type { OfflineChainConfig } from './load-mastering-chain-node.js';
import type { SurroundBedAdjust, SurroundBeds } from '@aimaster/shared-types';

export type SurroundBedKind = 'front' | 'center' | 'surround' | 'lfe';

const clamp = (v: number, lo: number, hi: number, fb: number): number => {
  const x = Number.isFinite(v) ? v : fb;
  return Math.min(hi, Math.max(lo, x));
};

export const BED_GAIN_RANGE = { min: -12, max: 12 } as const;
export const BED_SHELF_RANGE = { min: -9, max: 9 } as const;

export function bedForRole(role: ChannelRole): SurroundBedKind {
  switch (role) {
    case 'FL': case 'FR': return 'front';
    case 'FC': return 'center';
    case 'BL': case 'BR': case 'SL': case 'SR': return 'surround';
    case 'LFE': return 'lfe';
    default: return 'front';
  }
}

const neutralAdjust = (): SurroundBedAdjust => ({ gainDb: 0, lowShelfDb: 0, highShelfDb: 0 });

export function defaultSurroundBeds(): SurroundBeds {
  return { front: neutralAdjust(), center: neutralAdjust(), surround: neutralAdjust(), lfeGainDb: 0 };
}

function sanitizeAdjust(a: SurroundBedAdjust | undefined): SurroundBedAdjust {
  return {
    gainDb: clamp(a?.gainDb ?? 0, BED_GAIN_RANGE.min, BED_GAIN_RANGE.max, 0),
    lowShelfDb: clamp(a?.lowShelfDb ?? 0, BED_SHELF_RANGE.min, BED_SHELF_RANGE.max, 0),
    highShelfDb: clamp(a?.highShelfDb ?? 0, BED_SHELF_RANGE.min, BED_SHELF_RANGE.max, 0),
  };
}

export function sanitizeSurroundBeds(b: SurroundBeds | undefined | null): SurroundBeds {
  return {
    front: sanitizeAdjust(b?.front),
    center: sanitizeAdjust(b?.center),
    surround: sanitizeAdjust(b?.surround),
    lfeGainDb: clamp(b?.lfeGainDb ?? 0, BED_GAIN_RANGE.min, BED_GAIN_RANGE.max, 0),
  };
}

export function isBedAdjustNeutral(a: SurroundBedAdjust): boolean {
  return a.gainDb === 0 && a.lowShelfDb === 0 && a.highShelfDb === 0;
}

/** True when no bed carries any offset (the per-bed layer is a no-op). */
export function isSurroundBedsNeutral(b: SurroundBeds | undefined | null): boolean {
  if (!b) return true;
  return isBedAdjustNeutral(b.front) && isBedAdjustNeutral(b.center) && isBedAdjustNeutral(b.surround) && b.lfeGainDb === 0;
}

/**
 * Fold a bed's offsets into the shared (tone-only) chain config: gain → input
 * gain, low-shelf → eqLowShelfDb, high-shelf → eqAirDb (the chain's air shelf).
 * Un-bypasses the EQ when a shelf is set.  Pure — returns a new config.
 */
export function bedAdjustedConfig(base: OfflineChainConfig, adjust: SurroundBedAdjust): OfflineChainConfig {
  if (isBedAdjustNeutral(adjust)) return base;
  return {
    ...base,
    inputGainDb: base.inputGainDb + adjust.gainDb,
    eqLowShelfDb: base.eqLowShelfDb + adjust.lowShelfDb,
    eqAirDb: base.eqAirDb + adjust.highShelfDb,
    eqBypass: adjust.lowShelfDb !== 0 || adjust.highShelfDb !== 0 ? false : base.eqBypass,
  };
}
