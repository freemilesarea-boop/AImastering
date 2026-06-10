import { describe, it, expect } from 'vitest';
import {
  defaultRebalanceConfig,
  sanitizeRebalance,
  isApproxRebalanceUnity,
  isPreciseRebalanceActive,
  remixStems,
  REBAL_RANGES,
  STEMS,
  type RebalanceConfig,
  type StereoStems,
} from './rebalance-config.js';

describe('rebalance-config', () => {
  it('default config is approximation-unity and precise-inactive', () => {
    const d = defaultRebalanceConfig();
    expect(isApproxRebalanceUnity(d)).toBe(true);
    expect(isPreciseRebalanceActive(d)).toBe(false);
    expect(d.sidePct).toBe(100);
  });

  it('sanitize clamps out-of-range values to the declared ranges', () => {
    const dirty: RebalanceConfig = {
      vocalDb: 999, bassDb: -999, sidePct: 500,
      stemGainsDb: { vocals: 99, drums: -99, bass: 0, other: NaN as unknown as number },
      preciseEnabled: true,
    };
    const c = sanitizeRebalance(dirty);
    expect(c.vocalDb).toBe(REBAL_RANGES.vocalDb.max);
    expect(c.bassDb).toBe(REBAL_RANGES.bassDb.min);
    expect(c.sidePct).toBe(REBAL_RANGES.sidePct.max);
    expect(c.stemGainsDb.vocals).toBe(REBAL_RANGES.stemDb.max);
    expect(c.stemGainsDb.drums).toBe(REBAL_RANGES.stemDb.min);
    expect(c.stemGainsDb.other).toBe(0); // NaN → fallback 0
  });

  it('isApproxRebalanceUnity is false when any approximation control moves', () => {
    const base = defaultRebalanceConfig();
    expect(isApproxRebalanceUnity({ ...base, vocalDb: 3 })).toBe(false);
    expect(isApproxRebalanceUnity({ ...base, bassDb: -2 })).toBe(false);
    expect(isApproxRebalanceUnity({ ...base, sidePct: 130 })).toBe(false);
  });

  it('isPreciseRebalanceActive requires both the flag and a non-zero stem gain', () => {
    const base = defaultRebalanceConfig();
    expect(isPreciseRebalanceActive({ ...base, preciseEnabled: true })).toBe(false);
    expect(isPreciseRebalanceActive({ ...base, stemGainsDb: { ...base.stemGainsDb, vocals: 3 } })).toBe(false);
    expect(isPreciseRebalanceActive({ ...base, preciseEnabled: true, stemGainsDb: { ...base.stemGainsDb, vocals: 3 } })).toBe(true);
  });

  it('remixStems at 0 dB reconstructs the stem sum (Demucs stems sum to mix)', () => {
    const mk = (a: number[]) => ({ left: Float32Array.from(a), right: Float32Array.from(a.map((x) => x * 0.5)) });
    const stems: StereoStems = {
      vocals: mk([0.1, 0.2, -0.3]),
      drums: mk([0.05, -0.1, 0.2]),
      bass: mk([-0.2, 0.0, 0.1]),
      other: mk([0.0, 0.3, -0.05]),
    };
    const out = remixStems(stems, { vocals: 0, drums: 0, bass: 0, other: 0 });
    for (let i = 0; i < 3; i++) {
      const sumL = STEMS.reduce((acc, s) => acc + stems[s].left[i]!, 0);
      const sumR = STEMS.reduce((acc, s) => acc + stems[s].right[i]!, 0);
      expect(out.left[i]!).toBeCloseTo(sumL, 6);
      expect(out.right[i]!).toBeCloseTo(sumR, 6);
    }
  });

  it('remixStems applies per-stem gain in dB (+6 dB ≈ ×2)', () => {
    const mk = (v: number) => ({ left: Float32Array.from([v]), right: Float32Array.from([v]) });
    const stems: StereoStems = { vocals: mk(0.1), drums: mk(0), bass: mk(0), other: mk(0) };
    const out = remixStems(stems, { vocals: 6.0206, drums: 0, bass: 0, other: 0 });
    expect(out.left[0]!).toBeCloseTo(0.2, 3);
  });

  it('remixStems can mute a stem at the floor gain', () => {
    const mk = (v: number) => ({ left: Float32Array.from([v]), right: Float32Array.from([v]) });
    const stems: StereoStems = { vocals: mk(0.5), drums: mk(0.5), bass: mk(0), other: mk(0) };
    // -24 dB ≈ 0.063 → drums nearly removed
    const out = remixStems(stems, { vocals: 0, drums: -24, bass: 0, other: 0 });
    expect(out.left[0]!).toBeCloseTo(0.5 + 0.5 * Math.pow(10, -24 / 20), 4);
  });
});
