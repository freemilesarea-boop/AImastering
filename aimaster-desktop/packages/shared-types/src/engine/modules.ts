// Canonical DSP module type definitions for the Loui engine schema (preset v1).
//
// IMPORTANT — read first:
//   The "canonical" chain is the SUPERSET of what the current Python pipeline
//   and the current TS realtime preview both contain. Each adapter (Python /
//   TS) may "noop" modules that it has not yet implemented; the noop must be
//   recorded in the adapter's processing log so it surfaces in golden tests.
//
// Reference docs:
//   docs/redesign/loui-mastering-v2/m1/00-M1-SCOPE.md
//   docs/redesign/loui-mastering-v2/m1/01-DSP-MAPPING.md

// ── Primitive parameter types ───────────────────────────────────────────────

export type FilterType = 'low_shelf' | 'high_shelf' | 'peak' | 'high_pass' | 'low_pass';

export type DynamicEqMode = 'cut' | 'boost';

export type MultibandId = 'low' | 'mid' | 'vocal' | 'high';

export type DitherAlgorithm =
  | 'tpdf'
  | 'rectangular'
  | 'pow-r-1'
  | 'pow-r-2'
  | 'pow-r-3'
  | 'none';

export type LoudnessAlgorithm = 'linear' | 'static' | 'iterative' | 'auto';

// ── Source / Sink ───────────────────────────────────────────────────────────

export interface EngineSourceModule {
  type: 'source';
  /** ID inside the graph (must be unique). */
  id: string;
}

export interface EngineSinkModule {
  type: 'sink';
  id: string;
}

// ── Adaptive EQ (Python eq.py 5-band base + style overlay) ──────────────────

export interface EngineEqBand {
  id: string;
  filterType: FilterType;
  freqHz: number;
  /** Either q or widthOctaves — adapter prefers q if both set. */
  q?: number;
  widthOctaves?: number;
  gainDb: number;
  /**
   * If true, the adapter is allowed to scale the gain by an analyzer signal
   * (e.g. Python's low-to-mid ratio).  Off by default for portability.
   */
  adaptive?: boolean;
}

export interface EngineAdaptiveEqModule {
  type: 'adaptive-eq';
  id: string;
  bands: EngineEqBand[];
}

// ── Dynamic EQ (Python dynamic_eq.py 6-band) ────────────────────────────────

export interface EngineDynamicEqBand {
  id: string;
  freqHz: number;
  q: number;
  /** In dBFS — when input crosses this, the band engages. */
  thresholdDb: number;
  /** Max reduction or boost in dB (sign is implicit in `mode`). */
  reductionDb: number;
  mode: DynamicEqMode;
  attackMs?: number;
  releaseMs?: number;
}

export interface EngineDynamicEqModule {
  type: 'dynamic-eq';
  id: string;
  /** 0..2 multiplier on per-band reductionDb.  0 = off. */
  intensity: number;
  bands: EngineDynamicEqBand[];
}

// ── Multiband EQ (Python multiband.py — reference matching 4-band) ──────────

export interface EngineMultibandEqBand {
  id: MultibandId;
  centreHz: number;
  q: number;
  rangeHz: [number, number];
  gainDb: number;
}

export interface EngineMultibandEqModule {
  type: 'multiband-eq';
  id: string;
  bands: EngineMultibandEqBand[];
  /** Bands with |gainDb| < skipBelowDb are skipped at runtime. */
  skipBelowDb?: number;
}

// ── Bus Compressor (Python dynamics.py "glue") ──────────────────────────────

export interface EngineBusCompModule {
  type: 'bus-comp';
  id: string;
  thresholdDb: number;
  ratio: number;
  attackMs: number;
  releaseMs: number;
  makeupDb: number;
  kneeDb: number;
  vocalProtection?: {
    maxRatio?: number;
    minAttackMs?: number;
    maxMakeupDb?: number;
  };
}

// ── Transient Protection (TS only — transientProtection.ts) ─────────────────

export interface EngineTransientProtectionModule {
  type: 'transient-protection';
  id: string;
  thresholdRatio?: number;
  maxReductionDb?: number;
  attackMs?: number;
  releaseMs?: number;
  slope?: number;
  warmupMs?: number;
  refractoryMs?: number;
}

// ── Vocal Enhancer (TS only — vocalEnhancer.ts) ─────────────────────────────

export interface EngineVocalEnhancerModule {
  type: 'vocal-enhancer';
  id: string;
  scoreThreshold?: number;
  maxCorrectionDb?: number;
  forceEnable?: boolean;
}

// ── Effects (Saturator / Imager / De-esser — Python effects.py) ─────────────

export interface EngineSaturatorModule {
  type: 'saturator';
  id: string;
  /** 0..1.  0 = bypass. */
  amount: number;
  model?: 'compand-curve' | 'tanh' | 'cubic';
}

export interface EngineStereoImagerModule {
  type: 'stereo-imager';
  id: string;
  /** 0.5..2.0, 1.0 = passthrough. */
  width: number;
}

export interface EngineDeesserModule {
  type: 'deesser';
  id: string;
  freqHz: number;
  q: number;
  reductionDb: number;
}

// ── Gain Staging (TS only — gainStaging.ts) ─────────────────────────────────

export interface EngineGainStagingModule {
  type: 'gain-staging';
  id: string;
  targetPeakDb?: number;
  targetRmsDb?: number;
  targetLufs?: number;
  maxBoostDb?: number;
  maxAttenuateDb?: number;
  measureTruePeak?: boolean;
}

// ── Loudness Normalization (both, different algorithms) ─────────────────────

export interface EngineLoudnessNormModule {
  type: 'loudness-norm';
  id: string;
  targetLufs: number;
  targetTpDb: number;
  targetLra?: number;
  algorithm?: LoudnessAlgorithm;
  /** Iterative algorithm only. */
  toleranceLu?: number;
  /** Iterative algorithm only. */
  maxIters?: number;
}

// ── Soft Clip (TS only — softClip.ts) ───────────────────────────────────────

export interface EngineSoftClipModule {
  type: 'soft-clip';
  id: string;
  thresholdDb?: number;
  driveDb?: number;
  model?: 'cubic' | 'tanh' | 'compand-curve';
}

// ── Brickwall Limiter (both — alimiter vs peakLimiter) ──────────────────────

export interface EngineLimiterModule {
  type: 'limiter';
  id: string;
  ceilingDb: number;
  inputGainDb?: number;
  attackMs?: number;
  releaseMs?: number;
  lookAheadMs?: number;
  fastReleaseMs?: number;
  fastRatio?: number;
  holdMs?: number;
  oversample?: 1 | 2 | 4 | 8 | 16;
}

// ── ISP Safety (Python only) ────────────────────────────────────────────────

export interface EngineIspSafetyModule {
  type: 'isp-safety';
  id: string;
  ceilingDbtp: number;
  headroomDb?: number;
  oversample?: 4 | 8 | 16;
}

// ── Dither (neither implements yet — M2) ────────────────────────────────────

export interface EngineDitherModule {
  type: 'dither';
  id: string;
  bitDepth: 16 | 24 | 32;
  algorithm?: DitherAlgorithm;
}

// ── Union ───────────────────────────────────────────────────────────────────

export type EngineModule =
  | EngineSourceModule
  | EngineGainStagingModule
  | EngineAdaptiveEqModule
  | EngineDynamicEqModule
  | EngineMultibandEqModule
  | EngineBusCompModule
  | EngineTransientProtectionModule
  | EngineVocalEnhancerModule
  | EngineSaturatorModule
  | EngineStereoImagerModule
  | EngineDeesserModule
  | EngineLoudnessNormModule
  | EngineSoftClipModule
  | EngineLimiterModule
  | EngineIspSafetyModule
  | EngineDitherModule
  | EngineSinkModule;

export type EngineModuleType = EngineModule['type'];

/** All module type strings, in canonical chain order. */
export const ENGINE_MODULE_ORDER: readonly EngineModuleType[] = [
  'source',
  'gain-staging',
  'adaptive-eq',
  'dynamic-eq',
  'multiband-eq',
  'bus-comp',
  'transient-protection',
  'vocal-enhancer',
  'saturator',
  'stereo-imager',
  'deesser',
  'loudness-norm',
  'soft-clip',
  'limiter',
  'isp-safety',
  'dither',
  'sink',
] as const;
