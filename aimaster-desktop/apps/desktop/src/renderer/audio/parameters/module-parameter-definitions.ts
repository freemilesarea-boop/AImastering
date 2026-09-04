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
      kind: 'number', id: 'lowShelfDb', label: 'Low Shelf',
      hint: '120 Hz / Q=0.7',
      unit: 'dB', min: -6, max: 6, default: 1.2, step: 0.1,
      format: fmt.signedDb, automatable: true,
      binding: {
        moduleType: 'adaptive-eq',
        path: 'bands[lowShelf].gainDb',
        status: 'pending',
      },
    },
    {
      kind: 'number', id: 'presenceDb', label: 'Presence',
      hint: '3 kHz peak / Q=1.1',
      unit: 'dB', min: -6, max: 6, default: 1.4, step: 0.1,
      format: fmt.signedDb, automatable: true,
      binding: {
        moduleType: 'adaptive-eq',
        path: 'bands[presence].gainDb',
        status: 'pending',
      },
    },
    {
      kind: 'number', id: 'airDb', label: 'Air',
      hint: '12 kHz shelf',
      unit: 'dB', min: -6, max: 6, default: 2.0, step: 0.1,
      format: fmt.signedDb, automatable: true,
      binding: {
        moduleType: 'adaptive-eq',
        path: 'bands[air].gainDb',
        status: 'pending',
      },
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
        note: 'Routes to loudness-norm.targetLufs (separate engine module).',
      },
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
        note: 'Export-renderable (M3-P-NEXT-5D-2-c) — applied on Re-master & Export, not preview.',
      },
    },
    {
      kind: 'enum', id: 'dither', label: 'Dither',
      values: ['none', 'tpdf', 'shaped', 'shaped-strong'],
      default: 'tpdf',
      labels: {
        'none': 'None', 'tpdf': 'TPDF',
        'shaped': 'Shaped', 'shaped-strong': 'Shaped (strong)',
      },
      hints:  {
        'none':          'Rounding only — the error follows the signal',
        'tpdf':          'Standard triangular dither',
        'shaped':        'Noise pushed above the ear\u2019s sensitive band',
        'shaped-strong': 'Pushed harder — least audible noise, most total noise',
      },
      automatable: false,
      binding: {
        moduleType: null,
        path: 'export.dither',
        status: 'unavailable',
        exportField: 'dither',
        // Like sampleRate and bitDepth: it changes the EXPORT render, not the
        // preview, because the preview never leaves float and so has no word
        // length to reduce.
        note: 'Export-renderable — applied on Re-master & Export, not preview.',
      },
    },
  ],
};

// ── Aggregate ────────────────────────────────────────────────────────────

export const ALL_MODULE_PARAMETER_DEFS: AllModulesDefinitions = {
  eq:       EQ_DEFS,
  dynamics: DYNAMICS_DEFS,
  imager:   IMAGER_DEFS,
  limiter:  LIMITER_DEFS,
  export:   EXPORT_DEFS,
};
