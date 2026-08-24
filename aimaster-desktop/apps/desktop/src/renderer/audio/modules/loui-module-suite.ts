// Loui Module Suite (OZONE-STYLE-MODULE-SUITE).
//
// A modular-mastering registry inspired by the *structure* of pro
// mastering suites (EQ / Dynamics / Imager / Limiter / Maximizer / …),
// re-imagined for Loui — AI-music + streaming focused, charcoal/lavender.
// NOT a clone of any product's names, art, or algorithms.
//
// HONESTY IS THE CONTRACT (see MODULE_STATUS_POLICY.md):
//   • live         — processes in BOTH the realtime preview AND the
//                    offline export (parameters reach the exported file).
//   • preview-only — processes in the Rust realtime preview chain, but the
//                    export pipeline does not yet honour it.
//   • export-only  — affects the offline export render only (not preview).
//   • planned      — no DSP yet; UI shell, clearly badged "Coming soon".
//
// The status here is GROUNDED in what actually exists: the Rust
// MasteringChain (EQ/dynamics/imager/limiter) for preview, and the 4
// export-renderable params (targetLufs / targetTp / stereoWidth /
// outputGainDb).  Nothing claims "live" without backing.

export type ModuleStatus = 'live' | 'preview-only' | 'export-only' | 'planned';

export type ModuleCategory =
  | 'tone'        // EQ-family
  | 'dynamics'    // compression / limiting / loudness
  | 'stereo'      // imaging
  | 'lowend'      // bass / sub
  | 'character'   // saturation / excitement
  | 'ai'          // AI-music problem solvers (preset-backed)
  | 'reference'   // match / guidance
  | 'output';     // dither / export

/** What the main visualizer draws for this module when active. */
export type ModuleVisual = 'eq-curve' | 'spectrum' | 'gr-meter' | 'vectorscope' | 'lowend-meter' | 'none';

export type ModuleSupport = 'full' | 'partial' | 'none';

export interface LouiModule {
  id: string;
  displayName: string;
  category: ModuleCategory;
  status: ModuleStatus;
  /** Whether the realtime Rust preview chain processes this. */
  previewSupport: ModuleSupport;
  /** Whether the offline export honours this. */
  exportSupport: ModuleSupport;
  /** Default chain bypass state (UI). */
  defaultBypass: boolean;
  /** Relative CPU cost estimate for the realtime path (0 = none). */
  cpuCost: 'none' | 'low' | 'medium' | 'high';
  visual: ModuleVisual;
  /** Maps to an existing ProductPage parameter module (opens its panel). */
  paramModuleId?: 'eq' | 'dynamics' | 'imager' | 'limiter' | 'export';
  /** Delivered as a Loui preset rather than a standalone DSP module. */
  presetBacked?: boolean;
  description: string;
  /** Loui-native algorithm name where one applies (no third-party terms). */
  algorithmName?: string;
}

// ── The first official lineup ─────────────────────────────────────────
//
// Chain order mirrors the Rust MasteringChain:
//   input gain → EQ → dynamics → imager → limiter → output

const SUITE: LouiModule[] = [
  {
    id: 'eq', displayName: 'EQ', category: 'tone', status: 'preview-only',
    previewSupport: 'full', exportSupport: 'partial', defaultBypass: false, cpuCost: 'low',
    visual: 'eq-curve', paramModuleId: 'eq',
    description: 'Low cut / low shelf / presence / air tone shaping. Heard live in the preview; output gain is export-renderable.',
  },
  {
    id: 'dynamic-eq', displayName: 'Dynamic EQ', category: 'tone', status: 'planned',
    previewSupport: 'none', exportSupport: 'none', defaultBypass: true, cpuCost: 'medium',
    visual: 'eq-curve',
    description: 'Frequency-conscious dynamics (per-band threshold/gain). No DSP yet — planned.',
  },
  {
    id: 'dynamics', displayName: 'Dynamics', category: 'dynamics', status: 'preview-only',
    previewSupport: 'full', exportSupport: 'none', defaultBypass: false, cpuCost: 'low',
    visual: 'gr-meter', paramModuleId: 'dynamics', algorithmName: 'Loui Glue',
    description: 'Single-band glue compression (threshold / ratio / attack / release / mix). Live in the preview.',
  },
  {
    id: 'imager', displayName: 'Imager', category: 'stereo', status: 'live',
    previewSupport: 'full', exportSupport: 'partial', defaultBypass: false, cpuCost: 'low',
    visual: 'vectorscope', paramModuleId: 'imager',
    description: 'Stereo width + low-mono fold-down. Width is export-renderable; low-mono is preview-only.',
  },
  {
    id: 'limiter', displayName: 'Limiter', category: 'dynamics', status: 'live',
    previewSupport: 'full', exportSupport: 'full', defaultBypass: false, cpuCost: 'medium',
    visual: 'gr-meter', paramModuleId: 'limiter', algorithmName: 'Loui Clean Limit',
    description: 'Lookahead ceiling. The export measures inter-sample peaks at 4× and pulls the file down; the preview only leaves fixed headroom for them.',
  },
  {
    id: 'maximizer', displayName: 'Maximizer', category: 'dynamics', status: 'live',
    previewSupport: 'full', exportSupport: 'full', defaultBypass: false, cpuCost: 'medium',
    visual: 'gr-meter', paramModuleId: 'limiter', algorithmName: 'Loui Loud Push',
    description: 'Loudness target + push character, through the same ceiling as the Limiter. Loudness is export-renderable.',
  },
  {
    id: 'exciter', displayName: 'Exciter', category: 'character', status: 'planned',
    previewSupport: 'none', exportSupport: 'none', defaultBypass: true, cpuCost: 'low',
    visual: 'spectrum',
    description: 'Harmonic excitement / warmth. No DSP yet — planned.',
  },
  {
    id: 'bass-control', displayName: 'Bass Control', category: 'lowend', status: 'planned',
    previewSupport: 'none', exportSupport: 'none', defaultBypass: true, cpuCost: 'low',
    visual: 'lowend-meter',
    description: 'Sub balance / punch / mud control. No dedicated DSP yet — planned (low shelf approximates today).',
  },
  {
    id: 'low-end-focus', displayName: 'Low End Focus', category: 'lowend', status: 'planned',
    previewSupport: 'none', exportSupport: 'none', defaultBypass: true, cpuCost: 'medium',
    visual: 'lowend-meter',
    description: 'Mono-locks + tightens the sub for translation. No DSP yet — planned.',
  },
  {
    id: 'harshness-control', displayName: 'Harshness Control', category: 'tone', status: 'planned',
    previewSupport: 'none', exportSupport: 'none', defaultBypass: true, cpuCost: 'medium',
    visual: 'spectrum',
    description: '2–5 kHz harshness taming. Today delivered via AI presets (AI Vocal Cleaner / Cymbal Smooth); a dedicated dynamic module is planned.',
  },
  {
    id: 'reference-match', displayName: 'Reference Match', category: 'reference', status: 'planned',
    previewSupport: 'none', exportSupport: 'none', defaultBypass: true, cpuCost: 'low',
    visual: 'spectrum',
    description: 'Tonal guidance from a reference track (NOT a copy). Analysis + delta planned.',
  },
  {
    id: 'export', displayName: 'Dither / Export', category: 'output', status: 'export-only',
    previewSupport: 'none', exportSupport: 'partial', defaultBypass: false, cpuCost: 'none',
    visual: 'none', paramModuleId: 'export',
    description: 'Sample rate + bit depth are applied on export render (not preview). Dither is planned.',
  },
];

// ── AI-special modules (preset-backed; honest about it) ────────────────
const AI_MODULES: LouiModule[] = [
  {
    id: 'ai-vocal-cleaner', displayName: 'AI Vocal Cleaner', category: 'ai', status: 'preview-only',
    previewSupport: 'full', exportSupport: 'partial', defaultBypass: true, cpuCost: 'low',
    visual: 'spectrum', presetBacked: true,
    description: 'Tames AI vocal harshness via the preview EQ chain. Delivered as a preset (apply from the Preset Browser).',
  },
  {
    id: 'cymbal-smooth', displayName: 'Cymbal Smooth', category: 'ai', status: 'preview-only',
    previewSupport: 'full', exportSupport: 'partial', defaultBypass: true, cpuCost: 'low',
    visual: 'spectrum', presetBacked: true,
    description: 'Smooths metallic AI cymbals via the preview EQ chain. Preset-backed.',
  },
  {
    id: 'stereo-repair', displayName: 'Stereo Repair', category: 'ai', status: 'preview-only',
    previewSupport: 'full', exportSupport: 'partial', defaultBypass: true, cpuCost: 'low',
    visual: 'vectorscope', presetBacked: true,
    description: 'Collapses fake-wide AI stereo (width + low-mono). Width is export-renderable. Preset-backed.',
  },
  {
    id: 'mono-safe-shorts', displayName: 'Mono Safe Shorts', category: 'ai', status: 'preview-only',
    previewSupport: 'full', exportSupport: 'partial', defaultBypass: true, cpuCost: 'low',
    visual: 'vectorscope', presetBacked: true,
    description: 'Mobile / Shorts mono-robust master. Preset-backed.',
  },
  {
    id: 'ai-harshness-guard', displayName: 'AI Harshness Guard', category: 'ai', status: 'planned',
    previewSupport: 'none', exportSupport: 'none', defaultBypass: true, cpuCost: 'medium',
    visual: 'spectrum',
    description: 'Always-on dynamic harshness ceiling for AI material. Planned (needs dynamic EQ DSP).',
  },
];

export const LOUI_MODULES: readonly LouiModule[] = [...SUITE, ...AI_MODULES];

const BY_ID = new Map(LOUI_MODULES.map((m) => [m.id, m]));
export function getModule(id: string): LouiModule | undefined { return BY_ID.get(id); }

/** Chain-order modules (the signal-flow lineup, excluding AI/preset entries). */
export const CHAIN_MODULE_IDS: readonly string[] = SUITE.map((m) => m.id);

export const MODULE_CATEGORY_LABEL: Record<ModuleCategory, string> = {
  tone: 'Tone', dynamics: 'Dynamics', stereo: 'Stereo', lowend: 'Low End',
  character: 'Character', ai: 'AI Special', reference: 'Reference', output: 'Output',
};

export const MODULE_STATUS_LABEL: Record<ModuleStatus, string> = {
  live: 'Live', 'preview-only': 'Preview only', 'export-only': 'Export only', planned: 'Coming soon',
};

/** Modules that actually do something today (preview and/or export). */
export function activeModules(): LouiModule[] {
  return LOUI_MODULES.filter((m) => m.status !== 'planned');
}
