// What the offline chain renderer measured, as the app's loudness type.
//
// `audio:master-rust-experimental` answers with the RENDERER's metrics —
// `RenderMetrics` / `NormalizedRenderMetrics` from
// `main/offline/rust-offline-render-core.ts`:
//
//   { samplePeak, samplePeakDb, limiterGrDb, samples, durationSec, renderMs,
//     measuredProcessedLufs, finalLufs, targetLufs, appliedLoudnessGainDb,
//     finalTruePeakDb }
//
// `render-song.ts` used to put that object into `MasteringResult.loudnessAfter`
// behind a cast:
//
//   loudnessAfter: (res.metrics as MasteringResult['loudnessAfter']) ?? …
//
// None of those eleven keys is `integratedLufs`.  The cast silenced the
// compiler, the `??` never fired because the object is truthy, and the queue
// row then ran
//
//   item.masteringResult.loudnessAfter.integratedLufs.toFixed(1)
//
// on `undefined` — "Cannot read properties of undefined (reading 'toFixed')",
// which React turned into the error boundary and the whole app with it.  It
// happened on the STUDIO path only (a song with saved Studio work), which is
// why it did not happen to everybody.
//
// The two numbers are there under different names, and they are measurements
// of the finished file rather than estimates: `finalLufs` is the integrated
// loudness of pass 2's output and `finalTruePeakDb` its true peak.  So this
// renames them and refuses to invent the rest — the offline renderer does not
// measure a loudness range, and `null` says so.

import type { LoudnessStats } from '@aimaster/shared-types';

/** A finite number, or null — never NaN, never Infinity, never a guess. */
function measured(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Map the offline renderer's metrics onto `LoudnessStats`.
 *
 * Returns null when the payload carries no measured loudness at all, which
 * is the un-normalised render (no target LUFS, so no second pass).  A caller
 * must then say "not measured" rather than show a number.
 */
export function loudnessAfterFromRenderMetrics(metrics: unknown): LoudnessStats | null {
  if (metrics === null || typeof metrics !== 'object') return null;
  const m = metrics as Record<string, unknown>;

  // Pass 2 measured the finished file.  `integratedLufs` / `truePeakDbtp`
  // are accepted too, so a future payload that already speaks this type
  // passes through unchanged.
  const lufs = measured(m['finalLufs']) ?? measured(m['integratedLufs']);
  const tp   = measured(m['finalTruePeakDb']) ?? measured(m['truePeakDbtp']);
  if (lufs === null || tp === null) return null;

  return {
    integratedLufs: lufs,
    truePeakDbtp:   tp,
    // The offline chain renderer does not measure a loudness range.
    lra: measured(m['lra']),
  };
}
