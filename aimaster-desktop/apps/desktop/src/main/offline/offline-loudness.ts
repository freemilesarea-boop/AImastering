// Offline loudness measurement + target-gain solver (RUST-OFFLINE-RENDER-2).
//
// Reuses the SAME `LouiAnalyzer` (node WASM) the realtime meters use —
// EBU R128 / BS.1770-4 gated integrated LUFS + true peak — so the offline
// measurement matches what the user sees in the analyzer.  No re-implemented
// loudness math.

import { createOfflineAnalyzer } from './load-mastering-chain-node.js';

export interface LoudnessMeasurement {
  integratedLufs: number;   // -Infinity for silence
  truePeakDbtp: number;     // -Infinity for silence
  samplePeakDb: number;
}

/** Measure a deinterleaved stereo buffer's integrated loudness + true peak. */
export function measureStereoLoudness(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  blockSize = 4096,
): LoudnessMeasurement {
  const n = Math.min(left.length, right.length);
  const an = createOfflineAnalyzer(sampleRate, 2);
  try {
    an.reset();
    for (let pos = 0; pos < n; pos += blockSize) {
      const end = Math.min(pos + blockSize, n);
      an.processStereo(left.subarray(pos, end).slice(), right.subarray(pos, end).slice());
    }
    const s = an.snapshot();
    return {
      integratedLufs: Number.isFinite(s.integratedLufs) ? s.integratedLufs : -Infinity,
      truePeakDbtp: Number.isFinite(s.truePeakDbtp) ? s.truePeakDbtp : -Infinity,
      samplePeakDb: Number.isFinite(s.samplePeakDb) ? s.samplePeakDb : -Infinity,
    };
  } finally {
    try { an.free?.(); } catch { /* ignore */ }
  }
}

export interface LoudnessGainPolicy {
  /** Max upward gain (dB).  Default +12. */
  maxBoostDb?: number;
  /** Max downward gain (dB, negative).  Default -24. */
  maxCutDb?: number;
  /** Below this integrated LUFS, treat as silence → no gain. */
  silenceFloorLufs?: number;
}

export interface LoudnessGainSolution {
  appliedGainDb: number;
  /** Reason the gain was limited / zeroed (diagnostics). */
  note: 'ok' | 'silence' | 'clamped-boost' | 'clamped-cut';
}

/**
 * Solve the input-gain adjustment to push the chain output toward
 * `targetLufs`.  The gain is applied as the chain's INPUT gain on a second
 * pass (push-into-limiter), so the limiter still guarantees the ceiling —
 * the solver only bounds the boost/cut and skips silence.
 */
export function solveLoudnessGain(
  measuredLufs: number,
  targetLufs: number,
  policy: LoudnessGainPolicy = {},
): LoudnessGainSolution {
  const maxBoost = policy.maxBoostDb ?? 12;
  const maxCut = policy.maxCutDb ?? -24;
  const floor = policy.silenceFloorLufs ?? -60;

  if (!Number.isFinite(measuredLufs) || measuredLufs <= floor) {
    return { appliedGainDb: 0, note: 'silence' };
  }
  const want = targetLufs - measuredLufs;
  if (want > maxBoost) return { appliedGainDb: maxBoost, note: 'clamped-boost' };
  if (want < maxCut) return { appliedGainDb: maxCut, note: 'clamped-cut' };
  return { appliedGainDb: want, note: 'ok' };
}
