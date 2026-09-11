// Public M1 entry point — run a validated EnginePreset against an audio
// buffer using the existing TS realtime mastering chain.
//
// Boundary contract:
//   - Input:   AudioBufferLike + validated EnginePreset
//   - Output:  AudioBufferLike + AdapterRunReport
//   - Errors:  validation failures throw (caller must validate first)
//
// This wrapper is callable from the renderer (no browser-only APIs) and
// from Node (e.g. apps/desktop/scripts/dsp-equivalence-compare.ts).

import type {
  EnginePreset,
  AdapterRunReport,
} from '@aimaster/shared-types/engine';

import { processMasteringWithConfig, type ModePipelineResult } from '../masteringModes.js';
import type { AudioBufferLike } from '../loudnessCore.js';
import { buildAdapterReport, presetToModeConfig } from './from-preset.js';

export interface RunPresetResult {
  buffer: AudioBufferLike;
  report: AdapterRunReport;
  /**
   * The internal ModePipelineResult (gain staging applied, transients,
   * vocal, limiter — same shape the existing UI consumes).  Surfaced
   * for the cross-language harness and debugging.
   */
  internal: ModePipelineResult;
  /** Wall-clock duration of the run in ms. */
  durationMs: number;
}

/**
 * Run an EnginePreset against `input` and return the mastered buffer.
 *
 * Modules the TS chain does not yet implement are skipped and recorded
 * in `report.entries` with status='noop' — this is the M1 honest
 * behaviour; the caller can inspect the report to see what the Python
 * adapter applied that we did not.
 *
 * What IS applied is the preset's own numbers, not its bucket's: the loudness
 * target, the true-peak ceiling and the limiter strength come from the JSON.
 * The stages the TS chain has — gain staging, transient protection, the vocal
 * enhancer — still run on the bucket's parameters, because the schema has no
 * field for them; those are marked applied because they are, and the values
 * they run are the bucket's.  That gap is real and belongs to M2.
 */
export function runPreset(input: AudioBufferLike, preset: EnginePreset): RunPresetResult {
  const t0 = (typeof performance !== 'undefined' ? performance : Date).now();

  const { mode, entries } = presetToModeConfig(preset);
  // The CONFIG, not the bucket name.  `presetToModeConfig` has already read
  // the preset's loudness target, true-peak ceiling and limiter strength into
  // `mode`; passing `mode.mode` instead would look the bucket up again and
  // discard all three.  It used to, and the result was seven built-in presets
  // rendering as three waveforms — see `processMasteringWithConfig`.
  const internal = processMasteringWithConfig(input, mode);

  const durationMs = (typeof performance !== 'undefined' ? performance : Date).now() - t0;
  const report = buildAdapterReport(
    preset,
    entries,
    input.sampleRate,
    durationMs,
  );

  return {
    buffer: internal.buffer,
    report,
    internal,
    durationMs,
  };
}
