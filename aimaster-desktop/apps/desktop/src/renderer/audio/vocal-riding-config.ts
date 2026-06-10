// vocal-riding-config — renderer-side model for automatic vocal level riding.
//
// The DSP (envelope detector + gain curve + M/S centre ride) lives in the main
// process (main/offline/vocal-riding.ts); vocal riding applies on the offline
// EXPORT, like the section/precise tiers — the live preview is unchanged.

import type { VocalRidingPlan } from '@aimaster/shared-types';

export const VOCAL_RIDING_RANGES = {
  amount: { min: 0, max: 1 },
  boostCutDb: { min: 0, max: 12 },
  responseMs: { min: 50, max: 1000 },
} as const;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export function defaultVocalRiding(): VocalRidingPlan {
  return { enabled: false, amount: 0.5, maxBoostDb: 6, maxCutDb: 6, responseMs: 300 };
}

/** True when the plan would not change the signal (disabled or amount 0). */
export function isVocalRidingUnity(plan: VocalRidingPlan | undefined | null): boolean {
  return !plan || !plan.enabled || plan.amount <= 0;
}

export function sanitizeVocalRiding(plan: VocalRidingPlan): VocalRidingPlan {
  const n = (v: number, fb: number): number => (Number.isFinite(v) ? v : fb);
  return {
    enabled: !!plan.enabled,
    amount: clamp(n(plan.amount, 0.5), VOCAL_RIDING_RANGES.amount.min, VOCAL_RIDING_RANGES.amount.max),
    maxBoostDb: clamp(n(plan.maxBoostDb, 6), VOCAL_RIDING_RANGES.boostCutDb.min, VOCAL_RIDING_RANGES.boostCutDb.max),
    maxCutDb: clamp(n(plan.maxCutDb, 6), VOCAL_RIDING_RANGES.boostCutDb.min, VOCAL_RIDING_RANGES.boostCutDb.max),
    responseMs: clamp(n(plan.responseMs, 300), VOCAL_RIDING_RANGES.responseMs.min, VOCAL_RIDING_RANGES.responseMs.max),
  };
}
