// Transient detection + protection.
//
// Why this matters in a mastering chain:
//   Kicks and snares are the loudest, fastest-rising events in a mix.
//   When they hit the limiter at sample peak the limiter grabs hard for
//   the duration of the transient — which causes the whole program to
//   be pumped down for several milliseconds at every snare.  The
//   classic symptom is a "flat" master where every transient feels
//   equally loud and the groove dies.
//
// The fix is a small bit of pre-processing that slightly tames the
// transient PEAKS only — leaving the attack character (the FAST RISE)
// intact, and leaving the body of the signal untouched.  The limiter
// then has far more headroom on those peaks, and does much less GR on
// the rest of the program.
//
// Algorithm: dual-envelope onset detector.
//
//   • fastEnv = LPF(|x|, 300 Hz)     → ~1 ms time constant
//   • slowEnv = LPF(|x|, 10 Hz)      → ~30 ms time constant
//   • ratio   = fastEnv / slowEnv
//   • when ratio > kThreshold (≈ 1.5), we're seeing a transient onset
//   • brief, soft gain reduction proportional to (ratio - kThreshold),
//     capped at maxReductionDb (default -1.5 dB)
//   • the gain envelope itself has fast attack (≈ 1 ms) + medium
//     release (≈ 20 ms) so the transient ATTACK fires before the gain
//     dips — then recovers smoothly
//
// Stereo: linked (use the louder channel's envelope) so we never shift
// the L/R balance of a transient.

import { Biquad, rbjLowPass } from './biquad.js';
import { AudioBufferLike } from './loudnessCore.js';

export interface TransientProtectParams {
  /** Ratio above which a transient triggers reduction.  Default 1.5. */
  thresholdRatio?: number;
  /** Max gain reduction at the transient peak, dB.  Default 1.5. */
  maxReductionDb?: number;
  /** Reduction envelope attack (ms).  Default 1 ms. */
  attackMs?:       number;
  /** Reduction envelope release (ms).  Default 20 ms. */
  releaseMs?:      number;
  /** Slope: how much reduction per unit of (ratio - threshold).  Default 0.6. */
  slope?:          number;
  /** Skip detection for the first N ms (slow LPF convergence).  Default 100. */
  warmupMs?:       number;
  /** Min gap (ms) between counted onsets so one kick = one count.  Default 60.
   *  This affects the diagnostic transientCount only — gain-reduction
   *  shaping is independent. */
  refractoryMs?:   number;
}

export interface TransientProtectResult {
  buffer:           AudioBufferLike;
  /** How many discrete transient onsets were detected and tamed. */
  transientCount:   number;
  /** Largest gain reduction applied at any sample, in dB (always ≥ 0). */
  maxReductionDb:   number;
  /** Mean reduction over the program, dB.  Tiny (< 0.1 dB) on non-transient material. */
  meanReductionDb:  number;
  /** Sample-peak before / after — useful to verify the chain made headroom. */
  inputPeakDb:      number;
  outputPeakDb:     number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function dbOf(lin: number): number { return lin <= 0 ? -Infinity : 20 * Math.log10(lin); }

function rectifiedLpf(src: Float32Array, fs: number, cutoffHz: number): Float32Array {
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = Math.abs(src[i] as number);
  const lp = new Biquad(rbjLowPass(fs, cutoffHz));
  lp.processBlock(out);
  return out;
}

function samplePeak(channels: Float32Array[]): number {
  let p = 0;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) {
      const v = Math.abs(ch[i] as number);
      if (v > p) p = v;
    }
  }
  return p;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Detect kick/snare-style transient onsets and apply a small, brief gain
 * reduction at those peaks so a downstream limiter doesn't end up
 * pumping the whole program when transients hit.  The body of the signal
 * is left untouched — only the transient PEAKS are softened.
 *
 * Returns a fresh buffer (input never mutated) plus diagnostics.
 */
export function protectTransients(
  input: AudioBufferLike,
  opts: TransientProtectParams = {},
): TransientProtectResult {
  const fs = input.sampleRate;
  const nCh = input.numberOfChannels;

  const thresholdRatio = opts.thresholdRatio ?? 1.5;
  const maxReductionDb = opts.maxReductionDb ?? 1.5;
  const attackMs       = opts.attackMs       ?? 1;
  const releaseMs      = opts.releaseMs      ?? 20;
  const slope          = opts.slope          ?? 0.6;
  const warmupMs       = opts.warmupMs       ?? 100;
  const refractoryMs   = opts.refractoryMs   ?? 60;

  // Snapshot — independent copy.
  const out: Float32Array[] = new Array(nCh);
  for (let c = 0; c < nCh; c++) {
    out[c] = new Float32Array(input.getChannelData(c));
  }
  const inputPeakDb = dbOf(samplePeak(out));

  const N = (out[0] as Float32Array | undefined)?.length ?? 0;
  if (N === 0 || nCh === 0) {
    return {
      buffer: bufFromPlanar(out, fs),
      transientCount: 0,
      maxReductionDb: 0,
      meanReductionDb: 0,
      inputPeakDb,
      outputPeakDb: inputPeakDb,
    };
  }

  // Build per-channel envelopes, then link by taking the max-of-channels
  // ratio sample-by-sample.
  const fastChan: Float32Array[] = new Array(nCh);
  const slowChan: Float32Array[] = new Array(nCh);
  for (let c = 0; c < nCh; c++) {
    fastChan[c] = rectifiedLpf(out[c] as Float32Array, fs, 300);
    slowChan[c] = rectifiedLpf(out[c] as Float32Array, fs, 10);
  }

  // Linked transient ratio: max over channels of fast / slow.
  // The slow LPF (10 Hz) takes ~100 ms to converge from a zero state, so
  // any sample inside the warm-up window can have an artificially-high
  // ratio that's NOT a real transient — we suppress detection there.
  // We also gate on a minimum slow-envelope absolute level so silence
  // doesn't flicker.
  const warmupSmp = Math.round(fs * warmupMs / 1000);
  const SLOW_GATE_LIN = Math.pow(10, -55 / 20);   // ≈ 1.78e-3, ~-55 dBFS
  const ratio = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    if (i < warmupSmp) { ratio[i] = 1; continue; }
    let r = 0;
    for (let c = 0; c < nCh; c++) {
      const f = (fastChan[c] as Float32Array)[i] as number;
      const s = (slowChan[c] as Float32Array)[i] as number;
      if (s > SLOW_GATE_LIN) {
        const ri = f / s;
        if (ri > r) r = ri;
      }
    }
    ratio[i] = r === 0 ? 1 : r;
  }

  // Convert ratio → desired gain reduction (linear).  Below threshold:
  // 1.0 (no reduction).  Above: smooth ramp toward 10^(-maxReductionDb/20).
  // Onset counting uses a refractory gap so each kick = one count even if
  // the dual-envelope detector sees jagged sub-onsets in the attack.
  const minLin = Math.pow(10, -maxReductionDb / 20);
  const refractorySmp = Math.round(fs * refractoryMs / 1000);
  const target = new Float32Array(N);
  let transientCount = 0;
  let lastTrigger = -refractorySmp - 1;
  for (let i = 0; i < N; i++) {
    const r = ratio[i] as number;
    if (r <= thresholdRatio) {
      target[i] = 1;
    } else {
      // gainReductionDb = slope * (ratio - threshold), clamped to maxReduction.
      const grDb = Math.min(maxReductionDb, slope * (r - thresholdRatio));
      target[i] = Math.max(minLin, Math.pow(10, -grDb / 20));
      if (i - lastTrigger > refractorySmp) {
        transientCount++;
        lastTrigger = i;
      }
    }
  }

  // Smooth the target with a 1-pole envelope follower.  Asymmetric
  // attack/release: snap down fast on attack, ramp up gently on release.
  const attackSmp  = Math.max(1, Math.round(fs * attackMs  / 1000));
  const releaseSmp = Math.max(1, Math.round(fs * releaseMs / 1000));
  const aAtk = 1 - Math.exp(-1 / attackSmp);
  const aRel = 1 - Math.exp(-1 / releaseSmp);
  const env = new Float32Array(N);
  let g = 1;
  let sumGrDb = 0;
  let maxGrDb = 0;
  for (let i = 0; i < N; i++) {
    const t = target[i] as number;
    const alpha = t < g ? aAtk : aRel;
    g = g + (t - g) * alpha;
    if (g > 1) g = 1;
    if (g < minLin) g = minLin;
    env[i] = g;
    if (g < 1) {
      const grDb = -20 * Math.log10(g);
      if (grDb > maxGrDb) maxGrDb = grDb;
      sumGrDb += grDb;
    }
  }
  const meanGrDb = sumGrDb / N;

  // Apply.
  for (let c = 0; c < nCh; c++) {
    const arr = out[c] as Float32Array;
    for (let i = 0; i < N; i++) arr[i] = (arr[i] as number) * (env[i] as number);
  }

  return {
    buffer: bufFromPlanar(out, fs),
    transientCount,
    maxReductionDb: maxGrDb,
    meanReductionDb: meanGrDb,
    inputPeakDb,
    outputPeakDb: dbOf(samplePeak(out)),
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function bufFromPlanar(channels: Float32Array[], sr: number): AudioBufferLike {
  return {
    sampleRate:       sr,
    numberOfChannels: channels.length,
    length:           (channels[0] as Float32Array | undefined)?.length ?? 0,
    getChannelData(c: number): Float32Array { return channels[c] as Float32Array; },
  };
}
