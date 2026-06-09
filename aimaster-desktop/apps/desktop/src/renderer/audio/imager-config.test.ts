import { describe, it, expect } from 'vitest';
import {
  defaultImagerMultiband, sanitizeImagerMultiband, isImagerMultibandUnity, packImagerWidths,
  IMG_RANGES, type ImagerMultibandConfig,
} from './imager-config.js';

describe('imager-config', () => {
  it('default is disabled + unity (no-op)', () => {
    const c = defaultImagerMultiband();
    expect(c.enabled).toBe(false);
    expect(isImagerMultibandUnity(c)).toBe(true);
    expect(c.widthsPct).toEqual([100, 100, 100, 100]);
  });

  it('isUnity: disabled OR all widths 100', () => {
    const widened: ImagerMultibandConfig = { ...defaultImagerMultiband(), enabled: true, widthsPct: [0, 100, 100, 200] };
    expect(isImagerMultibandUnity(widened)).toBe(false);
    expect(isImagerMultibandUnity({ ...widened, enabled: false })).toBe(true);
    expect(isImagerMultibandUnity({ ...widened, widthsPct: [100, 100, 100, 100] })).toBe(true);
  });

  it('sanitize clamps widths + orders crossovers', () => {
    const c = sanitizeImagerMultiband({ enabled: true, xoverLoHz: 9000, xoverMidHz: 200, xoverHiHz: 100, widthsPct: [-50, 999, 100, 50] });
    expect(c.widthsPct[0]).toBe(IMG_RANGES.widthPct.min);
    expect(c.widthsPct[1]).toBe(IMG_RANGES.widthPct.max);
    expect(c.xoverLoHz).toBeLessThan(c.xoverMidHz);
    expect(c.xoverMidHz).toBeLessThan(c.xoverHiHz);
  });

  it('packImagerWidths → Float64Array of 4 in band order', () => {
    const p = packImagerWidths({ ...defaultImagerMultiband(), enabled: true, widthsPct: [0, 80, 120, 200] });
    expect(p).toBeInstanceOf(Float64Array);
    expect(Array.from(p)).toEqual([0, 80, 120, 200]);
  });
});
