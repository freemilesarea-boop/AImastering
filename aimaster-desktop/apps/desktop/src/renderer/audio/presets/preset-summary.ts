// Human-readable preset summaries for the browser UX (M2-PRESET-NEXT-1).
//
// Turns the parameter diff between two presets into editorial chips —
// "this preset changes: Loudness, Width, EQ tone" — and surfaces a
// preset's key facts for the selected-preset summary.

import { diffPresets, type PresetParamDiff } from './preset-compare.js';
import type { LouiPreset } from './loui-presets.js';

/** Coarse, user-facing change groups. */
export type PresetChangeGroup =
  | 'Loudness'
  | 'True-peak ceiling'
  | 'Width'
  | 'Low-end / mono'
  | 'EQ tone'
  | 'Dynamics'
  | 'Limiter';

const GROUP_FOR: Record<string, PresetChangeGroup> = {
  // limiter
  'limiter.targetLufs': 'Loudness',
  'limiter.ceilingDbtp': 'True-peak ceiling',
  'limiter.lookaheadMs': 'Limiter',
  'limiter.character': 'Limiter',
  'limiter.isp': 'Limiter',
  // imager
  'imager.widthPct': 'Width',
  'imager.lowMonoHz': 'Low-end / mono',
  // eq
  'eq.lowCutHz': 'Low-end / mono',
  'eq.lowShelfDb': 'EQ tone',
  'eq.presenceDb': 'EQ tone',
  'eq.airDb': 'EQ tone',
  'eq.outputGainDb': 'Loudness',
  // dynamics
  'dynamics.thresholdDb': 'Dynamics',
  'dynamics.ratio': 'Dynamics',
  'dynamics.attackMs': 'Dynamics',
  'dynamics.releaseMs': 'Dynamics',
  'dynamics.mixPct': 'Dynamics',
};

const GROUP_ORDER: PresetChangeGroup[] = [
  'Loudness', 'True-peak ceiling', 'Width', 'Low-end / mono', 'EQ tone', 'Dynamics', 'Limiter',
];

function groupOf(d: PresetParamDiff): PresetChangeGroup | undefined {
  return GROUP_FOR[`${d.moduleId}.${d.parameterId}`];
}

/**
 * The set of change groups that differ when moving `from` → `to`.
 * Ordered for display.  Empty when the presets are identical.
 */
export function presetChangeGroups(from: LouiPreset, to: LouiPreset): PresetChangeGroup[] {
  const groups = new Set<PresetChangeGroup>();
  for (const d of diffPresets(from, to)) {
    const g = groupOf(d);
    if (g) groups.add(g);
  }
  return GROUP_ORDER.filter((g) => groups.has(g));
}

/** Key facts about a single preset for the selected-preset summary. */
export interface PresetHighlights {
  targetLufs: number;
  ceilingDbtp: number;
  widthPct: number;
  tonalBalance: LouiPreset['tonalBalance'];
  aiOptimized: boolean;
  monoSafe: boolean;
}

export function presetHighlights(p: LouiPreset): PresetHighlights {
  const lim = p.tuning.limiter?.parameters ?? {};
  const img = p.tuning.imager?.parameters ?? {};
  return {
    targetLufs: typeof lim['targetLufs'] === 'number' ? (lim['targetLufs'] as number) : -14,
    ceilingDbtp: typeof lim['ceilingDbtp'] === 'number' ? (lim['ceilingDbtp'] as number) : -1,
    widthPct: typeof img['widthPct'] === 'number' ? (img['widthPct'] as number) : 100,
    tonalBalance: p.tonalBalance,
    aiOptimized: p.aiOptimized,
    monoSafe: p.monoSafe,
  };
}
