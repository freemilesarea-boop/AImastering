// Convert a Loui preset's tuning into the central parameter-state shapes.
// Pure + typechecked — no DSP, no React.

import {
  defaultAllModulesState,
  type AllModulesDefinitions,
  type AllModulesParameterState,
  type ModuleId,
  type ParameterValue,
} from '../parameters/parameter-state.js';
import { MODULE_IDS } from '../parameters/parameter-state.js';
import type { LouiPreset } from './loui-presets.js';

/** A single parameter value to apply (used by the bulk-apply path). */
export interface PresetParameterEntry {
  moduleId: ModuleId;
  parameterId: string;
  value: ParameterValue;
}

/** A per-module bypass override to apply. */
export interface PresetBypassEntry {
  moduleId: ModuleId;
  bypass: boolean;
}

export interface PresetApplyPlan {
  parameters: PresetParameterEntry[];
  bypasses: PresetBypassEntry[];
}

/**
 * Flatten a preset's sparse tuning into an ordered apply plan.  Order
 * follows MODULE_IDS so application is deterministic.
 */
export function presetApplyPlan(preset: LouiPreset): PresetApplyPlan {
  const parameters: PresetParameterEntry[] = [];
  const bypasses: PresetBypassEntry[] = [];
  for (const moduleId of MODULE_IDS) {
    const mod = preset.tuning[moduleId];
    if (!mod) continue;
    if (typeof mod.bypass === 'boolean') bypasses.push({ moduleId, bypass: mod.bypass });
    for (const [parameterId, value] of Object.entries(mod.parameters)) {
      parameters.push({ moduleId, parameterId, value });
    }
  }
  return { parameters, bypasses };
}

/**
 * Build a FULL all-modules state from defaults + the preset's overrides.
 * Useful for stories / tests / headless consistency checks (the live app
 * applies via the parameter-state provider's `applyPreset`).
 */
export function presetToParameterState(
  preset: LouiPreset,
  defs: AllModulesDefinitions,
): AllModulesParameterState {
  const state = defaultAllModulesState(defs);
  for (const moduleId of MODULE_IDS) {
    const mod = preset.tuning[moduleId];
    if (!mod) continue;
    if (typeof mod.bypass === 'boolean') state[moduleId].bypass = mod.bypass;
    state[moduleId] = {
      ...state[moduleId],
      parameters: { ...state[moduleId].parameters, ...mod.parameters },
    };
  }
  return state;
}
