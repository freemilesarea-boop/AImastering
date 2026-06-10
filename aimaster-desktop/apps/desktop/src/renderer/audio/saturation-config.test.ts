import { describe, it, expect } from 'vitest';
import {
  defaultSaturationConfig, sanitizeSaturation, isSaturationUnity, packSaturationBandDrives,
  shapeSample, saturateSample, makeSaturationCurve, CHARACTER_CODE, SAT_RANGES,
  type SaturationConfig,
} from './saturation-config.js';

const active = (over: Partial<SaturationConfig> = {}): SaturationConfig =>
  ({ ...defaultSaturationConfig(), bypass: false, drive: 60, ...over });

describe('saturation-config', () => {
  it('default is bypassed + unity', () => {
    const c = defaultSaturationConfig();
    expect(c.bypass).toBe(true);
    expect(isSaturationUnity(c)).toBe(true);
    expect(CHARACTER_CODE[c.character]).toBe(1); // tape
  });

  it('isUnity: bypass / drive 0 / mix 0 / all band drives 0', () => {
    expect(isSaturationUnity(active({ drive: 0 }))).toBe(true);
    expect(isSaturationUnity(active({ mixPct: 0 }))).toBe(true);
    expect(isSaturationUnity(active())).toBe(false);
    expect(isSaturationUnity(active({ multibandEnabled: true, bandDrivesPct: [0, 0, 0, 0] }))).toBe(true);
  });

  it('sanitize clamps drive/mix/band + orders crossovers', () => {
    const c = sanitizeSaturation(active({ drive: 999, mixPct: -5, bandDrivesPct: [-9, 999, 100, 100], xoverLoHz: 9000, xoverMidHz: 200, xoverHiHz: 100 }));
    expect(c.drive).toBe(SAT_RANGES.drive.max);
    expect(c.mixPct).toBe(SAT_RANGES.mixPct.min);
    expect(c.bandDrivesPct[0]).toBe(0);
    expect(c.bandDrivesPct[1]).toBe(SAT_RANGES.bandDrivePct.max);
    expect(c.xoverLoHz).toBeLessThan(c.xoverMidHz);
    expect(c.xoverMidHz).toBeLessThan(c.xoverHiHz);
  });

  it('shapeSample has ~unit slope at origin for every character', () => {
    const dx = 1e-4;
    for (const ch of ['warm', 'tape', 'tube', 'modern'] as const) {
      const slope = (shapeSample(ch, dx) - shapeSample(ch, -dx)) / (2 * dx);
      expect(Math.abs(slope - 1)).toBeLessThan(0.01);
    }
  });

  it('saturateSample: drive 0 → passthrough; high drive soft-clips a loud sample', () => {
    expect(saturateSample('tape', 0.7, 0)).toBeCloseTo(0.7, 9);
    const out = saturateSample('tape', 0.95, 100);
    expect(Math.abs(out)).toBeLessThan(0.95);
  });

  it('makeSaturationCurve returns the requested length and is bounded', () => {
    const curve = makeSaturationCurve('modern', 80, 512);
    expect(curve).toHaveLength(512);
    expect(Array.from(curve).every((v) => Number.isFinite(v) && Math.abs(v) <= 1.5)).toBe(true);
  });

  it('packSaturationBandDrives → Float64Array of 4', () => {
    const p = packSaturationBandDrives(active({ bandDrivesPct: [0, 50, 150, 200] }));
    expect(p).toBeInstanceOf(Float64Array);
    expect(Array.from(p)).toEqual([0, 50, 150, 200]);
  });
});
