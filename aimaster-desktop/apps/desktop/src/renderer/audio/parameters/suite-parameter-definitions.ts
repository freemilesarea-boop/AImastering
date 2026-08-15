// Parameter definitions for the Ozone-class module suite.
//
// The five original product-layout modules (EQ / Dynamics / Imager /
// Limiter / Export) live in `module-parameter-definitions.ts`.  This file
// covers everything the Rust `MasteringChain` gained on top of them:
// restoration, dynamic EQ, multiband dynamics, spectral processing,
// character and the vintage suite.
//
// Every definition here is BACKED BY DSP — each `binding.path` names a real
// field on `MasteringChainConfig`, and `chain-config.ts` turns the state
// into the JSON the chain accepts.  `status: 'wired'` therefore means what
// it says: turn the knob and the audio changes, in the preview and in the
// export, because both run the same chain.
//
// Ranges match the clamps the Rust modules apply.  Where the DSP clamps
// harder than the UI would allow, the UI range is the narrower of the two,
// so a slider at its end stop is a real end stop rather than a value the
// engine silently rejects.

import type {
  ModuleParameterDefinitions,
  EngineBindingTarget,
} from './parameter-state.js';

// ── Formatters ───────────────────────────────────────────────────────────

const fmt = {
  signedDb: (v: number): string => (v >= 0 ? `+${v.toFixed(1)}` : v.toFixed(1)),
  db:       (v: number): string => v.toFixed(1),
  integer:  (v: number): string => v.toFixed(0),
  oneDec:   (v: number): string => v.toFixed(1),
  ratio:    (v: number): string => `${v.toFixed(1)}:1`,
  hz:       (v: number): string => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k` : v.toFixed(0)),
  pct:      (v: number): string => v.toFixed(0),
  signedPct: (v: number): string => (v >= 0 ? `+${v.toFixed(0)}` : v.toFixed(0)),
};

/** Every binding in this file points at a real chain-config field. */
function wired(path: string): EngineBindingTarget {
  return { moduleType: null, path, status: 'wired' };
}

// ─────────────────────────────────────────────────────────────────────────
// Restoration
// ─────────────────────────────────────────────────────────────────────────

const DENOISE_DEFS: ModuleParameterDefinitions = {
  moduleId: 'denoise',
  bypassBinding: wired('denoise.bypass'),
  parameters: [
    {
      kind: 'number', id: 'reductionDb', label: 'Reduction',
      hint: 'How far the noise floor is pushed down',
      unit: 'dB', min: 0, max: 30, default: 0, step: 0.5,
      format: fmt.db, automatable: true, binding: wired('denoise.reductionDb'),
    },
    {
      kind: 'number', id: 'thresholdDb', label: 'Threshold',
      hint: 'Higher treats more of the signal as noise',
      unit: 'dB', min: -12, max: 12, default: 0, step: 0.5,
      format: fmt.signedDb, automatable: true, binding: wired('denoise.thresholdDb'),
    },
    {
      kind: 'number', id: 'sharpness', label: 'Sharpness',
      hint: '1.0 = Wiener; higher cuts harder',
      min: 0.5, max: 3, default: 1, step: 0.1,
      format: fmt.oneDec, automatable: true, binding: wired('denoise.sharpness'),
    },
    {
      kind: 'number', id: 'smoothing', label: 'Smoothing',
      hint: 'Suppresses musical-noise artefacts',
      min: 0, max: 0.95, default: 0.6, step: 0.05,
      format: (v) => v.toFixed(2), automatable: true, binding: wired('denoise.smoothing'),
    },
    {
      kind: 'boolean', id: 'autoProfile', label: 'Auto profile',
      hint: 'Track the floor continuously instead of using a learned one',
      default: true, offLabel: 'Learned', onLabel: 'Auto',
      automatable: false, binding: wired('denoise.autoProfile'),
    },
  ],
};

const DEHUM_DEFS: ModuleParameterDefinitions = {
  moduleId: 'dehum',
  bypassBinding: wired('dehum.bypass'),
  parameters: [
    {
      kind: 'enum', id: 'frequencyHz', label: 'Mains',
      hint: 'Fundamental of the hum',
      values: ['50', '60'], default: '60',
      labels: { '50': '50 Hz', '60': '60 Hz' },
      automatable: false, binding: wired('dehum.frequencyHz'),
    },
    {
      kind: 'number', id: 'depthDb', label: 'Depth',
      hint: 'Notch depth at each harmonic',
      unit: 'dB', min: 0, max: 48, default: 0, step: 1,
      format: fmt.db, automatable: true, binding: wired('dehum.depthDb'),
    },
    {
      kind: 'number', id: 'harmonics', label: 'Harmonics',
      hint: 'Partials notched, including the fundamental',
      min: 1, max: 12, default: 6, step: 1,
      format: fmt.integer, automatable: false, binding: wired('dehum.harmonics'),
    },
    {
      kind: 'number', id: 'q', label: 'Q',
      hint: 'Higher is narrower — takes less music with the hum',
      min: 5, max: 80, default: 30, step: 1,
      format: fmt.integer, automatable: true, binding: wired('dehum.q'),
    },
    {
      kind: 'boolean', id: 'adaptive', label: 'Adaptive',
      hint: 'Back off on harmonics that carry music',
      default: true, automatable: false, binding: wired('dehum.adaptive'),
    },
  ],
};

const DECLICK_DEFS: ModuleParameterDefinitions = {
  moduleId: 'declick',
  bypassBinding: wired('declick.bypass'),
  // Repair is opt-in: most material has no clicks, and a detector
  // running on clean audio is pure cost.
  defaultBypass: true,
  parameters: [
    {
      kind: 'number', id: 'sensitivity', label: 'Sensitivity',
      hint: 'How far above the local level counts as a click',
      min: 2, max: 20, default: 6, step: 0.5,
      format: (v) => `${v.toFixed(1)}×`, automatable: true, binding: wired('declick.sensitivity'),
    },
    {
      kind: 'number', id: 'maxRunSamples', label: 'Max length',
      hint: 'Longest defect repaired, in samples',
      min: 1, max: 24, default: 16, step: 1,
      format: fmt.integer, automatable: false, binding: wired('declick.maxRunSamples'),
    },
  ],
};

const DEESS_DEFS: ModuleParameterDefinitions = {
  moduleId: 'deess',
  bypassBinding: wired('deess.bypass'),
  parameters: [
    {
      kind: 'number', id: 'frequencyHz', label: 'Frequency',
      hint: 'Split between the untouched body and the ducked band',
      unit: 'Hz', min: 2000, max: 16000, default: 6500, step: 100,
      format: fmt.hz, automatable: true, binding: wired('deess.frequencyHz'),
    },
    {
      kind: 'number', id: 'rangeDb', label: 'Range',
      hint: 'Maximum attenuation',
      unit: 'dB', min: 0, max: 24, default: 0, step: 0.5,
      format: fmt.db, automatable: true, binding: wired('deess.rangeDb'),
    },
    {
      kind: 'number', id: 'thresholdDb', label: 'Threshold',
      unit: 'dB', min: -60, max: 0, default: -30, step: 0.5,
      format: fmt.db, automatable: true, binding: wired('deess.thresholdDb'),
    },
    {
      kind: 'number', id: 'ratio', label: 'Ratio',
      min: 1, max: 20, default: 4, step: 0.5,
      format: fmt.ratio, automatable: true, binding: wired('deess.ratio'),
    },
    {
      kind: 'number', id: 'attackMs', label: 'Attack',
      unit: 'ms', min: 0.1, max: 20, default: 1, step: 0.1,
      format: fmt.oneDec, automatable: true, binding: wired('deess.attackMs'),
    },
    {
      kind: 'number', id: 'releaseMs', label: 'Release',
      unit: 'ms', min: 10, max: 400, default: 60, step: 5,
      format: fmt.integer, automatable: true, binding: wired('deess.releaseMs'),
    },
    {
      kind: 'boolean', id: 'wideband', label: 'Mode',
      hint: 'Split band keeps the body still; wideband ducks everything',
      default: false, offLabel: 'Split band', onLabel: 'Wideband',
      automatable: false, binding: wired('deess.wideband'),
    },
  ],
};

// ─────────────────────────────────────────────────────────────────────────
// Tone
// ─────────────────────────────────────────────────────────────────────────

/** One dynamic-EQ band's parameters, prefixed `bandN`. */
function dynEqBand(index: number): ModuleParameterDefinitions['parameters'] {
  const p = `band${index}`;
  const path = (field: string) => wired(`dynamicEq.bands[${index}].${field}`);
  return [
    {
      kind: 'boolean', id: `${p}Enabled`, label: `Band ${index + 1}`,
      default: false, automatable: false, binding: path('enabled'),
    },
    {
      kind: 'enum', id: `${p}Shape`, label: 'Shape',
      values: ['bell', 'lowShelf', 'highShelf'], default: 'bell',
      labels: { bell: 'Bell', lowShelf: 'Low shelf', highShelf: 'High shelf' },
      automatable: false, binding: path('shape'),
    },
    {
      kind: 'enum', id: `${p}Mode`, label: 'Direction',
      hint: 'Down cuts loud passages; Up lifts quiet ones',
      values: ['down', 'up'], default: 'down',
      labels: { down: 'Down', up: 'Up' },
      automatable: false, binding: path('mode'),
    },
    {
      kind: 'number', id: `${p}FrequencyHz`, label: 'Frequency',
      unit: 'Hz', min: 20, max: 20000, default: 1000, step: 1,
      format: fmt.hz, automatable: true, binding: path('frequencyHz'),
    },
    {
      kind: 'number', id: `${p}Q`, label: 'Q',
      min: 0.2, max: 12, default: 1, step: 0.1,
      format: fmt.oneDec, automatable: true, binding: path('q'),
    },
    {
      kind: 'number', id: `${p}ThresholdDb`, label: 'Threshold',
      unit: 'dB', min: -60, max: 0, default: -24, step: 0.5,
      format: fmt.db, automatable: true, binding: path('thresholdDb'),
    },
    {
      kind: 'number', id: `${p}Ratio`, label: 'Ratio',
      min: 1, max: 20, default: 3, step: 0.5,
      format: fmt.ratio, automatable: true, binding: path('ratio'),
    },
    {
      kind: 'number', id: `${p}RangeDb`, label: 'Range',
      hint: 'Ceiling on how far this band may move',
      unit: 'dB', min: 0, max: 24, default: 6, step: 0.5,
      format: fmt.db, automatable: true, binding: path('rangeDb'),
    },
    {
      kind: 'number', id: `${p}AttackMs`, label: 'Attack',
      unit: 'ms', min: 0.5, max: 100, default: 10, step: 0.5,
      format: fmt.oneDec, automatable: true, binding: path('attackMs'),
    },
    {
      kind: 'number', id: `${p}ReleaseMs`, label: 'Release',
      unit: 'ms', min: 10, max: 1000, default: 120, step: 5,
      format: fmt.integer, automatable: true, binding: path('releaseMs'),
    },
  ];
}

/** Bands the dynamic EQ exposes.  Matches `DYN_EQ_BANDS` in Rust. */
export const DYN_EQ_BAND_COUNT = 6;

const DYNAMIC_EQ_DEFS: ModuleParameterDefinitions = {
  moduleId: 'dynamic-eq',
  bypassBinding: wired('dynamicEq.bypass'),
  parameters: Array.from({ length: DYN_EQ_BAND_COUNT }, (_, i) => dynEqBand(i)).flat(),
};

const VINTAGE_EQ_DEFS: ModuleParameterDefinitions = {
  moduleId: 'vintage-eq',
  bypassBinding: wired('vintageEq.bypass'),
  parameters: [
    {
      kind: 'number', id: 'lowFrequencyHz', label: 'Low freq',
      hint: 'Both the boost and the attenuation reference this',
      unit: 'Hz', min: 20, max: 200, default: 60, step: 1,
      format: fmt.hz, automatable: true, binding: wired('vintageEq.lowFrequencyHz'),
    },
    {
      kind: 'number', id: 'lowBoostDb', label: 'Low boost',
      unit: 'dB', min: 0, max: 12, default: 0, step: 0.5,
      format: fmt.db, automatable: true, binding: wired('vintageEq.lowBoostDb'),
    },
    {
      kind: 'number', id: 'lowCutDb', label: 'Low atten',
      hint: 'Run with the boost — they do not cancel',
      unit: 'dB', min: 0, max: 12, default: 0, step: 0.5,
      format: fmt.db, automatable: true, binding: wired('vintageEq.lowCutDb'),
    },
    {
      kind: 'number', id: 'highFrequencyHz', label: 'High freq',
      unit: 'Hz', min: 2000, max: 20000, default: 10000, step: 100,
      format: fmt.hz, automatable: true, binding: wired('vintageEq.highFrequencyHz'),
    },
    {
      kind: 'number', id: 'highBoostDb', label: 'High boost',
      unit: 'dB', min: 0, max: 12, default: 0, step: 0.5,
      format: fmt.db, automatable: true, binding: wired('vintageEq.highBoostDb'),
    },
    {
      kind: 'number', id: 'highBandwidth', label: 'Bandwidth',
      hint: 'Width of the high boost',
      min: 0, max: 1, default: 0.5, step: 0.05,
      format: (v) => v.toFixed(2), automatable: true, binding: wired('vintageEq.highBandwidth'),
    },
    {
      kind: 'number', id: 'highCutDb', label: 'High atten',
      unit: 'dB', min: 0, max: 12, default: 0, step: 0.5,
      format: fmt.db, automatable: true, binding: wired('vintageEq.highCutDb'),
    },
  ],
};

// ─────────────────────────────────────────────────────────────────────────
// Spectral (Match EQ / Shaper / Stabilizer share one STFT stage)
// ─────────────────────────────────────────────────────────────────────────

const MATCH_EQ_DEFS: ModuleParameterDefinitions = {
  moduleId: 'match-eq',
  bypassBinding: wired('spectral.matchEnabled'),
  // The spectral trio each cost an STFT frame of latency, so they stay
  // off until asked for even though their amounts have useful defaults.
  defaultBypass: true,
  parameters: [
    {
      kind: 'number', id: 'amountPct', label: 'Amount',
      hint: 'How much of the source→reference difference to apply',
      unit: '%', min: 0, max: 100, default: 50, step: 1,
      format: fmt.pct, automatable: true, binding: wired('spectral.matchAmountPct'),
    },
    {
      kind: 'number', id: 'maxMoveDb', label: 'Max move',
      hint: 'Per-band ceiling on the correction',
      unit: 'dB', min: 1, max: 18, default: 9, step: 0.5,
      format: fmt.db, automatable: true, binding: wired('spectral.matchMaxMoveDb'),
    },
    {
      kind: 'number', id: 'smoothingBands', label: 'Smoothing',
      hint: 'Wider makes the correction a curve, not a comb',
      min: 0, max: 6, default: 2, step: 1,
      format: fmt.integer, automatable: false, binding: wired('spectral.curveSmoothingBands'),
    },
  ],
};

const SPECTRAL_SHAPER_DEFS: ModuleParameterDefinitions = {
  moduleId: 'spectral-shaper',
  bypassBinding: wired('spectral.shaperEnabled'),
  defaultBypass: true,
  parameters: [
    {
      kind: 'number', id: 'amountPct', label: 'Amount',
      hint: 'How much of the excess is removed',
      unit: '%', min: 0, max: 100, default: 50, step: 1,
      format: fmt.pct, automatable: true, binding: wired('spectral.shaperAmountPct'),
    },
    {
      kind: 'number', id: 'thresholdDb', label: 'Threshold',
      hint: 'How far above its neighbours a peak must sit',
      unit: 'dB', min: 1, max: 24, default: 8, step: 0.5,
      format: fmt.db, automatable: true, binding: wired('spectral.shaperThresholdDb'),
    },
    {
      kind: 'number', id: 'lowHz', label: 'Low edge',
      unit: 'Hz', min: 100, max: 8000, default: 1000, step: 50,
      format: fmt.hz, automatable: true, binding: wired('spectral.shaperLowHz'),
    },
    {
      kind: 'number', id: 'highHz', label: 'High edge',
      unit: 'Hz', min: 2000, max: 20000, default: 16000, step: 100,
      format: fmt.hz, automatable: true, binding: wired('spectral.shaperHighHz'),
    },
    {
      kind: 'number', id: 'blurBins', label: 'Neighbourhood',
      hint: 'Bins the excess is measured against',
      min: 1, max: 48, default: 12, step: 1,
      format: fmt.integer, automatable: false, binding: wired('spectral.shaperBlurBins'),
    },
  ],
};

const STABILIZER_DEFS: ModuleParameterDefinitions = {
  moduleId: 'stabilizer',
  bypassBinding: wired('spectral.stabilizerEnabled'),
  defaultBypass: true,
  parameters: [
    {
      kind: 'number', id: 'amountPct', label: 'Amount',
      hint: 'How firmly the long-term curve is pulled to the target',
      unit: '%', min: 0, max: 100, default: 40, step: 1,
      format: fmt.pct, automatable: true, binding: wired('spectral.stabilizerAmountPct'),
    },
    {
      kind: 'number', id: 'tiltDbPerOct', label: 'Target tilt',
      hint: 'Negative is darker — most music sits near -1.5',
      unit: 'dB/oct', min: -4, max: 2, default: -1.5, step: 0.1,
      format: fmt.signedDb, automatable: true, binding: wired('spectral.stabilizerTiltDbPerOct'),
    },
    {
      kind: 'number', id: 'maxMoveDb', label: 'Max move',
      unit: 'dB', min: 1, max: 12, default: 6, step: 0.5,
      format: fmt.db, automatable: true, binding: wired('spectral.stabilizerMaxMoveDb'),
    },
  ],
};

// ─────────────────────────────────────────────────────────────────────────
// Dynamics
// ─────────────────────────────────────────────────────────────────────────

const BAND_NAMES = ['Low', 'Low mid', 'High mid', 'High'] as const;

/** One multiband band's parameters, prefixed `bandN`. */
function multibandBand(index: number): ModuleParameterDefinitions['parameters'] {
  const p = `band${index}`;
  const path = (field: string) => wired(`multiband.bands[${index}].${field}`);
  const name = BAND_NAMES[index];
  return [
    {
      kind: 'enum', id: `${p}Mode`, label: `${name} mode`,
      hint: 'Compress controls the loud; expand pushes down the quiet',
      values: ['compress', 'expand'], default: 'compress',
      labels: { compress: 'Compress', expand: 'Expand' },
      automatable: false, binding: path('mode'),
    },
    {
      kind: 'number', id: `${p}ThresholdDb`, label: `${name} threshold`,
      unit: 'dB', min: -60, max: 0, default: 0, step: 0.5,
      format: fmt.db, automatable: true, binding: path('thresholdDb'),
    },
    {
      kind: 'number', id: `${p}Ratio`, label: `${name} ratio`,
      min: 1, max: 20, default: 1, step: 0.1,
      format: fmt.ratio, automatable: true, binding: path('ratio'),
    },
    {
      kind: 'number', id: `${p}AttackMs`, label: `${name} attack`,
      unit: 'ms', min: 0.5, max: 200, default: 10, step: 0.5,
      format: fmt.oneDec, automatable: true, binding: path('attackMs'),
    },
    {
      kind: 'number', id: `${p}ReleaseMs`, label: `${name} release`,
      unit: 'ms', min: 10, max: 1000, default: 120, step: 5,
      format: fmt.integer, automatable: true, binding: path('releaseMs'),
    },
    {
      kind: 'number', id: `${p}MakeupDb`, label: `${name} makeup`,
      unit: 'dB', min: -12, max: 12, default: 0, step: 0.5,
      format: fmt.signedDb, automatable: true, binding: path('makeupDb'),
    },
    {
      kind: 'number', id: `${p}MixPct`, label: `${name} mix`,
      hint: 'Below 100 is parallel compression',
      unit: '%', min: 0, max: 100, default: 100, step: 1,
      format: fmt.pct, automatable: true, binding: path('mixPct'),
    },
    {
      kind: 'boolean', id: `${p}Solo`, label: `${name} solo`,
      default: false, automatable: false, binding: path('solo'),
    },
    {
      kind: 'boolean', id: `${p}Mute`, label: `${name} mute`,
      default: false, automatable: false, binding: path('mute'),
    },
  ];
}

/** Bands every multiband module runs.  Matches `BANDS` in Rust. */
export const MULTIBAND_BAND_COUNT = 4;

/** Crossover parameters shared by the multiband modules. */
function crossoverParams(module: string): ModuleParameterDefinitions['parameters'] {
  return [
    {
      kind: 'number', id: 'crossover1Hz', label: 'Low / low-mid',
      unit: 'Hz', min: 30, max: 500, default: 120, step: 1,
      format: fmt.hz, automatable: false, binding: wired(`${module}.crossoverHz[0]`),
    },
    {
      kind: 'number', id: 'crossover2Hz', label: 'Low-mid / high-mid',
      unit: 'Hz', min: 200, max: 3000, default: 800, step: 10,
      format: fmt.hz, automatable: false, binding: wired(`${module}.crossoverHz[1]`),
    },
    {
      kind: 'number', id: 'crossover3Hz', label: 'High-mid / high',
      unit: 'Hz', min: 2000, max: 16000, default: 5000, step: 50,
      format: fmt.hz, automatable: false, binding: wired(`${module}.crossoverHz[2]`),
    },
  ];
}

const MULTIBAND_DEFS: ModuleParameterDefinitions = {
  moduleId: 'multiband',
  bypassBinding: wired('multiband.bypass'),
  parameters: [
    ...crossoverParams('multiband'),
    ...Array.from({ length: MULTIBAND_BAND_COUNT }, (_, i) => multibandBand(i)).flat(),
  ],
};

const VINTAGE_COMP_DEFS: ModuleParameterDefinitions = {
  moduleId: 'vintage-comp',
  bypassBinding: wired('vintageComp.bypass'),
  parameters: [
    {
      kind: 'number', id: 'thresholdDb', label: 'Threshold',
      unit: 'dB', min: -60, max: 0, default: -18, step: 0.5,
      format: fmt.db, automatable: true, binding: wired('vintageComp.thresholdDb'),
    },
    {
      kind: 'number', id: 'ratio', label: 'Ratio',
      hint: '1:1 switches the module off',
      min: 1, max: 20, default: 1, step: 0.1,
      format: fmt.ratio, automatable: true, binding: wired('vintageComp.ratio'),
    },
    {
      kind: 'number', id: 'attackMs', label: 'Attack',
      unit: 'ms', min: 0.5, max: 100, default: 10, step: 0.5,
      format: fmt.oneDec, automatable: true, binding: wired('vintageComp.attackMs'),
    },
    {
      kind: 'number', id: 'characterPct', label: 'Character',
      hint: 'Saturation that rides with the gain reduction',
      unit: '%', min: 0, max: 100, default: 40, step: 1,
      format: fmt.pct, automatable: true, binding: wired('vintageComp.characterPct'),
    },
    {
      kind: 'number', id: 'makeupDb', label: 'Makeup',
      unit: 'dB', min: -12, max: 24, default: 0, step: 0.5,
      format: fmt.signedDb, automatable: true, binding: wired('vintageComp.makeupDb'),
    },
    {
      kind: 'number', id: 'mixPct', label: 'Mix',
      unit: '%', min: 0, max: 100, default: 100, step: 1,
      format: fmt.pct, automatable: true, binding: wired('vintageComp.mixPct'),
    },
  ],
};

const IMPACT_DEFS: ModuleParameterDefinitions = {
  moduleId: 'impact',
  bypassBinding: wired('impact.bypass'),
  parameters: [
    ...crossoverParams('impact'),
    ...BAND_NAMES.map((name, i) => ({
      kind: 'number' as const, id: `band${i}Pct`, label: name,
      // Only the first band carries the explainer — repeating it on all
      // four turns a hint into noise.
      ...(i === 0 ? { hint: 'Right accentuates attacks, left softens them' } : {}),
      unit: '%', min: -100, max: 100, default: 0, step: 1,
      format: fmt.signedPct, automatable: true,
      binding: wired(`impact.impactPct[${i}]`),
    })),
  ],
};

const LOW_END_FOCUS_DEFS: ModuleParameterDefinitions = {
  moduleId: 'low-end-focus',
  bypassBinding: wired('lowEndFocus.bypass'),
  parameters: [
    {
      kind: 'enum', id: 'mode', label: 'Mode',
      hint: 'Punchy separates attacks; Smooth evens the bottom out',
      values: ['punchy', 'smooth'], default: 'punchy',
      labels: { punchy: 'Punchy', smooth: 'Smooth' },
      automatable: false, binding: wired('lowEndFocus.mode'),
    },
    {
      kind: 'number', id: 'frequencyHz', label: 'Frequency',
      hint: 'Top of the shaped low band',
      unit: 'Hz', min: 40, max: 500, default: 150, step: 5,
      format: fmt.hz, automatable: true, binding: wired('lowEndFocus.frequencyHz'),
    },
    {
      kind: 'number', id: 'contrastPct', label: 'Contrast',
      unit: '%', min: 0, max: 100, default: 0, step: 1,
      format: fmt.pct, automatable: true, binding: wired('lowEndFocus.contrastPct'),
    },
    {
      kind: 'number', id: 'gainDb', label: 'Gain',
      hint: 'Trim on the low band only',
      unit: 'dB', min: -12, max: 12, default: 0, step: 0.5,
      format: fmt.signedDb, automatable: true, binding: wired('lowEndFocus.gainDb'),
    },
  ],
};

// ─────────────────────────────────────────────────────────────────────────
// Character
// ─────────────────────────────────────────────────────────────────────────

const EXCITER_DEFS: ModuleParameterDefinitions = {
  moduleId: 'exciter',
  bypassBinding: wired('exciter.bypass'),
  parameters: [
    {
      kind: 'enum', id: 'mode', label: 'Character',
      values: ['warm', 'retro', 'tape', 'tube', 'triode'], default: 'tube',
      labels: { warm: 'Warm', retro: 'Retro', tape: 'Tape', tube: 'Tube', triode: 'Triode' },
      hints: {
        warm: 'Gentle odd harmonics — thickens without brightening',
        retro: '2nd-dominant, fattens the low end',
        tape: 'Compressive odd harmonics, rounds transients',
        tube: 'Strong 2nd — presence and sheen',
        triode: 'Aggressive 2nd + 3rd, for the air band',
      },
      automatable: false, binding: wired('exciter.mode'),
    },
    ...crossoverParams('exciter'),
    ...BAND_NAMES.map((name, i) => ({
      kind: 'number' as const, id: `band${i}Pct`, label: name,
      unit: '%', min: 0, max: 100, default: 0, step: 1,
      format: fmt.pct, automatable: true,
      binding: wired(`exciter.bandAmountPct[${i}]`),
    })),
    {
      kind: 'number', id: 'driveDb', label: 'Drive',
      hint: 'Level-matched — changes colour, not volume',
      unit: 'dB', min: 0, max: 24, default: 6, step: 0.5,
      format: fmt.db, automatable: true, binding: wired('exciter.driveDb'),
    },
    {
      kind: 'number', id: 'outputDb', label: 'Output',
      unit: 'dB', min: -12, max: 12, default: 0, step: 0.5,
      format: fmt.signedDb, automatable: true, binding: wired('exciter.outputDb'),
    },
  ],
};

const TAPE_DEFS: ModuleParameterDefinitions = {
  moduleId: 'tape',
  bypassBinding: wired('tape.bypass'),
  parameters: [
    {
      kind: 'enum', id: 'speed', label: 'Speed',
      hint: 'Slower tape means a lower head bump and less top',
      values: ['7.5ips', '15ips', '30ips'], default: '15ips',
      labels: { '7.5ips': '7.5 ips', '15ips': '15 ips', '30ips': '30 ips' },
      automatable: false, binding: wired('tape.speed'),
    },
    {
      kind: 'number', id: 'mixPct', label: 'Mix',
      hint: '0 bypasses the transport entirely',
      unit: '%', min: 0, max: 100, default: 0, step: 1,
      format: fmt.pct, automatable: true, binding: wired('tape.mixPct'),
    },
    {
      kind: 'number', id: 'driveDb', label: 'Drive',
      hint: 'Record level — level-matched on output',
      unit: 'dB', min: 0, max: 24, default: 0, step: 0.5,
      format: fmt.db, automatable: true, binding: wired('tape.driveDb'),
    },
    {
      kind: 'number', id: 'bias', label: 'Bias',
      hint: 'Shifts the head bump',
      min: -1, max: 1, default: 0, step: 0.05,
      format: (v) => (v >= 0 ? `+${v.toFixed(2)}` : v.toFixed(2)),
      automatable: true, binding: wired('tape.bias'),
    },
    {
      kind: 'number', id: 'wowFlutterPct', label: 'Wow / flutter',
      unit: '%', min: 0, max: 100, default: 0, step: 1,
      format: fmt.pct, automatable: true, binding: wired('tape.wowFlutterPct'),
    },
  ],
};

// ─────────────────────────────────────────────────────────────────────────
// Aggregate
// ─────────────────────────────────────────────────────────────────────────

/** Definitions for every module the suite added on top of the original five. */
export const SUITE_PARAMETER_DEFS = {
  denoise: DENOISE_DEFS,
  dehum: DEHUM_DEFS,
  declick: DECLICK_DEFS,
  deess: DEESS_DEFS,
  'dynamic-eq': DYNAMIC_EQ_DEFS,
  'vintage-eq': VINTAGE_EQ_DEFS,
  'match-eq': MATCH_EQ_DEFS,
  'spectral-shaper': SPECTRAL_SHAPER_DEFS,
  stabilizer: STABILIZER_DEFS,
  multiband: MULTIBAND_DEFS,
  'vintage-comp': VINTAGE_COMP_DEFS,
  impact: IMPACT_DEFS,
  'low-end-focus': LOW_END_FOCUS_DEFS,
  exciter: EXCITER_DEFS,
  tape: TAPE_DEFS,
} as const;
