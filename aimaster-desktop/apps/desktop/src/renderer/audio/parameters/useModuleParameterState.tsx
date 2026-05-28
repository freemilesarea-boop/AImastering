// Central UI parameter state provider + hooks.
//
// Architecture
//   <ModuleParameterStateProvider> mounts once near the top of
//   ProductPage.  It owns the all-modules state snapshot, dispatches
//   typed commands, and appends each command to a rolling log.
//
//   Panels consume their slice via `useModuleParameters(moduleId)`,
//   which returns:
//     • state           — the current parameter values
//     • bypass / setBypass
//     • setParam(id, value, source?)
//     • reset(source?)
//     • isModified      — whether any parameter differs from default
//     • def             — the module's parameter definition list
//
//   The command log is exposed via `useEngineCommandLog()` for dev
//   tooling / Storybook.
//
// NOTHING in this module touches the DSP chain.  When M3-P-NEXT-5B
// arrives, the provider gains an `engineDispatcher` prop that
// forwards each command to the real engine bridge.

import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { ALL_MODULE_PARAMETER_DEFS } from './module-parameter-definitions.js';
import type { DispatchResult, EngineDispatcher } from '../engine-bridge/engine-dispatcher.js';
import { NOOP_DISPATCHER } from '../engine-bridge/noop-engine-dispatcher.js';
import {
  defaultAllModulesState,
  defaultStateForModule,
  type AllModulesDefinitions,
  type AllModulesParameterState,
  type ModuleId,
  type ModuleParameterState,
  type ParameterValue,
} from './parameter-state.js';
import {
  describeCommand,
  makeResetModuleCommand,
  makeSetBypassCommand,
  makeSetParamCommand,
  type CommandSource,
  type EngineCommand,
  type LoadPresetCommand,
} from './engine-command.js';
import type { PresetApplyPlan } from '../presets/preset-to-state.js';

// ── Context shape ────────────────────────────────────────────────────────

interface ParameterStateContextValue {
  state: AllModulesParameterState;
  defs: AllModulesDefinitions;
  /** Full append-only command log.  Capped at `logCapacity` entries. */
  log: readonly EngineCommand[];
  /** Append-only dispatch-result log.  Capped at `logCapacity` entries. */
  dispatchLog: readonly DispatchResult[];
  /** Name of the active engine dispatcher (for dev UI). */
  dispatcherName: string;
  setParam: (moduleId: ModuleId, parameterId: string, candidate: unknown, source?: CommandSource) => void;
  setBypass: (moduleId: ModuleId, bypass: boolean, source?: CommandSource) => void;
  resetModule: (moduleId: ModuleId, source?: CommandSource) => void;
  /**
   * Apply a whole preset's tuning in one batch: validates + clamps every
   * parameter, merges state in a single update, and dispatches the wired
   * commands so the export path stays consistent with the preview.
   */
  applyPreset: (plan: PresetApplyPlan, meta?: { presetId?: string; presetName?: string; source?: CommandSource }) => void;
  clearLog: () => void;
  /** Replace the full state in one shot — used by undo/redo + custom-preset load. */
  replaceState: (next: AllModulesParameterState, source?: CommandSource) => void;
  /** Step one entry back in the history stack. */
  undo: () => void;
  /** Step one entry forward in the (redo) stack — empty after any new edit. */
  redo: () => void;
  /** Whether there is a state to undo to. */
  canUndo: boolean;
  /** Whether there is a state to redo to. */
  canRedo: boolean;
}

/** History cap — keeps memory bounded while remaining far above realistic use. */
const HISTORY_CAP = 64;
/** Coalesce window — repeated edits on the same target within this ms reuse the same history slot. */
const COALESCE_MS = 500;

const ParameterStateContext = createContext<ParameterStateContextValue | null>(null);

// ── Provider ─────────────────────────────────────────────────────────────

export interface ModuleParameterStateProviderProps {
  /** Override the all-modules default snapshot (Storybook / tests). */
  initialState?: AllModulesParameterState;
  /** Override the parameter definitions (rare — keep wired to canonical defs). */
  defs?: AllModulesDefinitions;
  /** Max log entries kept in memory.  Default 256. */
  logCapacity?: number;
  /** Optional sink the provider mirrors every command into (dev tooling). */
  onCommand?: (cmd: EngineCommand) => void;
  /**
   * Engine dispatcher — receives every accepted (ok / clamped) command.
   * Defaults to the no-op dispatcher (no engine connected).  Rejected
   * commands are NEVER dispatched.  The result of each dispatch is
   * appended to `dispatchLog`.
   */
  dispatcher?: EngineDispatcher;
  children: React.ReactNode;
}

export function ModuleParameterStateProvider(props: ModuleParameterStateProviderProps) {
  const defs = props.defs ?? ALL_MODULE_PARAMETER_DEFS;
  const [state, setState] = useState<AllModulesParameterState>(
    () => props.initialState ?? defaultAllModulesState(defs),
  );
  const [log, setLog] = useState<EngineCommand[]>([]);
  const [dispatchLog, setDispatchLog] = useState<DispatchResult[]>([]);
  const capacity = props.logCapacity ?? 256;

  // ── Undo/redo history ──────────────────────────────────────────────
  // Past = states BEFORE recent edits (oldest at index 0).  Future =
  // states forfeited by undo; cleared on any new edit.  Repeated edits
  // on the same parameter inside COALESCE_MS reuse the top history slot
  // so dragging a slider doesn't flood the stack with one entry per pixel.
  const pastRef = useRef<AllModulesParameterState[]>([]);
  const futureRef = useRef<AllModulesParameterState[]>([]);
  const lastPushAt = useRef(0);
  const lastPushKey = useRef('');
  const stateRef = useRef(state);
  stateRef.current = state;
  // Force-update counter so canUndo/canRedo recompute when refs change.
  const [historyTick, setHistoryTick] = useState(0);
  const bumpHistory = useCallback(() => setHistoryTick((n) => (n + 1) | 0), []);

  const pushHistory = useCallback((prev: AllModulesParameterState, key: string) => {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const sameAsLast = key === lastPushKey.current && (now - lastPushAt.current) < COALESCE_MS;
    if (!sameAsLast) {
      pastRef.current.push(prev);
      if (pastRef.current.length > HISTORY_CAP) pastRef.current.shift();
    }
    lastPushAt.current = now;
    lastPushKey.current = key;
    if (futureRef.current.length > 0) futureRef.current = [];
    bumpHistory();
  }, [bumpHistory]);

  const undo = useCallback(() => {
    const prev = pastRef.current.pop();
    if (!prev) return;
    futureRef.current.push(stateRef.current);
    if (futureRef.current.length > HISTORY_CAP) futureRef.current.shift();
    lastPushKey.current = '__undo__'; // break coalescing
    setState(prev);
    bumpHistory();
  }, [bumpHistory]);

  const redo = useCallback(() => {
    const next = futureRef.current.pop();
    if (!next) return;
    pastRef.current.push(stateRef.current);
    if (pastRef.current.length > HISTORY_CAP) pastRef.current.shift();
    lastPushKey.current = '__redo__';
    setState(next);
    bumpHistory();
  }, [bumpHistory]);

  // Keep the dispatcher in a ref so callbacks stay stable even if the
  // caller passes a freshly-constructed dispatcher each render.
  const dispatcherRef = useRef<EngineDispatcher>(props.dispatcher ?? NOOP_DISPATCHER);
  dispatcherRef.current = props.dispatcher ?? NOOP_DISPATCHER;

  const appendLog = useCallback((cmd: EngineCommand) => {
    setLog((prev) => {
      const next = prev.length >= capacity ? prev.slice(prev.length - capacity + 1) : prev.slice();
      next.push(cmd);
      return next;
    });
    props.onCommand?.(cmd);
  }, [capacity, props]);

  const appendDispatch = useCallback((result: DispatchResult) => {
    setDispatchLog((prev) => {
      const next = prev.length >= capacity ? prev.slice(prev.length - capacity + 1) : prev.slice();
      next.push(result);
      return next;
    });
  }, [capacity]);

  // Dispatch an accepted command and record the result.  Never throws —
  // a dispatcher that misbehaves is caught and logged as `failed`.
  const dispatch = useCallback((cmd: EngineCommand) => {
    let result: DispatchResult;
    try {
      result = dispatcherRef.current.dispatch(cmd);
    } catch (err) {
      result = {
        status: 'failed',
        command: cmd,
        timestamp: typeof performance !== 'undefined' ? performance.now() : Date.now(),
        note: `dispatcher threw: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    appendDispatch(result);
  }, [appendDispatch]);

  const setParam = useCallback((
    moduleId: ModuleId,
    parameterId: string,
    candidate: unknown,
    source: CommandSource = 'user',
  ) => {
    const cmd = makeSetParamCommand({ defs, moduleId, parameterId, candidate, source });
    appendLog(cmd);
    // Rejected commands: keep UI state, never dispatch.
    if (cmd.validation.status === 'rejected') return;
    // History snapshot BEFORE the change (coalesces drag-as-one-undo).
    if (source === 'user') pushHistory(stateRef.current, `setParam:${moduleId}:${parameterId}`);
    // Optimistic UI update (no rollback on engine failure in this phase).
    setState((s) => ({
      ...s,
      [moduleId]: {
        ...s[moduleId],
        parameters: { ...s[moduleId].parameters, [parameterId]: cmd.value as ParameterValue },
      },
    }));
    // Dispatch ok / clamped commands to the engine.
    dispatch(cmd);
  }, [appendLog, defs, dispatch, pushHistory]);

  const setBypass = useCallback((moduleId: ModuleId, bypass: boolean, source: CommandSource = 'user') => {
    const cmd = makeSetBypassCommand({ moduleId, bypass, source });
    appendLog(cmd);
    if (source === 'user') pushHistory(stateRef.current, `setBypass:${moduleId}`);
    setState((s) => ({
      ...s,
      [moduleId]: { ...s[moduleId], bypass },
    }));
    dispatch(cmd);
  }, [appendLog, dispatch, pushHistory]);

  const resetModule = useCallback((moduleId: ModuleId, source: CommandSource = 'reset') => {
    const cmd = makeResetModuleCommand({ moduleId, source });
    appendLog(cmd);
    pushHistory(stateRef.current, `reset:${moduleId}`);
    setState((s) => ({ ...s, [moduleId]: defaultStateForModule(defs[moduleId]) }));
    dispatch(cmd);
  }, [appendLog, defs, dispatch, pushHistory]);

  const replaceState = useCallback((next: AllModulesParameterState, source: CommandSource = 'user') => {
    pushHistory(stateRef.current, `replaceState:${source}`);
    setState(next);
  }, [pushHistory]);

  const applyPreset = useCallback((
    plan: PresetApplyPlan,
    meta: { presetId?: string; presetName?: string; source?: CommandSource } = {},
  ) => {
    const source: CommandSource = meta.source ?? 'preset';

    // Log a LOAD_PRESET marker so the command log shows the ripple origin.
    if (meta.presetId) {
      const loadCmd: LoadPresetCommand = {
        kind: 'LOAD_PRESET',
        timestamp: typeof performance !== 'undefined' ? performance.now() : Date.now(),
        source,
        presetId: meta.presetId,
        ...(meta.presetName ? { presetName: meta.presetName } : {}),
      };
      appendLog(loadCmd);
    }

    // Pre-build + validate every command (pure — no state writes yet).
    const paramCmds = plan.parameters.map((e) => ({
      e,
      cmd: makeSetParamCommand({ defs, moduleId: e.moduleId, parameterId: e.parameterId, candidate: e.value, source }),
    }));
    const bypassCmds = plan.bypasses.map((b) =>
      makeSetBypassCommand({ moduleId: b.moduleId, bypass: b.bypass, source }),
    );

    for (const { cmd } of paramCmds) appendLog(cmd);
    for (const cmd of bypassCmds) appendLog(cmd);

    // History snapshot before the bulk preset apply (so undo restores
    // whatever the user had before).  Coalesced under a single key per
    // preset so applying the same preset twice doesn't pile up entries.
    pushHistory(stateRef.current, `applyPreset:${meta.presetId ?? 'unknown'}`);

    // Single merged state update — accepted (ok/clamped) params + bypasses.
    setState((s) => {
      const next: AllModulesParameterState = { ...s };
      for (const { e, cmd } of paramCmds) {
        if (cmd.validation.status === 'rejected') continue;
        next[e.moduleId] = {
          ...next[e.moduleId],
          parameters: { ...next[e.moduleId].parameters, [e.parameterId]: cmd.value as ParameterValue },
        };
      }
      for (const cmd of bypassCmds) {
        next[cmd.moduleId] = { ...next[cmd.moduleId], bypass: cmd.bypass };
      }
      return next;
    });

    // Dispatch accepted commands to the engine (export staging).
    for (const { cmd } of paramCmds) {
      if (cmd.validation.status !== 'rejected') dispatch(cmd);
    }
    for (const cmd of bypassCmds) dispatch(cmd);
  }, [appendLog, defs, dispatch, pushHistory]);

  const clearLog = useCallback(() => { setLog([]); setDispatchLog([]); }, []);

  const dispatcherName = dispatcherRef.current.name;

  const canUndo = pastRef.current.length > 0;
  const canRedo = futureRef.current.length > 0;

  const value: ParameterStateContextValue = useMemo(() => ({
    state, defs, log, dispatchLog, dispatcherName,
    setParam, setBypass, resetModule, applyPreset, clearLog,
    replaceState, undo, redo, canUndo, canRedo,
  }), [state, defs, log, dispatchLog, dispatcherName, setParam, setBypass, resetModule, applyPreset, clearLog, replaceState, undo, redo, canUndo, canRedo, historyTick]);

  return (
    <ParameterStateContext.Provider value={value}>
      {props.children}
    </ParameterStateContext.Provider>
  );
}

// ── Hooks ────────────────────────────────────────────────────────────────

/** Internal — read the raw context.  Throws if used outside the provider. */
function useParameterStateContext(): ParameterStateContextValue {
  const ctx = useContext(ParameterStateContext);
  if (!ctx) {
    throw new Error(
      '[useModuleParameterState] component used outside ModuleParameterStateProvider',
    );
  }
  return ctx;
}

/**
 * Returns whether the calling tree is inside a parameter-state provider.
 * Useful for components (panels) that want to operate controlled when a
 * provider is present and self-managed otherwise.
 */
export function hasParameterStateProvider(): boolean {
  return useContext(ParameterStateContext) !== null;
}

export interface ModuleParameterApi {
  /** Snapshot of this module's UI parameter state. */
  state: ModuleParameterState;
  /** Module-level bypass flag. */
  bypass: boolean;
  /** Whether any parameter currently differs from its default value. */
  isModified: boolean;
  /** All parameter definitions for this module (label / range / formatter). */
  def: AllModulesDefinitions[ModuleId];
  /** Read a single parameter value with a fall-back to default. */
  get: (parameterId: string) => ParameterValue;
  /** Update a parameter (validates + clamps + logs a SET_MODULE_PARAM command). */
  setParam: (parameterId: string, candidate: unknown, source?: CommandSource) => void;
  /** Toggle / set the module's bypass (SET_MODULE_BYPASS). */
  setBypass: (bypass: boolean, source?: CommandSource) => void;
  /** Reset every parameter (and bypass = false) to defaults (RESET_MODULE). */
  reset: (source?: CommandSource) => void;
}

/**
 * Hook for a single module's slice of the parameter state.
 *
 * Throws if used outside `<ModuleParameterStateProvider>`.  Panels that
 * want to work in both controlled (provider present) and standalone
 * (Storybook story) modes should fall back to local state when the
 * provider is absent — see the panel implementations.
 */
export function useModuleParameters(moduleId: ModuleId): ModuleParameterApi {
  const ctx = useParameterStateContext();
  const moduleState = ctx.state[moduleId];
  const moduleDef = ctx.defs[moduleId];

  const isModified = useMemo(() => {
    if (moduleState.bypass) return true;
    for (const p of moduleDef.parameters) {
      if (moduleState.parameters[p.id] !== p.default) return true;
    }
    return false;
  }, [moduleState, moduleDef]);

  const get = useCallback((parameterId: string): ParameterValue => {
    const v = moduleState.parameters[parameterId];
    if (v !== undefined) return v;
    const def = moduleDef.parameters.find((d) => d.id === parameterId);
    return def?.default ?? '';
  }, [moduleState, moduleDef]);

  const setParam = useCallback((parameterId: string, candidate: unknown, source?: CommandSource) => {
    ctx.setParam(moduleId, parameterId, candidate, source);
  }, [ctx, moduleId]);

  const setBypass = useCallback((bypass: boolean, source?: CommandSource) => {
    ctx.setBypass(moduleId, bypass, source);
  }, [ctx, moduleId]);

  const reset = useCallback((source?: CommandSource) => {
    ctx.resetModule(moduleId, source);
  }, [ctx, moduleId]);

  return {
    state: moduleState,
    bypass: moduleState.bypass,
    isModified,
    def: moduleDef,
    get,
    setParam,
    setBypass,
    reset,
  };
}

/** Subscribe to the full command log (newest commands appended). */
export function useEngineCommandLog(): {
  log: readonly EngineCommand[];
  clear: () => void;
} {
  const ctx = useParameterStateContext();
  return { log: ctx.log, clear: ctx.clearLog };
}

/** Subscribe to the engine dispatch-result log + active dispatcher name. */
export function useEngineDispatchLog(): {
  dispatchLog: readonly DispatchResult[];
  dispatcherName: string;
  clear: () => void;
} {
  const ctx = useParameterStateContext();
  return { dispatchLog: ctx.dispatchLog, dispatcherName: ctx.dispatcherName, clear: ctx.clearLog };
}

/**
 * Read the full all-modules parameter state + defs.  Re-renders on any
 * parameter change.  Used by the pending-summary computation, which spans
 * multiple modules.
 */
export function useAllModuleParameters(): {
  state: AllModulesParameterState;
  defs: AllModulesDefinitions;
} {
  const ctx = useParameterStateContext();
  return { state: ctx.state, defs: ctx.defs };
}

/**
 * Apply a Loui preset's tuning to the parameter state in one batch.
 * Returns a stable callback; pass the preset's apply plan + metadata.
 * Throws if used outside `<ModuleParameterStateProvider>`.
 */
export function useApplyPreset(): ParameterStateContextValue['applyPreset'] {
  return useParameterStateContext().applyPreset;
}

/** Undo / redo the central parameter state. */
export function useUndoRedo(): {
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
} {
  const ctx = useParameterStateContext();
  return { undo: ctx.undo, redo: ctx.redo, canUndo: ctx.canUndo, canRedo: ctx.canRedo };
}

/** Replace the entire parameter state in one shot (custom-preset load). */
export function useReplaceParameterState(): ParameterStateContextValue['replaceState'] {
  return useParameterStateContext().replaceState;
}

/** Render a command as a single-line string.  Re-exported for ergonomics. */
export { describeCommand };
