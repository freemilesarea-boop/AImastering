// Canonical parameter definitions for the five product-layout modules.
//
// Every parameter on every slide-over panel maps to an entry here.  This
// file is the single source of truth for:
//
//   • min / max / step / default values
//   • display label + hint copy
//   • engine binding target (used by M3-P-NEXT-5B / M2-full)
//
// IMPORTANT — this module does NOT touch the DSP chain.  The `binding`
// field is purely informational until M3-P-NEXT-5B wires it.

import type {
  AllModulesDefinitions,
  ModuleParameterDefinitions,
} from './parameter-state.js';
import { SUITE_PARAMETER_DEFS } from './suite-parameter-definitions.js';

// ── Number formatters ────────────────────────────────────────────────────

const fmt = {
  /** Sign-aware dB:  +1.2 / -3.4 / 0.0 */
  signedDb: (v: number): string => (v >= 0 ? `+${v.toFixed(1)}` : v.toFixed(1)),
  /** Integer dB / Hz / ms. */
  integer: (v: number): string => v.toFixed(0),
  /** 1-decimal absolute value (LUFS, dBTP, ms ≤ 100). */
  oneDec:  (v: number): string => v.toFixed(1),
  /** 2-decimal ratio. */
  ratio:   (v: number): string => v.toFixed(1),
};

// ── EQ ───────────────────────────────────────────────────────────────────

const EQ_DEFS: ModuleParameterDefinitions = {
  moduleId: 'eq',
  bypassBinding: {
    moduleType: 'adaptive-eq',
    path: 'bypass',
    status: 'pending',
    note: 'Adapter-side bypass not yet exposed; will be added in M2-full.',
  },
  parameters: [
    {
      kind: 'number', id: 'lowCutHz', label: 'Low Cut',
      hint: 'High-pass at the low end',
      unit: 'Hz', min: 20, max: 120, default: 32, step: 1,
      format: fmt.integer, automatable: true,
      binding: {
        moduleType: 'adaptive-eq',
        path: 'bands[lowCut].freqHz',
        status: 'pending',
      },
    },
    {
      kind: 'number', id: 'lowCutQ', label: 'Low Cut Q',
      hint: 'Resonance at the corner',
      min: 0.3, max: 6, default: 0.707, step: 0.01,
      format: fmt.ratio, automatable: true,
      binding: { moduleType: 'adaptive-eq', path: 'bands[lowCut].q', status: 'pending' },
    },
    {
      kind: 'number', id: 'lowShelfHz', label: 'Low Shelf Freq',
      unit: 'Hz', min: 20, max: 1000, default: 120, step: 1,
      format: fmt.integer, automatable: true,
      binding: { moduleType: 'adaptive-eq', path: 'bands[lowShelf].freqHz', status: 'pending' },
    },
    {
      kind: 'number', id: 'lowShelfDb', label: 'Low Shelf',
      // The gain range is ±18 rather than ±6: a graph you can drag is only
      // as expressive as the axis it is drawn on, and ±6 makes every move
      // look identical.
      unit: 'dB', min: -18, max: 18, default: 1.2, step: 0.1,
      format: fmt.signedDb, automatable: true,
      binding: {
        moduleType: 'adaptive-eq',
        path: 'bands[lowShelf].gainDb',
        status: 'pending',
      },
    },
    {
      kind: 'number', id: 'lowShelfQ', label: 'Low Shelf Slope',
      min: 0.3, max: 2, default: 0.707, step: 0.01,
      format: fmt.ratio, automatable: true,
      binding: { moduleType: 'adaptive-eq', path: 'bands[lowShelf].q', status: 'pending' },
    },
    {
      kind: 'number', id: 'presenceHz', label: 'Presence Freq',
      unit: 'Hz', min: 100, max: 16_000, default: 3000, step: 1,
      format: fmt.integer, automatable: true,
      binding: { moduleType: 'adaptive-eq', path: 'bands[presence].freqHz', status: 'pending' },
    },
    {
      kind: 'number', id: 'presenceDb', label: 'Presence',
      unit: 'dB', min: -18, max: 18, default: 1.4, step: 0.1,
      format: fmt.signedDb, automatable: true,
      binding: {
        moduleType: 'adaptive-eq',
        path: 'bands[presence].gainDb',
        status: 'pending',
      },
    },
    {
      kind: 'number', id: 'presenceQ', label: 'Presence Q',
      hint: 'Higher is narrower',
      min: 0.3, max: 12, default: 1.1, step: 0.01,
      format: fmt.ratio, automatable: true,
      binding: { moduleType: 'adaptive-eq', path: 'bands[presence].q', status: 'pending' },
    },
    {
      kind: 'number', id: 'airHz', label: 'Air Freq',
      unit: 'Hz', min: 2000, max: 20_000, default: 12_000, step: 10,
      format: fmt.integer, automatable: true,
      binding: { moduleType: 'adaptive-eq', path: 'bands[air].freqHz', status: 'pending' },
    },
    {
      kind: 'number', id: 'airDb', label: 'Air',
      unit: 'dB', min: -18, max: 18, default: 2.0, step: 0.1,
      format: fmt.signedDb, automatable: true,
      binding: {
        moduleType: 'adaptive-eq',
        path: 'bands[air].gainDb',
        status: 'pending',
      },
    },
    {
      kind: 'number', id: 'airQ', label: 'Air Slope',
      min: 0.3, max: 2, default: 0.707, step: 0.01,
      format: fmt.ratio, automatable: true,
      binding: { moduleType: 'adaptive-eq', path: 'bands[air].q', status: 'pending' },
    },
    {
      kind: 'number', id: 'outputGainDb', label: 'Output Gain',
      unit: 'dB', min: -12, max: 12, default: 0.0, step: 0.1,
      format: fmt.signedDb, automatable: true,
      binding: {
        moduleType: 'gain-staging',
        path: 'targetPeakDb',
        status: 'wired',
        note: 'Maps to gain-staging.targetPeakDb at write time.',
      },
    },
    {
      kind: 'boolean', id: 'adaptive', label: 'Adaptive',
      hint: 'Auto-tune EQ to spectral target',
      default: true,
      automatable: false,
      binding: {
        moduleType: 'adaptive-eq',
        path: 'adaptive',
        status: 'wired',
        note: 'Each adaptive-eq band has an `adaptive` flag in EngineSchema.',
      },
    },
  ],
};

// ── Dynamics (Glue Comp) ─────────────────────────────────────────────────

const DYNAMICS_DEFS: ModuleParameterDefinitions = {
  moduleId: 'dynamics',
  bypassBinding: {
    moduleType: 'bus-comp',
    path: 'bypass',
    status: 'pending',
  },
  parameters: [
    {
      kind: 'number', id: 'thresholdDb', label: 'Threshold',
      unit: 'dB', min: -30, max: 0, default: -14, step: 0.5,
      format: fmt.oneDec, automatable: true,
      binding: { moduleType: 'bus-comp', path: 'thresholdDb', status: 'wired' },
    },
    {
      kind: 'number', id: 'ratio', label: 'Ratio',
      unit: ':1', min: 1, max: 10, default: 2.0, step: 0.1,
      format: fmt.ratio, automatable: true,
      binding: { moduleType: 'bus-comp', path: 'ratio', status: 'wired' },
    },
    {
      kind: 'number', id: 'attackMs', label: 'Attack',
      unit: 'ms', min: 0.1, max: 100, default: 10, step: 0.5,
      format: fmt.oneDec, automatable: true,
      binding: { moduleType: 'bus-comp', path: 'attackMs', status: 'wired' },
    },
    {
      kind: 'number', id: 'releaseMs', label: 'Release',
      unit: 'ms', min: 10, max: 1000, default: 120, step: 5,
      format: fmt.integer, automatable: true,
      binding: { moduleType: 'bus-comp', path: 'releaseMs', status: 'wired' },
    },
    {
      kind: 'number', id: 'mixPct', label: 'Mix',
      hint: '0 = dry, 100 = fully compressed',
      unit: '%', min: 0, max: 100, default: 100, step: 1,
      format: fmt.integer, automatable: true,
      binding: {
        moduleType: 'bus-comp',
        path: 'mixPct',
        status: 'pending',
        note: 'bus-comp has no `mixPct` field today; M2-full will add it.',
      },
    },
  ],
};

// ── Imager ───────────────────────────────────────────────────────────────

const IMAGER_DEFS: ModuleParameterDefinitions = {
  moduleId: 'imager',
  bypassBinding: {
    moduleType: 'stereo-imager',
    path: 'bypass',
    status: 'pending',
  },
  parameters: [
    {
      kind: 'number', id: 'widthPct', label: 'Width',
      hint: '0 = mono · 200 = extreme wide',
      unit: '%', min: 0, max: 200, default: 100, step: 1,
      format: fmt.integer, automatable: true,
      binding: {
        moduleType: 'stereo-imager',
        path: 'width',
        status: 'wired',
        note: 'UI 0..200 maps to engine 0..2.0 (1.0 = passthrough).',
      },
    },
    {
      kind: 'number', id: 'lowMonoHz', label: 'Low Mono',
      hint: 'Sum L+R below this frequency',
      unit: 'Hz', min: 20, max: 400, default: 120, step: 5,
      format: fmt.integer, automatable: true,
      binding: {
        moduleType: 'stereo-imager',
        path: 'lowMonoFrequency',
        status: 'pending',
      },
    },
    {
      kind: 'boolean', id: 'stereoize', label: 'Stereoize',
      hint: 'Spread mono sources synthetically',
      default: false,
      automatable: false,
      binding: {
        moduleType: 'stereo-imager',
        path: 'stereoize',
        status: 'pending',
      },
    },
    {
      kind: 'number', id: 'bandLowPct', label: 'Low Band',
      unit: '%', min: 0, max: 200, default: 40, step: 5,
      format: fmt.integer, automatable: false,
      binding: { moduleType: 'stereo-imager', path: 'bands[0].width', status: 'pending' },
    },
    {
      kind: 'number', id: 'bandMidLowPct', label: 'Mid-Low Band',
      unit: '%', min: 0, max: 200, default: 100, step: 5,
      format: fmt.integer, automatable: false,
      binding: { moduleType: 'stereo-imager', path: 'bands[1].width', status: 'pending' },
    },
    {
      kind: 'number', id: 'bandMidHighPct', label: 'Mid-High Band',
      unit: '%', min: 0, max: 200, default: 110, step: 5,
      format: fmt.integer, automatable: false,
      binding: { moduleType: 'stereo-imager', path: 'bands[2].width', status: 'pending' },
    },
    {
      kind: 'number', id: 'bandHighPct', label: 'High Band',
      unit: '%', min: 0, max: 200, default: 90, step: 5,
      format: fmt.integer, automatable: false,
      binding: { moduleType: 'stereo-imager', path: 'bands[3].width', status: 'pending' },
    },
  ],
};

// ── Limiter ──────────────────────────────────────────────────────────────

const LIMITER_DEFS: ModuleParameterDefinitions = {
  moduleId: 'limiter',
  bypassBinding: {
    moduleType: 'limiter',
    path: 'bypass',
    status: 'pending',
    note: 'Disabling the limiter at this stage is dangerous; bypass surfaces as UI lock + warning.',
  },
  parameters: [
    {
      kind: 'number', id: 'targetLufs', label: 'Target LUFS',
      hint: 'Integrated loudness target',
      unit: 'LUFS', min: -24, max: -6, default: -14, step: 0.5,
      format: fmt.oneDec, automatable: true,
      binding: {
        moduleType: 'loudness-norm',
        path: 'targetLufs',
        status: 'wired',
        note: 'Drives the chain loudness loop: gain at the input from a measurement of the output.',
      },
    },
    {
      // The switch that makes Target LUFS audible while listening.
      //
      // It exists because the target has two honest meanings and they are
      // not the same job: "render the file at this loudness" (a two-pass
      // measurement, which the export does) and "let me HEAR it at this
      // loudness now" (a converging loop, which is this). Off leaves the
      // export behaviour exactly as it was.
      kind: 'boolean', id: 'autoGain', label: 'Auto Gain',
      hint: 'Reach Target LUFS while listening',
      default: true,
      onLabel: 'Auto', offLabel: 'Manual',
      automatable: false,
      binding: { moduleType: 'loudness-norm', path: 'enabled', status: 'wired' },
    },
    {
      kind: 'number', id: 'maxBoostDb', label: 'Max Boost',
      hint: 'Most Auto Gain may add',
      unit: 'dB', min: 0, max: 24, default: 12, step: 0.5,
      format: fmt.oneDec, automatable: false,
      binding: { moduleType: 'loudness-norm', path: 'maxBoostDb', status: 'wired' },
    },
    {
      // The manual counterpart, and the control that was missing entirely.
      //
      // `chain-config.ts` has always read `limiter.driveDb`, and the Rust
      // limiter has always used it as the maximizer input — but no
      // parameter defined it, so it read its default of 0 forever. The one
      // control that makes a master louder was unreachable from the UI.
      kind: 'number', id: 'driveDb', label: 'Drive',
      hint: 'Level pushed into the limiter',
      unit: 'dB', min: 0, max: 12, default: 0, step: 0.1,
      format: fmt.oneDec, automatable: true,
      binding: { moduleType: 'limiter', path: 'driveDb', status: 'wired' },
    },
    {
      kind: 'number', id: 'ceilingDbtp', label: 'True-Peak Ceiling',
      hint: 'Maximum allowed inter-sample peak',
      unit: 'dBTP', min: -3, max: 0, default: -1.0, step: 0.1,
      format: fmt.oneDec, automatable: true,
      binding: { moduleType: 'limiter', path: 'ceilingDb', status: 'wired' },
    },
    {
      kind: 'boolean', id: 'isp', label: 'True-Peak',
      hint: '4× oversampled ISP detection',
      default: true,
      onLabel: 'ISP', offLabel: 'Sample',
      automatable: false,
      binding: {
        moduleType: 'limiter',
        path: 'oversample',
        status: 'wired',
        note: 'ON → oversample=4; OFF → oversample=1.',
      },
    },
    {
      kind: 'number', id: 'lookaheadMs', label: 'Lookahead',
      hint: 'Anticipation buffer for transient capture',
      unit: 'ms', min: 0, max: 20, default: 2.5, step: 0.1,
      format: fmt.oneDec, automatable: true,
      binding: { moduleType: 'limiter', path: 'lookAheadMs', status: 'wired' },
    },
    {
      kind: 'enum', id: 'character', label: 'Character',
      values: ['transparent', 'glue', 'aggressive', 'classic'],
      default: 'glue',
      labels: {
        transparent: 'Transparent',
        glue:        'Glue',
        aggressive:  'Aggressive',
        classic:     'Classic',
      },
      hints: {
        transparent: 'Clean, hi-fi mastering',
        glue:        'Default — warms transients',
        aggressive:  'Loud, modern pop',
        classic:     'Vintage, soft saturation',
      },
      automatable: false,
      binding: {
        moduleType: 'limiter',
        path: 'character',
        status: 'pending',
        note: 'Only "glue" maps to today\'s Python limiter; others are M2-full additions.',
      },
    },
  ],
};

// ── Export ───────────────────────────────────────────────────────────────

const EXPORT_DEFS: ModuleParameterDefinitions = {
  moduleId: 'export',
  bypassBinding: {
    moduleType: null,
    path: 'bypass',
    status: 'unavailable',
    note: 'Export is a render-stage decision, not a DSP module.',
  },
  parameters: [
    {
      kind: 'enum', id: 'format', label: 'Format',
      values: ['wav', 'flac', 'mp3', 'aiff', 'ogg'],
      default: 'wav',
      labels: { wav: 'WAV', flac: 'FLAC', mp3: 'MP3', aiff: 'AIFF', ogg: 'OGG' },
      hints:  {
        wav:  'PCM · uncompressed',
        flac: 'Lossless compressed',
        mp3:  'Lossy · streaming',
        aiff: 'PCM · Apple',
        ogg:  'Vorbis · open',
      },
      automatable: false,
      binding: {
        moduleType: null,
        path: 'export.format',
        status: 'unavailable',
        note: 'Today the Electron main process exports MP3 + WAV; FLAC/AIFF/OGG land in M3-P-NEXT-5B.',
      },
    },
    {
      kind: 'enum', id: 'sampleRate', label: 'Sample Rate',
      values: ['44100', '48000', '88200', '96000', '192000'],
      default: '48000',
      labels: {
        '44100':  '44.1 kHz',
        '48000':  '48 kHz',
        '88200':  '88.2 kHz',
        '96000':  '96 kHz',
        '192000': '192 kHz',
      },
      hints:  {
        '48000':  'Default',
        '88200':  'Hi-res',
        '96000':  'Hi-res',
        '192000': 'Hi-res',
      },
      automatable: false,
      binding: {
        moduleType: null,
        path: 'export.sampleRate',
        status: 'unavailable',
        exportField: 'sampleRate',
        note: 'Export-renderable (M3-P-NEXT-5D-2-c) — applied on Re-master & Export, not preview.',
      },
    },
    {
      kind: 'enum', id: 'bitDepth', label: 'Bit Depth',
      values: ['16', '24', '32'],
      default: '24',
      labels: { '16': '16-bit', '24': '24-bit', '32': '32-bit Float' },
      hints:  {
        '16': 'CD / streaming',
        '24': 'Default',
        '32': 'Float (no clipping)',
      },
      automatable: false,
      binding: {
        moduleType: null,
        path: 'export.bitDepth',
        status: 'unavailable',
        exportField: 'bitDepth',
        note: 'Export-renderable, and now also the target the chain\'s dither stage quantises to — so the preview hears the same bit depth the file will have.',
      },
    },
    {
      kind: 'enum', id: 'dither', label: 'Dither',
      values: ['none', 'tpdf', 'shaped'],
      default: 'tpdf',
      labels: { none: 'None', tpdf: 'TPDF', shaped: 'Shaped' },
      hints:  {
        none:   'No noise added',
        tpdf:   'Standard noise dither',
        shaped: 'Noise-shaped (recommended)',
      },
      automatable: false,
      binding: {
        moduleType: 'dither',
        path: 'dither.mode',
        status: 'wired',
        note: 'Applied by the chain\'s dither stage, against `bitDepth`. Audible in the preview as well as the export, so the choice can be auditioned.',
      },
    },
    {
      kind: 'boolean', id: 'ditherAutoBlank', label: 'Auto-blank',
      hint: '무음 구간에서는 디더 노이즈를 멈춥니다',
      default: true,
      automatable: false,
      binding: {
        moduleType: 'dither',
        path: 'dither.autoBlank',
        status: 'wired',
      },
    },
  ],
};

// ── Aggregate ────────────────────────────────────────────────────────────

export const ALL_MODULE_PARAMETER_DEFS: AllModulesDefinitions = {
  // The original product-layout five.
  eq:       EQ_DEFS,
  dynamics: DYNAMICS_DEFS,
  imager:   IMAGER_DEFS,
  limiter:  LIMITER_DEFS,
  export:   EXPORT_DEFS,
  // Everything the Ozone-class suite added — see
  // `suite-parameter-definitions.ts`.
  ...SUITE_PARAMETER_DEFS,
};
