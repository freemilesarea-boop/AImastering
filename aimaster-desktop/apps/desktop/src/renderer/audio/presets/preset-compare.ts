// Preset-to-preset comparison helpers (M2-PRESET-TUNING).
//
// Used by the tuning harness + QA tooling to see exactly which DSP
// parameters differ between two presets — so "preset compare" is a real
// parameter diff, not just an A/B loudness impression.

import {
  ALL_MODULE_PARAMETER_DEFS,
} from '../parameters/module-parameter-definitions.js';
import {
  type AllModulesDefinitions,
  type ModuleId,
  type ParameterValue,
} from '../parameters/parameter-state.js';
import { MODULE_IDS } from '../parameters/parameter-state.js';
import { presetToParameterState } from './preset-to-state.js';
import type { LouiPreset } from './loui-presets.js';

export interface PresetParamDiff {
  moduleId: ModuleId;
  parameterId: string;
  a: ParameterValue;
  b: ParameterValue;
}

/**
 * Diff the effective (defaults + tuning) parameter state of two presets.
 * Returns only the parameters whose values differ.
 */
export function diffPresets(
  a: LouiPreset,
  b: LouiPreset,
  defs: AllModulesDefinitions = ALL_MODULE_PARAMETER_DEFS,
): PresetParamDiff[] {
  const sa = presetToParameterState(a, defs);
  const sb = presetToParameterState(b, defs);
  const diffs: PresetParamDiff[] = [];
  for (const moduleId of MODULE_IDS) {
    const pa = sa[moduleId].parameters;
    const pb = sb[moduleId].parameters;
    const ids = new Set([...Object.keys(pa), ...Object.keys(pb)]);
    for (const parameterId of ids) {
      const a = pa[parameterId];
      const b = pb[parameterId];
      if (a === undefined || b === undefined) continue; // both derive from defaults
      if (a !== b) diffs.push({ moduleId, parameterId, a, b });
    }
  }
  return diffs;
}

/** One-line human summary of a diff list (for logs / QA notes). */
export function describePresetDiff(diffs: PresetParamDiff[]): string {
  if (diffs.length === 0) return 'identical';
  return diffs
    .map((d) => `${d.moduleId}.${d.parameterId}: ${String(d.a)} → ${String(d.b)}`)
    .join(' · ');
}
