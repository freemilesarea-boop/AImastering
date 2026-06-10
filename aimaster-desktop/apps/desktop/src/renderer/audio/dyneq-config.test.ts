import { describe, it, expect } from 'vitest';
import {
  defaultDynamicEqConfig, defaultDynEqBand, sanitizeDynamicEq, isDynamicEqUnity, packDynamicEq,
  FILTER_CODE, MODE_CODE, MAX_DYNEQ_BANDS, DYNEQ_RANGES, type DynamicEqConfig,
} from './dyneq-config.js';

describe('dyneq-config', () => {
  it('default is bypassed + unity with no bands', () => {
    const c = defaultDynamicEqConfig();
    expect(c.bypass).toBe(true);
    expect(c.bands).toHaveLength(0);
    expect(isDynamicEqUnity(c)).toBe(true);
  });

  it('isUnity: bypass / disabled bands / range 0', () => {
    const active: DynamicEqConfig = { bypass: false, bands: [defaultDynEqBand(1000)] };
    expect(isDynamicEqUnity(active)).toBe(false);
    expect(isDynamicEqUnity({ ...active, bypass: true })).toBe(true);
    expect(isDynamicEqUnity({ bypass: false, bands: [{ ...defaultDynEqBand(1000), enabled: false }] })).toBe(true);
    expect(isDynamicEqUnity({ bypass: false, bands: [{ ...defaultDynEqBand(1000), rangeDb: 0 }] })).toBe(true);
  });

  it('sanitize clamps band fields + caps to MAX_DYNEQ_BANDS', () => {
    const many = sanitizeDynamicEq({ bypass: false, bands: Array.from({ length: MAX_DYNEQ_BANDS + 3 }, () => defaultDynEqBand(1000)) });
    expect(many.bands).toHaveLength(MAX_DYNEQ_BANDS);
    const c = sanitizeDynamicEq({ bypass: false, bands: [{ ...defaultDynEqBand(1000), freqHz: 99999, q: 99, rangeDb: 99 }] });
    expect(c.bands[0]!.freqHz).toBe(DYNEQ_RANGES.freqHz.max);
    expect(c.bands[0]!.q).toBe(DYNEQ_RANGES.q.max);
    expect(c.bands[0]!.rangeDb).toBe(DYNEQ_RANGES.rangeDb.max);
  });

  it('packDynamicEq produces parallel arrays with type/mode codes', () => {
    const cfg: DynamicEqConfig = {
      bypass: false,
      bands: [
        { ...defaultDynEqBand(80), filterType: 'lowshelf', mode: 'upboost', freqHz: 80 },
        { ...defaultDynEqBand(8000), filterType: 'highshelf', mode: 'downcut', freqHz: 8000 },
      ],
    };
    const p = packDynamicEq(cfg);
    expect(Array.from(p.types)).toEqual([FILTER_CODE.lowshelf, FILTER_CODE.highshelf]);
    expect(Array.from(p.modes)).toEqual([MODE_CODE.upboost, MODE_CODE.downcut]);
    expect(Array.from(p.freqs)).toEqual([80, 8000]);
    expect(p.enableds).toBeInstanceOf(Uint8Array);
    expect(p.thresholds).toHaveLength(2);
  });
});
