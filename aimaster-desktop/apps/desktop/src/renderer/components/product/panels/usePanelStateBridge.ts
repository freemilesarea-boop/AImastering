// Bridge hook — accept controlled props OR fall back to local state.
//
// Every parameter panel (EQ / Dynamics / …) supports two modes:
//   • Controlled — caller passes `state` + `onParamChange` (etc.)
//     Production: ProductPage wires this from `useModuleParameters()`.
//   • Uncontrolled — no props passed.  The panel manages its own
//     local useState, mirroring the M3-P-NEXT-4 behaviour.
//
// This file centralises the merge so each panel stays small.

import { useCallback, useState } from 'react';
import type { ParameterValue } from '../../../audio/parameters/index.js';

export type ParamRecord = Record<string, ParameterValue>;

export interface ControlledPanelProps {
  /** Caller-supplied parameter state.  When provided, this is the source of truth. */
  state?: ParamRecord;
  /** Caller-supplied bypass flag. */
  bypass?: boolean;
  /** Caller-supplied modified flag (drives the slide-over header badge). */
  isModified?: boolean;
  /** Caller-supplied per-parameter setter. */
  onParamChange?: (parameterId: string, value: ParameterValue) => void;
  /** Caller-supplied bypass setter. */
  onBypassChange?: (bypass: boolean) => void;
  /** Caller-supplied reset action. */
  onReset?: () => void;
}

export interface PanelStateBridge<TState> {
  /** Effective state — caller value or local fallback. */
  state: TState;
  bypass: boolean;
  /** Setter that calls either the controlled `onParamChange` or local setState. */
  setParam: <K extends keyof TState>(parameterId: K, value: TState[K]) => void;
  setBypass: (b: boolean) => void;
  reset: () => void;
}

/**
 * Choose between controlled props and uncontrolled local state.
 *
 * `defaults` becomes the initial local state when no `props.state` is
 * supplied.  When `props.state` is provided, the caller owns the data
 * flow and the local fallback is unused.
 *
 * The generic `TState` is unconstrained — each panel defines its own
 * narrow shape (e.g. `EqState`), and the bridge casts the loosely-typed
 * controlled `state` prop back to that shape at the merge point.  We
 * trust ProductPage to pass keys that match the panel's expectations
 * (the central parameter definitions enforce this contract).
 */
export function usePanelStateBridge<TState>(
  defaults: TState,
  props: ControlledPanelProps,
  defaultsReset: () => TState = () => ({ ...(defaults as object) } as TState),
): PanelStateBridge<TState> {
  const [local, setLocal] = useState<TState>(defaults);
  const [localBypass, setLocalBypass] = useState<boolean>(false);

  const controlled = props.state !== undefined;
  const state: TState = controlled ? (props.state as unknown as TState) : local;
  const bypass = props.bypass ?? localBypass;

  const setParam = useCallback(<K extends keyof TState>(parameterId: K, value: TState[K]) => {
    if (props.onParamChange) {
      props.onParamChange(parameterId as string, value as unknown as ParameterValue);
      return;
    }
    setLocal((prev) => ({ ...(prev as object), [parameterId]: value } as TState));
  }, [props]);

  const setBypass = useCallback((b: boolean) => {
    if (props.onBypassChange) { props.onBypassChange(b); return; }
    setLocalBypass(b);
  }, [props]);

  const reset = useCallback(() => {
    if (props.onReset) { props.onReset(); return; }
    setLocal(defaultsReset());
    setLocalBypass(false);
  }, [props, defaultsReset]);

  return { state, bypass, setParam, setBypass, reset };
}
