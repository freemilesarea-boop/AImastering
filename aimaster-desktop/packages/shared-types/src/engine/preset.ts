// EnginePreset v1 — top-level serializable shape consumed by both Python
// adapter and TS realtime runner.

import type { EngineModule } from './modules.js';
import type { MasteringStyle, LimiterStrength } from '../index.js';

// ── Policies (DSP-orthogonal decisions) ─────────────────────────────────────

/** How aggressive the vocal-protection guard is.  Off → no clamps. */
export type VocalProtectionPolicy = 'off' | 'safe' | 'strict';

/** Optional safe-mode overlay (Python `safe_modes.py`). */
export type SafeMode = 'none' | 'safe' | 'vocal_safe' | 'low_limit';

export interface EnginePresetPolicies {
  vocalProtection?: VocalProtectionPolicy;
  safeMode?: SafeMode;
  /** Whether the Python AI-correction overlay should engage. */
  aiCorrections?: boolean;
  /**
   * The limiter strength tier (low/medium/high).  The adapter resolves this
   * into per-limiter parameter overrides if the chain contains a `limiter`.
   */
  limiterStrength?: LimiterStrength;
}

// ── Output ──────────────────────────────────────────────────────────────────

export type EnginePresetSampleRate = 44100 | 48000 | 88200 | 96000;
export type EnginePresetBitDepth = 16 | 24 | 32;
export type EnginePresetFormat = 'wav' | 'flac' | 'mp3' | 'aac';

export interface EnginePresetOutput {
  sampleRate: EnginePresetSampleRate;
  bitDepth: EnginePresetBitDepth;
  format: EnginePresetFormat;
  /** Required if format is 'mp3' or 'aac'. */
  bitrateKbps?: number;
}

// ── Meta ────────────────────────────────────────────────────────────────────

export interface EnginePresetMeta {
  author?: string;
  createdAt?: string;
  updatedAt?: string;
  tags?: string[];
  genre?: string;
  description?: string;
  /**
   * Bridge to the legacy MasteringStyle taxonomy.  The Python adapter uses
   * this to look up legacy mode-specific overlays that have not yet been
   * fully unrolled into the JSON (e.g. analyzer-dependent EQ adjustments).
   * Once M2 fully decouples Python, this field becomes informational only.
   */
  legacyStyleId?: MasteringStyle;
}

// ── Compatibility ───────────────────────────────────────────────────────────

export interface EnginePresetCompatibility {
  /** Minimum @aimaster/shared-types engine schema semver. */
  engineApiMin: string;
  /**
   * Optional minimum dsp-core semver (M2+).  M1 leaves this blank.
   */
  dspCoreMin?: string;
}

// ── Top-level ───────────────────────────────────────────────────────────────

export const ENGINE_PRESET_SCHEMA_ID = 'https://schemas.loui.studio/engine-preset/v1';
export type EnginePresetSchemaId = typeof ENGINE_PRESET_SCHEMA_ID;

export interface EnginePreset {
  $schema: EnginePresetSchemaId;
  id: string;
  name: string;
  version: string;
  compatibility: EnginePresetCompatibility;
  meta: EnginePresetMeta;
  policies: EnginePresetPolicies;
  output: EnginePresetOutput;
  chain: {
    nodes: EngineModule[];
  };
}

/** Adapter processing log entry — recorded per-module at runtime. */
export interface AdapterLogEntry {
  moduleId: string;
  moduleType: EngineModule['type'];
  /** 'applied' | 'noop' | 'clamped' | 'error' */
  status: 'applied' | 'noop' | 'clamped' | 'error';
  /** Implementation-specific note (e.g. "transient-protection not supported by Python adapter"). */
  note?: string;
  /** Clamped parameter snapshots if `status === 'clamped'`. */
  clamps?: Array<{ field: string; from: number | string | boolean; to: number | string | boolean }>;
}

export interface AdapterRunReport {
  presetId: string;
  presetVersion: string;
  adapter: 'python' | 'ts';
  /** Sample rate the adapter actually operated at (may differ from preset.output.sampleRate). */
  actualSampleRate: number;
  durationMs: number;
  entries: AdapterLogEntry[];
}
