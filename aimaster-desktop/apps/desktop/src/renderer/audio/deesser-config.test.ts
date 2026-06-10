import { describe, it, expect } from 'vitest';
import {
  defaultDeesserConfig, sanitizeDeesser, isDeesserActive, deesserToDynEqBand,
  combineDynamicEqWithDeesser, DEESS_RANGES, type DeesserConfig,
} from './deesser-config.js';
import { defaultDynamicEqConfig, defaultDynEqBand, type DynamicEqConfig } from './dyneq-config.js';

const onDeess = (over: Partial<DeesserConfig> = {}): DeesserConfig => ({ ...defaultDeesserConfig(), enabled: true, ...over });

describe('deesser-config', () => {
  it('default is disabled (inactive)', () => {
    expect(isDeesserActive(defaultDeesserConfig())).toBe(false);
  });

  it('sanitize clamps freq/threshold/range/q', () => {
    const c = sanitizeDeesser(onDeess({ freqHz: 99999, rangeDb: 99, q: 99 }));
    expect(c.freqHz).toBe(DEESS_RANGES.freqHz.max);
    expect(c.rangeDb).toBe(DEESS_RANGES.rangeDb.max);
    expect(c.q).toBe(DEESS_RANGES.q.max);
  });

  it('deesserToDynEqBand → a fast downcut band, or null when inactive', () => {
    expect(deesserToDynEqBand(defaultDeesserConfig())).toBeNull();
    expect(deesserToDynEqBand(onDeess({ rangeDb: 0 }))).toBeNull();
    const b = deesserToDynEqBand(onDeess({ freqHz: 7000 }))!;
    expect(b.mode).toBe('downcut');
    expect(b.freqHz).toBe(7000);
    expect(b.attackMs).toBeLessThanOrEqual(2); // fast
  });

  it('combine appends the de-ess band to user bands (capped 6)', () => {
    const dyn: DynamicEqConfig = { bypass: false, bands: [defaultDynEqBand(200), defaultDynEqBand(500)] };
    const c = combineDynamicEqWithDeesser(dyn, onDeess());
    expect(c.bypass).toBe(false);
    expect(c.bands).toHaveLength(3); // 2 user + 1 de-ess
    expect(c.bands[2]!.mode).toBe('downcut');
  });

  it('combine drops user bands when their dynamic EQ is bypassed, keeps de-ess', () => {
    const dyn: DynamicEqConfig = { bypass: true, bands: [defaultDynEqBand(200)] };
    const c = combineDynamicEqWithDeesser(dyn, onDeess());
    expect(c.bands).toHaveLength(1);
  });

  it('combine of two inactive → bypassed', () => {
    const c = combineDynamicEqWithDeesser(defaultDynamicEqConfig(), defaultDeesserConfig());
    expect(c.bypass).toBe(true);
    expect(c.bands).toHaveLength(0);
  });
});
