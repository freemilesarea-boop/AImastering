// useWaveformPeaks — decode an audio URL into bucketed peak data for the
// playback bar's waveform overlay.  Cached in-memory (LRU-ish) so switching
// revisions or A/B-flipping doesn't re-decode the same file twice.
//
// The hook is best-effort:
//   • If decoding fails (CSP / corrupt file / unsupported codec), it returns
//     `peaks: null` with an error message — the playback bar gracefully
//     falls back to its plain progress fill.
//   • A new src cancels any in-flight decode for the previous src.

import { useEffect, useRef, useState } from 'react';

export interface WaveformPeaks {
  /** Per-bucket max abs sample (0..1), length = bucketCount.  Null while loading or on failure. */
  data: Float32Array | null;
  bucketCount: number;
  /** Decode running.  Useful for a "loading" skeleton state. */
  decoding: boolean;
  /** Diagnostic — populated when decoding fails so callers can show / log it. */
  error: string | null;
  /** True once a successful decode lands for this src.  Stays true on subsequent re-renders. */
  ready: boolean;
}

const EMPTY: WaveformPeaks = { data: null, bucketCount: 0, decoding: false, error: null, ready: false };

// LRU cache of decoded peaks per (src, bucketCount).  Cap keeps memory bounded
// when the user A/B-flips between many revisions in a long session.
const CACHE_CAP = 8;
const cache = new Map<string, Float32Array>();
function cacheKey(src: string, buckets: number): string { return `${buckets}|${src}`; }
function cacheGet(key: string): Float32Array | undefined {
  const v = cache.get(key);
  if (!v) return undefined;
  // Touch — move to end for LRU recency.
  cache.delete(key); cache.set(key, v);
  return v;
}
function cachePut(key: string, value: Float32Array): void {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  if (cache.size > CACHE_CAP) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
}

// Single lazy AudioContext for decode (closed = creation cost on first use,
// reused across all decodes for the session).
let decodeCtx: AudioContext | null = null;
function getDecodeCtx(): AudioContext | null {
  if (decodeCtx) return decodeCtx;
  if (typeof AudioContext === 'undefined') return null;
  try { decodeCtx = new AudioContext({ sampleRate: 48000 }); } catch { decodeCtx = null; }
  return decodeCtx;
}

/** Reduce a mono / stereo AudioBuffer into per-bucket peak abs values. */
function computePeaks(buffer: AudioBuffer, bucketCount: number): Float32Array {
  const out = new Float32Array(bucketCount);
  const channels = buffer.numberOfChannels;
  const samples = buffer.length;
  // For long files: stride sampling.  We don't need exact peak — the bar is
  // a visual reference; missing one sample per bucket is invisible.
  // Walk channel data with stride to keep this O(bucketCount).
  const samplesPerBucket = samples / bucketCount;
  // Pre-read all channel data refs (avoids repeated method calls in inner loop).
  const ch0 = buffer.getChannelData(0);
  const ch1 = channels > 1 ? buffer.getChannelData(1) : ch0;
  for (let b = 0; b < bucketCount; b++) {
    const start = Math.floor(b * samplesPerBucket);
    const end = Math.min(samples, Math.floor((b + 1) * samplesPerBucket));
    let peak = 0;
    // Stride at most 64 samples to bound cost — for a 3-min track at 48k stereo
    // that's still ~200 samples per bucket scanned.
    const stride = Math.max(1, Math.floor((end - start) / 64));
    for (let i = start; i < end; i += stride) {
      const l = Math.abs(ch0[i]!);
      const r = Math.abs(ch1[i]!);
      const a = l > r ? l : r;
      if (a > peak) peak = a;
    }
    out[b] = peak;
  }
  // Normalise so the loudest bucket reads 1.0 — keeps quiet songs visible.
  let max = 0;
  for (let i = 0; i < out.length; i++) if (out[i]! > max) max = out[i]!;
  if (max > 0 && max < 1) {
    const k = 1 / max;
    for (let i = 0; i < out.length; i++) out[i] = (out[i]!) * k;
  }
  return out;
}

export function useWaveformPeaks(src: string | null | undefined, bucketCount = 1200): WaveformPeaks {
  const [state, setState] = useState<WaveformPeaks>(EMPTY);
  const reqIdRef = useRef(0);

  useEffect(() => {
    if (!src) { setState(EMPTY); return; }
    const key = cacheKey(src, bucketCount);
    const hit = cacheGet(key);
    if (hit) {
      setState({ data: hit, bucketCount, decoding: false, error: null, ready: true });
      return;
    }
    const reqId = ++reqIdRef.current;
    setState({ data: null, bucketCount, decoding: true, error: null, ready: false });
    let cancelled = false;
    (async () => {
      try {
        const ctx = getDecodeCtx();
        if (!ctx) throw new Error('AudioContext unavailable');
        const resp = await fetch(src);
        if (!resp.ok) throw new Error(`fetch failed (${resp.status})`);
        const buf = await resp.arrayBuffer();
        if (cancelled || reqIdRef.current !== reqId) return;
        // decodeAudioData copies the buffer, so we can release ours.
        const decoded = await ctx.decodeAudioData(buf);
        if (cancelled || reqIdRef.current !== reqId) return;
        const peaks = computePeaks(decoded, bucketCount);
        cachePut(key, peaks);
        setState({ data: peaks, bucketCount, decoding: false, error: null, ready: true });
      } catch (e) {
        if (cancelled || reqIdRef.current !== reqId) return;
        const msg = e instanceof Error ? e.message : String(e);
        setState({ data: null, bucketCount, decoding: false, error: msg, ready: false });
      }
    })();
    return () => { cancelled = true; };
  }, [src, bucketCount]);

  return state;
}
