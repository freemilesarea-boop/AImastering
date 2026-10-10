/**
 * Tuned values that reach no engine.
 *
 * A preset sets a parameter, the user sees it on a slider, the app draws a
 * picture of it — and the render never receives it.  That happened: the
 * imager's four per-band widths were built into the chain config by
 * `chain-config.ts` and read by nothing, so a preset asking for a 78 % top
 * band got the same width everywhere, and a check asserting "it narrows the
 * top rather than the whole image" passed while nothing was narrowed.
 *
 * The test is mechanical rather than a list of known-bad names: move the
 * parameter back to its default on its own and rebuild BOTH chain configs —
 * the flat realtime one the worklet takes and the wire one the offline render
 * takes.  If neither changes, no engine could have seen it.
 *
 * A parameter this reports is not necessarily a bug in the parameter: it may
 * be a feature the engine has and the app does not send yet (per-band width is
 * exactly that — dsp-core `mastering/imager.rs` implements it).  What it is
 * always a bug in is a PRESET that tunes it, because a preset is a promise
 * about the sound.
 */
import { buildChainConfig } from '../../src/renderer/audio/chain-config.js';
import { stateToChainConfig } from '../../src/renderer/audio/realtime-mastering-chain.js';
import { ALL_MODULE_PARAMETER_DEFS } from '../../src/renderer/audio/parameters/module-parameter-definitions.js';
import {
  MODULE_IDS, defaultAllModulesState,
  type AllModulesParameterState, type ModuleId, type ParameterValue,
} from '../../src/renderer/audio/parameters/parameter-state.js';

/** The shape both `LouiPreset.tuning` and `RECOMMENDED` reduce to. */
export type TunedModules = Readonly<Partial<Record<string, {
  readonly parameters?: Readonly<Record<string, ParameterValue>>;
  readonly bypass?: boolean;
} | undefined>>>;

function defaultOf(moduleId: ModuleId, parameterId: string): ParameterValue | undefined {
  const def = ALL_MODULE_PARAMETER_DEFS[moduleId]?.parameters
    .find((p) => p.id === parameterId);
  return def ? (def as { default: ParameterValue }).default : undefined;
}

function stateFor(tuning: TunedModules): AllModulesParameterState {
  const state = defaultAllModulesState(ALL_MODULE_PARAMETER_DEFS);
  for (const moduleId of MODULE_IDS) {
    const mod = tuning[moduleId];
    if (!mod) continue;
    const next = { ...state[moduleId] };
    if (typeof mod.bypass === 'boolean') next.bypass = mod.bypass;
    next.parameters = { ...next.parameters, ...(mod.parameters ?? {}) };
    state[moduleId] = next;
  }
  return state;
}

/** Both configs, as one string — what an engine could possibly receive. */
function fingerprint(state: AllModulesParameterState): string {
  return `${JSON.stringify(stateToChainConfig(state))}|${JSON.stringify(buildChainConfig({ state }))}`;
}

/**
 * Parameters this tuning sets away from their default that change neither
 * chain config, as `module.parameter = value` strings.
 */
export function inertTunedParameters(tuning: TunedModules): string[] {
  const full = stateFor(tuning);
  const base = fingerprint(full);
  const found: string[] = [];
  for (const moduleId of MODULE_IDS) {
    const mod = tuning[moduleId];
    if (!mod?.parameters) continue;
    for (const [parameterId, value] of Object.entries(mod.parameters)) {
      const fallback = defaultOf(moduleId, parameterId);
      if (fallback === undefined || fallback === value) continue;
      const reverted = stateFor({
        ...tuning,
        [moduleId]: { ...mod, parameters: { ...mod.parameters, [parameterId]: fallback } },
      });
      if (fingerprint(reverted) === base) {
        found.push(`${moduleId}.${parameterId} = ${String(value)}`);
      }
    }
  }
  return found;
}
