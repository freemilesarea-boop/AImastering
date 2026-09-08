// Realtime mastering preview — Rust MasteringChain (WASM) wrapper (M2-full).
//
// Wraps `LouiMasteringChain` from @loui/dsp-wasm and maps the product
// UI's parameter state into the chain's config.
//
// Two paths exist:
//
//   • `stateToChainConfig` / `applyChainConfig` — the original flat,
//     five-module positional config.  Retained for the legacy worklet
//     message shape and the tests written against it.
//   • `stateToSuiteConfig` / `applySuiteConfig` — the full module suite via
//     `setConfigJson`.  This is what the product uses; it reaches every
//     module, and the same config object drives the offline export.
//
// Scope: this module is the renderer-side bridge.  The AudioWorklet tap
// that calls `process()` per block (main-thread WASM, mirroring the
// analyzer tap) is wired only when the realtime-preview flag is on; when
// off, the existing re-render preview is used unchanged.
//
// The preview is a low-latency APPROXIMATION; the final export remains
// the offline render.  Both consume the same parameter values.

import type { AllModulesParameterState } from './parameters/index.js';
import { buildChainConfig, chainConfigToJson, type ChainConfigWire } from './chain-config.js';

/** Flat config the WASM chain's `setConfig` accepts (UI-space units). */
export interface RealtimeChainConfig {
  inputGainDb: number;
  eqLowCutHz: number; eqLowShelfDb: number; eqPresenceDb: number; eqAirDb: number;
  eqAdaptive: boolean; eqBypass: boolean;
  dynThresholdDb: number; dynRatio: number; dynAttackMs: number; dynReleaseMs: number;
  dynMixPct: number; dynBypass: boolean;
  imgWidthPct: number; imgLowMonoHz: number; imgBypass: boolean;
  limCeilingDbtp: number; limLookaheadMs: number; limIsp: boolean; limBypass: boolean;
  outputGainDb: number;
  masterBypass: boolean;
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

/**
 * Map the central parameter state → the realtime chain config.  Pure.
 * Mirrors the module-parameter-definitions ids exactly.
 */
export function stateToChainConfig(state: AllModulesParameterState): RealtimeChainConfig {
  const eq = state.eq.parameters;
  const dyn = state.dynamics.parameters;
  const img = state.imager.parameters;
  const lim = state.limiter.parameters;
  return {
    // EQ output gain doubles as the chain's input gain staging.
    inputGainDb: 0,
    eqLowCutHz:   num(eq['lowCutHz'], 32),
    eqLowShelfDb: num(eq['lowShelfDb'], 0),
    eqPresenceDb: num(eq['presenceDb'], 0),
    eqAirDb:      num(eq['airDb'], 0),
    eqAdaptive:   bool(eq['adaptive'], false),
    eqBypass:     state.eq.bypass,
    dynThresholdDb: num(dyn['thresholdDb'], 0),
    dynRatio:       num(dyn['ratio'], 1),
    dynAttackMs:    num(dyn['attackMs'], 10),
    dynReleaseMs:   num(dyn['releaseMs'], 120),
    dynMixPct:      num(dyn['mixPct'], 100),
    dynBypass:      state.dynamics.bypass,
    imgWidthPct:   num(img['widthPct'], 100),
    imgLowMonoHz:  num(img['lowMonoHz'], 20),
    imgBypass:     state.imager.bypass,
    limCeilingDbtp: num(lim['ceilingDbtp'], -1),
    limLookaheadMs: num(lim['lookaheadMs'], 2.5),
    limIsp:         bool(lim['isp'], true),
    limBypass:      state.limiter.bypass,
    // eq.outputGainDb drives the chain's output gain.
    outputGainDb: num(eq['outputGainDb'], 0),
    masterBypass: false,
  };
}

/**
 * Build the full-suite chain config from parameter state.
 *
 * `eq.outputGainDb` doubles as the chain's output trim, matching the
 * behaviour the flat config has always had.
 */
export function stateToSuiteConfig(
  state: AllModulesParameterState,
  opts?: { matchTargetCurveDb?: readonly number[]; masterBypass?: boolean },
): ChainConfigWire {
  // `outputGainDb` is not passed: the builder reads the EQ module's knob
  // itself, so every caller gets the same behaviour.
  return buildChainConfig({
    state,
    ...(opts?.masterBypass ? { masterBypass: true } : {}),
    ...(opts?.matchTargetCurveDb ? { matchTargetCurveDb: opts.matchTargetCurveDb } : {}),
  });
}

/**
 * Apply a full-suite config to a chain handle.
 *
 * Returns false when the chain has no JSON path (an older WASM build) so
 * the caller can fall back to {@link applyChainConfig} rather than silently
 * leaving the chain at its previous settings.
 */
export function applySuiteConfig(chain: SuiteCapableChain, cfg: ChainConfigWire): boolean {
  if (typeof chain.setConfigJson !== 'function') return false;
  chain.setConfigJson(chainConfigToJson(cfg));
  return true;
}

/** Minimal structural type for the WASM chain (avoids a hard import here). */
interface WasmChain {
  setConfig(
    inputGainDb: number,
    eqLowCutHz: number, eqLowShelfDb: number, eqPresenceDb: number, eqAirDb: number,
    eqAdaptive: boolean, eqBypass: boolean,
    dynThresholdDb: number, dynRatio: number, dynAttackMs: number, dynReleaseMs: number,
    dynMixPct: number, dynBypass: boolean,
    imgWidthPct: number, imgLowMonoHz: number, imgBypass: boolean,
    limCeilingDbtp: number, limLookaheadMs: number, limIsp: boolean, limBypass: boolean,
    outputGainDb: number, masterBypass: boolean,
  ): void;
  processStereo(left: Float32Array, right: Float32Array): void;
  limiterGrDb(): number;
  safetyEvents?(): number;
  reset(): void;
  free?(): void;
}

/** Apply a config object to a WASM chain handle (spreads the flat args). */
export function applyChainConfig(chain: WasmChain, c: RealtimeChainConfig): void {
  chain.setConfig(
    c.inputGainDb,
    c.eqLowCutHz, c.eqLowShelfDb, c.eqPresenceDb, c.eqAirDb, c.eqAdaptive, c.eqBypass,
    c.dynThresholdDb, c.dynRatio, c.dynAttackMs, c.dynReleaseMs, c.dynMixPct, c.dynBypass,
    c.imgWidthPct, c.imgLowMonoHz, c.imgBypass,
    c.limCeilingDbtp, c.limLookaheadMs, c.limIsp, c.limBypass,
    c.outputGainDb, c.masterBypass,
  );
}

/** A chain build that understands the JSON config path. */
export interface SuiteCapableChain {
  setConfigJson?(json: string): void;
  latencySamples?(): number;
}

export type { WasmChain };
