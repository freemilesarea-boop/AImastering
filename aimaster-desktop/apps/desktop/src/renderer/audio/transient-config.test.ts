import { describe, it, expect } from 'vitest';
import {
  defaultTransientConfig, sanitizeTransient, isTransientUnity, packTransientBands,
  TR_RANGES, type TransientConfig,
} from './transient-config.js';

describe('transient-config', () => {
  it('default is bypassed + unity', () => {
    const c = defaultTransientConfig();
    expect(c.bypass).toBe(true);
    expect(isTransientUnity(c)).toBe(true);
    expect(c.bands).toHaveLength(4);
  });

  it('isUnity: bypass / 0 amounts / all-zero bands', () => {
    expect(isTransientUnity({ ...defaultTransientConfig(), bypass: false })).toBe(true);
    expect(isTransientUnity({ ...defaultTransientConfig(), bypass: false, attackPct: 50 })).toBe(false);
    const mb: TransientConfig = { ...defaultTransientConfig(), bypass: false, multibandEnabled: true };
    expect(isTransientUnity(mb)).toBe(true);
    mb.bands[1] = { attackPct: 30, sustainPct: 0 };
    expect(isTransientUnity(mb)).toBe(false);
  });

  it('sanitize clamps amounts to [-100,100] + orders crossovers', () => {
    const c = sanitizeTransient({ ...defaultTransientConfig(), attackPct: 999, sustainPct: -999, xoverLoHz: 9000, xoverMidHz: 200, xoverHiHz: 100 });
    expect(c.attackPct).toBe(TR_RANGES.amountPct.max);
    expect(c.sustainPct).toBe(TR_RANGES.amountPct.min);
    expect(c.xoverLoHz).toBeLessThan(c.xoverMidHz);
    expect(c.xoverMidHz).toBeLessThan(c.xoverHiHz);
  });

  it('packTransientBands → two Float64Arrays of 4 in band order', () => {
    const cfg: TransientConfig = {
      ...defaultTransientConfig(), bypass: false, multibandEnabled: true,
      bands: [
        { attackPct: 10, sustainPct: -10 },
        { attackPct: 20, sustainPct: -20 },
        { attackPct: 30, sustainPct: -30 },
        { attackPct: 40, sustainPct: -40 },
      ],
    };
    const p = packTransientBands(cfg);
    expect(Array.from(p.attacks)).toEqual([10, 20, 30, 40]);
    expect(Array.from(p.sustains)).toEqual([-10, -20, -30, -40]);
  });
});
