// M1 schema-aware runner for the TS realtime mastering chain.
//
// Consumers:
//   - Renderer code that wants to drive the preview chain from an
//     EnginePreset JSON instead of a hard-coded MasteringMode string.
//   - apps/desktop/scripts/dsp-equivalence-compare.ts (the cross-language
//     golden harness — Python and TS run the same preset, then numeric
//     deltas are computed).

export { runPreset, type RunPresetResult } from './runPreset.js';
export {
  presetToModeConfig,
  buildAdapterReport,
  type PresetToModeResult,
} from './from-preset.js';
