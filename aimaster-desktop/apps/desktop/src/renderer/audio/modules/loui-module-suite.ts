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
// The status here is GROUNDED in what actually exists.  Since the module
// suite landed, the Rust `MasteringChain` runs BOTH paths — the WASM
// worklet for the realtime preview and the node-target WASM for the offline
// export render — driven by the same `ChainConfigWire` object.  A module
// implemented in that chain is therefore genuinely `live`: the same code
// produces the preview you hear and the file you get.
//
// Modules still marked `preview-only` are the ones the export path cannot
// carry (preset-backed AI entries, which apply through the preview EQ), and
// `planned` remains reserved for things with no DSP at all.  Nothing claims
// "live" without backing.

import type { ModuleId } from '../parameters/parameter-state.js';

export type ModuleStatus = 'live' | 'preview-only' | 'export-only' | 'planned';

export type ModuleCategory =
  | 'restoration' // repair — runs before anything else in the chain
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
  /** Maps to a parameter module (opens its panel).  See `ModuleId`. */
  paramModuleId?: ModuleId;
  /** Delivered as a Loui preset rather than a standalone DSP module. */
  presetBacked?: boolean;
  description: string;
  /** Loui-native algorithm name where one applies (no third-party terms). */
  algorithmName?: string;
}

// ── The lineup ────────────────────────────────────────────────────────
//
// Registry order mirrors the Rust MasteringChain's signal flow:
//   input gain
//   → de-click → de-hum → de-noise → de-esser          (restoration)
//   → parametric EQ → match EQ / shaper / stabilizer   (corrective)
//   → vintage EQ → EQ → dynamic EQ                     (tone)
//   → multiband → glue → vintage comp → impact → low end focus
//   → exciter → tape                                   (character)
//   → imager → limiter/maximizer → output gain

const SUITE: LouiModule[] = [
  {
    id: 'eq', displayName: 'EQ', category: 'tone', status: 'live',
    previewSupport: 'full', exportSupport: 'full', defaultBypass: false, cpuCost: 'low',
    visual: 'eq-curve', paramModuleId: 'eq',
    description: 'Low cut / low shelf / presence / air tone shaping. Heard live in the preview; output gain is export-renderable.',
  },
  {
    id: 'dynamic-eq', displayName: 'Dynamic EQ', category: 'tone', status: 'live',
    previewSupport: 'full', exportSupport: 'full', defaultBypass: true, cpuCost: 'medium',
    visual: 'eq-curve',
    description: 'Six bands of level-dependent EQ. Down mode cuts what only gets loud; Up mode lifts what only gets quiet. Live in preview and export.',
  },
  {
    id: 'dynamics', displayName: 'Dynamics', category: 'dynamics', status: 'live',
    previewSupport: 'full', exportSupport: 'full', defaultBypass: false, cpuCost: 'low',
    visual: 'gr-meter', paramModuleId: 'dynamics', algorithmName: 'Loui Glue',
    description: 'Single-band glue compression (threshold / ratio / attack / release / mix). Live in the preview.',
  },
  {
    id: 'imager', displayName: 'Imager', category: 'stereo', status: 'live',
    previewSupport: 'full', exportSupport: 'full', defaultBypass: false, cpuCost: 'low',
    visual: 'vectorscope', paramModuleId: 'imager',
    description: 'Stereo width + low-mono fold-down. Width is export-renderable; low-mono is preview-only.',
  },
  {
    id: 'limiter', displayName: 'Limiter', category: 'dynamics', status: 'live',
    previewSupport: 'full', exportSupport: 'full', defaultBypass: false, cpuCost: 'medium',
    visual: 'gr-meter', paramModuleId: 'limiter', algorithmName: 'Loui Clean Limit',
    description: 'True-peak-safe ceiling with lookahead + ISP. Live in preview AND export.',
  },
  {
    id: 'maximizer', displayName: 'Maximizer', category: 'dynamics', status: 'live',
    previewSupport: 'full', exportSupport: 'full', defaultBypass: false, cpuCost: 'medium',
    visual: 'gr-meter', paramModuleId: 'limiter', algorithmName: 'Loui Loud Push',
    description: 'Loudness target + push character, true-peak protected. Loudness is export-renderable.',
  },
  {
    id: 'exciter', displayName: 'Exciter', category: 'character', status: 'live',
    previewSupport: 'full', exportSupport: 'full', defaultBypass: true, cpuCost: 'medium',
    visual: 'spectrum',
    description: 'Four-band harmonic exciter — Warm / Retro / Tape / Tube / Triode. Level-matched per band, so drive changes colour rather than volume.',
  },
  {
    id: 'bass-control', displayName: 'Bass Control', category: 'lowend', status: 'planned',
    previewSupport: 'none', exportSupport: 'none', defaultBypass: true, cpuCost: 'low',
    visual: 'lowend-meter',
    description: 'Sub balance / punch / mud control. Covered today by Low End Focus and the multiband low band; a dedicated module is still planned.',
  },
  {
    id: 'low-end-focus', displayName: 'Low End Focus', category: 'lowend', status: 'live',
    previewSupport: 'full', exportSupport: 'full', defaultBypass: true, cpuCost: 'medium',
    visual: 'lowend-meter',
    description: 'Punchy separates low transients; Smooth evens the bottom out. Plus a low-band-only trim.',
  },
  {
    id: 'harshness-control', displayName: 'Harshness Control', category: 'tone', status: 'live',
    previewSupport: 'full', exportSupport: 'full', defaultBypass: true, cpuCost: 'high',
    visual: 'spectrum', paramModuleId: 'spectral-shaper',
    description: 'Spectral Shaper — pulls down any bin sitting above its own spectral neighbourhood, so resonances and harshness are tamed without a static notch.',
  },
  {
    id: 'reference-match', displayName: 'Reference Match', category: 'reference', status: 'live',
    previewSupport: 'full', exportSupport: 'full', defaultBypass: true, cpuCost: 'high',
    visual: 'spectrum', paramModuleId: 'match-eq',
    description: 'Matches the long-term tonal curve towards a reference (NOT a copy of it) on a 32-band log grid, with a per-band ceiling on the move.',
  },
  {
    id: 'declick', displayName: 'De-click', category: 'restoration', status: 'live',
    previewSupport: 'full', exportSupport: 'full', defaultBypass: true, cpuCost: 'low',
    visual: 'none', paramModuleId: 'declick', algorithmName: 'Loui Repair',
    description: 'Finds impulsive defects against a smoothed local level and repairs them by cubic interpolation across the damage.',
  },
  {
    id: 'dehum', displayName: 'De-hum', category: 'restoration', status: 'live',
    previewSupport: 'full', exportSupport: 'full', defaultBypass: false, cpuCost: 'low',
    visual: 'spectrum', paramModuleId: 'dehum',
    description: 'Mains hum comb — fundamental plus up to twelve harmonics. Adaptive mode backs off on harmonics that carry music.',
  },
  {
    id: 'denoise', displayName: 'De-noise', category: 'restoration', status: 'live',
    previewSupport: 'full', exportSupport: 'full', defaultBypass: false, cpuCost: 'high',
    visual: 'spectrum', paramModuleId: 'denoise', algorithmName: 'Loui Spectral Clean',
    description: 'Spectral broadband de-noise with a learned or auto-tracked noise profile. Adds one STFT frame of latency when engaged.',
  },
  {
    id: 'deess', displayName: 'De-esser', category: 'restoration', status: 'live',
    previewSupport: 'full', exportSupport: 'full', defaultBypass: false, cpuCost: 'low',
    visual: 'gr-meter', paramModuleId: 'deess',
    description: 'Split-band sibilance control applied as a dynamic high shelf, so the body of the mix never moves.',
  },
  {
    id: 'spectral-shaper', displayName: 'Spectral Shaper', category: 'tone', status: 'live',
    previewSupport: 'full', exportSupport: 'full', defaultBypass: false, cpuCost: 'high',
    visual: 'spectrum', paramModuleId: 'spectral-shaper', algorithmName: 'Loui Resonance Tame',
    description: 'Per-frame spectral smoothing — tames resonances and harshness that only appear on some notes.',
  },
  {
    id: 'stabilizer', displayName: 'Stabilizer', category: 'tone', status: 'live',
    previewSupport: 'full', exportSupport: 'full', defaultBypass: false, cpuCost: 'high',
    visual: 'spectrum', paramModuleId: 'stabilizer',
    description: 'Pulls the long-term tonal curve towards a target tilt. No reference track needed.',
  },
  {
    id: 'vintage-eq', displayName: 'Vintage EQ', category: 'tone', status: 'live',
    previewSupport: 'full', exportSupport: 'full', defaultBypass: false, cpuCost: 'low',
    visual: 'eq-curve', paramModuleId: 'vintage-eq', algorithmName: 'Loui Program EQ',
    description: 'Passive program EQ. Low boost and attenuation at the same frequency do not cancel — you get the lift with a scooped upper bass.',
  },
  {
    id: 'multiband', displayName: 'Multiband Dynamics', category: 'dynamics', status: 'live',
    previewSupport: 'full', exportSupport: 'full', defaultBypass: false, cpuCost: 'medium',
    visual: 'gr-meter', paramModuleId: 'multiband', algorithmName: 'Loui Four Band',
    description: 'Four Linkwitz-Riley bands, each compressing or expanding independently, with makeup, parallel mix and solo.',
  },
  {
    id: 'vintage-comp', displayName: 'Vintage Comp', category: 'dynamics', status: 'live',
    previewSupport: 'full', exportSupport: 'full', defaultBypass: false, cpuCost: 'low',
    visual: 'gr-meter', paramModuleId: 'vintage-comp', algorithmName: 'Loui Vari-Mu',
    description: 'Vari-mu behaviour: a knee that softens as it works harder, a program-dependent release, and saturation that rides with the gain reduction.',
  },
  {
    id: 'impact', displayName: 'Impact', category: 'dynamics', status: 'live',
    previewSupport: 'full', exportSupport: 'full', defaultBypass: false, cpuCost: 'medium',
    visual: 'gr-meter', paramModuleId: 'impact', algorithmName: 'Loui Transient',
    description: 'Multiband transient shaper driven by the gap between a fast and a slow envelope, so sustained material is left alone.',
  },
  {
    id: 'tape', displayName: 'Tape', category: 'character', status: 'live',
    previewSupport: 'full', exportSupport: 'full', defaultBypass: false, cpuCost: 'medium',
    visual: 'spectrum', paramModuleId: 'tape', algorithmName: 'Loui Transport',
    description: 'Tape machine model — record saturation, head bump, gap loss and wow/flutter, selectable at 7.5 / 15 / 30 ips.',
  },
  {
    id: 'dither', displayName: 'Dither', category: 'output', status: 'live',
    previewSupport: 'full', exportSupport: 'full', defaultBypass: false, cpuCost: 'low',
    visual: 'none', paramModuleId: 'export', algorithmName: 'Loui Quantise',
    description: 'TPDF or noise-shaped dither on bit-depth reduction, with auto-blanking. Quantises the preview to the export depth too, so the choice can be auditioned before committing to a file. Inactive at 32-bit float.',
  },
  {
    id: 'export', displayName: 'Export', category: 'output', status: 'export-only',
    previewSupport: 'none', exportSupport: 'full', defaultBypass: false, cpuCost: 'none',
    visual: 'none', paramModuleId: 'export',
    description: 'Container format, sample rate and bit depth for the written file. Applied on export render, not in the preview.',
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
    id: 'ai-harshness-guard', displayName: 'AI Harshness Guard', category: 'ai', status: 'live',
    previewSupport: 'full', exportSupport: 'full', defaultBypass: true, cpuCost: 'medium',
    visual: 'spectrum', paramModuleId: 'dynamic-eq',
    description: 'Always-on dynamic harshness ceiling for AI material, built on the Dynamic EQ. Live in preview and export.',
  },
];

export const LOUI_MODULES: readonly LouiModule[] = [...SUITE, ...AI_MODULES];

const BY_ID = new Map(LOUI_MODULES.map((m) => [m.id, m]));
export function getModule(id: string): LouiModule | undefined { return BY_ID.get(id); }

/**
 * Chain-order modules — the signal-flow lineup, excluding AI/preset entries.
 *
 * Written out explicitly rather than derived from the registry's array
 * order: the registry groups modules by when they were added, while this is
 * the order audio actually passes through them in `MasteringChain`.  A UI
 * that renders the chain must use this list, or it will show a signal flow
 * the engine does not have.
 */
export const CHAIN_MODULE_IDS: readonly string[] = [
  'declick', 'dehum', 'denoise', 'deess',
  'reference-match', 'harshness-control', 'stabilizer', 'spectral-shaper',
  'vintage-eq', 'eq', 'dynamic-eq',
  'multiband', 'dynamics', 'vintage-comp', 'impact', 'low-end-focus', 'bass-control',
  'exciter', 'tape',
  'imager', 'limiter', 'maximizer',
  'dither', 'export',
];

export const MODULE_CATEGORY_LABEL: Record<ModuleCategory, string> = {
  restoration: 'Restoration',
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
