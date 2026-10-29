// Single source of truth for the renderable engine-key → MasteringOptions
// mapping.
//
// WHAT THIS IS, NOW THAT THE BUILDER IS GONE.  It is a SPECIFICATION, not a
// helper: the four parameters the Python export path (`masterFile`, five
// scalar options) can carry exactly.  Its one importer inside `src/` is
// `pending-summary.ts`, whose own only caller is a selftest — so nothing a
// user runs reads this table.  What reads it are the two checks that hold
// the UI's `exportSupport` claims to it:
//
//   modules-selftest        "export-renderable claims are backed by
//                            RENDERABLE_MAP" — limiter / maximizer / imager
//                            all claim export support, so each must map
//   export-support-selftest "exact set equals the renderable map size
//                            (no over-claiming)"
//
// Those badges are what a user reads before pressing export, so the table
// stays even though only tests import it.  `scripts/fixtures/
// test-only-exports.txt` records that on purpose.
//
// It used to also export `RENDERABLE_ENGINE_KEYS` and
// `isRenderableEngineKey`, for a staged-patch builder that asked "is this
// key renderable?" one fragment at a time.  That builder, the dispatcher
// that fed it and the preview-render client that consumed it are gone, and
// nothing else ever asked the question.
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
