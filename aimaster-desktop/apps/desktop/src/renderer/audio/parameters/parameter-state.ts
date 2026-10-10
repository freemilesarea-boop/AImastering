// Canonical UI parameter state model for the Loui Mastering product
// layout.  This module defines the *types* — concrete parameter
// definitions live alongside in `module-parameter-definitions.ts`.
//
// The state model is a single source of truth for every parameter the
// user can twist in the product layout slide-over panels.  It is:
//
//   • UI-state-only — no DSP value is written from THIS module.  The
//     state it defines does reach the DSP; `chain-config.ts` turns an
//     all-modules state into the offline render's config and the
//     preview's alike.
//   • Engine-agnostic — each parameter carries a `binding` field naming
//     its EngineSchema target.  The binding is read today, not someday:
//     `engine-bridge/engine-dispatcher.ts` refuses a command whose
//     binding is not `wired`, `export-parameter-adapter.ts` grades a
//     parameter's export support from it, and `pending-summary.ts`
//     counts what is still unimplemented.
//   • Validated — `engine-command.ts` provides clamp/quantise helpers.
//     They are reached through `makeSetParamCommand`, which means
//     through `ModuleParameterStateProvider` — see the note in
//     `useModuleParameterState.tsx` about who mounts that, because the
//     page the app ships writes this state WITHOUT them.
//
// Reference docs:
//   docs/redesign/loui-mastering-v2/m3-product-next-5a/00-OVERVIEW.md

import type { EngineModuleType } from '@aimaster/shared-types/engine';

// ── Module identification ────────────────────────────────────────────────

/**
 * Modules exposed by the product layout.  Stable order — this is chain
 * order, so a list rendered straight from `MODULE_IDS` reads the way the
 * signal actually flows: repair, correct, control, colour, image, output.
 */
export type ModuleId =
  // Restoration
  | 'declick' | 'dehum' | 'denoise' | 'deess' | 'top-rebuild'
  // Tone / spectral
  | 'parametric-eq' | 'eq' | 'match-eq' | 'spectral-shaper' | 'hiss-gate' | 'stabilizer'
  | 'vintage-eq' | 'dynamic-eq'
  // Dynamics
  | 'multiband' | 'dynamics' | 'vintage-comp' | 'impact' | 'low-end-focus'
  // Character
  | 'exciter' | 'tape'
  // Space
  | 'delay' | 'reverb'
  // Stereo / output
  | 'imager' | 'limiter' | 'export';

export const MODULE_IDS: readonly ModuleId[] = [
  'declick', 'dehum', 'denoise', 'deess', 'top-rebuild',
  'parametric-eq', 'eq', 'match-eq', 'spectral-shaper', 'hiss-gate', 'stabilizer', 'vintage-eq', 'dynamic-eq',
  'multiband', 'dynamics', 'vintage-comp', 'impact', 'low-end-focus',
  'exciter', 'tape',
  'delay', 'reverb',
  'imager', 'limiter', 'export',
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
   * Whether the chain the Studio render runs on carries this value.
   *   - `'wired'`: it does.  `parameter-reach-selftest` measures this by
   *     moving the parameter and rebuilding the render's chain config, and
   *     fails a `wired` entry that moves nothing.
   *   - `'pending'`: it does not yet.  Measured too, in the other
   *     direction: an entry that says `pending` while already moving the
   *     config fails, because that is how this field went stale before —
   *     twenty-three entries promised "M2-full will add it" for fields the
   *     Rust engine had all along.
   *   - `'unavailable'`: there is no DSP module to carry it, and there is
   *     not going to be.  The export module's format / rate / depth are
   *     render-stage decisions, not chain stages, and the sweep skips them.
   *
   * What this does NOT say is whether the PREVIEW can let you hear it: the
   * realtime chain carries 17 of 223 parameters, and the same selftest
   * prints that map per module.
   */
  status: 'wired' | 'pending' | 'unavailable';
  /** Optional adapter-specific note for diagnostics. */
  note?: string;
  /**
   * Export-renderable mapping (M3-P-NEXT-5D-2-c).  When set, this param
   * maps to a `MasteringOptions` field that the Re-master & Export path
   * applies — even when `status` is `'unavailable'` (render-stage, no
   * DSP module).  Example: `'sampleRate'`, `'bitDepth'`.  These do NOT
   * affect the preview (preview is always a 320 kbps MP3).
   */
  exportField?: string;
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
  /**
   * Set when NOTHING implements this parameter yet.
   *
   * Different from `binding.status`, which says whether the render's chain
   * carries the value.  (That doc used to say "the Python preview render",
   * which is a third thing again — Python is the fallback, not the path a
   * Studio render takes — and reading it is what sent one audit looking for
   * twenty-three missing features that were all present.)  This says the
   * value reaches no engine at all:
   * move it and neither chain config changes, so no renderer, preview or
   * export can behave differently.
   *
   * Measured rather than asserted — `scripts/parameter-reach-selftest.ts`
   * moves every parameter with its module forced into the config and fails
   * both ways: an undeclared parameter that reaches nothing, and a declared
   * one that has started working and needs the flag taken off.  A panel that
   * shows a control the engine has never heard of is the failure this
   * prevents; the string is what it tells the user.
   */
  unimplemented?: string;
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
  /**
   * Whether the module starts bypassed.
   *
   * Needed by modules whose parameters have useful non-zero defaults but
   * which must NOT be running until asked for — the spectral trio would
   * otherwise cost an STFT on every session just because their "amount"
   * defaults to a sensible starting value.  Defaults to `false`.
   */
  defaultBypass?: boolean;
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
  return { moduleId: def.moduleId, bypass: def.defaultBypass === true, parameters };
}

/**
 * Build the default all-modules snapshot from definitions.
 *
 * Driven by `MODULE_IDS` rather than a hand-written literal, so adding a
 * module to the suite cannot leave a hole in the default state.
 */
export function defaultAllModulesState(defs: AllModulesDefinitions): AllModulesParameterState {
  const out = {} as AllModulesParameterState;
  for (const id of MODULE_IDS) {
    out[id] = defaultStateForModule(defs[id]);
  }
  return out;
}
