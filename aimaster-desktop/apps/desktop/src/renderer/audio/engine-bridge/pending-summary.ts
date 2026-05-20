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
  type ParameterValue,
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

// ── Export override (M3-P-NEXT-5D-2-a) ────────────────────────────────────

export interface ExportOverrideResult {
  /** MasteringOptions override to merge before re-mastering for export. */
  optionsOverride: Partial<MasteringOptions>;
  /** MasteringOptions keys applied (renderable audio params + export quality). */
  appliedOverrideKeys: string[];
  /** UI parameter ids staged but NOT applied to the export (no mapping). */
  skippedParameterIds: string[];
  /** Deterministic hash of the override. */
  patchHash: string;
  /** Whether there's anything to apply (else "Export As-is" is equivalent). */
  hasOverride: boolean;
  /** Export-quality keys applied (sampleRate / bitDepth) — for UI labelling. */
  qualityAppliedKeys: string[];
}

/**
 * Build the export override from a preview pending summary + the export
 * module's quality state (sampleRate / bitDepth).
 *
 * Renderable AUDIO params (targetLufs / targetTp / stereoWidth /
 * outputGainDb) come from `summary.renderOverride` — the SAME override the
 * preview uses, so audio content stays consistent.  Export-only QUALITY
 * params come from `exportState`, validated against their enum `values`
 * and converted to numbers.  Quality is applied on Re-master & Export
 * only — it never affects the preview MP3.
 */
export function buildExportOverride(
  summary: PendingSummary,
  exportState?: Record<string, ParameterValue>,
  baseOptions?: MasteringOptions,
  defs: AllModulesDefinitions = ALL_MODULE_PARAMETER_DEFS,
): ExportOverrideResult {
  const optionsOverride: Partial<MasteringOptions> = { ...summary.renderOverride };
  const appliedOverrideKeys = Object.keys(optionsOverride);
  const qualityAppliedKeys: string[] = [];

  // Export-quality param defs (those with an `exportField`).
  const exportFieldDefs = defs.export.parameters.filter((d) => d.binding.exportField);
  const exportFieldParamIds = new Set(exportFieldDefs.map((d) => `export.${d.id}`));

  // Staged-only list — exclude export-quality params (handled below).
  const skippedParameterIds = summary.unsupportedPending
    .map((u) => `${u.moduleId}.${u.parameterId}`)
    .filter((id) => !exportFieldParamIds.has(id));

  if (exportState) {
    for (const def of exportFieldDefs) {
      const field = def.binding.exportField!;
      const raw = exportState[def.id];
      if (raw === undefined) continue;
      const validEnum = def.kind === 'enum' && typeof raw === 'string' && def.values.includes(raw);
      const num = typeof raw === 'string' ? Number(raw) : (typeof raw === 'number' ? raw : Number.NaN);
      if (validEnum && Number.isFinite(num)) {
        const baseVal = baseOptions ? (baseOptions as unknown as Record<string, unknown>)[field] : undefined;
        if (num !== baseVal) {
          (optionsOverride as Record<string, unknown>)[field] = num;
          appliedOverrideKeys.push(field);
          qualityAppliedKeys.push(field);
        }
      } else if (raw !== def.default) {
        skippedParameterIds.push(`export.${def.id}`);
      }
    }
  }

  return {
    optionsOverride,
    appliedOverrideKeys,
    skippedParameterIds,
    patchHash: hashOverride(optionsOverride),
    hasOverride: appliedOverrideKeys.length > 0,
    qualityAppliedKeys,
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
  // Export quality (M3-P-NEXT-5D-2-c) — seed from base so the export panel
  // matches the master's actual quality at load (only set if the value is
  // a recognised enum option, else keep the canonical default).
  const srDef = defs.export.parameters.find((d) => d.id === 'sampleRate');
  const bdDef = defs.export.parameters.find((d) => d.id === 'bitDepth');
  const srStr = String(baseOptions.sampleRate);
  const bdStr = String(baseOptions.bitDepth);
  if (srDef?.kind === 'enum' && srDef.values.includes(srStr)) state.export.parameters['sampleRate'] = srStr;
  if (bdDef?.kind === 'enum' && bdDef.values.includes(bdStr)) state.export.parameters['bitDepth'] = bdStr;
  return state;
}
