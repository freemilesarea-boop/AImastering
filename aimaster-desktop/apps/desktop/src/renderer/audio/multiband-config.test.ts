import { describe, it, expect } from 'vitest';
import {
  defaultMultibandConfig, sanitizeMultiband, isMultibandUnity, packMultibandArrays,
  MB_RANGES, type MultibandConfig,
} from './multiband-config.js';

describe('multiband-config', () => {
  it('default is bypassed + unity (no-op)', () => {
    const cfg = defaultMultibandConfig();
    expect(cfg.bypass).toBe(true);
    expect(isMultibandUnity(cfg)).toBe(true);
    expect(cfg.bands).toHaveLength(4);
  });

  it('sanitize clamps band fields into range', () => {
    const cfg: MultibandConfig = {
      ...defaultMultibandConfig(),
      bypass: false,
      bands: [
        { thresholdDb: -999, ratio: 99, attackMs: 0, releaseMs: 99999, makeupDb: 99 },
        ...defaultMultibandConfig().bands.slice(1),
      ] as MultibandConfig['bands'],
    };
    const s = sanitizeMultiband(cfg);
    expect(s.bands[0]!.thresholdDb).toBe(MB_RANGES.thresholdDb.min);
    expect(s.bands[0]!.ratio).toBe(MB_RANGES.ratio.max);
    expect(s.bands[0]!.attackMs).toBe(MB_RANGES.attackMs.min);
    expect(s.bands[0]!.releaseMs).toBe(MB_RANGES.releaseMs.max);
    expect(s.bands[0]!.makeupDb).toBe(MB_RANGES.makeupDb.max);
  });

  it('sanitize forces ascending crossovers', () => {
    const cfg: MultibandConfig = { ...defaultMultibandConfig(), xoverLoHz: 400, xoverMidHz: 300, xoverHiHz: 250 };
    const s = sanitizeMultiband(cfg);
    expect(s.xoverLoHz).toBeLessThan(s.xoverMidHz);
    expect(s.xoverMidHz).toBeLessThan(s.xoverHiHz);
  });

  it('isMultibandUnity: bypass OR all unity bands', () => {
    const active: MultibandConfig = {
      ...defaultMultibandConfig(), bypass: false,
      bands: defaultMultibandConfig().bands.map((b) => ({ ...b, ratio: 3 })) as MultibandConfig['bands'],
    };
    expect(isMultibandUnity(active)).toBe(false);
    expect(isMultibandUnity({ ...active, bypass: true })).toBe(true);
  });

  it('packMultibandArrays produces 4-length parallel Float64Arrays in band order', () => {
    const cfg: MultibandConfig = {
      ...defaultMultibandConfig(), bypass: false,
      bands: [
        { thresholdDb: -10, ratio: 2, attackMs: 5, releaseMs: 100, makeupDb: 1 },
        { thresholdDb: -20, ratio: 3, attackMs: 10, releaseMs: 120, makeupDb: 2 },
        { thresholdDb: -30, ratio: 4, attackMs: 15, releaseMs: 140, makeupDb: 3 },
        { thresholdDb: -40, ratio: 5, attackMs: 20, releaseMs: 160, makeupDb: 4 },
      ],
    };
    const p = packMultibandArrays(cfg);
    expect(Array.from(p.thresholds)).toEqual([-10, -20, -30, -40]);
    expect(Array.from(p.ratios)).toEqual([2, 3, 4, 5]);
    expect(Array.from(p.makeups)).toEqual([1, 2, 3, 4]);
    expect(p.attacks).toBeInstanceOf(Float64Array);
    expect(p.releases).toHaveLength(4);
  });
});
