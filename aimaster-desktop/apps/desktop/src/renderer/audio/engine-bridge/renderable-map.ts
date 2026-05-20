// Single source of truth for the renderable engine-key → MasteringOptions
// mapping.  Extracted so both the builder and the pending-summary helper
// import it without a circular dependency.
//
// An entry here makes a wired parameter reflect in the preview re-render.
// All four target MasteringOptions fields the Python pipeline already
// honours; staged values are pre-converted to engine space by the
// dispatcher's `toEngineValue`.
//
// Engine keys verified against module-parameter-definitions.ts:
//   limiter.targetLufs   → loudness-norm.targetLufs
//   limiter.ceilingDbtp  → limiter.ceilingDb
//   imager.widthPct      → stereo-imager.width      (value already /100)
//   eq.outputGainDb      → gain-staging.targetPeakDb

import type { MasteringOptions } from '@aimaster/shared-types';

export const RENDERABLE_MAP_LOOKUP: Readonly<Record<string, keyof MasteringOptions>> = {
  'loudness-norm:targetLufs':  'targetLufs',
  'limiter:ceilingDb':         'targetTp',
  'stereo-imager:width':       'stereoWidth',
  'gain-staging:targetPeakDb': 'outputGainDb',
};

/** Read-only list of renderable engine keys. */
export const RENDERABLE_ENGINE_KEYS: ReadonlyArray<string> = Object.keys(RENDERABLE_MAP_LOOKUP);

/** Whether an engine key (`${moduleType}:${path}`) is renderable today. */
export function isRenderableEngineKey(key: string): boolean {
  return key in RENDERABLE_MAP_LOOKUP;
}
