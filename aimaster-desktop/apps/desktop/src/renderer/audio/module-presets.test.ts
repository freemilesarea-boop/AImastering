import { describe, it, expect } from 'vitest';
import { MODULE_PRESETS, getModulePreset } from './module-presets.js';
import { isMultibandUnity } from './multiband-config.js';
import { isImagerMultibandUnity } from './imager-config.js';
import { isSaturationUnity } from './saturation-config.js';
import { isTransientUnity } from './transient-config.js';
import { isDynamicEqUnity } from './dyneq-config.js';

describe('module-presets', () => {
  it('every preset builds a complete, finite config set', () => {
    for (const p of MODULE_PRESETS) {
      const c = p.build();
      expect(c.multiband.bands).toHaveLength(4);
      expect(c.imagerMultiband.widthsPct).toHaveLength(4);
      expect(['warm', 'tape', 'tube', 'modern']).toContain(c.saturation.character);
      expect(c.transient.bands).toHaveLength(4);
      expect(Array.isArray(c.dynamicEq.bands)).toBe(true);
    }
  });

  it('"off" preset bypasses every module', () => {
    const c = getModulePreset('off')!.build();
    expect(isMultibandUnity(c.multiband)).toBe(true);
    expect(isImagerMultibandUnity(c.imagerMultiband)).toBe(true);
    expect(isSaturationUnity(c.saturation)).toBe(true);
    expect(isTransientUnity(c.transient)).toBe(true);
    expect(isDynamicEqUnity(c.dynamicEq)).toBe(true);
  });

  it('Punchy engages the transient + multiband', () => {
    const c = getModulePreset('punchy')!.build();
    expect(isTransientUnity(c.transient)).toBe(false);
    expect(isMultibandUnity(c.multiband)).toBe(false);
  });

  it('Wide engages the imager', () => {
    const c = getModulePreset('wide')!.build();
    expect(isImagerMultibandUnity(c.imagerMultiband)).toBe(false);
    expect(c.imagerMultiband.widthsPct[0]).toBe(0); // lows mono
  });

  it('Warm engages saturation (tube) + a dynamic-EQ band', () => {
    const c = getModulePreset('warm')!.build();
    expect(c.saturation.character).toBe('tube');
    expect(isSaturationUnity(c.saturation)).toBe(false);
    expect(isDynamicEqUnity(c.dynamicEq)).toBe(false);
  });

  it('Clean adds a de-ess dynamic-EQ band', () => {
    const c = getModulePreset('clean')!.build();
    expect(c.dynamicEq.bands.length).toBeGreaterThan(0);
    expect(c.dynamicEq.bands[0]!.mode).toBe('downcut');
  });

  it('build() returns fresh dynamic-EQ band ids each call', () => {
    const a = getModulePreset('clean')!.build();
    const b = getModulePreset('clean')!.build();
    if (a.dynamicEq.bands[0] && b.dynamicEq.bands[0]) {
      expect(a.dynamicEq.bands[0].id).not.toBe(b.dynamicEq.bands[0].id);
    }
  });
});
