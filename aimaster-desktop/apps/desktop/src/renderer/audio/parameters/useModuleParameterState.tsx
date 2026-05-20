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
} from './engine-command.js';

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
  clearLog: () => void;
}

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
  }, [appendLog, defs, dispatch]);

  const setBypass = useCallback((moduleId: ModuleId, bypass: boolean, source: CommandSource = 'user') => {
    const cmd = makeSetBypassCommand({ moduleId, bypass, source });
    appendLog(cmd);
    setState((s) => ({
      ...s,
      [moduleId]: { ...s[moduleId], bypass },
    }));
    dispatch(cmd);
  }, [appendLog, dispatch]);

  const resetModule = useCallback((moduleId: ModuleId, source: CommandSource = 'reset') => {
    const cmd = makeResetModuleCommand({ moduleId, source });
    appendLog(cmd);
    setState((s) => ({ ...s, [moduleId]: defaultStateForModule(defs[moduleId]) }));
    dispatch(cmd);
  }, [appendLog, defs, dispatch]);

  const clearLog = useCallback(() => { setLog([]); setDispatchLog([]); }, []);

  const dispatcherName = dispatcherRef.current.name;

  const value: ParameterStateContextValue = useMemo(() => ({
    state, defs, log, dispatchLog, dispatcherName,
    setParam, setBypass, resetModule, clearLog,
  }), [state, defs, log, dispatchLog, dispatcherName, setParam, setBypass, resetModule, clearLog]);

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

/** Render a command as a single-line string.  Re-exported for ergonomics. */
export { describeCommand };
