// Pure offline block-render core (RUST-OFFLINE-RENDER-1).
//
// Runs the same Rust MasteringChain over a whole deinterleaved stereo
// buffer, block by block (the chain is allocation-free + realtime-safe, so
// offline = looping `processStereo`).  Headless-testable (the parity
// harness drives this directly).

import {
  createOfflineChain, applyChainConfigForRender, withInputGain,
  type OfflineChainConfig, type WasmMasteringChain,
} from './load-mastering-chain-node.js';
import { measureStereoLoudness, solveLoudnessGain, type LoudnessGainPolicy } from './offline-loudness.js';

export interface RenderMetrics {
  /**
   * Chain latency that was compensated, in samples.
   *
   * Null when this WASM build cannot report it, in which case the render is
   * still produced but arrives late by that amount and loses its tail.
   * Null is not zero and callers must not treat it as such.
   */
  latencySamples: number | null;
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
  const t0 = Date.now();

  let chain: WasmMasteringChain | null = null;
  try {
    chain = createOfflineChain(sampleRate);
    chain.reset();
    applyChainConfigForRender(chain, config);

    // ── Latency ──────────────────────────────────────────────────────────
    // The chain's STFT stages (de-noise, spectral shaper, hiss gate) delay
    // the signal by ~2048 samples; a chain without them delays by none. This
    // render used to ignore that entirely, and the delay is not harmless:
    //
    //   • the whole master arrived up to 43 ms late, and
    //   • the last 43 ms — the end of the fade — was pushed past the end of
    //     the output buffer and silently lost.
    //
    // The fix is the same one the stem renderer uses: pad the input by the
    // latency so the chain flushes what is still inside it, then read the
    // output from `latency` onwards so the result sits on the source's own
    // timeline.
    const reported = typeof chain.latencySamples === 'function' ? chain.latencySamples() : null;
    const latency = reported !== null && Number.isFinite(reported) && reported > 0
      ? Math.floor(reported)
      : reported === null ? null : 0;
    const pad = latency ?? 0;
    const total = n + pad;

    const work = new Float32Array(total);
    const workR = new Float32Array(total);
    work.set(inLeft.subarray(0, n));
    workR.set(inRight.subarray(0, n));

    for (let pos = 0; pos < total; pos += blockSize) {
      const end = Math.min(pos + blockSize, total);
      // wasm-bindgen copies the Float32Array in + back out, so write the
      // processed block back into the buffer.
      const lCopy = work.subarray(pos, end).slice();
      const rCopy = workR.subarray(pos, end).slice();
      chain.processStereo(lCopy, rCopy);
      work.set(lCopy, pos);
      workR.set(rCopy, pos);
      if (onProgress && (pos % (blockSize * 64) === 0)) onProgress(pos / total);
    }
    onProgress?.(1);

    // Reading from `pad` removes the chain's own delay. The output is the
    // same length as the input, and it now ends where the source ended
    // rather than 43 ms earlier.
    const left = work.subarray(pad, pad + n).slice();
    const right = workR.subarray(pad, pad + n).slice();

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
        latencySamples: latency,
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
  /** How many correction passes were spent. */
  loudnessPasses: number;
  /**
   * Why the correction ended where it did.
   *
   * `ceiling-limited` means further input gain stopped producing more
   * loudness — the limiter is holding the level and the target is not
   * reachable on this material through this chain. A caller that shows the
   * requested target without showing this is telling the user something
   * the file does not do.
   */
  loudnessNote: 'ok' | 'silence' | 'clamped-boost' | 'clamped-cut' | 'ceiling-limited';
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

/** How close to the target counts as landing on it, dB. */
const LOUDNESS_TOLERANCE_DB = 0.3;
/**
 * Most correction passes to spend.
 *
 * Four is enough to converge on anything reachable. When it has not
 * converged by then the target is not reachable through this chain's
 * ceiling, and more passes would confirm that more slowly.
 */
const MAX_LOUDNESS_PASSES = 4;

/**
 * Loudness-aware render: run the chain, measure, correct, repeat.
 *
 *   Pass 1 — run the chain, measure integrated LUFS.
 *   Solve  — input gain toward targetLufs (bounded; silence skipped).
 *   Pass N — re-run with that gain and measure again, until the result is
 *            within tolerance or the ceiling stops it moving.
 *
 * The ceiling is enforced by the chain's own limiter (`limCeilingDbtp`), not
 * by re-limiting here, so the true peak stays under it by construction.
 *
 * # Why it iterates
 *
 * A chain with a limiter in it is not linear in its input gain. Solving once
 * assumes +6 dB in gives +6 dB out; once the limiter is working, most of
 * what is added at the input is taken straight back off, and the correction
 * undershoots — measured at 7 dB on dense material aiming at a loud target.
 * The single-pass version of this function was the reason loud presets never
 * reached their stated loudness.
 *
 * # Why the gain goes through `withInputGain`
 *
 * Because writing it to the flat `inputGainDb` does nothing at all when the
 * config carries a `suiteConfig`, which the app's export path always does.
 * See that function.
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

  let current = renderStereoBuffer(inLeft, inRight, config, sampleRate, blockSize,
    (f) => onProgress?.(f * 0.4));
  let measured = measureStereoLoudness(current.left, current.right, sampleRate);
  const firstLufs = measured.integratedLufs;

  const maxBoost = norm.maxBoostDb ?? 12;
  const maxCut = norm.maxCutDb ?? -24;

  let total = 0;
  let passes = 0;
  let clamped: 'clamped-boost' | 'clamped-cut' | 'silence' | null = null;
  let saturated = false;

  for (passes = 1; passes <= MAX_LOUDNESS_PASSES; passes++) {
    const solved = solveLoudnessGain(measured.integratedLufs, norm.targetLufs, norm);
    if (solved.note === 'silence') { clamped = 'silence'; break; }

    // The policy bounds the TOTAL correction, not each step of it.
    const wanted = total + solved.appliedGainDb;
    const bounded = Math.max(maxCut, Math.min(maxBoost, wanted));
    if (bounded !== wanted) clamped = wanted > bounded ? 'clamped-boost' : 'clamped-cut';

    const step = bounded - total;
    if (Math.abs(step) < 0.05) break;

    const cfgN = withInputGain(config, bounded);
    const next = renderStereoBuffer(inLeft, inRight, cfgN, sampleRate, blockSize,
      (f) => onProgress?.(0.4 + (0.55 * (passes - 1 + f)) / MAX_LOUDNESS_PASSES));
    const after = measureStereoLoudness(next.left, next.right, sampleRate);

    // More gain in, no more loudness out: the ceiling is holding the level
    // and no further correction will move it.
    const stalled = Math.abs(step) > 0.5 && step > 0 &&
      (after.integratedLufs - measured.integratedLufs) < Math.abs(step) * 0.1;

    current = next;
    measured = after;
    total = bounded;

    if (stalled) { saturated = true; break; }
    if (Math.abs(norm.targetLufs - measured.integratedLufs) <= LOUDNESS_TOLERANCE_DB) break;
  }
  passes = Math.min(passes, MAX_LOUDNESS_PASSES);
  onProgress?.(1);

  const note: NormalizedRenderMetrics['loudnessNote'] =
    clamped === 'silence' ? 'silence'
      : saturated ? 'ceiling-limited'
      : clamped ?? (Math.abs(norm.targetLufs - measured.integratedLufs) <= LOUDNESS_TOLERANCE_DB
        ? 'ok' : 'ceiling-limited');

  return {
    left: current.left,
    right: current.right,
    metrics: {
      ...current.metrics,
      renderMs: Date.now() - t0,
      measuredProcessedLufs: firstLufs,
      finalLufs: measured.integratedLufs,
      targetLufs: norm.targetLufs,
      appliedLoudnessGainDb: total,
      finalTruePeakDb: measured.truePeakDbtp,
      loudnessPasses: passes,
      loudnessNote: note,
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
