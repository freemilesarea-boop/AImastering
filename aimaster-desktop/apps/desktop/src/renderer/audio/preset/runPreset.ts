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

import { processMasteringWithMode, type ModePipelineResult } from '../masteringModes.js';
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
 */
export function runPreset(input: AudioBufferLike, preset: EnginePreset): RunPresetResult {
  const t0 = (typeof performance !== 'undefined' ? performance : Date).now();

  const { mode, entries } = presetToModeConfig(preset);
  const internal = processMasteringWithMode(input, mode.mode);

  // Note: the M1 TS chain ignores `mode` parameter customisation here —
  // processMasteringWithMode looks up MODE_CONFIGS[mode.mode] directly.
  // The `mode` we built carries the bucketed config; bucket is what the
  // existing pipeline runs.  This is one of the gaps M2's Rust adapter
  // must close (run the JSON values, not the bucket).

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
