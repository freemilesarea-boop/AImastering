// section-plan — renderer-side model for per-section gain automation (P2).
//
// Mirrors the detected SectionAnalysis into an editable plan (one gain per
// section).  The actual envelope synthesis + application lives in the main
// process (main/offline/section-mastering.ts); section mastering applies on the
// offline EXPORT, like the precise stem tier — the live preview is unchanged.

import type { SectionMasteringPlan, SectionGain, SectionSegment } from '@aimaster/shared-types';

export const SECTION_GAIN_RANGE = { min: -12, max: 12 } as const;
export const DEFAULT_CROSSFADE_MS = 120;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export function defaultSectionPlan(): SectionMasteringPlan {
  return { enabled: false, crossfadeMs: DEFAULT_CROSSFADE_MS, gains: [] };
}

/** True when the plan would not change the signal (disabled or all gains 0). */
export function isSectionPlanUnity(plan: SectionMasteringPlan | undefined | null): boolean {
  if (!plan || !plan.enabled || plan.gains.length === 0) return true;
  return plan.gains.every((g) => g.gainDb === 0);
}

/** Build an editable (0 dB) plan from the analyzer's detected sections. */
export function buildSectionPlanFromAnalysis(
  sections: SectionSegment[] | undefined | null,
  prev?: SectionMasteringPlan,
): SectionMasteringPlan {
  const list = sections ?? [];
  const gains: SectionGain[] = list
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
    .map((s) => {
      // Preserve a prior gain if the same time range is still present.
      const match = prev?.gains.find((g) => g.startSec === s.start && g.endSec === s.end);
      return { startSec: s.start, endSec: s.end, gainDb: match?.gainDb ?? 0 };
    });
  return {
    enabled: prev?.enabled ?? false,
    crossfadeMs: prev?.crossfadeMs ?? DEFAULT_CROSSFADE_MS,
    gains,
  };
}

export function sanitizeSectionPlan(plan: SectionMasteringPlan): SectionMasteringPlan {
  return {
    enabled: !!plan.enabled,
    crossfadeMs: clamp(Number.isFinite(plan.crossfadeMs) ? plan.crossfadeMs : DEFAULT_CROSSFADE_MS, 0, 2000),
    gains: (plan.gains ?? []).map((g) => ({
      startSec: Math.max(0, g.startSec),
      endSec: Math.max(g.startSec, g.endSec),
      gainDb: clamp(Number.isFinite(g.gainDb) ? g.gainDb : 0, SECTION_GAIN_RANGE.min, SECTION_GAIN_RANGE.max),
    })),
  };
}

/** Set one section's gain by index (returns a new, sanitized plan). */
export function setSectionGain(plan: SectionMasteringPlan, index: number, gainDb: number): SectionMasteringPlan {
  if (index < 0 || index >= plan.gains.length) return plan;
  const gains = plan.gains.map((g, i) => (i === index ? { ...g, gainDb } : g));
  return sanitizeSectionPlan({ ...plan, gains });
}
