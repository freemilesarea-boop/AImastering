// Stage 3 — loudness maximizer.
//
// Drives the integrated LUFS toward a target by iterating:
//   1. Measure I-LUFS of the current buffer.
//   2. Compute Δ = target - measured.
//   3. Apply +Δ dB pre-gain, then re-run the soft-clip + peak-limiter
//      stages.
//   4. Stop when |Δ| < tolerance, or maxIters reached, or the limiter is
//      already so saturated that more pre-gain produces no further loudness
//      gain (diminishing-returns guard).
//
// Convergence note: when the chain is hard-limiting, +1 dB of pre-gain
// produces < 1 dB of LUFS rise (because the limiter eats some of it).  We
// damp the correction by 0.85 to avoid overshoot oscillation.  After 2–3
// iterations the residual is typically < 0.3 LU.

import { LoudnessAnalyzer } from './loudnessCore.js';
import { softClipBlock, compileSoftClip, SoftClipParams } from './softClip.js';
import { processPeakLimiter, PeakLimiterParams } from './peakLimiter.js';

export interface MaximizerParams {
  /** Target integrated LUFS (e.g. -14 for streaming, -9 for KPOP loud). */
  targetLufs:  number;
  /** Stop iterating when |target - measured| ≤ this.  Default 0.3 LU. */
  toleranceLu?: number;
  /** Hard cap on iterations.  Default 4. */
  maxIters?:    number;
  /** Soft-clip params (Stage 1).  Defaults yield gentle saturation. */
  softClip?:    SoftClipParams;
  /** Peak-limiter params (Stage 2).  Defaults to TP-safe. */
  peakLimiter?: PeakLimiterParams;
  /** Damping factor for the gain correction loop.  Default 0.85. */
  damping?:     number;
}

export interface MaximizerResult {
  out:           Float32Array[];     // processed channels
  measuredLufs:  number;             // post-chain integrated LUFS
  appliedGainDb: number;             // total pre-gain applied (cumulative)
  passes:        number;
  maxGrDb:       number;             // peak GR in the final pass
  converged:     boolean;            // true if |Δ| ≤ tolerance
}

// Run Stage 1 + Stage 2 once with the given pre-gain applied.
function runChain(
  src: Float32Array[],
  preGain: number,
  fs: number,
  scParams: SoftClipParams | undefined,
  plParams: PeakLimiterParams | undefined,
): { out: Float32Array[]; maxGrDb: number } {
  // Apply pre-gain into a fresh copy.
  const nCh = src.length;
  const N = (src[0] as Float32Array).length;
  const scaled: Float32Array[] = new Array(nCh);
  for (let c = 0; c < nCh; c++) {
    const dst = new Float32Array(N);
    const s = src[c] as Float32Array;
    for (let i = 0; i < N; i++) dst[i] = (s[i] as number) * preGain;
    scaled[c] = dst;
  }
  // Stage 1 — soft clip (analog-style, in place).
  const sc = compileSoftClip(scParams);
  for (let c = 0; c < nCh; c++) softClipBlock(scaled[c] as Float32Array, sc);
  // Stage 2 — look-ahead peak limiter.
  const lim = processPeakLimiter(scaled, fs, plParams);
  return { out: lim.out, maxGrDb: lim.maxGainReducDb };
}

// Measure integrated LUFS of a planar buffer.
function measureLufs(channels: Float32Array[], fs: number): number {
  const an = new LoudnessAnalyzer(fs, channels.length);
  an.processBlock(channels);
  return an.getIntegratedLufs();
}

export function processLoudnessMaximizer(
  src: Float32Array[],
  fs: number,
  p: MaximizerParams,
): MaximizerResult {
  const tolerance = p.toleranceLu ?? 0.3;
  const maxIters  = p.maxIters    ?? 4;
  const damping   = p.damping     ?? 0.85;

  // Bootstrap measurement of the unprocessed buffer.  This anchors the
  // first correction and avoids running an extra dummy iteration.
  const lufsIn = measureLufs(src, fs);
  let preGainDb = isFinite(lufsIn) ? (p.targetLufs - lufsIn) : 0;

  // Iteration loop.
  let result: { out: Float32Array[]; maxGrDb: number } = { out: src, maxGrDb: 0 };
  let measured = lufsIn;
  let passes = 0;
  let converged = false;

  for (let i = 0; i < maxIters; i++) {
    passes++;
    const preGain = Math.pow(10, preGainDb / 20);
    result = runChain(src, preGain, fs, p.softClip, p.peakLimiter);
    measured = measureLufs(result.out, fs);
    const delta = p.targetLufs - measured;
    if (Math.abs(delta) <= tolerance) { converged = true; break; }
    // If the limiter is already producing > 8 dB GR and we're still under
    // target, further pre-gain mostly burns into distortion — bail out.
    if (delta > 0 && result.maxGrDb > 8 && Math.abs(delta) < 1.0) {
      converged = false; break;
    }
    preGainDb += delta * damping;
  }

  return {
    out:           result.out,
    measuredLufs:  measured,
    appliedGainDb: preGainDb,
    passes,
    maxGrDb:       result.maxGrDb,
    converged,
  };
}
