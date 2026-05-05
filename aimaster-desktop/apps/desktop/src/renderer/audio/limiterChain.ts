// 3-stage limiter — public processLimiter() API.
//
//   Stage 1 — analog-style soft clipper       (softClip.ts)
//   Stage 2 — look-ahead peak limiter         (peakLimiter.ts)
//   Stage 3 — iterative loudness maximizer    (loudnessMaximizer.ts)
//
// Plus a final true-peak guard that re-checks the inter-sample peak with
// the BS.1770-4 4× polyphase oversample and applies a final hard ceiling
// of `truePeakCeilingDb` (default -1 dBTP).  This satisfies the contract:
//
//   • Inter-sample peak is bounded ≤ -1 dBTP after the chain runs.
//   • At target -10 LUFS (or quieter) the soft-clip + limiter operate in
//     their linear regions and produce no audible distortion.

import { AudioBufferLike } from './loudnessCore.js';
import { TruePeakChannel } from './truePeak.js';
import { processLoudnessMaximizer, MaximizerParams } from './loudnessMaximizer.js';
import type { SoftClipParams } from './softClip.js';
import type { PeakLimiterParams } from './peakLimiter.js';

export interface ProcessLimiterOptions {
  /** Final true-peak ceiling in dBTP.  Default -1.0 dBTP. */
  truePeakCeilingDb?: number;
  /** Stage-1 soft-clip thresholdDb / ceilingDb / driveDb. */
  softClip?:          SoftClipParams;
  /** Stage-2 look-ahead peak limiter params. */
  peakLimiter?:       PeakLimiterParams;
  /** Iteration tolerance (LU) and ceiling on iteration count. */
  toleranceLu?:       number;
  maxIters?:          number;
}

export interface ProcessLimiterResult {
  /** Processed buffer (same shape as input).  Independent of the input. */
  buffer:           AudioBufferLike;
  /** Post-chain integrated LUFS. */
  measuredLufs:     number;
  /** Post-chain inter-sample true-peak in dBTP (max across channels). */
  truePeakDbtp:     number;
  /** Pre-gain applied by the loudness-maximizer loop, in dB. */
  appliedGainDb:    number;
  /** Number of maximizer iterations consumed. */
  passes:           number;
  /** Peak GR (positive dB) seen in the final limiter pass. */
  maxGrDb:          number;
  /** Did the maximizer hit |Δ| ≤ toleranceLu? */
  converged:        boolean;
  /** True if the final TP guard kicked in to clamp inter-sample peaks. */
  truePeakGuarded:  boolean;
}

// Build a duck-typed AudioBufferLike from planar Float32Arrays.
function bufferFromPlanar(
  channels: Float32Array[],
  sampleRate: number,
): AudioBufferLike {
  return {
    sampleRate,
    numberOfChannels: channels.length,
    length:           (channels[0] as Float32Array | undefined)?.length ?? 0,
    getChannelData(c: number): Float32Array {
      return channels[c] as Float32Array;
    },
  };
}

// Final TP guard — measures every channel via 4× polyphase, computes the
// max true-peak across channels, and if it exceeds the ceiling applies a
// linked broadband attenuation so all channels stay below it.  This is a
// last line of defense; the maximizer's conservative sample-peak ceiling
// (-1.5 dBFS by default) is normally enough.
function applyTruePeakGuard(
  channels: Float32Array[],
  ceilingDbtp: number,
): { tpDb: number; guarded: boolean } {
  const ch: TruePeakChannel[] = channels.map(() => new TruePeakChannel());
  for (let c = 0; c < channels.length; c++) {
    ch[c]?.processBlock(channels[c] as Float32Array);
  }
  let peakLin = 0;
  for (const t of ch) if (t.peakLinear() > peakLin) peakLin = t.peakLinear();
  const tpDb = peakLin <= 0 ? -Infinity : 20 * Math.log10(peakLin);
  const ceilingLin = Math.pow(10, ceilingDbtp / 20);
  if (peakLin <= ceilingLin) return { tpDb, guarded: false };

  // Reduce broadband to bring TP exactly to ceiling.
  const reduce = ceilingLin / peakLin;
  for (let c = 0; c < channels.length; c++) {
    const a = channels[c] as Float32Array;
    for (let i = 0; i < a.length; i++) a[i] = (a[i] as number) * reduce;
  }
  return { tpDb: ceilingDbtp, guarded: true };
}

/**
 * 3-stage limiter chain — analog soft clip → look-ahead peak limiter →
 * iterative loudness maximizer → true-peak guard.
 *
 * Returns a NEW buffer (the input is not mutated).
 */
export function processLimiter(
  input: AudioBufferLike,
  targetLUFS: number,
  options: ProcessLimiterOptions = {},
): ProcessLimiterResult {
  const fs   = input.sampleRate;
  const nCh  = input.numberOfChannels;

  // Snapshot input as planar Float32Arrays (independent of the input).
  const src: Float32Array[] = new Array(nCh);
  for (let c = 0; c < nCh; c++) {
    const ic = input.getChannelData(c);
    src[c] = new Float32Array(ic);
  }

  // Stage 3 (which itself runs Stages 1+2 each iteration).
  const maxParams: MaximizerParams = { targetLufs: targetLUFS };
  if (options.toleranceLu !== undefined) maxParams.toleranceLu = options.toleranceLu;
  if (options.maxIters    !== undefined) maxParams.maxIters    = options.maxIters;
  if (options.softClip    !== undefined) maxParams.softClip    = options.softClip;
  if (options.peakLimiter !== undefined) maxParams.peakLimiter = options.peakLimiter;
  const max = processLoudnessMaximizer(src, fs, maxParams);

  // Final true-peak guard.
  const tpCeil = options.truePeakCeilingDb ?? -1.0;
  const tpRes = applyTruePeakGuard(max.out, tpCeil);

  return {
    buffer:           bufferFromPlanar(max.out, fs),
    measuredLufs:     max.measuredLufs,
    truePeakDbtp:     tpRes.tpDb,
    appliedGainDb:    max.appliedGainDb,
    passes:           max.passes,
    maxGrDb:          max.maxGrDb,
    converged:        max.converged,
    truePeakGuarded:  tpRes.guarded,
  };
}
