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
    description: 'The Loui flagship — bright, clear AI-pop sheen with restrained 3 kHz so it never turns harsh.',
    intendedPlatform: ['Spotify', 'Apple Music', 'TikTok'],
    loudnessProfile: 'loud',
    tonalBalance: 'bright',
    aiOptimized: true,
    monoSafe: true,
    recommendedGenres: ['Pop', 'AI Pop', 'Synthpop'],
    accent: ACCENT.violet,
    version: '1.1.0',
    // v1.1: presence pulled to 0.5 + air to 2.0 (bright, not harsh); width
    // nudged to 112 for a touch more space without mono risk.
    tuning: tune({
      eq:       { parameters: { lowCutHz: 34, lowShelfDb: 0.8, presenceDb: 0.5, airDb: 2.0, outputGainDb: 0 } },
      dynamics: { parameters: { thresholdDb: -15, ratio: 2.2, attackMs: 8, releaseMs: 110, mixPct: 100 } },
      imager:   { parameters: { widthPct: 112, lowMonoHz: 120 } },
      limiter:  { parameters: { targetLufs: -10, ceilingDbtp: -1.0, lookaheadMs: 2.5, character: 'glue' } },
    }),
  },
  {
    id: 'kpop-loud',
    displayName: 'KPOP Loud',
    category: 'core',
    description: 'Maximum-impact K-pop master — loud, bright and punchy, with a −1.0 dBTP ceiling so it never tears.',
    intendedPlatform: ['Spotify', 'YouTube', 'Melon'],
    loudnessProfile: 'loud',
    tonalBalance: 'punchy',
    aiOptimized: false,
    monoSafe: true,
    recommendedGenres: ['K-Pop', 'Dance Pop', 'Hyperpop'],
    accent: ACCENT.rose,
    version: '1.1.0',
    // v1.1: anti-tear — ceiling back to −1.0 + lookahead 2.0 for clean
    // peak capture; air 3.0→2.8 + presence 1.6→1.4 to stay loud not shrill;
    // harder glue (ratio 3.2 / thr −18) for density.
    tuning: tune({
      eq:       { parameters: { lowCutHz: 36, lowShelfDb: 1.0, presenceDb: 1.4, airDb: 2.8, outputGainDb: 0 } },
      dynamics: { parameters: { thresholdDb: -18, ratio: 3.2, attackMs: 5, releaseMs: 90, mixPct: 100 } },
      imager:   { parameters: { widthPct: 128, lowMonoHz: 145 } },
      limiter:  { parameters: { targetLufs: -8, ceilingDbtp: -1.0, lookaheadMs: 2.0, character: 'aggressive' } },
    }),
  },
  {
    id: 'streaming-pro',
    displayName: 'Streaming Pro',
    category: 'core',
    description: 'Neutral, reference-grade streaming master at −14 LUFS — the safest balanced default.',
    intendedPlatform: ['Spotify', 'Apple Music', 'Amazon Music', 'Tidal'],
    loudnessProfile: 'streaming',
    tonalBalance: 'neutral',
    aiOptimized: false,
    monoSafe: true,
    recommendedGenres: ['Any', 'Pop', 'Rock', 'Hip-Hop'],
    accent: ACCENT.blue,
    version: '1.1.0',
    // v1.1: the reference — a hair more air (1.6) than YouTube Safe so it
    // reads as the "open, balanced" baseline; presence eased to 0.7.
    tuning: tune({
      eq:       { parameters: { lowCutHz: 30, lowShelfDb: 0.6, presenceDb: 0.7, airDb: 1.6, outputGainDb: 0 } },
      dynamics: { parameters: { thresholdDb: -14, ratio: 2.0, attackMs: 12, releaseMs: 130, mixPct: 100 } },
      imager:   { parameters: { widthPct: 106, lowMonoHz: 110 } },
      limiter:  { parameters: { targetLufs: -14, ceilingDbtp: -1.0, lookaheadMs: 2.5, character: 'glue' } },
    }),
  },
  {
    id: 'youtube-safe',
    displayName: 'YouTube Safe',
    category: 'core',
    description: 'Low-fatigue, long-listen master for YouTube — softened top end and a −1.5 dBTP lossy-safe ceiling.',
    intendedPlatform: ['YouTube', 'YouTube Music'],
    loudnessProfile: 'streaming',
    tonalBalance: 'neutral',
    aiOptimized: false,
    monoSafe: true,
    recommendedGenres: ['Any', 'Vlog', 'Cover'],
    accent: ACCENT.green,
    version: '1.1.0',
    // v1.1: distinctly the "fatigue-free" one vs Streaming Pro — softer
    // top (air 1.0, presence 0.4), gentler/longer comp, safer ceiling.
    tuning: tune({
      eq:       { parameters: { lowCutHz: 30, lowShelfDb: 0.5, presenceDb: 0.4, airDb: 1.0, outputGainDb: 0 } },
      dynamics: { parameters: { thresholdDb: -13, ratio: 1.9, attackMs: 14, releaseMs: 150, mixPct: 95 } },
      imager:   { parameters: { widthPct: 102, lowMonoHz: 115 } },
      limiter:  { parameters: { targetLufs: -14, ceilingDbtp: -1.5, lookaheadMs: 3.5, character: 'glue' } },
    }),
  },
];

// ── Character lineup ──────────────────────────────────────────────────

const CHARACTER: LouiPreset[] = [
  {
    id: 'lofi-warm',
    displayName: 'Lofi Warm',
    category: 'character',
    description: 'Warm, cozy lo-fi — softened highs, warm low-mids, relaxed dynamics.',
    intendedPlatform: ['Spotify', 'YouTube'],
    loudnessProfile: 'broadcast',
    tonalBalance: 'warm',
    aiOptimized: false,
    monoSafe: true,
    recommendedGenres: ['Lo-Fi', 'Chillhop', 'Jazzhop'],
    accent: ACCENT.amber,
    version: '1.1.0',
    // v1.1: softer top (air −2.5, presence −1.2) + warmer low-mid
    // (lowShelf 2.6) for a rounder, dustier character.
    tuning: tune({
      eq:       { parameters: { lowCutHz: 26, lowShelfDb: 2.6, presenceDb: -1.2, airDb: -2.5, outputGainDb: 0 } },
      dynamics: { parameters: { thresholdDb: -16, ratio: 2.4, attackMs: 18, releaseMs: 230, mixPct: 88 } },
      imager:   { parameters: { widthPct: 94, lowMonoHz: 105 } },
      limiter:  { parameters: { targetLufs: -16, ceilingDbtp: -1.0, lookaheadMs: 3.0, character: 'classic' } },
    }),
  },
  {
    id: 'edm-wide',
    displayName: 'EDM Wide',
    category: 'character',
    description: 'Big, wide festival sound — wide highs over a strong mono low end to keep phase safe.',
    intendedPlatform: ['Spotify', 'Beatport', 'SoundCloud'],
    loudnessProfile: 'loud',
    tonalBalance: 'punchy',
    aiOptimized: false,
    monoSafe: true,
    recommendedGenres: ['EDM', 'House', 'Future Bass', 'Trance'],
    accent: ACCENT.cyan,
    version: '1.1.0',
    // v1.1: phase-risk control — width eased 140→138 and low-mono raised
    // 150→160 so the sub stays mono; harder glue (thr −17) for drive.
    tuning: tune({
      eq:       { parameters: { lowCutHz: 30, lowShelfDb: 1.2, presenceDb: 0.8, airDb: 2.6, outputGainDb: 0 } },
      dynamics: { parameters: { thresholdDb: -17, ratio: 3.0, attackMs: 4, releaseMs: 80, mixPct: 100 } },
      imager:   { parameters: { widthPct: 138, lowMonoHz: 160 } },
      limiter:  { parameters: { targetLufs: -9, ceilingDbtp: -1.0, lookaheadMs: 1.5, character: 'aggressive' } },
    }),
  },
  {
    id: 'ballad-vocal',
    displayName: 'Ballad Vocal',
    category: 'character',
    description: 'Vocal-forward ballad master — clear presence and air with a trimmed low end so the voice sits up front.',
    intendedPlatform: ['Spotify', 'Apple Music'],
    loudnessProfile: 'streaming',
    tonalBalance: 'bright',
    aiOptimized: false,
    monoSafe: true,
    recommendedGenres: ['Ballad', 'R&B', 'Singer-Songwriter'],
    accent: ACCENT.violet,
    version: '1.1.0',
    // v1.1: less low (lowCut 42, lowShelf 0.2) so it never gets boomy;
    // air eased to 1.6, gentle 1.8:1 comp to keep dynamics.
    tuning: tune({
      eq:       { parameters: { lowCutHz: 42, lowShelfDb: 0.2, presenceDb: 1.8, airDb: 1.6, outputGainDb: 0 } },
      dynamics: { parameters: { thresholdDb: -13, ratio: 1.8, attackMs: 16, releaseMs: 170, mixPct: 88 } },
      imager:   { parameters: { widthPct: 100, lowMonoHz: 110 } },
      limiter:  { parameters: { targetLufs: -14, ceilingDbtp: -1.0, lookaheadMs: 3.0, character: 'glue' } },
    }),
  },
  {
    id: 'piano-natural',
    displayName: 'Piano Natural',
    category: 'character',
    description: 'Transparent, dynamic acoustic master — minimal coloring and the lightest touch of limiting.',
    intendedPlatform: ['Apple Music', 'Tidal', 'Classical streaming'],
    loudnessProfile: 'dynamic',
    tonalBalance: 'neutral',
    aiOptimized: false,
    monoSafe: true,
    recommendedGenres: ['Piano', 'Classical', 'Acoustic', 'Ambient'],
    accent: ACCENT.slate,
    version: '1.1.0',
    // v1.1: maximally dynamic — softer 1.4:1 / 60% parallel comp, longer
    // 5 ms lookahead for clean transients, no over-compression.
    tuning: tune({
      eq:       { parameters: { lowCutHz: 26, lowShelfDb: 0.0, presenceDb: 0.3, airDb: 1.0, outputGainDb: 0 } },
      dynamics: { parameters: { thresholdDb: -9, ratio: 1.4, attackMs: 28, releaseMs: 260, mixPct: 60 } },
      imager:   { parameters: { widthPct: 100, lowMonoHz: 80 } },
      limiter:  { parameters: { targetLufs: -16, ceilingDbtp: -1.0, lookaheadMs: 5.0, character: 'transparent' } },
    }),
  },
  {
    id: 'vintage-soft',
    displayName: 'Vintage Soft',
    category: 'character',
    description: 'Soft, rounded vintage tone — warm lows, gently tamed top, classic limiter glue.',
    intendedPlatform: ['Spotify', 'YouTube'],
    loudnessProfile: 'streaming',
    tonalBalance: 'warm',
    aiOptimized: false,
    monoSafe: true,
    recommendedGenres: ['Soul', 'Funk', 'Indie', 'Retro Pop'],
    accent: ACCENT.amber,
    version: '1.1.0',
    // v1.1: rounder — fuller low-shelf (1.8), top tamed a bit more
    // (air −1.5) with a touch of presence dip; slightly narrowed.
    tuning: tune({
      eq:       { parameters: { lowCutHz: 30, lowShelfDb: 1.8, presenceDb: 0.2, airDb: -1.5, outputGainDb: 0 } },
      dynamics: { parameters: { thresholdDb: -15, ratio: 2.5, attackMs: 16, releaseMs: 190, mixPct: 100 } },
      imager:   { parameters: { widthPct: 98, lowMonoHz: 110 } },
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
    description: 'Tames 2–5 kHz AI-vocal harshness and clears low-mid mud while keeping the voice intelligible.',
    intendedPlatform: ['Spotify', 'Apple Music', 'TikTok'],
    loudnessProfile: 'streaming',
    tonalBalance: 'neutral',
    aiOptimized: true,
    monoSafe: true,
    recommendedGenres: ['AI Pop', 'AI Vocal', 'Cover'],
    accent: ACCENT.violet,
    version: '1.1.0',
    // v1.1: presence cut eased −2.5→−2.0 so it de-harshes WITHOUT dulling,
    // and a small air lift (0.8) restores "open" clarity; de-mud retained.
    tuning: tune({
      eq:       { parameters: { lowCutHz: 46, lowShelfDb: -1.0, presenceDb: -2.0, airDb: 0.8, outputGainDb: 0 } },
      dynamics: { parameters: { thresholdDb: -14, ratio: 2.4, attackMs: 10, releaseMs: 140, mixPct: 100 } },
      imager:   { parameters: { widthPct: 100, lowMonoHz: 130 } },
      limiter:  { parameters: { targetLufs: -14, ceilingDbtp: -1.0, lookaheadMs: 3.0, character: 'glue' } },
    }),
  },
  {
    id: 'ai-vocal-texture',
    displayName: 'AI Vocal Texture',
    category: 'ai-special',
    description: 'Removes the watery, swirling sheen generative tools leave on vocal consonants — rebuilds the top end from a healthy midrange instead of boosting the damaged one, then tightens what is left.',
    intendedPlatform: ['Spotify', 'Apple Music', 'YouTube', 'TikTok'],
    loudnessProfile: 'streaming',
    tonalBalance: 'neutral',
    aiOptimized: true,
    monoSafe: true,
    recommendedGenres: ['AI Pop', 'AI Vocal', 'Suno', 'Cover'],
    accent: ACCENT.green,
    version: '1.0.0',
    // The five moves that address the artefact, in the order they matter.
    //
    //   1. Top Rebuild does the actual repair — the damaged band leaves and
    //      a replacement built from 4.5 kHz arrives in its place.  70 %
    //      rather than 100 % because cymbals share that band and a full
    //      replacement makes them sound synthetic.
    //   2. Spectral Shaper catches the frame-to-frame swirl that survives,
    //      above the rebuild's crossover.
    //   3. De-esser at a modest range: generated sibilance is broader than
    //      a real 's', so a little over a wide band beats a lot of a narrow
    //      one.
    //   4. The imager narrows the top only.  The artefact is partly a
    //      phase smear, and pulling the top in is what makes the voice sit
    //      in the centre again — the single most audible move here.
    //   5. Impact restores the consonant attack the rebuild cannot: the
    //      envelope is copied from a band that had its transients smeared.
    //
    // Loudness is left at streaming defaults: this preset fixes a texture,
    // it does not decide how loud the record is.
    tuning: tune({
      'top-rebuild': {
        bypass: false,
        parameters: {
          amountPct: 70, crossoverHz: 9000, sourceHz: 4500,
          characterPct: 60, followMs: 12,
        },
      },
      'spectral-shaper': {
        bypass: false,
        parameters: {
          amountPct: 60, thresholdDb: 4.5, lowHz: 8000, highHz: 16000, blurBins: 12,
        },
      },
      deess: {
        bypass: false,
        parameters: {
          frequencyHz: 6500, rangeDb: 5, thresholdDb: -30, ratio: 4,
          attackMs: 1, releaseMs: 60, wideband: false,
        },
      },
      imager: { parameters: { widthPct: 100, lowMonoHz: 120, bandHighPct: 78, bandMidHighPct: 92 } },
      impact: {
        bypass: false,
        parameters: { crossover1Hz: 120, crossover2Hz: 800, crossover3Hz: 5000, band2Pct: 18 },
      },
      eq: { parameters: { lowCutHz: 34, lowShelfDb: 0, presenceDb: -0.5, airDb: 0.6, outputGainDb: 0 } },
      dynamics: { parameters: { thresholdDb: -14, ratio: 2.0, attackMs: 12, releaseMs: 140, mixPct: 100 } },
      limiter: { parameters: { targetLufs: -14, ceilingDbtp: -1.0, lookaheadMs: 3.0, character: 'glue' } },
    }),
  },
  {
    id: 'cymbal-smooth',
    displayName: 'Cymbal Smooth',
    category: 'ai-special',
    description: 'Smooths metallic, splashy AI cymbals + hi-hats — strong air roll-off, gentle upper-mid trim.',
    intendedPlatform: ['Spotify', 'YouTube'],
    loudnessProfile: 'streaming',
    tonalBalance: 'warm',
    aiOptimized: true,
    monoSafe: true,
    recommendedGenres: ['AI Pop', 'AI Rock', 'Electronic'],
    accent: ACCENT.cyan,
    version: '1.1.0',
    // v1.1: target the cymbal band harder (air −3.0) but ease the 3 kHz
    // cut to −1.0 so the mix doesn't go dull — cymbal-specific, not muffled.
    tuning: tune({
      eq:       { parameters: { lowCutHz: 32, lowShelfDb: 0.6, presenceDb: -1.0, airDb: -3.0, outputGainDb: 0 } },
      dynamics: { parameters: { thresholdDb: -14, ratio: 2.0, attackMs: 14, releaseMs: 150, mixPct: 100 } },
      imager:   { parameters: { widthPct: 100, lowMonoHz: 120 } },
      limiter:  { parameters: { targetLufs: -14, ceilingDbtp: -1.0, lookaheadMs: 3.0, character: 'glue' } },
    }),
  },
  {
    id: 'stereo-repair',
    displayName: 'Stereo Repair',
    category: 'ai-special',
    description: 'Fixes fake / over-wide AI stereo — narrows the image and forces a wide mono low end for phase safety.',
    intendedPlatform: ['Spotify', 'Apple Music', 'Club'],
    loudnessProfile: 'streaming',
    tonalBalance: 'neutral',
    aiOptimized: true,
    monoSafe: true,
    recommendedGenres: ['AI Pop', 'AI Electronic', 'Upmixed'],
    accent: ACCENT.blue,
    version: '1.1.0',
    // v1.1: stronger correction — width 90→88 and low-mono 220→240 so the
    // phasey fake-wide bass collapses to mono and survives fold-down.
    tuning: tune({
      eq:       { parameters: { lowCutHz: 32, lowShelfDb: 0.4, presenceDb: 0.4, airDb: 1.0, outputGainDb: 0 } },
      dynamics: { parameters: { thresholdDb: -14, ratio: 2.0, attackMs: 12, releaseMs: 130, mixPct: 100 } },
      imager:   { parameters: { widthPct: 88, lowMonoHz: 240 } },
      limiter:  { parameters: { targetLufs: -14, ceilingDbtp: -1.0, lookaheadMs: 2.5, character: 'glue' } },
    }),
  },
  {
    id: 'mono-safe-shorts',
    displayName: 'Mono Safe Shorts',
    category: 'ai-special',
    description: 'For phone speakers, Shorts & Reels — mono-collapse-proof, clear on tiny speakers, punchy yet safe.',
    intendedPlatform: ['TikTok', 'YouTube Shorts', 'Instagram Reels'],
    loudnessProfile: 'loud',
    tonalBalance: 'bright',
    aiOptimized: true,
    monoSafe: true,
    recommendedGenres: ['Short-form', 'AI Pop', 'Hook'],
    accent: ACCENT.green,
    version: '1.1.0',
    // v1.1: mono-collapse-proof — slightly narrowed (95) + very high
    // low-mono (200); more presence (1.4) for tiny-speaker clarity, fast
    // punchy comp retained.
    tuning: tune({
      eq:       { parameters: { lowCutHz: 50, lowShelfDb: 0.2, presenceDb: 1.4, airDb: 1.6, outputGainDb: 0 } },
      dynamics: { parameters: { thresholdDb: -16, ratio: 2.6, attackMs: 8, releaseMs: 110, mixPct: 100 } },
      imager:   { parameters: { widthPct: 95, lowMonoHz: 200 } },
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
