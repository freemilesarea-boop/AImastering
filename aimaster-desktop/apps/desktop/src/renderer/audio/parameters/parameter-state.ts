// Canonical UI parameter state model for the Loui Mastering product
// layout.  This module defines the *types* — concrete parameter
// definitions live alongside in `module-parameter-definitions.ts`.
//
// The state model is a single source of truth for every parameter the
// user can twist in the product layout slide-over panels.  It is:
//
//   • UI-state-only — no DSP value is written from this module.
//   • Engine-agnostic — each parameter carries a `binding` field
//     pointing to a future EngineSchema target; the binding is what
//     M2-full / M3-P-NEXT-5B will consume to write to the real DSP.
//   • Validated — `engine-command.ts` provides clamp/quantise helpers
//     so every value entering state is in-range and step-aligned.
//
// Reference docs:
//   docs/redesign/loui-mastering-v2/m3-product-next-5a/00-OVERVIEW.md

import type { EngineModuleType } from '@aimaster/shared-types/engine';

// ── Module identification ────────────────────────────────────────────────

/** Modules exposed by the product layout slide-over.  Stable order. */
export type ModuleId = 'eq' | 'dynamics' | 'imager' | 'limiter' | 'export';

export const MODULE_IDS: readonly ModuleId[] = [
  'eq',
  'dynamics',
  'imager',
  'limiter',
  'export',
] as const;

// ── Engine binding target ────────────────────────────────────────────────

/**
 * Where a UI parameter routes when the engine binding (M2-full / M3-P-NEXT-5B)
 * lands.  `status` declares whether any adapter currently honours the
 * binding — useful for showing "Unavailable" badges in dev tooling.
 */
export interface EngineBindingTarget {
  /**
   * EngineSchema module type the parameter routes to.  `null` means the
   * parameter has no DSP equivalent (e.g. export-related UI state).
   */
  moduleType: EngineModuleType | null;
  /**
   * Path inside the module — e.g. `'bands[lowShelf].gainDb'` or
   * `'thresholdDb'`.  Free-form for now; M3-P-NEXT-5B will tighten
   * this to a structured selector.
   */
  path: string;
  /**
   * Whether any adapter currently writes / reads this binding.
   *   - `'wired'`: ready today (e.g. limiter ceiling already exists)
   *   - `'pending'`: M2-full plans to wire it
   *   - `'unavailable'`: not on any roadmap (export-only / debug-only)
   */
  status: 'wired' | 'pending' | 'unavailable';
  /** Optional adapter-specific note for diagnostics. */
  note?: string;
}

// ── Parameter definitions ────────────────────────────────────────────────

interface BaseParameterDef {
  /** Stable id, unique within its module.  Used in commands + automation. */
  id: string;
  /** Human-readable label.  Drives slider / knob labels. */
  label: string;
  /** Optional descriptive subtitle. */
  hint?: string;
  /** Whether the parameter is currently exposed to UI automation. */
  automatable: boolean;
  /** Engine binding target — see {@link EngineBindingTarget}. */
  binding: EngineBindingTarget;
}

export interface NumericParameterDef extends BaseParameterDef {
  kind: 'number';
  unit?: string;
  min: number;
  max: number;
  default: number;
  step: number;
  /** Optional formatter for live display.  Default: `v.toFixed(1)`. */
  format?: (v: number) => string;
}

export interface BooleanParameterDef extends BaseParameterDef {
  kind: 'boolean';
  default: boolean;
  offLabel?: string;
  onLabel?: string;
}

export interface EnumParameterDef extends BaseParameterDef {
  kind: 'enum';
  values: readonly string[];
  default: string;
  /** Optional editorial labels per value (defaults to the value string). */
  labels?: Readonly<Record<string, string>>;
  /** Optional editorial hints per value. */
  hints?: Readonly<Record<string, string>>;
}

export type ParameterDef =
  | NumericParameterDef
  | BooleanParameterDef
  | EnumParameterDef;

// ── Value type union ─────────────────────────────────────────────────────

/** Runtime value type a parameter can hold. */
export type ParameterValue = number | boolean | string;

/**
 * Helper — return the TS type that matches a given parameter definition.
 *
 * @example
 * type V = ValueOf<NumericParameterDef>;  // number
 */
export type ValueOf<D extends ParameterDef> =
  D extends NumericParameterDef ? number :
  D extends BooleanParameterDef ? boolean :
  D extends EnumParameterDef    ? string  :
  never;

// ── Module / state shapes ────────────────────────────────────────────────

/**
 * Snapshot of one module's UI parameter state.  `parameters` holds the
 * current value for every parameter defined in
 * `module-parameter-definitions.ts` for the same module.
 */
export interface ModuleParameterState {
  moduleId: ModuleId;
  bypass: boolean;
  /** Map: parameter id → current value (typed loosely as ParameterValue). */
  parameters: Record<string, ParameterValue>;
}

/** All-modules snapshot. */
export type AllModulesParameterState = Record<ModuleId, ModuleParameterState>;

// ── Definition lookup helpers ────────────────────────────────────────────

/** All-modules definition map. */
export type AllModulesDefinitions = Record<ModuleId, ModuleParameterDefinitions>;

export interface ModuleParameterDefinitions {
  moduleId: ModuleId;
  /** Module-level engine binding (used for `bypass`). */
  bypassBinding: EngineBindingTarget;
  parameters: readonly ParameterDef[];
}

/** Find a parameter definition by module + parameter id.  Throws if missing. */
export function findParameterDef(
  defs: AllModulesDefinitions,
  moduleId: ModuleId,
  parameterId: string,
): ParameterDef {
  const mod = defs[moduleId];
  const p = mod.parameters.find((d) => d.id === parameterId);
  if (!p) {
    throw new Error(`[parameter-state] unknown parameter "${moduleId}.${parameterId}"`);
  }
  return p;
}

/** Map a parameter definition list to a default-value snapshot. */
export function defaultStateForModule(def: ModuleParameterDefinitions): ModuleParameterState {
  const parameters: Record<string, ParameterValue> = {};
  for (const p of def.parameters) {
    parameters[p.id] = p.default;
  }
  return { moduleId: def.moduleId, bypass: false, parameters };
}

/** Build the default all-modules snapshot from definitions. */
export function defaultAllModulesState(defs: AllModulesDefinitions): AllModulesParameterState {
  return {
    eq:       defaultStateForModule(defs.eq),
    dynamics: defaultStateForModule(defs.dynamics),
    imager:   defaultStateForModule(defs.imager),
    limiter:  defaultStateForModule(defs.limiter),
    export:   defaultStateForModule(defs.export),
  };
}
