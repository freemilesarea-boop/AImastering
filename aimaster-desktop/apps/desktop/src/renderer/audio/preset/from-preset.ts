// EnginePreset → existing TS ModeConfig (lossy mapping).
//
// This is the TS-side counterpart of services/python-audio/app/engine/adapter.py.
// It deliberately does NOT try to implement modules the renderer currently
// lacks (adaptive-eq, dynamic-eq, bus-comp, etc.).  Those are recorded in
// the AdapterRunReport as 'noop' so the cross-language harness can quantify
// the gap.
//
// Reference: docs/redesign/loui-mastering-v2/m1/01-DSP-MAPPING.md

import type {
  EnginePreset,
  EngineModule,
  AdapterRunReport,
  AdapterLogEntry,
} from '@aimaster/shared-types/engine';
import type { MasteringStyle, LimiterStrength } from '@aimaster/shared-types';

import {
  MODE_CONFIGS,
  type ModeConfig,
  type MasteringMode,
} from '../masteringModes.js';

/**
 * Modules whose effect is reflected in the current TS realtime preview chain.
 * The mapping is intentionally narrow — only what `masteringModes.ts` actually
 * applies.  Everything else is recorded as 'noop'.
 */
const TS_APPLIED_TYPES: ReadonlySet<EngineModule['type']> = new Set([
  'source',
  'gain-staging',
  'transient-protection',
  'vocal-enhancer',
  'loudness-norm',
  'soft-clip',
  'limiter',
  'sink',
]);

const TS_NOOP_TYPES: ReadonlySet<EngineModule['type']> = new Set([
  'adaptive-eq',
  'dynamic-eq',
  'multiband-eq',
  'bus-comp',
  'saturator',
  'stereo-imager',
  'deesser',
  'isp-safety',
  'dither',
]);

/**
 * Map Python's 7-style taxonomy to TS's 3-mode taxonomy.  Documented in
 * docs/redesign/loui-mastering-v2/m1/00-M1-SCOPE.md §4.3.  This mapping
 * is purely organisational — the preset's explicit targetLufs / ceilingDb
 * still drive the actual processing.
 */
function legacyStyleToMode(style: MasteringStyle | undefined | null): MasteringMode {
  switch (style) {
    case 'natural':
      return 'CLEAN';
    case 'balanced':
    case 'bright':
    case 'warm':
      return 'BALANCED';
    case 'loud':
    case 'kpop_loud':
    case 'punch':
      return 'LOUD';
    default:
      return 'BALANCED';
  }
}

/**
 * Map policy-level limiter strength tier onto the TS peak limiter params.
 * Mirrors Python LIMITER_STRENGTHS in pipeline.py.
 */
function applyLimiterStrengthToMode(
  base: ModeConfig,
  tier: LimiterStrength | undefined,
): ModeConfig {
  if (!tier) return base;
  let releaseMs: number;
  let fastRatio: number;
  let holdMs: number;
  if (tier === 'low') {
    releaseMs = 200; fastRatio = 2; holdMs = 3;
  } else if (tier === 'high') {
    releaseMs = 60;  fastRatio = 4; holdMs = 1;
  } else {
    releaseMs = 120; fastRatio = 3; holdMs = 2;
  }
  return {
    ...base,
    limiter: {
      ...base.limiter,
      peakLimiter: {
        ...base.limiter.peakLimiter,
        releaseMs,
        fastRatio,
        holdMs,
      },
    },
  };
}

export interface PresetToModeResult {
  /** The ModeConfig the existing `processMasteringWithMode` can consume. */
  mode: ModeConfig;
  /** Which base mode the preset was bucketed into. */
  bucket: MasteringMode;
  /** Diagnostic log — one entry per node in the preset chain. */
  entries: AdapterLogEntry[];
}

/**
 * Translate a validated EnginePreset into a ModeConfig.
 *
 * Lossy by design: this is the M1 honest mapping while the TS chain is
 * still a "preview approximation" rather than a faithful reproduction of
 * the Python pipeline.  Every module is recorded in `entries`.
 */
export function presetToModeConfig(preset: EnginePreset): PresetToModeResult {
  const legacy = preset.meta.legacyStyleId;
  const bucket = legacyStyleToMode(legacy);
  const base: ModeConfig = MODE_CONFIGS[bucket];

  // Pull the preset's loudness/limiter targets and override the base mode
  // where the schema is explicit — keeps the bucket as a sane starting
  // point but honours the preset's actual numbers.
  const lnorm = preset.chain.nodes.find(
    (n: EngineModule) => n.type === 'loudness-norm',
  );
  const lim = preset.chain.nodes.find((n: EngineModule) => n.type === 'limiter');

  const targetLufs =
    lnorm && lnorm.type === 'loudness-norm' ? lnorm.targetLufs : base.targetLufs;
  const ceilingDb =
    lim && lim.type === 'limiter'
      ? lim.ceilingDb
      : (base.limiter.truePeakCeilingDb ?? -1.0);

  let mode: ModeConfig = {
    ...base,
    label: preset.name,
    description: preset.meta.description ?? base.description,
    targetLufs,
    limiter: {
      ...base.limiter,
      truePeakCeilingDb: ceilingDb,
    },
  };

  mode = applyLimiterStrengthToMode(mode, preset.policies.limiterStrength);

  // Build the per-module log.
  const entries: AdapterLogEntry[] = preset.chain.nodes.map((n: EngineModule): AdapterLogEntry => {
    if (TS_APPLIED_TYPES.has(n.type)) {
      return { moduleId: n.id, moduleType: n.type, status: 'applied' };
    }
    if (TS_NOOP_TYPES.has(n.type)) {
      return {
        moduleId: n.id,
        moduleType: n.type,
        status: 'noop',
        note: `TS realtime preview does not implement '${n.type}' yet — Python-only module`,
      };
    }
    return {
      moduleId: n.id,
      moduleType: n.type,
      status: 'error',
      note: `unknown module type ${n.type}`,
    };
  });

  return { mode, bucket, entries };
}

/**
 * Build an AdapterRunReport from the entries returned by `presetToModeConfig`
 * plus runtime metadata.  Use this so the cross-language harness can diff
 * Python's report against TS's report on the same shape.
 */
export function buildAdapterReport(
  preset: EnginePreset,
  entries: AdapterLogEntry[],
  actualSampleRate: number,
  durationMs: number,
): AdapterRunReport {
  return {
    presetId: preset.id,
    presetVersion: preset.version,
    adapter: 'ts',
    actualSampleRate,
    durationMs,
    entries,
  };
}
