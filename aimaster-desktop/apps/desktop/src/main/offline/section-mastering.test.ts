import { describe, it, expect } from 'vitest';
import {
  synthesizeGainEnvelope, applyGainEnvelope, applySectionPlan,
  isSectionPlanUnity, sanitizeSectionPlan, SECTION_GAIN_RANGE,
} from './section-mastering.js';
import type { SectionMasteringPlan } from '@aimaster/shared-types';

const SR = 1000; // 1 kHz keeps sample math easy in tests

const plan = (over: Partial<SectionMasteringPlan> = {}): SectionMasteringPlan => ({
  enabled: true, crossfadeMs: 0, gains: [], ...over,
});

describe('isSectionPlanUnity', () => {
  it('true when disabled, empty, or all-zero gains', () => {
    expect(isSectionPlanUnity(undefined)).toBe(true);
    expect(isSectionPlanUnity(plan({ enabled: false, gains: [{ startSec: 0, endSec: 1, gainDb: 6 }] }))).toBe(true);
    expect(isSectionPlanUnity(plan({ gains: [] }))).toBe(true);
    expect(isSectionPlanUnity(plan({ gains: [{ startSec: 0, endSec: 1, gainDb: 0 }] }))).toBe(true);
  });
  it('false with a non-zero gain', () => {
    expect(isSectionPlanUnity(plan({ gains: [{ startSec: 0, endSec: 1, gainDb: 3 }] }))).toBe(false);
  });
});

describe('synthesizeGainEnvelope', () => {
  it('unity plan → all 1.0, correct length', () => {
    const env = synthesizeGainEnvelope(plan({ gains: [] }), SR, 500);
    expect(env.length).toBe(500);
    expect(Array.from(env).every((v) => v === 1)).toBe(true);
  });

  it('section interior takes the section gain; gaps stay unity', () => {
    // +6 dB over [1s, 2s) of a 3s buffer, no crossfade.
    const env = synthesizeGainEnvelope(plan({ crossfadeMs: 0, gains: [{ startSec: 1, endSec: 2, gainDb: 6 }] }), SR, 3 * SR);
    expect(env[500]!).toBeCloseTo(1, 6);            // before section (gap)
    expect(env[1500]!).toBeCloseTo(Math.pow(10, 6 / 20), 5); // interior
    expect(env[2500]!).toBeCloseTo(1, 6);            // after section (gap)
  });

  it('crossfade makes the boundary continuous (no hard jump)', () => {
    const env = synthesizeGainEnvelope(plan({ crossfadeMs: 100, gains: [{ startSec: 1, endSec: 2, gainDb: 12 }] }), SR, 3 * SR);
    let maxStep = 0;
    for (let i = 1; i < env.length; i++) maxStep = Math.max(maxStep, Math.abs(env[i]! - env[i - 1]!));
    // Without smoothing the jump would be ~|3.98−1|; the crossfade keeps each
    // step small.
    expect(maxStep).toBeLessThan(0.1);
  });

  it('adjacent sections ramp from one gain to the next', () => {
    const env = synthesizeGainEnvelope(plan({
      crossfadeMs: 100,
      gains: [{ startSec: 0, endSec: 1, gainDb: -6 }, { startSec: 1, endSec: 2, gainDb: 6 }],
    }), SR, 2 * SR);
    const lo = Math.pow(10, -6 / 20), hi = Math.pow(10, 6 / 20);
    expect(env[500]!).toBeCloseTo(lo, 4);   // first section interior
    expect(env[1500]!).toBeCloseTo(hi, 4);  // second section interior
    expect(env[1000]!).toBeGreaterThan(lo); // boundary is mid-ramp
    expect(env[1000]!).toBeLessThan(hi);
  });
});

describe('applyGainEnvelope / applySectionPlan', () => {
  it('applyGainEnvelope multiplies per sample', () => {
    const L = Float32Array.from([1, 1, 1, 1]);
    const R = Float32Array.from([2, 2, 2, 2]);
    const env = Float32Array.from([1, 0.5, 2, 1]);
    const out = applyGainEnvelope(L, R, env);
    expect(Array.from(out.left)).toEqual([1, 0.5, 2, 1]);
    expect(Array.from(out.right)).toEqual([2, 1, 4, 2]);
  });

  it('applySectionPlan is a no-op (applied=false) when unity', () => {
    const L = Float32Array.from([1, 2, 3]);
    const r = applySectionPlan(L, L, SR, plan({ enabled: false, gains: [{ startSec: 0, endSec: 1, gainDb: 6 }] }));
    expect(r.applied).toBe(false);
    expect(r.left).toBe(L);
  });

  it('applySectionPlan boosts the targeted section', () => {
    const n = 3 * SR;
    const L = new Float32Array(n).fill(0.1);
    const r = applySectionPlan(L, L, SR, plan({ crossfadeMs: 0, gains: [{ startSec: 1, endSec: 2, gainDb: 6 }] }));
    expect(r.applied).toBe(true);
    expect(r.left[1500]!).toBeCloseTo(0.1 * Math.pow(10, 6 / 20), 5);
    expect(r.left[500]!).toBeCloseTo(0.1, 6);
  });
});

describe('sanitizeSectionPlan', () => {
  it('clamps gains and drops invalid ranges', () => {
    const s = sanitizeSectionPlan(plan({
      crossfadeMs: 99999,
      gains: [
        { startSec: 0, endSec: 1, gainDb: 99 },     // clamp gain
        { startSec: 2, endSec: 1, gainDb: 0 },       // end<=start → dropped
        { startSec: -5, endSec: 3, gainDb: -99 },    // clamp start + gain
      ],
    }));
    expect(s.gains).toHaveLength(2);
    expect(s.gains[0]!.gainDb).toBe(SECTION_GAIN_RANGE.max);
    expect(s.gains[1]!.startSec).toBe(0);
    expect(s.gains[1]!.gainDb).toBe(SECTION_GAIN_RANGE.min);
    expect(s.crossfadeMs).toBeLessThanOrEqual(2000);
  });
});
