// module-presets — one-click style presets that configure all 5 Phase-2
// modules (multiband comp / 4-band imager / saturation / transient /
// dynamic EQ) at once.
//
// Each preset's `build()` returns a fresh, sanitised set of the five configs
// (fresh dynamic-EQ band ids per call).  The store's `applyModulePreset`
// writes them into the five module slices in one batch.  "끄기" resets all to
// their bypassed defaults.

import { type MultibandConfig, defaultMultibandConfig, sanitizeMultiband } from './multiband-config.js';
import { type ImagerMultibandConfig, defaultImagerMultiband, sanitizeImagerMultiband } from './imager-config.js';
import { type SaturationConfig, defaultSaturationConfig, sanitizeSaturation } from './saturation-config.js';
import { type TransientConfig, defaultTransientConfig, sanitizeTransient } from './transient-config.js';
import { type DynamicEqConfig, defaultDynamicEqConfig, defaultDynEqBand, sanitizeDynamicEq } from './dyneq-config.js';

export interface ModulePresetConfigs {
  multiband: MultibandConfig;
  imagerMultiband: ImagerMultibandConfig;
  saturation: SaturationConfig;
  transient: TransientConfig;
  dynamicEq: DynamicEqConfig;
}

export interface ModulePreset {
  id: string;
  name: string;
  hint: string;
  build: () => ModulePresetConfigs;
}

// ── builder helpers ────────────────────────────────────────────────────────

function allBypassed(): ModulePresetConfigs {
  return {
    multiband: defaultMultibandConfig(),
    imagerMultiband: defaultImagerMultiband(),
    saturation: defaultSaturationConfig(),
    transient: defaultTransientConfig(),
    dynamicEq: defaultDynamicEqConfig(),
  };
}

function mb(over: Partial<MultibandConfig>): MultibandConfig {
  return sanitizeMultiband({ ...defaultMultibandConfig(), bypass: false, ...over });
}
function sat(over: Partial<SaturationConfig>): SaturationConfig {
  return sanitizeSaturation({ ...defaultSaturationConfig(), bypass: false, ...over });
}
function tr(over: Partial<TransientConfig>): TransientConfig {
  return sanitizeTransient({ ...defaultTransientConfig(), bypass: false, ...over });
}
function img(over: Partial<ImagerMultibandConfig>): ImagerMultibandConfig {
  return sanitizeImagerMultiband({ ...defaultImagerMultiband(), enabled: true, ...over });
}
function deq(bands: DynamicEqConfig['bands']): DynamicEqConfig {
  return sanitizeDynamicEq({ bypass: false, bands });
}

// ── presets ────────────────────────────────────────────────────────────────

export const MODULE_PRESETS: ModulePreset[] = [
  {
    id: 'off', name: '끄기', hint: '모든 모듈 바이패스',
    build: allBypassed,
  },
  {
    id: 'punchy', name: 'Punchy', hint: '어택 강조 + 저역 글루',
    build: () => ({
      ...allBypassed(),
      multiband: mb({ bands: [
        { thresholdDb: -28, ratio: 2.5, attackMs: 30, releaseMs: 150, makeupDb: 1.5 },
        { thresholdDb: -24, ratio: 1.4, attackMs: 20, releaseMs: 140, makeupDb: 0 },
        { thresholdDb: -24, ratio: 1, attackMs: 10, releaseMs: 120, makeupDb: 0 },
        { thresholdDb: -24, ratio: 1, attackMs: 5, releaseMs: 100, makeupDb: 0 },
      ] }),
      transient: tr({ attackPct: 40, sustainPct: -8 }),
      saturation: sat({ character: 'tape', drive: 14, mixPct: 100 }),
    }),
  },
  {
    id: 'warm', name: 'Warm', hint: '튜브 새추 + 고역 완화 + 바디',
    build: () => ({
      ...allBypassed(),
      saturation: sat({ character: 'tube', drive: 28, mixPct: 80 }),
      transient: tr({ attackPct: -8, sustainPct: 18 }),
      dynamicEq: deq([
        { ...defaultDynEqBand(9000), filterType: 'highshelf', mode: 'downcut', freqHz: 9000, thresholdDb: -26, ratio: 3, rangeDb: 3 },
      ]),
    }),
  },
  {
    id: 'wide', name: 'Wide', hint: '저역 모노 + 고역 확장',
    build: () => ({
      ...allBypassed(),
      imagerMultiband: img({ widthsPct: [0, 95, 120, 160] }),
      saturation: sat({ character: 'tape', drive: 8, mixPct: 100 }),
    }),
  },
  {
    id: 'clean', name: 'Clean', hint: '투명한 글루 + 디에서',
    build: () => ({
      ...allBypassed(),
      multiband: mb({ bands: [
        { thresholdDb: -24, ratio: 1.5, attackMs: 30, releaseMs: 150, makeupDb: 0 },
        { thresholdDb: -24, ratio: 1.5, attackMs: 20, releaseMs: 140, makeupDb: 0 },
        { thresholdDb: -24, ratio: 1.5, attackMs: 12, releaseMs: 120, makeupDb: 0 },
        { thresholdDb: -24, ratio: 1.5, attackMs: 6, releaseMs: 100, makeupDb: 0 },
      ] }),
      dynamicEq: deq([
        { ...defaultDynEqBand(7000), filterType: 'bell', mode: 'downcut', freqHz: 7000, q: 3, thresholdDb: -28, ratio: 4, rangeDb: 6 },
      ]),
    }),
  },
  {
    id: 'loud', name: 'Loud', hint: '강한 멀티밴드 + 새추 + 어택',
    build: () => ({
      ...allBypassed(),
      multiband: mb({ bands: [
        { thresholdDb: -26, ratio: 3, attackMs: 20, releaseMs: 140, makeupDb: 2 },
        { thresholdDb: -26, ratio: 3, attackMs: 15, releaseMs: 130, makeupDb: 2 },
        { thresholdDb: -26, ratio: 3, attackMs: 10, releaseMs: 120, makeupDb: 2 },
        { thresholdDb: -26, ratio: 3, attackMs: 6, releaseMs: 100, makeupDb: 2 },
      ] }),
      saturation: sat({ character: 'tape', drive: 38, mixPct: 100 }),
      transient: tr({ attackPct: 20, sustainPct: 0 }),
    }),
  },
];

export function getModulePreset(id: string): ModulePreset | undefined {
  return MODULE_PRESETS.find((p) => p.id === id);
}
