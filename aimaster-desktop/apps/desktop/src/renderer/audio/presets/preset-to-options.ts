// Map a Loui preset → the HomePage MasteringOptions (M2-PRESET-NEXT-1
// follow-up).
//
// HomePage masters via the legacy options model (style / targetLufs /
// targetTp / stereoWidth / limiterStrength).  This bridges the official
// LouiPreset lineup into that flow so users can pick a Loui preset BEFORE
// mastering.  Only the export-renderable params are mapped (loudness /
// ceiling / width / limiter strength) — the same subset the export honours
// — plus a best-fit MasteringStyle, so there is no preview/export drift.

import type { MasteringStyle, LimiterStrength } from '@aimaster/shared-types';
import type { LouiPreset } from './loui-presets.js';

/** Best-fit legacy MasteringStyle per preset id. */
const STYLE_BY_ID: Record<string, MasteringStyle> = {
  'ai-pop': 'bright',
  'kpop-loud': 'kpop_loud',
  'streaming-pro': 'balanced',
  'youtube-safe': 'balanced',
  'lofi-warm': 'warm',
  'edm-wide': 'loud',
  'ballad-vocal': 'bright',
  'piano-natural': 'natural',
  'vintage-soft': 'warm',
  'ai-vocal-cleaner': 'balanced',
  'cymbal-smooth': 'warm',
  'stereo-repair': 'balanced',
  'mono-safe-shorts': 'punch',
};

function num(p: LouiPreset, mod: 'eq' | 'imager' | 'limiter', id: string, d: number): number {
  const v = p.tuning[mod]?.parameters?.[id];
  return typeof v === 'number' ? v : d;
}

/** Derive limiter strength from the preset's loudness + limiter character. */
function limiterStrength(p: LouiPreset): LimiterStrength {
  const lufs = num(p, 'limiter', 'targetLufs', -14);
  const character = p.tuning.limiter?.parameters?.['character'];
  if (character === 'transparent' || lufs <= -16) return 'low';
  if (character === 'aggressive' || lufs >= -10) return 'high';
  return 'medium';
}

export interface PresetMasteringOptions {
  style: MasteringStyle;
  targetLufs: number;
  targetTp: number;
  stereoWidth: number;
  limiterStrength: LimiterStrength;
}

/**
 * Convert a Loui preset into the renderable MasteringOptions subset
 * HomePage uses.  `stereoWidth` is engine-space (1.0 = passthrough),
 * matching how the export reads width.
 */
export function louiPresetToMasteringOptions(p: LouiPreset): PresetMasteringOptions {
  return {
    style: STYLE_BY_ID[p.id] ?? 'balanced',
    targetLufs: num(p, 'limiter', 'targetLufs', -14),
    targetTp: num(p, 'limiter', 'ceilingDbtp', -1),
    stereoWidth: num(p, 'imager', 'widthPct', 100) / 100,
    limiterStrength: limiterStrength(p),
  };
}
