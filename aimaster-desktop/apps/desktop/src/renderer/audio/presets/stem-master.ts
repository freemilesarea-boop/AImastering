// stem-master — the master bus of a stem session.
//
// A stem session's master bus is not a new thing to design. It is the
// mastering the app already does, applied to the sum instead of to a file:
// the same Loui presets, the same `buildChainConfig`, the same engine. So
// this file is a lookup, not a second implementation — if the K-pop preset
// changes, the stem session's K-pop master changes with it, because there
// is only one K-pop preset.
//
// # Why the loudness target travels separately
//
// The preset carries a `targetLufs`, and the chain has a loudness module
// that could chase it while it plays. The master bus does not use that
// module: it is normalised in two passes by the renderer instead (measure
// the finished master, correct, re-run the master chain only). An AGC has
// to guess while it plays and lands NEAR the target; a measurement of the
// whole file lands ON it.
//
// So `masterTargetFor` returns the number separately, and the wire this
// file builds has the loudness module off. Having both would be worse than
// having either: the AGC would move the level the two-pass had already set,
// and the file would miss the target it reported hitting.

import type { ChainConfigWire } from '../chain-config.js';
import { buildChainConfig } from '../chain-config.js';
import { ALL_MODULE_PARAMETER_DEFS } from '../parameters/module-parameter-definitions.js';
import { presetToParameterState } from './preset-to-state.js';
import { getPreset, LOUI_PRESETS, type LouiPreset } from './loui-presets.js';

/** Presets offered as a stem session's master bus, in the order shown. */
export const MASTER_BUS_PRESETS: readonly string[] = [
  'streaming-pro', 'ai-pop', 'kpop-loud', 'youtube-safe',
  'edm-wide', 'ballad-vocal', 'lofi-warm', 'piano-natural',
] as const;

export interface MasterBusChoice {
  id: string;
  displayName: string;
  description: string;
  targetLufs: number;
  ceilingDbtp: number;
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** Target loudness and ceiling a preset asks for. */
export function masterTargetFor(preset: LouiPreset): { targetLufs: number; ceilingDbtp: number } {
  const lim = preset.tuning.limiter?.parameters ?? {};
  return {
    targetLufs: num(lim.targetLufs, -14),
    ceilingDbtp: num(lim.ceilingDbtp, -1),
  };
}

/** The master-bus choices, for the picker. */
export function masterBusChoices(): MasterBusChoice[] {
  return MASTER_BUS_PRESETS
    .map((id) => getPreset(id))
    .filter((p): p is LouiPreset => p !== undefined)
    .map((p) => ({
      id: p.id,
      displayName: p.displayName,
      description: p.description,
      ...masterTargetFor(p),
    }));
}

/**
 * Build the master bus chain for a preset.
 *
 * `targetLufsOverride` replaces the preset's own target — the picker offers
 * a preset AND a loudness, because "K-pop but not that loud" is a normal
 * thing to want and re-tuning a preset to get it is not.
 *
 * The limiter stays in the chain and keeps its ceiling: it is what holds
 * the true peak while the two-pass correction pushes the level up.
 */
export function masterWireFor(
  presetId: string,
  targetLufsOverride?: number,
): { wire: ChainConfigWire; targetLufs: number; ceilingDbtp: number } | null {
  const preset = getPreset(presetId);
  if (!preset) return null;

  const state = presetToParameterState(preset, ALL_MODULE_PARAMETER_DEFS);
  const wire = buildChainConfig({ state, masterBypass: false });

  // The two-pass normalisation owns the loudness. See the header.
  if (wire.loudness) wire.loudness = { ...wire.loudness, enabled: false };

  const target = masterTargetFor(preset);
  const targetLufs = typeof targetLufsOverride === 'number' && Number.isFinite(targetLufsOverride)
    ? targetLufsOverride
    : target.targetLufs;

  return { wire, targetLufs, ceilingDbtp: target.ceilingDbtp };
}

/** Every preset id that exists, for validating a stored choice. */
export function isKnownPreset(id: string): boolean {
  return LOUI_PRESETS.some((p) => p.id === id);
}
