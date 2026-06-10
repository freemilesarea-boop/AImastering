// section-mastering — per-section gain automation for the offline render (P2).
//
// "Section-based mastering": lift the chorus, tame the bridge, etc.  The plan is
// a list of time ranges (from the section analyzer) each with a gain offset; we
// synthesize a smooth, per-sample gain envelope (raised-cosine crossfades at the
// boundaries so transitions are inaudible) and multiply it into the signal
// BEFORE the mastering chain — so the compressor/limiter/loudnorm glue the
// re-balanced sections together.
//
// Honest scope: this is gain automation, not a per-section re-master of the full
// chain (the chain carries stateful dynamics that don't segment cleanly).  It is
// the tractable, deterministic, headless-testable core of section mastering.
//
// Pure (no I/O); the envelope + apply are fully unit-tested.

import type { SectionMasteringPlan, SectionGain } from '@aimaster/shared-types';

const db2lin = (db: number): number => Math.pow(10, db / 20);
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export const SECTION_GAIN_RANGE = { min: -12, max: 12 } as const;
export const DEFAULT_CROSSFADE_MS = 120;

/** True when the plan would not change the signal (disabled or all gains 0). */
export function isSectionPlanUnity(plan: SectionMasteringPlan | undefined | null): boolean {
  if (!plan || !plan.enabled || plan.gains.length === 0) return true;
  return plan.gains.every((g) => g.gainDb === 0);
}

/** Defensive clamp of an untrusted plan (ranges + ordering-safe). */
export function sanitizeSectionPlan(plan: SectionMasteringPlan): SectionMasteringPlan {
  const gains: SectionGain[] = (plan.gains ?? [])
    .filter((g) => Number.isFinite(g.startSec) && Number.isFinite(g.endSec) && g.endSec > g.startSec)
    .map((g) => ({
      startSec: Math.max(0, g.startSec),
      endSec: Math.max(g.startSec, g.endSec),
      gainDb: clamp(Number.isFinite(g.gainDb) ? g.gainDb : 0, SECTION_GAIN_RANGE.min, SECTION_GAIN_RANGE.max),
    }));
  return {
    enabled: !!plan.enabled,
    crossfadeMs: clamp(Number.isFinite(plan.crossfadeMs) ? plan.crossfadeMs : DEFAULT_CROSSFADE_MS, 0, 2000),
    gains,
  };
}

/**
 * Synthesize a per-sample LINEAR gain envelope (length `totalSamples`).  Samples
 * inside a section take that section's gain; gaps are unity (1.0); section
 * boundaries are raised-cosine crossfaded over `crossfadeMs`.  Always returns a
 * valid envelope — an empty/unity plan yields all-1.0.
 */
export function synthesizeGainEnvelope(
  plan: SectionMasteringPlan,
  sampleRate: number,
  totalSamples: number,
): Float32Array {
  const env = new Float32Array(totalSamples).fill(1);
  if (isSectionPlanUnity(plan)) return env;

  // Piecewise-constant target gain (linear) per sample: section gain or unity.
  for (const g of plan.gains) {
    const lin = db2lin(g.gainDb);
    const s0 = clamp(Math.round(g.startSec * sampleRate), 0, totalSamples);
    const s1 = clamp(Math.round(g.endSec * sampleRate), 0, totalSamples);
    for (let i = s0; i < s1; i++) env[i] = lin;
  }

  // Raised-cosine crossfade across each value transition.
  const half = Math.max(0, Math.floor((plan.crossfadeMs / 1000) * sampleRate / 2));
  if (half === 0) return env;

  // Collect transitions first (so smoothing one doesn't perturb detection of the next).
  const transitions: Array<{ at: number; from: number; to: number }> = [];
  for (let i = 1; i < totalSamples; i++) {
    if (env[i] !== env[i - 1]) transitions.push({ at: i, from: env[i - 1]!, to: env[i]! });
  }
  const smoothed = Float32Array.from(env);
  for (const t of transitions) {
    const lo = Math.max(0, t.at - half);
    const hi = Math.min(totalSamples, t.at + half);
    const span = hi - lo;
    if (span <= 0) continue;
    for (let i = lo; i < hi; i++) {
      const x = (i - lo) / span; // 0..1
      const w = 0.5 - 0.5 * Math.cos(Math.PI * x); // raised cosine 0→1
      smoothed[i] = t.from + (t.to - t.from) * w;
    }
  }
  return smoothed;
}

/** Multiply a gain envelope into stereo buffers (new arrays).  Pure. */
export function applyGainEnvelope(
  left: Float32Array,
  right: Float32Array,
  env: Float32Array,
): { left: Float32Array; right: Float32Array } {
  const n = Math.min(left.length, right.length, env.length);
  const outL = Float32Array.from(left);
  const outR = Float32Array.from(right);
  for (let i = 0; i < n; i++) { outL[i]! *= env[i]!; outR[i]! *= env[i]!; }
  return { left: outL, right: outR };
}

/** Apply a section plan to a stereo buffer (no-op when unity).  Pure. */
export function applySectionPlan(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  plan: SectionMasteringPlan,
): { left: Float32Array; right: Float32Array; applied: boolean } {
  const clean = sanitizeSectionPlan(plan);
  if (isSectionPlanUnity(clean)) return { left, right, applied: false };
  const env = synthesizeGainEnvelope(clean, sampleRate, Math.min(left.length, right.length));
  const out = applyGainEnvelope(left, right, env);
  return { ...out, applied: true };
}
