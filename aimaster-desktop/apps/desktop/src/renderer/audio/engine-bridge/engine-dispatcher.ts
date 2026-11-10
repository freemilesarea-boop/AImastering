// Engine dispatcher — the seam between UI parameter commands and a real
// DSP engine.
//
// M3-P-NEXT-5B scope (read carefully):
//   • This is the FIRST connection — only the parameters whose binding
//     status is `wired` get translated into engine space.
//   • This dispatcher performs no DSP write: the app installs
//     `NOOP_DISPATCHER`, so nothing here reaches an engine.  It does NOT
//     follow that parameter edits are inaudible — this header used to say
//     the preview "plays a pre-rendered file" and stop there.  The file is
//     the source; the parameter state is built into a chain config on every
//     edit and posted to the mastering worklet, so an edit is heard while
//     the file plays.  What is still true is that it does not come through
//     THIS seam.  `runPreset` DOES now run the preset's own
//     loudness target, true-peak ceiling and limiter strength rather than its
//     bucket's — it used to render every preset in a bucket identically — but
//     it is an offline render of a saved preset, not a live parameter write.
//     The stages with no field in the schema (gain staging, transient
//     protection, the vocal enhancer) still run the bucket's numbers; see
//     `audio/preset/runPreset.ts`.  So "applied" is not yet a reachable
//     status for any real dispatcher.
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


// ── What is left of this seam ────────────────────────────────────────────
//
// `PresetPatchDispatcher` lived here: it turned a parameter command into an
// EngineSchema patch fragment and accumulated it, exposing the result via
// `getStagedPatch()` "for the future offline-render / live-engine consumer
// (M3-P-NEXT-5C)".  That consumer was `preview-render-client.ts`, which with
// its transport, its mocks and the barrel that exported them is gone — the
// app applies a parameter change by rebuilding the chain config from state
// and letting the worklet and the render read it, so nothing ever staged a
// patch.  Nothing constructed the class either, not even a test.
//
// Its routing also still spoke of bypass bindings with `status: 'pending'`,
// which stopped existing when all 23 bindings were measured and marked
// `wired`.
//
// What remains is the seam itself: `EngineDispatcher`, its result types, and
// `toEngineValue` (which `pending-summary.ts` uses).  The app installs
// `NOOP_DISPATCHER`, so every accepted command is handed to something that
// does nothing.  That is a design state, not dead code — `useModuleParameterState`
// really does call it — so taking the seam out of the hook is a separate
// decision from this clean-up, and it is not made here.
