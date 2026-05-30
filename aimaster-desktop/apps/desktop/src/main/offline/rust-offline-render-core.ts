// Pure offline block-render core (RUST-OFFLINE-RENDER-1).
//
// Runs the same Rust MasteringChain over a whole deinterleaved stereo
// buffer, block by block (the chain is allocation-free + realtime-safe, so
// offline = looping `processStereo`).  Headless-testable (the parity
// harness drives this directly).

import {
  createOfflineChain, applyOfflineConfig,
  type OfflineChainConfig, type WasmMasteringChain,
} from './load-mastering-chain-node.js';
import { measureStereoLoudness, solveLoudnessGain, type LoudnessGainPolicy } from './offline-loudness.js';

export interface RenderMetrics {
  /** Linear sample peak (max |x|) of the output. */
  samplePeak: number;
  /** Sample peak in dBFS (−Infinity for silence). */
  samplePeakDb: number;
  /** Final limiter gain reduction (dB). */
  limiterGrDb: number;
  /** Output length in samples (per channel). */
  samples: number;
  durationSec: number;
  renderMs: number;
}

export interface RenderResult {
  left: Float32Array;
  right: Float32Array;
  metrics: RenderMetrics;
}

const DEFAULT_BLOCK = 512;

function dbfs(peak: number): number {
  return peak > 0 ? 20 * Math.log10(peak) : -Infinity;
}

/**
 * Process a deinterleaved stereo buffer through the chain.  Mutates copies
 * (returns new arrays).  Throws only if the WASM chain is unavailable.
 */
export function renderStereoBuffer(
  inLeft: Float32Array,
  inRight: Float32Array,
  config: OfflineChainConfig,
  sampleRate: number,
  blockSize: number = DEFAULT_BLOCK,
  onProgress?: (frac: number) => void,
): RenderResult {
  const n = Math.min(inLeft.length, inRight.length);
  const left = inLeft.slice(0, n);
  const right = inRight.slice(0, n);
  const t0 = Date.now();

  let chain: WasmMasteringChain | null = null;
  try {
    chain = createOfflineChain(sampleRate);
    chain.reset();
    applyOfflineConfig(chain, config);

    for (let pos = 0; pos < n; pos += blockSize) {
      const end = Math.min(pos + blockSize, n);
      // Subarray views share memory with `left`/`right` — processed in place.
      const lb = left.subarray(pos, end);
      const rb = right.subarray(pos, end);
      // wasm-bindgen copies the Float32Array in + back out, so write the
      // processed block back into the buffer.
      const lCopy = lb.slice();
      const rCopy = rb.slice();
      chain.processStereo(lCopy, rCopy);
      left.set(lCopy, pos);
      right.set(rCopy, pos);
      if (onProgress && (pos % (blockSize * 64) === 0)) onProgress(pos / n);
    }
    onProgress?.(1);

    let peak = 0;
    for (let i = 0; i < n; i++) {
      const a = Math.abs(left[i]!); if (a > peak) peak = a;
      const b = Math.abs(right[i]!); if (b > peak) peak = b;
    }
    const grDb = chain.limiterGrDb();
    return {
      left, right,
      metrics: {
        samplePeak: peak,
        samplePeakDb: dbfs(peak),
        limiterGrDb: Number.isFinite(grDb) ? grDb : 0,
        samples: n,
        durationSec: n / sampleRate,
        renderMs: Date.now() - t0,
      },
    };
  } finally {
    try { chain?.free?.(); } catch { /* ignore */ }
  }
}

export interface NormalizedRenderMetrics extends RenderMetrics {
  /** Integrated LUFS of the chain output BEFORE the loudness gain (pass 1). */
  measuredProcessedLufs: number;
  /** Integrated LUFS of the FINAL output (pass 2). */
  finalLufs: number;
  targetLufs: number;
  appliedLoudnessGainDb: number;
  finalTruePeakDb: number;
}

export interface NormalizedRenderResult {
  left: Float32Array;
  right: Float32Array;
  metrics: NormalizedRenderMetrics;
}

export interface NormalizeOptions extends LoudnessGainPolicy {
  targetLufs: number;
  targetTp: number;
}

/**
 * Two-pass loudness-aware render (RUST-OFFLINE-RENDER-2):
 *   Pass 1 — run the chain, measure integrated LUFS.
 *   Solve  — input-gain to push toward targetLufs (bounded; silence skipped).
 *   Pass 2 — re-run the chain with that input gain; the chain limiter holds
 *            the true-peak ceiling, so loudness rises without clipping.
 *
 * The ceiling is enforced by the chain's own limiter (config.limCeilingDbtp),
 * NOT by re-limiting here — so finalTruePeak ≤ ceiling by construction.
 */
export function renderStereoBufferNormalized(
  inLeft: Float32Array,
  inRight: Float32Array,
  config: OfflineChainConfig,
  sampleRate: number,
  norm: NormalizeOptions,
  blockSize: number = DEFAULT_BLOCK,
  onProgress?: (frac: number) => void,
): NormalizedRenderResult {
  const t0 = Date.now();
  // Pass 1.
  const p1 = renderStereoBuffer(inLeft, inRight, config, sampleRate, blockSize, (f) => onProgress?.(f * 0.45));
  const m1 = measureStereoLoudness(p1.left, p1.right, sampleRate);
  // Solve loudness gain (applied as the chain's INPUT gain on pass 2).
  const sol = solveLoudnessGain(m1.integratedLufs, norm.targetLufs, norm);

  // If no gain needed (silence or ≈target), keep pass 1.
  let final = p1;
  let finalMeas = m1;
  if (Math.abs(sol.appliedGainDb) > 0.05) {
    const cfg2: OfflineChainConfig = { ...config, inputGainDb: config.inputGainDb + sol.appliedGainDb };
    final = renderStereoBuffer(inLeft, inRight, cfg2, sampleRate, blockSize, (f) => onProgress?.(0.45 + f * 0.45));
    finalMeas = measureStereoLoudness(final.left, final.right, sampleRate);
  }
  onProgress?.(1);

  return {
    left: final.left,
    right: final.right,
    metrics: {
      ...final.metrics,
      renderMs: Date.now() - t0,
      measuredProcessedLufs: m1.integratedLufs,
      finalLufs: finalMeas.integratedLufs,
      targetLufs: norm.targetLufs,
      appliedLoudnessGainDb: sol.appliedGainDb,
      finalTruePeakDb: finalMeas.truePeakDbtp,
    },
  };
}

/** Interleave L/R → a single Float32Array (LRLR…). */
export function interleave(left: Float32Array, right: Float32Array): Float32Array {
  const n = Math.min(left.length, right.length);
  const out = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) { out[i * 2] = left[i]!; out[i * 2 + 1] = right[i]!; }
  return out;
}

/** Deinterleave LRLR… → { left, right }.  Mono input duplicates to both. */
export function deinterleave(data: Float32Array, channels: number): { left: Float32Array; right: Float32Array } {
  if (channels === 1) return { left: data.slice(), right: data.slice() };
  const n = Math.floor(data.length / channels);
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  for (let i = 0; i < n; i++) { left[i] = data[i * channels]!; right[i] = data[i * channels + 1]!; }
  return { left, right };
}
