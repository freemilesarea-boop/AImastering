// Pending-change summary across all modules.
//
// "Pending" = a UI parameter value not yet reflected in the current
// preview.  Two flavours:
//   • renderable  — a wired param with a MasteringOptions mapping whose
//                   current engine value differs from what the preview
//                   currently reflects.  The "Update Preview" button
//                   applies these.
//   • staged-only — a param changed from its default but with no
//                   renderable mapping.  Informational; never renders.
//
// Computed from the provider's parameter STATE (not the dispatcher's
// imperative patch) so it stays reactive to UI changes.
//
// Baselining: the provider's state is seeded from the base master
// options (see `initialStateFromBaseOptions`), so "current === base"
// holds at load and nothing reads as pending until the user changes
// something.

import type { MasteringOptions } from '@aimaster/shared-types';
import {
  ALL_MODULE_PARAMETER_DEFS,
  defaultAllModulesState,
  type AllModulesDefinitions,
  type AllModulesParameterState,
  type ModuleId,
} from '../parameters/index.js';
import { toEngineValue } from './engine-dispatcher.js';
import { hashOverride } from './engine-preset-builder.js';
import { RENDERABLE_MAP_LOOKUP } from './renderable-map.js';

export interface PendingItem {
  moduleId: ModuleId;
  parameterId: string;
  enginePath: string;
}

export interface RenderablePendingItem extends PendingItem {
  optionKey: keyof MasteringOptions;
  currentValue: number;
  renderedValue: number;
}

export interface PendingSummary {
  renderablePending: RenderablePendingItem[];
  unsupportedPending: PendingItem[];
  /** Per-module pending kind: 'renderable' wins over 'staged' over null. */
  pendingByModule: Record<ModuleId, 'renderable' | 'staged' | null>;
  renderablePendingCount: number;
  unsupportedPendingCount: number;
  totalPendingCount: number;
  hasUnrenderedChanges: boolean;
  /**
   * FULL renderable override vs the base master — the override to SEND on
   * the next render (each render is from base, not incremental, so it
   * must carry every changed renderable value).
   */
  renderOverride: Partial<MasteringOptions>;
  /** Deterministic hash of `renderOverride`. */
  patchHash: string;
}

const EMPTY_BY_MODULE: Record<ModuleId, 'renderable' | 'staged' | null> = {
  eq: null, dynamics: null, imager: null, limiter: null, export: null,
};

/** The base-master value implied for a renderable MasteringOptions field. */
function baseValueFor(base: MasteringOptions, optionKey: keyof MasteringOptions): number {
  switch (optionKey) {
    case 'targetLufs':   return base.targetLufs;
    case 'targetTp':     return base.targetTp;
    case 'stereoWidth':  return typeof base.stereoWidth === 'number' ? base.stereoWidth : 1.0;
    case 'outputGainDb': return typeof base.outputGainDb === 'number' ? base.outputGainDb : 0;
    default:             return Number.NaN;
  }
}

/**
 * Summarise pending changes from the current parameter state.
 *
 * @param state                current all-modules parameter state
 * @param lastRenderedOverride the override that produced the current
 *                             preview ({} = the original master)
 * @param baseOptions          the original master's options (baseline)
 * @param defs                 parameter definitions (defaults to canonical)
 */
export function summarizePending(
  state: AllModulesParameterState,
  lastRenderedOverride: Partial<MasteringOptions>,
  baseOptions: MasteringOptions,
  defs: AllModulesDefinitions = ALL_MODULE_PARAMETER_DEFS,
): PendingSummary {
  const renderablePending: RenderablePendingItem[] = [];
  const unsupportedPending: PendingItem[] = [];
  const pendingByModule = { ...EMPTY_BY_MODULE };
  const renderOverride: Partial<MasteringOptions> = {};

  for (const moduleId of Object.keys(state) as ModuleId[]) {
    const moduleState = state[moduleId];
    const moduleDef = defs[moduleId];

    for (const def of moduleDef.parameters) {
      const current = moduleState.parameters[def.id];
      if (current === undefined) continue;

      const engineKey = `${def.binding.moduleType}:${def.binding.path}`;
      const optionKey = RENDERABLE_MAP_LOOKUP[engineKey];

      if (optionKey && def.binding.status === 'wired') {
        const { engineValue } = toEngineValue(moduleId, def.id, current);
        if (typeof engineValue !== 'number') continue;
        const base = baseValueFor(baseOptions, optionKey);
        const rendered = (lastRenderedOverride[optionKey] as number | undefined) ?? base;

        // Override to send: every renderable value that differs from base.
        if (engineValue !== base) {
          (renderOverride[optionKey] as number) = engineValue;
        }
        // Pending (badge): differs from what the preview currently reflects.
        if (engineValue !== rendered) {
          renderablePending.push({
            moduleId, parameterId: def.id,
            enginePath: engineKey, optionKey,
            currentValue: engineValue, renderedValue: rendered,
          });
          pendingByModule[moduleId] = 'renderable';
        }
      } else if (current !== def.default) {
        unsupportedPending.push({ moduleId, parameterId: def.id, enginePath: engineKey });
        if (pendingByModule[moduleId] !== 'renderable') {
          pendingByModule[moduleId] = 'staged';
        }
      }
    }
  }

  return {
    renderablePending,
    unsupportedPending,
    pendingByModule,
    renderablePendingCount: renderablePending.length,
    unsupportedPendingCount: unsupportedPending.length,
    totalPendingCount: renderablePending.length + unsupportedPending.length,
    hasUnrenderedChanges: renderablePending.length > 0,
    renderOverride,
    patchHash: hashOverride(renderOverride),
  };
}

/**
 * Seed an all-modules parameter state from the base master options, so
 * the renderable params start matching the preview (no false pending at
 * load).  Non-renderable params keep their canonical defaults.
 */
export function initialStateFromBaseOptions(
  baseOptions: MasteringOptions,
  defs: AllModulesDefinitions = ALL_MODULE_PARAMETER_DEFS,
): AllModulesParameterState {
  const state = defaultAllModulesState(defs);
  state.limiter.parameters['targetLufs']  = baseOptions.targetLufs;
  state.limiter.parameters['ceilingDbtp'] = baseOptions.targetTp;
  state.imager.parameters['widthPct'] =
    (typeof baseOptions.stereoWidth === 'number' ? baseOptions.stereoWidth : 1.0) * 100;
  state.eq.parameters['outputGainDb'] =
    typeof baseOptions.outputGainDb === 'number' ? baseOptions.outputGainDb : 0;
  return state;
}
