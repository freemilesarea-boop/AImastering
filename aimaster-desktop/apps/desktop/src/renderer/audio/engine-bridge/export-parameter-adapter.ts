// Export-parameter support adapter (OZONE-MODULE-NEXT-4).
//
// Classifies every UI parameter by HOW it reaches the final export — so
// the app can tell the user exactly which knobs make it into the rendered
// file, and which are preview-only.  Grounded entirely in what the Python
// engine actually consumes (audit: EXPORT_RENDERABLE_AUDIT.md):
//
//   exact        — module param maps to a renderable MasteringOptions field
//                  Python honours (loudness / ceiling / width / output gain);
//                  also drives the re-render preview.
//   export-only  — applied on the export render, not the preview (sample
//                  rate / bit depth).
//   preview-only — processed by the Rust realtime preview chain but the
//                  Python export does NOT honour it (EQ tone, dynamics,
//                  low-mono, limiter lookahead/ISP).
//   approximate  — RESERVED.  No parameter is approximated today: mapping
//                  EQ tone → `style`/`saturation` would silently override
//                  the user's choices and is lossy, so we keep those
//                  preview-only (see EXPORT_APPROXIMATION_POLICY.md).
//   planned      — no DSP yet (export format today; dither used to be here
//                  and now has an adapter, so it grades export-only).
//
// IMPORTANT: this NEVER promotes a param Python can't honour.  The honest
// truth is that no EQ/Dynamics/Limiter-detail knob is export-exact beyond
// the four already-renderable ones.

import { ALL_MODULE_PARAMETER_DEFS } from '../parameters/module-parameter-definitions.js';
import type { AllModulesDefinitions, ModuleId, ParameterDef } from '../parameters/parameter-state.js';
import { RENDERABLE_MAP_LOOKUP } from './renderable-map.js';

export type ExportSupport = 'exact' | 'approximate' | 'export-only' | 'preview-only' | 'planned';

export const EXPORT_SUPPORT_LABEL: Record<ExportSupport, string> = {
  exact: 'Export exact',
  approximate: 'Export approximate',
  'export-only': 'Export only',
  'preview-only': 'Preview only',
  planned: 'Planned',
};

function engineKey(def: ParameterDef): string {
  return `${def.binding.moduleType}:${def.binding.path}`;
}

// Engine module types that the Rust realtime preview chain actually
// processes — only these can be "preview-only".  Anything else with no
// export mapping is "planned" (no DSP anywhere yet).
const REALTIME_CHAIN_MODULE_TYPES = new Set([
  'adaptive-eq', 'bus-comp', 'stereo-imager', 'limiter', 'gain-staging', 'loudness-norm',
]);

/** Classify a single parameter definition. */
export function classifyParamExport(def: ParameterDef): ExportSupport {
  // Export-stage quality (sample rate / bit depth) — applied on render only.
  if (def.binding.exportField) return 'export-only';
  // Renderable audio param the Python engine honours → exact.
  if (def.binding.status === 'wired' && engineKey(def) in RENDERABLE_MAP_LOOKUP) return 'exact';
  // Processed in the realtime preview chain (Rust) but Python ignores it.
  if (def.binding.moduleType && REALTIME_CHAIN_MODULE_TYPES.has(def.binding.moduleType)) return 'preview-only';
  // No DSP anywhere (export format today).
  return 'planned';
}

export interface ParamExportRow {
  moduleId: ModuleId;
  parameterId: string;
  label: string;
  support: ExportSupport;
}

/** Full per-parameter export-support matrix. */
export function exportSupportMatrix(defs: AllModulesDefinitions = ALL_MODULE_PARAMETER_DEFS): ParamExportRow[] {
  const rows: ParamExportRow[] = [];
  for (const moduleId of Object.keys(defs) as ModuleId[]) {
    for (const def of defs[moduleId].parameters) {
      rows.push({ moduleId, parameterId: def.id, label: def.label, support: classifyParamExport(def) });
    }
  }
  return rows;
}

export interface ExportSupportSummary {
  exact: number;
  approximate: number;
  exportOnly: number;
  previewOnly: number;
  /** Human one-liner, e.g. "2 exact · 1 export-only · 3 preview-only (not exported)". */
  text: string;
}

/**
 * Summarise the export support of a set of CHANGED parameter ids
 * (`"moduleId.parameterId"`).  Used by the export panel to tell the user
 * how many of their edits actually reach the file.
 */
export function summarizeChangedExport(
  changed: ReadonlyArray<{ moduleId: ModuleId; parameterId: string }>,
  defs: AllModulesDefinitions = ALL_MODULE_PARAMETER_DEFS,
): ExportSupportSummary {
  let exact = 0, approximate = 0, exportOnly = 0, previewOnly = 0;
  for (const c of changed) {
    const def = defs[c.moduleId]?.parameters.find((d) => d.id === c.parameterId);
    if (!def) continue;
    switch (classifyParamExport(def)) {
      case 'exact': exact++; break;
      case 'approximate': approximate++; break;
      case 'export-only': exportOnly++; break;
      case 'preview-only': previewOnly++; break;
      case 'planned': break;
    }
  }
  const parts: string[] = [];
  if (exact) parts.push(`${exact} exact`);
  if (approximate) parts.push(`${approximate} approximate`);
  if (exportOnly) parts.push(`${exportOnly} export-only`);
  if (previewOnly) parts.push(`${previewOnly} preview-only (not exported)`);
  return { exact, approximate, exportOnly, previewOnly, text: parts.length ? parts.join(' · ') : 'no changes' };
}
