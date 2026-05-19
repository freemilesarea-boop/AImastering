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

import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { ALL_MODULE_PARAMETER_DEFS } from './module-parameter-definitions.js';
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
  children: React.ReactNode;
}

export function ModuleParameterStateProvider(props: ModuleParameterStateProviderProps) {
  const defs = props.defs ?? ALL_MODULE_PARAMETER_DEFS;
  const [state, setState] = useState<AllModulesParameterState>(
    () => props.initialState ?? defaultAllModulesState(defs),
  );
  const [log, setLog] = useState<EngineCommand[]>([]);
  const capacity = props.logCapacity ?? 256;

  const appendLog = useCallback((cmd: EngineCommand) => {
    setLog((prev) => {
      const next = prev.length >= capacity ? prev.slice(prev.length - capacity + 1) : prev.slice();
      next.push(cmd);
      return next;
    });
    props.onCommand?.(cmd);
  }, [capacity, props]);

  const setParam = useCallback((
    moduleId: ModuleId,
    parameterId: string,
    candidate: unknown,
    source: CommandSource = 'user',
  ) => {
    const cmd = makeSetParamCommand({ defs, moduleId, parameterId, candidate, source });
    appendLog(cmd);
    // Skip state mutation when the validator rejected the value.
    if (cmd.validation.status === 'rejected') return;
    setState((s) => ({
      ...s,
      [moduleId]: {
        ...s[moduleId],
        parameters: { ...s[moduleId].parameters, [parameterId]: cmd.value as ParameterValue },
      },
    }));
  }, [appendLog, defs]);

  const setBypass = useCallback((moduleId: ModuleId, bypass: boolean, source: CommandSource = 'user') => {
    appendLog(makeSetBypassCommand({ moduleId, bypass, source }));
    setState((s) => ({
      ...s,
      [moduleId]: { ...s[moduleId], bypass },
    }));
  }, [appendLog]);

  const resetModule = useCallback((moduleId: ModuleId, source: CommandSource = 'reset') => {
    appendLog(makeResetModuleCommand({ moduleId, source }));
    setState((s) => ({ ...s, [moduleId]: defaultStateForModule(defs[moduleId]) }));
  }, [appendLog, defs]);

  const clearLog = useCallback(() => setLog([]), []);

  const value: ParameterStateContextValue = useMemo(() => ({
    state, defs, log, setParam, setBypass, resetModule, clearLog,
  }), [state, defs, log, setParam, setBypass, resetModule, clearLog]);

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

/** Render a command as a single-line string.  Re-exported for ergonomics. */
export { describeCommand };
