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
