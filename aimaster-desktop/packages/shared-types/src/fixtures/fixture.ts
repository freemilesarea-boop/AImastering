// FixtureMetadata v1 — describes a single test fixture (raw mix + target
// metrics) the equivalence and policy harness consumes.
//
// IMPORTANT — IP / repo size:
//   The WAV file for a fixture is NEVER committed.  Recipes describe how
//   to synthesize the WAV deterministically, or point to a user-supplied
//   path.  Reference masters are absent in M1.5 — the "reference" is the
//   `targetMetrics` block, which encodes industry norms for the genre.

/** Fixture category — matches the M1.5 brief.  Add new ids with care. */
export type FixtureCategory =
  | 'kpop'
  | 'lofi'
  | 'edm'
  | 'hiphop'
  | 'ballad'
  | 'acoustic'
  | 'female-vocal'
  | 'male-vocal'
  | 'ai-harsh-mix'
  | 'reference-tone'           // synthetic — not a "genre" but useful for sanity tests
  | 'broadcast-speech';        // for -23 LUFS / EBU policy validation

/** How the raw WAV is produced. */
export type FixtureSourceType =
  | 'synthetic-recipe'         // deterministic generator (this repo's helper)
  | 'external-cc0'             // fetched at runtime from a public URL
  | 'user-supplied';           // pointer to a local path

export interface FixtureSourceSyntheticRecipe {
  type: 'synthetic-recipe';
  /** Generator id (the Python `app.fixtures.generator` recipe builder). */
  recipe: string;
  /** Free-form parameters consumed by the generator. */
  params: Record<string, unknown>;
}

export interface FixtureSourceExternalCC0 {
  type: 'external-cc0';
  url: string;
  /** Required SHA-256 for caching integrity. */
  sha256: string;
  license: 'CC0' | 'CC-BY' | 'CC-BY-SA' | 'public-domain';
  attribution?: string;
}

export interface FixtureSourceUserSupplied {
  type: 'user-supplied';
  /** Filesystem path relative to a user-configurable root (LOUI_FIXTURE_DIR). */
  relativePath: string;
}

export type FixtureSource =
  | FixtureSourceSyntheticRecipe
  | FixtureSourceExternalCC0
  | FixtureSourceUserSupplied;

/** Bands used for spectral-envelope target description. */
export type FixtureSpectrumProfile = Record<string, number>;
//   key = 1/3-oct centre (matches metrics.ts THIRD_OCT_CENTRES)
//   value = dB level (or -Infinity for n/a)

/** Aspirational "what a good master of this fixture looks like." */
export interface FixtureTargetMetrics {
  /** ITU R.128 integrated LUFS. */
  lufsI: number;
  /** True peak ceiling in dBTP — output must be ≤ this. */
  tpMaxDb: number;
  /** Loudness Range — output must be within [min, max]. */
  lraMinLu: number;
  lraMaxLu: number;
  /** Optional crest factor target (dB). */
  crestDb?: number;
  /** Optional spectral envelope target (1/3-oct dB per centre Hz). */
  thirdOctSpectrumDb?: FixtureSpectrumProfile;
  /** Optional notes on why these targets. */
  rationale?: string;
}

/** Policy enforced by tests against the rendered output of this fixture. */
export interface FixturePolicy {
  /** Allowed absolute LUFS-I deviation from target.lufsI. */
  lufsToleranceLu: number;
  /** Maximum allowed RMS deviation (dB) from target spectrum profile. */
  spectrumRmsDeltaMaxDb?: number;
  /** Maximum allowed |Δ| in any single 1/3-oct band (dB). */
  spectrumMaxDeltaMaxDb?: number;
  /** Tolerance for true-peak — typically 0 (cannot exceed ceiling). */
  tpHardCeiling?: true;
}

export interface FixtureCharacteristics {
  /** Synthetic fixtures are usually 20–60 s; longer fixtures should be unusual. */
  durationSec: number;
  sampleRate: 44100 | 48000 | 88200 | 96000;
  bitDepth: 16 | 24 | 32;
  channels: 1 | 2;
  /** Expected pre-master loudness — informational, used by tests for sanity. */
  preMasterLufsI?: number;
  /** Free-form tags for filtering. */
  tags?: string[];
}

export interface FixtureReferenceMaster {
  /** Whether an aspirational WAV is available (false in M1.5). */
  available: boolean;
  /** If `available`, relative path resolved against LOUI_FIXTURE_DIR. */
  wavRelativePath?: string;
  /** Always present — the numeric definition of "good." */
  targetMetrics: FixtureTargetMetrics;
}

export const FIXTURE_SCHEMA_ID = 'https://schemas.loui.studio/fixture/v1';
export type FixtureSchemaId = typeof FIXTURE_SCHEMA_ID;

export interface FixtureMetadata {
  $schema: FixtureSchemaId;
  id: string;                          // 'kpop-modern-01'
  category: FixtureCategory;
  name: string;
  version: string;                     // semver of this fixture
  source: FixtureSource;
  characteristics: FixtureCharacteristics;
  referenceMaster: FixtureReferenceMaster;
  /** Preset id this fixture is benchmarked against by default. */
  recommendedPresetId: string;         // 'builtin-kpop-loud'
  policy: FixturePolicy;
  /** Free-form description. */
  description?: string;
}
