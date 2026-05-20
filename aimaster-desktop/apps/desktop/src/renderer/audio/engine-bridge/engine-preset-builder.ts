// EnginePreset builder — staged patch → render override.
//
// M3-P-NEXT-5C scope:
//   • Convert the dispatcher's staged patch (StagedPatchEntry[]) into:
//       1. a MasteringOptions override the EXISTING Python preview render
//          can honour today (the renderable subset), and
//       2. the canonical EngineSchema patch (forward-compatible, reusable
//          by the future export path — see 05-OVERRIDE-REUSE.md).
//   • Only `loudness-norm.targetLufs` is renderable in 5C (per the brief —
//     "limiter.targetLufs 1개부터 시작").  The other wired fragments are
//     reported as `unsupportedForRender` and stay staged.
//
// The builder is a PURE function — deterministic output for a given patch
// + base options.  No IPC, no side effects.  Story- and unit-testable.

import type { MasteringOptions } from '@aimaster/shared-types';
import type { StagedPatchEntry } from './engine-dispatcher.js';

// ── Renderable mapping ───────────────────────────────────────────────────

/**
 * EngineSchema paths the current Python preview render can apply, mapped
 * to the MasteringOptions field they drive.
 *
 * 5C deliberately ships ONE entry — `loudness-norm.targetLufs`.  Adding
 * a row here (e.g. `limiter:ceilingDb` → `targetTp`) extends the
 * renderable set with no other code change — that is M3-P-NEXT-5D work.
 */
const RENDERABLE_MAP: Record<string, keyof MasteringOptions> = {
  'loudness-norm:targetLufs': 'targetLufs',
  // M3-P-NEXT-5D candidates (MasteringOptions already supports these):
  //   'limiter:ceilingDb'        → 'targetTp'
  //   'stereo-imager:width'      → 'stereoWidth'
  //   'gain-staging:targetPeakDb' → 'outputGainDb'
};

// ── Result type ──────────────────────────────────────────────────────────

export interface PreviewBuildResult {
  /**
   * MasteringOptions-compatible override the current preview render
   * honours.  Merge over the base options before invoking the render.
   */
  optionsOverride: Partial<MasteringOptions>;
  /**
   * Canonical EngineSchema patch fragments — the full wired set, in
   * engine space.  Reused unchanged by the future export path.
   */
  enginePatch: StagedPatchEntry[];
  /**
   * Wired fragments that are staged but the current preview render cannot
   * apply (no MasteringOptions mapping yet).
   */
  unsupportedForRender: Array<{
    moduleId: string;
    parameterId: string;
    enginePath: string;
    reason: string;
  }>;
  /** Whether the override contains at least one renderable change. */
  hasRenderableChange: boolean;
}

// ── Builder ──────────────────────────────────────────────────────────────

/**
 * Build a preview render override from the staged patch.
 *
 * @param patch  the dispatcher's accumulated wired fragments
 * @returns      a deterministic {@link PreviewBuildResult}
 */
export function buildPreviewOverride(patch: readonly StagedPatchEntry[]): PreviewBuildResult {
  const optionsOverride: Partial<MasteringOptions> = {};
  const unsupportedForRender: PreviewBuildResult['unsupportedForRender'] = [];

  // Sort for deterministic output regardless of insertion order.
  const sorted = [...patch].sort((a, b) =>
    `${a.moduleType}:${a.path}`.localeCompare(`${b.moduleType}:${b.path}`));

  for (const frag of sorted) {
    const key = `${frag.moduleType}:${frag.path}`;
    const optionKey = RENDERABLE_MAP[key];
    if (optionKey && typeof frag.value === 'number') {
      (optionsOverride[optionKey] as number) = frag.value;
    } else {
      unsupportedForRender.push({
        moduleId: frag.sourceModuleId,
        parameterId: frag.sourceParameterId,
        enginePath: key,
        reason: optionKey
          ? 'value type mismatch for renderable mapping'
          : 'no MasteringOptions mapping (staged for future render)',
      });
    }
  }

  return {
    optionsOverride,
    enginePatch: sorted,
    unsupportedForRender,
    hasRenderableChange: Object.keys(optionsOverride).length > 0,
  };
}

/**
 * Merge a base MasteringOptions with a preview override.  Used by the
 * renderer client before sending the re-render request.  Pure.
 */
export function mergeOptions(
  base: MasteringOptions,
  override: Partial<MasteringOptions>,
): MasteringOptions {
  return { ...base, ...override };
}
