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

// Compute total RMS in dBFS across all channels.  Used as a fallback
// loudness estimate when integrated LUFS is unmeasurable (signal below
// the BS.1770-4 -70 LUFS absolute gate, or true silence).
function rmsDbfs(channels: Float32Array[]): number {
  let sumSq = 0;
  let total = 0;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) sumSq += (ch[i] as number) ** 2;
    total += ch.length;
  }
  if (total === 0 || sumSq === 0) return -Infinity;
  const rms = Math.sqrt(sumSq / total);
  return 20 * Math.log10(rms);
}

// Sample peak in dBFS — used to short-circuit on true silence.
function samplePeakLin(channels: Float32Array[]): number {
  let peak = 0;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) {
      const v = Math.abs(ch[i] as number);
      if (v > peak) peak = v;
    }
  }
  return peak;
}

// Hard cap on cumulative pre-gain so a runaway iteration can never
// produce Infinity (which would propagate to NaN samples).
const PRE_GAIN_CAP_DB = 60;

export function processLoudnessMaximizer(
  src: Float32Array[],
  fs: number,
  p: MaximizerParams,
): MaximizerResult {
  const tolerance = p.toleranceLu ?? 0.3;
  const maxIters  = p.maxIters    ?? 4;
  const damping   = p.damping     ?? 0.85;

  // ── Short-circuit: true silence ──────────────────────────────────────────
  // No information in the input → no correction can recover loudness.
  // Return a zero-filled copy with no gain applied.
  if (samplePeakLin(src) === 0) {
    const nCh = src.length;
    const N = (src[0] as Float32Array | undefined)?.length ?? 0;
    const out: Float32Array[] = new Array(nCh);
    for (let c = 0; c < nCh; c++) out[c] = new Float32Array(N);
    return { out, measuredLufs: -Infinity, appliedGainDb: 0,
             passes: 0, maxGrDb: 0, converged: true };
  }

  // ── Bootstrap ────────────────────────────────────────────────────────────
  // Prefer integrated LUFS, but it returns -Infinity for very-quiet content
  // (below -70 LUFS gate).  Fall back to an RMS-derived estimate (not
  // K-weighted, but accurate enough for an initial pre-gain seed).
  const lufsIn = measureLufs(src, fs);
  let initialEstimateLufs: number;
  if (isFinite(lufsIn)) {
    initialEstimateLufs = lufsIn;
  } else {
    const rmsDb = rmsDbfs(src);
    // Add ~3 dB to approximate the stereo K-weighted offset for typical
    // broadband content.  Fine as a SEED — the iteration loop refines it.
    initialEstimateLufs = isFinite(rmsDb) ? rmsDb + 3 : -120;
  }
  let preGainDb = p.targetLufs - initialEstimateLufs;
  if (preGainDb >  PRE_GAIN_CAP_DB) preGainDb =  PRE_GAIN_CAP_DB;
  if (preGainDb < -PRE_GAIN_CAP_DB) preGainDb = -PRE_GAIN_CAP_DB;

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

    // If the OUTPUT still sits below the BS.1770 gate even after pre-gain,
    // we're at the maximum useful boost (bumped against the soft-clip
    // ceiling).  Further iteration would just produce Infinity-driven
    // garbage — bail out cleanly.
    if (!isFinite(measured)) {
      converged = false;
      break;
    }

    const delta = p.targetLufs - measured;
    if (Math.abs(delta) <= tolerance) { converged = true; break; }
    // If the limiter is already producing > 8 dB GR and we're still under
    // target, further pre-gain mostly burns into distortion — bail out.
    if (delta > 0 && result.maxGrDb > 8 && Math.abs(delta) < 1.0) {
      converged = false; break;
    }
    preGainDb += delta * damping;
    if (preGainDb >  PRE_GAIN_CAP_DB) preGainDb =  PRE_GAIN_CAP_DB;
    if (preGainDb < -PRE_GAIN_CAP_DB) preGainDb = -PRE_GAIN_CAP_DB;
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
