// precise-rebalance — apply Demucs/ONNX stem separation + per-stem gain to a
// stereo buffer before the mastering chain.  Kept separate from
// process-audio-file-rust so it is testable without the ffmpeg / wasm imports.

import { resampleLinear } from './stem-inference.js';
import { getStemSeparator, STEM_ORDER, type StemId, type StemSeparator } from './stem-separation.js';

export interface PreciseRebalanceOptions {
  enabled: boolean;
  gainsDb: Record<StemId, number>;
  /** Electron userData dir — where the model is cached. */
  userDataDir: string;
}

const db2lin = (db: number): number => Math.pow(10, db / 20);

/**
 * Separate into 4 stems, resample each back to `sampleRate`, and re-sum with
 * per-stem gain.  Returns the input unchanged (`applied: false`) when disabled
 * or when no model is installed — the caller then proceeds with the original
 * mix (graceful fallback to the approximation tier).
 *
 * `resolveSeparator` is injectable for tests; defaults to the real ONNX one.
 */
export async function applyPreciseRebalance(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  opts: PreciseRebalanceOptions,
  onProgress?: (frac: number) => void,
  resolveSeparator: (userDataDir: string) => Promise<StemSeparator | null> = getStemSeparator,
): Promise<{ left: Float32Array; right: Float32Array; applied: boolean }> {
  if (!opts.enabled) return { left, right, applied: false };
  const separator = await resolveSeparator(opts.userDataDir);
  if (!separator) return { left, right, applied: false };

  const stems = await separator.separate({ left, right, sampleRate }, onProgress);
  const n = left.length;
  const outL = new Float32Array(n);
  const outR = new Float32Array(n);
  for (const id of STEM_ORDER) {
    const g = db2lin(opts.gainsDb[id] ?? 0);
    const sl = resampleLinear(stems[id].left, stems[id].sampleRate, sampleRate);
    const sr = resampleLinear(stems[id].right, stems[id].sampleRate, sampleRate);
    const m = Math.min(n, sl.length, sr.length);
    for (let i = 0; i < m; i++) { outL[i]! += sl[i]! * g; outR[i]! += sr[i]! * g; }
  }
  return { left: outL, right: outR, applied: true };
}
