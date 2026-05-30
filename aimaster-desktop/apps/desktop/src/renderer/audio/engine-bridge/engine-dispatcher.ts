// Engine dispatcher — the seam between UI parameter commands and a real
// DSP engine.
//
// M3-P-NEXT-5B scope (read carefully):
//   • This is the FIRST connection — only the parameters whose binding
//     status is `wired` get translated into engine space.
//   • There is NO live DSP write today.  The production runtime preview
//     plays a pre-rendered file, and the TS `runPreset` path consumes
//     bucketed mode configs (not live JSON parameter values — see
//     `audio/preset/runPreset.ts` header).  So "applied" is not yet a
//     reachable status for any real dispatcher.
//   • The safe, forward-compatible action is `staged`: translate a wired
//     parameter into an EngineSchema patch fragment and accumulate it.
//     A later milestone (M3-P-NEXT-5C / M2-full) consumes the staged
//     patch to drive an offline render or a live engine.
//
// Dispatchers never throw — they return a typed DispatchResult.  The
// provider logs every result; nothing rolls back UI state on failure in
// this milestone (warning + result-log policy, per the brief).

import type { EngineModuleType } from '@aimaster/shared-types/engine';
import {
  findParameterDef,
  type AllModulesDefinitions,
  type EngineCommand,
  type ModuleId,
  type ParameterValue,
} from '../parameters/index.js';

// ── Result types ─────────────────────────────────────────────────────────

export type DispatchStatus =
  /** Engine accepted the value and applied it to live DSP.  NOT reachable today. */
  | 'applied'
  /** Translated into a preset patch fragment, awaiting render.  Safe + forward-compatible. */
  | 'staged'
  /** Parameter has no `wired` binding (pending / unavailable) — UI state kept, no engine effect. */
  | 'unsupported'
  /** Dispatcher intentionally does nothing (noop dispatcher / unhandled command kind). */
  | 'noop'
  /** dryRun mode — the dispatcher computed the engine value but did not apply it. */
  | 'dry-run'
  /** The engine threw / rejected the write.  UI state preserved (no rollback in this phase). */
  | 'failed';

export interface DispatchResult {
  status: DispatchStatus;
  /** The command that produced this result (self-contained for the log view). */
  command: EngineCommand;
  /** `performance.now()` at dispatch time. */
  timestamp: number;
  /** Resolved EngineSchema module type (when the command targets one). */
  engineModule?: EngineModuleType | null;
  /** Resolved EngineSchema parameter path. */
  enginePath?: string;
  /** Converted engine-space value (after UI → engine conversion). */
  engineValue?: ParameterValue;
  /** Human-readable note for the log / dev UI. */
  note?: string;
}

export interface EngineDispatcher {
  /** Stable identifier for logs / dev UI. */
  readonly name: string;
  /** Translate + (maybe) apply a command.  Never throws. */
  dispatch(command: EngineCommand): DispatchResult;
  /** Optional — current staged preset-patch fragments. */
  getStagedPatch?(): StagedPatchEntry[];
  /** Optional — clear any staged state. */
  reset?(): void;
}

/** One accumulated preset-patch fragment (engine-space). */
export interface StagedPatchEntry {
  moduleType: EngineModuleType;
  path: string;
  value: ParameterValue;
  /** Which UI (moduleId, parameterId) produced this fragment. */
  sourceModuleId: ModuleId;
  sourceParameterId: string;
}

// ── Value conversion (UI space → engine space) ───────────────────────────

/**
 * Convert a UI parameter value into engine space per the mapping in
 * `docs/.../m3-product-next-5a/04-PARAMETER-SCHEMA-MAPPING.md`.
 *
 * Most parameters pass through unchanged; a few need scaling.
 */
export function toEngineValue(
  moduleId: ModuleId,
  parameterId: string,
  value: ParameterValue,
): { engineValue: ParameterValue; note?: string } {
  // Imager width: UI 0..200 % → engine 0..2.0 multiplier (1.0 = passthrough).
  if (moduleId === 'imager' && (parameterId === 'widthPct'
    || parameterId === 'bandLowPct' || parameterId === 'bandMidLowPct'
    || parameterId === 'bandMidHighPct' || parameterId === 'bandHighPct')) {
    if (typeof value === 'number') {
      return { engineValue: value / 100, note: 'ui%/100 → engine multiplier' };
    }
  }
  // Limiter ISP toggle: boolean → oversample factor.
  if (moduleId === 'limiter' && parameterId === 'isp') {
    return { engineValue: value ? 4 : 1, note: 'ISP on→4×, off→1×' };
  }
  return { engineValue: value };
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// ── PresetPatchDispatcher — the production-safe 1st connection ───────────

/**
 * Translates `wired` parameters into EngineSchema patch fragments and
 * accumulates them.  Does NOT trigger a render or touch live DSP.
 *
 *   • `SET_MODULE_PARAM` (wired)        → `staged`
 *   • `SET_MODULE_PARAM` (pending/unavail) → `unsupported`
 *   • `SET_MODULE_BYPASS`               → `unsupported` (bypass bindings all pending)
 *   • `RESET_MODULE`                    → `staged` (clears that module's fragments)
 *   • everything else                   → `noop`
 *
 * The accumulated patch is exposed via `getStagedPatch()` for the future
 * offline-render / live-engine consumer (M3-P-NEXT-5C).
 */
export class PresetPatchDispatcher implements EngineDispatcher {
  readonly name: string;
  private patch = new Map<string, StagedPatchEntry>();
  private dryRun: boolean;

  constructor(
    private readonly defs: AllModulesDefinitions,
    opts: { dryRun?: boolean; name?: string } = {},
  ) {
    this.dryRun = opts.dryRun ?? false;
    this.name = opts.name ?? (this.dryRun ? 'preset-patch (dry-run)' : 'preset-patch');
  }

  dispatch(command: EngineCommand): DispatchResult {
    const base = { command, timestamp: now() };
    switch (command.kind) {
      case 'SET_MODULE_PARAM': {
        const def = findParameterDef(this.defs, command.moduleId, command.parameterId);
        const binding = def.binding;
        if (binding.status !== 'wired') {
          return {
            ...base,
            status: 'unsupported',
            engineModule: binding.moduleType,
            enginePath: binding.path,
            note: `binding status=${binding.status} — UI state kept, no engine effect`,
          };
        }
        const { engineValue, note } = toEngineValue(command.moduleId, command.parameterId, command.value);
        if (this.dryRun) {
          return {
            ...base,
            status: 'dry-run',
            engineModule: binding.moduleType,
            enginePath: binding.path,
            engineValue,
            note: note ? `dry-run · ${note}` : 'dry-run · would stage',
          };
        }
        if (binding.moduleType) {
          this.patch.set(`${binding.moduleType}:${binding.path}`, {
            moduleType: binding.moduleType,
            path: binding.path,
            value: engineValue,
            sourceModuleId: command.moduleId,
            sourceParameterId: command.parameterId,
          });
        }
        return {
          ...base,
          status: 'staged',
          engineModule: binding.moduleType,
          enginePath: binding.path,
          engineValue,
          note: note ? `staged · ${note}` : 'staged into preset patch (not yet rendered)',
        };
      }
      case 'SET_MODULE_BYPASS': {
        const bypassBinding = this.defs[command.moduleId].bypassBinding;
        return {
          ...base,
          status: 'unsupported',
          engineModule: bypassBinding.moduleType,
          enginePath: bypassBinding.path,
          note: `bypass binding status=${bypassBinding.status} — not wired yet`,
        };
      }
      case 'RESET_MODULE': {
        if (!this.dryRun) {
          for (const [key, entry] of this.patch) {
            if (entry.sourceModuleId === command.moduleId) this.patch.delete(key);
          }
        }
        return {
          ...base,
          status: this.dryRun ? 'dry-run' : 'staged',
          note: `module "${command.moduleId}" reset — staged fragments cleared`,
        };
      }
      default:
        return { ...base, status: 'noop', note: `${command.kind} not handled by preset-patch dispatcher` };
    }
  }

  getStagedPatch(): StagedPatchEntry[] {
    return [...this.patch.values()];
  }

  reset(): void {
    this.patch.clear();
  }
}
