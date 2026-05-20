// Loui Mastering — official preset lineup + metadata framework
// (M2-PRESET-TUNING).
//
// A Loui preset is NOT a parameter dump — it is a *product* preset: rich
// metadata (category / platform / character / badges) PLUS a real,
// hand-tuned set of DSP parameter values per module.  Selecting a preset
// applies these to the central parameter state, so:
//
//   • the realtime preview hears the full tuning (all modules), and
//   • the export honours the renderable subset (loudness / ceiling /
//     width / output gain) — same state, no parameter drift.
//
// The tuning philosophy is "AI music sounds better", not "generic Ozone
// mastering": harsh-vocal suppression, AI cymbal smoothing, fake-stereo
// cleanup, low-end mud control, and mobile/mono compatibility are
// first-class (see the ai-special lineup + PRESET docs).

import type { ModuleId, ParameterValue } from '../parameters/parameter-state.js';

// ── Metadata vocab ────────────────────────────────────────────────────

export type PresetCategory = 'core' | 'character' | 'ai-special';

/** Where the loudness target sits — drives the "streaming-safe" badge. */
export type LoudnessProfile = 'streaming' | 'loud' | 'broadcast' | 'dynamic';

/** Editorial tonal direction (not a measured value). */
export type TonalBalance = 'neutral' | 'warm' | 'bright' | 'punchy';

// ── Tuning ────────────────────────────────────────────────────────────

/** Per-module parameter overrides (sparse — unset params keep defaults). */
export interface PresetModuleTuning {
  bypass?: boolean;
  parameters: Record<string, ParameterValue>;
}

/** Sparse per-module tuning map. */
export type PresetTuning = Partial<Record<ModuleId, PresetModuleTuning>>;

// ── Preset ────────────────────────────────────────────────────────────

export interface LouiPreset {
  id: string;
  displayName: string;
  category: PresetCategory;
  description: string;
  /** Streaming / delivery platforms this preset targets. */
  intendedPlatform: string[];
  loudnessProfile: LoudnessProfile;
  tonalBalance: TonalBalance;
  /** Tuned specifically for AI-generated music quirks. */
  aiOptimized: boolean;
  /** Survives mono fold-down (phone / club mono / Shorts). */
  monoSafe: boolean;
  recommendedGenres: string[];
  /** UI accent colour (hex) for the preset card. */
  accent: string;
  /** Bumped whenever the tuning changes (preset = product quality). */
  version: string;
  /** The actual DSP tuning. */
  tuning: PresetTuning;
}

// Accent palette (kept in sync with the loui theme families).
const ACCENT = {
  violet: '#A78BFA',
  blue:   '#60A5FA',
  green:  '#34D399',
  amber:  '#FBBF24',
  rose:   '#FB7185',
  cyan:   '#22D3EE',
  slate:  '#94A3B8',
} as const;

// Helper to keep tuning literals terse + readable.
function tune(t: PresetTuning): PresetTuning { return t; }

// ── Core lineup ───────────────────────────────────────────────────────

const CORE: LouiPreset[] = [
  {
    id: 'ai-pop',
    displayName: 'AI Pop',
    category: 'core',
    description: 'Modern pop sheen tuned for AI vocals — controlled presence, lifted air, gentle glue.',
    intendedPlatform: ['Spotify', 'Apple Music', 'TikTok'],
    loudnessProfile: 'loud',
    tonalBalance: 'bright',
    aiOptimized: true,
    monoSafe: true,
    recommendedGenres: ['Pop', 'AI Pop', 'Synthpop'],
    accent: ACCENT.violet,
    version: '1.0.0',
    tuning: tune({
      eq:       { parameters: { lowCutHz: 34, lowShelfDb: 0.8, presenceDb: 0.6, airDb: 2.2, outputGainDb: 0 } },
      dynamics: { parameters: { thresholdDb: -15, ratio: 2.2, attackMs: 8, releaseMs: 110, mixPct: 100 } },
      imager:   { parameters: { widthPct: 110, lowMonoHz: 120 } },
      limiter:  { parameters: { targetLufs: -10, ceilingDbtp: -1.0, lookaheadMs: 2.5, character: 'glue' } },
    }),
  },
  {
    id: 'kpop-loud',
    displayName: 'KPOP Loud',
    category: 'core',
    description: 'Maximum-impact K-pop master — bright, wide, aggressively loud while true-peak safe.',
    intendedPlatform: ['Spotify', 'YouTube', 'Melon'],
    loudnessProfile: 'loud',
    tonalBalance: 'punchy',
    aiOptimized: false,
    monoSafe: true,
    recommendedGenres: ['K-Pop', 'Dance Pop', 'Hyperpop'],
    accent: ACCENT.rose,
    version: '1.0.0',
    tuning: tune({
      eq:       { parameters: { lowCutHz: 36, lowShelfDb: 1.0, presenceDb: 1.6, airDb: 3.0, outputGainDb: 0 } },
      dynamics: { parameters: { thresholdDb: -17, ratio: 3.0, attackMs: 5, releaseMs: 90, mixPct: 100 } },
      imager:   { parameters: { widthPct: 125, lowMonoHz: 140 } },
      limiter:  { parameters: { targetLufs: -8, ceilingDbtp: -0.8, lookaheadMs: 1.8, character: 'aggressive' } },
    }),
  },
  {
    id: 'streaming-pro',
    displayName: 'Streaming Pro',
    category: 'core',
    description: 'Neutral, reference-grade streaming master at −14 LUFS — the safe default.',
    intendedPlatform: ['Spotify', 'Apple Music', 'Amazon Music', 'Tidal'],
    loudnessProfile: 'streaming',
    tonalBalance: 'neutral',
    aiOptimized: false,
    monoSafe: true,
    recommendedGenres: ['Any', 'Pop', 'Rock', 'Hip-Hop'],
    accent: ACCENT.blue,
    version: '1.0.0',
    tuning: tune({
      eq:       { parameters: { lowCutHz: 30, lowShelfDb: 0.6, presenceDb: 0.8, airDb: 1.4, outputGainDb: 0 } },
      dynamics: { parameters: { thresholdDb: -14, ratio: 2.0, attackMs: 12, releaseMs: 130, mixPct: 100 } },
      imager:   { parameters: { widthPct: 105, lowMonoHz: 110 } },
      limiter:  { parameters: { targetLufs: -14, ceilingDbtp: -1.0, lookaheadMs: 2.5, character: 'glue' } },
    }),
  },
  {
    id: 'youtube-safe',
    displayName: 'YouTube Safe',
    category: 'core',
    description: 'Built for YouTube normalization + lossy headroom — −14 LUFS with a −1.5 dBTP ceiling.',
    intendedPlatform: ['YouTube', 'YouTube Music'],
    loudnessProfile: 'streaming',
    tonalBalance: 'neutral',
    aiOptimized: false,
    monoSafe: true,
    recommendedGenres: ['Any', 'Vlog', 'Cover'],
    accent: ACCENT.green,
    version: '1.0.0',
    tuning: tune({
      eq:       { parameters: { lowCutHz: 30, lowShelfDb: 0.6, presenceDb: 0.6, airDb: 1.2, outputGainDb: 0 } },
      dynamics: { parameters: { thresholdDb: -14, ratio: 2.0, attackMs: 12, releaseMs: 140, mixPct: 100 } },
      imager:   { parameters: { widthPct: 102, lowMonoHz: 110 } },
      limiter:  { parameters: { targetLufs: -14, ceilingDbtp: -1.5, lookaheadMs: 3.0, character: 'glue' } },
    }),
  },
];

// ── Character lineup ──────────────────────────────────────────────────

const CHARACTER: LouiPreset[] = [
  {
    id: 'lofi-warm',
    displayName: 'Lofi Warm',
    category: 'character',
    description: 'Warm, cozy lo-fi — rolled-off air, lifted lows, relaxed dynamics.',
    intendedPlatform: ['Spotify', 'YouTube'],
    loudnessProfile: 'broadcast',
    tonalBalance: 'warm',
    aiOptimized: false,
    monoSafe: true,
    recommendedGenres: ['Lo-Fi', 'Chillhop', 'Jazzhop'],
    accent: ACCENT.amber,
    version: '1.0.0',
    tuning: tune({
      eq:       { parameters: { lowCutHz: 28, lowShelfDb: 2.4, presenceDb: -1.0, airDb: -2.0, outputGainDb: 0 } },
      dynamics: { parameters: { thresholdDb: -16, ratio: 2.4, attackMs: 18, releaseMs: 220, mixPct: 90 } },
      imager:   { parameters: { widthPct: 95, lowMonoHz: 110 } },
      limiter:  { parameters: { targetLufs: -16, ceilingDbtp: -1.0, lookaheadMs: 3.0, character: 'classic' } },
    }),
  },
  {
    id: 'edm-wide',
    displayName: 'EDM Wide',
    category: 'character',
    description: 'Big, wide festival sound — strong mono bass, lifted air, punchy glue.',
    intendedPlatform: ['Spotify', 'Beatport', 'SoundCloud'],
    loudnessProfile: 'loud',
    tonalBalance: 'punchy',
    aiOptimized: false,
    monoSafe: true,
    recommendedGenres: ['EDM', 'House', 'Future Bass', 'Trance'],
    accent: ACCENT.cyan,
    version: '1.0.0',
    tuning: tune({
      eq:       { parameters: { lowCutHz: 30, lowShelfDb: 1.2, presenceDb: 0.8, airDb: 2.6, outputGainDb: 0 } },
      dynamics: { parameters: { thresholdDb: -16, ratio: 3.0, attackMs: 4, releaseMs: 80, mixPct: 100 } },
      imager:   { parameters: { widthPct: 140, lowMonoHz: 150 } },
      limiter:  { parameters: { targetLufs: -9, ceilingDbtp: -1.0, lookaheadMs: 1.5, character: 'aggressive' } },
    }),
  },
  {
    id: 'ballad-vocal',
    displayName: 'Ballad Vocal',
    category: 'character',
    description: 'Vocal-forward ballad master — clear presence, airy top, gentle dynamics.',
    intendedPlatform: ['Spotify', 'Apple Music'],
    loudnessProfile: 'streaming',
    tonalBalance: 'bright',
    aiOptimized: false,
    monoSafe: true,
    recommendedGenres: ['Ballad', 'R&B', 'Singer-Songwriter'],
    accent: ACCENT.violet,
    version: '1.0.0',
    tuning: tune({
      eq:       { parameters: { lowCutHz: 40, lowShelfDb: 0.4, presenceDb: 1.8, airDb: 1.8, outputGainDb: 0 } },
      dynamics: { parameters: { thresholdDb: -13, ratio: 1.8, attackMs: 15, releaseMs: 160, mixPct: 90 } },
      imager:   { parameters: { widthPct: 100, lowMonoHz: 110 } },
      limiter:  { parameters: { targetLufs: -14, ceilingDbtp: -1.0, lookaheadMs: 3.0, character: 'glue' } },
    }),
  },
  {
    id: 'piano-natural',
    displayName: 'Piano Natural',
    category: 'character',
    description: 'Transparent, dynamic acoustic master — minimal coloring, preserved transients.',
    intendedPlatform: ['Apple Music', 'Tidal', 'Classical streaming'],
    loudnessProfile: 'dynamic',
    tonalBalance: 'neutral',
    aiOptimized: false,
    monoSafe: true,
    recommendedGenres: ['Piano', 'Classical', 'Acoustic', 'Ambient'],
    accent: ACCENT.slate,
    version: '1.0.0',
    tuning: tune({
      eq:       { parameters: { lowCutHz: 28, lowShelfDb: 0.0, presenceDb: 0.4, airDb: 1.0, outputGainDb: 0 } },
      dynamics: { parameters: { thresholdDb: -10, ratio: 1.5, attackMs: 25, releaseMs: 250, mixPct: 70 } },
      imager:   { parameters: { widthPct: 100, lowMonoHz: 90 } },
      limiter:  { parameters: { targetLufs: -16, ceilingDbtp: -1.0, lookaheadMs: 4.0, character: 'transparent' } },
    }),
  },
  {
    id: 'vintage-soft',
    displayName: 'Vintage Soft',
    category: 'character',
    description: 'Soft, saturated vintage tone — warm lows, tamed top, classic limiter glue.',
    intendedPlatform: ['Spotify', 'YouTube'],
    loudnessProfile: 'streaming',
    tonalBalance: 'warm',
    aiOptimized: false,
    monoSafe: true,
    recommendedGenres: ['Soul', 'Funk', 'Indie', 'Retro Pop'],
    accent: ACCENT.amber,
    version: '1.0.0',
    tuning: tune({
      eq:       { parameters: { lowCutHz: 30, lowShelfDb: 1.6, presenceDb: 0.4, airDb: -1.0, outputGainDb: 0 } },
      dynamics: { parameters: { thresholdDb: -15, ratio: 2.5, attackMs: 14, releaseMs: 180, mixPct: 100 } },
      imager:   { parameters: { widthPct: 100, lowMonoHz: 110 } },
      limiter:  { parameters: { targetLufs: -13, ceilingDbtp: -1.0, lookaheadMs: 3.0, character: 'classic' } },
    }),
  },
];

// ── AI-special lineup ─────────────────────────────────────────────────
//
// These are the Loui differentiators — each targets a specific AI-music
// artefact.  See PRESET docs for the rationale per preset.

const AI_SPECIAL: LouiPreset[] = [
  {
    id: 'ai-vocal-cleaner',
    displayName: 'AI Vocal Cleaner',
    category: 'ai-special',
    description: 'Tames harsh AI vocal sibilance + 3 kHz glare and clears low-mid mud, keeping intelligibility.',
    intendedPlatform: ['Spotify', 'Apple Music', 'TikTok'],
    loudnessProfile: 'streaming',
    tonalBalance: 'neutral',
    aiOptimized: true,
    monoSafe: true,
    recommendedGenres: ['AI Pop', 'AI Vocal', 'Cover'],
    accent: ACCENT.violet,
    version: '1.0.0',
    tuning: tune({
      // Harsh-vocal suppression: pull 3 kHz presence DOWN, gentle air,
      // de-mud via low-shelf cut + slightly higher low-cut.
      eq:       { parameters: { lowCutHz: 46, lowShelfDb: -1.0, presenceDb: -2.5, airDb: 0.5, outputGainDb: 0 } },
      dynamics: { parameters: { thresholdDb: -14, ratio: 2.2, attackMs: 12, releaseMs: 140, mixPct: 100 } },
      imager:   { parameters: { widthPct: 100, lowMonoHz: 130 } },
      limiter:  { parameters: { targetLufs: -14, ceilingDbtp: -1.0, lookaheadMs: 3.0, character: 'glue' } },
    }),
  },
  {
    id: 'cymbal-smooth',
    displayName: 'Cymbal Smooth',
    category: 'ai-special',
    description: 'Smooths metallic, splashy AI cymbals + hi-hats — pulls down air + upper presence.',
    intendedPlatform: ['Spotify', 'YouTube'],
    loudnessProfile: 'streaming',
    tonalBalance: 'warm',
    aiOptimized: true,
    monoSafe: true,
    recommendedGenres: ['AI Pop', 'AI Rock', 'Electronic'],
    accent: ACCENT.cyan,
    version: '1.0.0',
    tuning: tune({
      eq:       { parameters: { lowCutHz: 32, lowShelfDb: 0.6, presenceDb: -1.5, airDb: -2.5, outputGainDb: 0 } },
      dynamics: { parameters: { thresholdDb: -14, ratio: 2.0, attackMs: 14, releaseMs: 150, mixPct: 100 } },
      imager:   { parameters: { widthPct: 100, lowMonoHz: 120 } },
      limiter:  { parameters: { targetLufs: -14, ceilingDbtp: -1.0, lookaheadMs: 3.0, character: 'glue' } },
    }),
  },
  {
    id: 'stereo-repair',
    displayName: 'Stereo Repair',
    category: 'ai-special',
    description: 'Fixes fake / over-wide AI stereo — narrows the image and forces low-end mono.',
    intendedPlatform: ['Spotify', 'Apple Music', 'Club'],
    loudnessProfile: 'streaming',
    tonalBalance: 'neutral',
    aiOptimized: true,
    monoSafe: true,
    recommendedGenres: ['AI Pop', 'AI Electronic', 'Upmixed'],
    accent: ACCENT.blue,
    version: '1.0.0',
    tuning: tune({
      eq:       { parameters: { lowCutHz: 32, lowShelfDb: 0.4, presenceDb: 0.4, airDb: 1.0, outputGainDb: 0 } },
      dynamics: { parameters: { thresholdDb: -14, ratio: 2.0, attackMs: 12, releaseMs: 130, mixPct: 100 } },
      // Narrow + strong low-mono to collapse phasey fake-wide artefacts.
      imager:   { parameters: { widthPct: 90, lowMonoHz: 220 } },
      limiter:  { parameters: { targetLufs: -14, ceilingDbtp: -1.0, lookaheadMs: 2.5, character: 'glue' } },
    }),
  },
  {
    id: 'mono-safe-shorts',
    displayName: 'Mono Safe Shorts',
    category: 'ai-special',
    description: 'Optimized for phone speakers, Shorts & Reels — mono-robust, clear, loud-but-safe.',
    intendedPlatform: ['TikTok', 'YouTube Shorts', 'Instagram Reels'],
    loudnessProfile: 'loud',
    tonalBalance: 'bright',
    aiOptimized: true,
    monoSafe: true,
    recommendedGenres: ['Short-form', 'AI Pop', 'Hook'],
    accent: ACCENT.green,
    version: '1.0.0',
    tuning: tune({
      // Tiny-speaker clarity: a touch more presence, restrained lows,
      // high low-mono so the bass survives a mono fold-down.
      eq:       { parameters: { lowCutHz: 50, lowShelfDb: 0.2, presenceDb: 1.2, airDb: 1.6, outputGainDb: 0 } },
      dynamics: { parameters: { thresholdDb: -16, ratio: 2.6, attackMs: 8, releaseMs: 110, mixPct: 100 } },
      imager:   { parameters: { widthPct: 100, lowMonoHz: 180 } },
      limiter:  { parameters: { targetLufs: -11, ceilingDbtp: -1.0, lookaheadMs: 2.0, character: 'glue' } },
    }),
  },
];

// ── Aggregate + lookups ───────────────────────────────────────────────

export const LOUI_PRESETS: readonly LouiPreset[] = [...CORE, ...CHARACTER, ...AI_SPECIAL];

const BY_ID = new Map(LOUI_PRESETS.map((p) => [p.id, p]));

/** Look up a preset by id (undefined if unknown). */
export function getPreset(id: string): LouiPreset | undefined {
  return BY_ID.get(id);
}

/** Default preset id (the safe streaming master). */
export const DEFAULT_PRESET_ID = 'streaming-pro';

export const PRESET_CATEGORY_ORDER: readonly PresetCategory[] = ['core', 'character', 'ai-special'];

export const PRESET_CATEGORY_LABEL: Record<PresetCategory, string> = {
  core: 'Core',
  character: 'Character',
  'ai-special': 'AI Special',
};

/** Group presets by category, preserving lineup order. */
export function presetsByCategory(): Record<PresetCategory, LouiPreset[]> {
  const out: Record<PresetCategory, LouiPreset[]> = { core: [], character: [], 'ai-special': [] };
  for (const p of LOUI_PRESETS) out[p.category].push(p);
  return out;
}

/** A preset is "streaming-safe" when its loudness target won't be heavily
 *  turned down by platform normalization (−13 LUFS or quieter). */
export function isStreamingSafe(p: LouiPreset): boolean {
  return p.loudnessProfile === 'streaming' || p.loudnessProfile === 'broadcast' || p.loudnessProfile === 'dynamic';
}
