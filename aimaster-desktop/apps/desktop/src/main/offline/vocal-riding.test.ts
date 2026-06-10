import { describe, it, expect } from 'vitest';
import {
  vocalBandEnvelope, computeRidingGain, applyVocalRiding,
  isVocalRidingUnity, sanitizeVocalRiding, VOCAL_RIDING_RANGES,
} from './vocal-riding.js';
import type { VocalRidingPlan } from '@aimaster/shared-types';

const SR = 48000;

const plan = (over: Partial<VocalRidingPlan> = {}): VocalRidingPlan => ({
  enabled: true, amount: 1, maxBoostDb: 6, maxCutDb: 6, responseMs: 200, ...over,
});

const tone = (n: number, freq: number, amp = 0.3): Float32Array =>
  Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * freq * i) / SR));

describe('isVocalRidingUnity', () => {
  it('true when disabled or amount 0', () => {
    expect(isVocalRidingUnity(undefined)).toBe(true);
    expect(isVocalRidingUnity(plan({ enabled: false }))).toBe(true);
    expect(isVocalRidingUnity(plan({ amount: 0 }))).toBe(true);
    expect(isVocalRidingUnity(plan())).toBe(false);
  });
});

describe('vocalBandEnvelope', () => {
  it('responds more to an in-band (vocal) tone than to sub-bass', () => {
    const n = SR; // 1 s
    const inBand = vocalBandEnvelope(tone(n, 1000), SR);
    const subBass = vocalBandEnvelope(tone(n, 50), SR);
    const avg = (a: Float32Array) => a.subarray(SR / 2).reduce((s, v) => s + v, 0) / (SR / 2);
    expect(avg(inBand)).toBeGreaterThan(avg(subBass) * 2);
  });
});

describe('computeRidingGain', () => {
  it('boosts the quiet region and cuts the loud region, within clamps', () => {
    const n = SR * 2;
    // First half quiet, second half loud (in-band tone).
    const mid = new Float32Array(n);
    const q = tone(SR, 1000, 0.05);
    const loud = tone(SR, 1000, 0.5);
    mid.set(q, 0); mid.set(loud, SR);
    const env = vocalBandEnvelope(mid, SR);
    const gain = computeRidingGain(env, SR, plan({ responseMs: 100 }));
    const at = (i: number) => gain[i]!;
    expect(at(SR * 0.75)).toBeGreaterThan(1);  // quiet → boosted
    expect(at(SR * 1.75)).toBeLessThan(1);      // loud → cut
    const maxBoost = Math.pow(10, 6 / 20), maxCut = Math.pow(10, -6 / 20);
    for (const g of gain) { expect(g).toBeLessThanOrEqual(maxBoost + 1e-3); expect(g).toBeGreaterThanOrEqual(maxCut - 1e-3); }
  });

  it('amount 0 → unity gain everywhere', () => {
    const env = vocalBandEnvelope(tone(SR, 1000), SR);
    const gain = computeRidingGain(env, SR, plan({ amount: 0 }));
    for (const g of gain) expect(g).toBeCloseTo(1, 6);
  });

  it('the riding gain is smooth (no large per-sample steps)', () => {
    const n = SR;
    const mid = new Float32Array(n);
    mid.set(tone(SR / 2, 1000, 0.05), 0);
    mid.set(tone(SR / 2, 1000, 0.5), SR / 2); // abrupt level jump
    const gain = computeRidingGain(vocalBandEnvelope(mid, SR), SR, plan({ responseMs: 300 }));
    let maxStep = 0;
    for (let i = 1; i < gain.length; i++) maxStep = Math.max(maxStep, Math.abs(gain[i]! - gain[i - 1]!));
    expect(maxStep).toBeLessThan(0.02);
  });
});

describe('applyVocalRiding', () => {
  it('no-op (applied=false) when unity', () => {
    const L = tone(128, 1000);
    const r = applyVocalRiding(L, L, SR, plan({ enabled: false }));
    expect(r.applied).toBe(false);
    expect(r.left).toBe(L);
  });

  it('preserves the side signal exactly (L′−R′ = L−R)', () => {
    const n = SR;
    const L = tone(n, 1000, 0.3);
    const R = tone(n, 1000, 0.3).map((v, i) => v + 0.1 * Math.sin((2 * Math.PI * 300 * i) / SR)); // different R → non-zero side
    const r = applyVocalRiding(L, R, SR, plan());
    expect(r.applied).toBe(true);
    for (let i = 0; i < n; i += 257) {
      expect(r.left[i]! - r.right[i]!).toBeCloseTo(L[i]! - R[i]!, 5);
    }
  });

  it('evens out a quiet-then-loud centre vocal', () => {
    const n = SR * 2;
    const L = new Float32Array(n);
    L.set(tone(SR, 1000, 0.05), 0);
    L.set(tone(SR, 1000, 0.5), SR);
    const r = applyVocalRiding(L, L, SR, plan({ responseMs: 150 }));
    // After riding, the loud/quiet ratio should shrink toward 1.
    const rms = (a: Float32Array, lo: number, hi: number) => {
      let s = 0; for (let i = lo; i < hi; i++) s += a[i]! * a[i]!; return Math.sqrt(s / (hi - lo));
    };
    const before = rms(L, SR + SR / 4, SR + SR / 2) / rms(L, SR / 4, SR / 2);
    const after = rms(r.left, SR + SR / 4, SR + SR / 2) / rms(r.left, SR / 4, SR / 2);
    expect(after).toBeLessThan(before);
  });
});

describe('sanitizeVocalRiding', () => {
  it('clamps all fields into range', () => {
    const s = sanitizeVocalRiding({ enabled: true, amount: 5, maxBoostDb: 99, maxCutDb: -3, responseMs: 5 });
    expect(s.amount).toBe(VOCAL_RIDING_RANGES.amount.max);
    expect(s.maxBoostDb).toBe(VOCAL_RIDING_RANGES.boostCutDb.max);
    expect(s.maxCutDb).toBe(VOCAL_RIDING_RANGES.boostCutDb.min);
    expect(s.responseMs).toBe(VOCAL_RIDING_RANGES.responseMs.min);
  });
});
