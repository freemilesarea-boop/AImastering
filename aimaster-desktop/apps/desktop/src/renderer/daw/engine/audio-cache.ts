// Decoded-audio cache.
//
// Clip playback, waveform drawing and transient detection all need the same
// decoded buffer, and decoding a 5-minute stereo WAV is ~200 ms — so it is
// decoded once per file and shared.  Peaks and transient marks are derived
// once too and cached alongside, because Tab to Transient must be instant.

import { toFileUrl } from '../../utils/fileUrl.js';
import { detectTransients } from '../edit/transient.js';
import type { FileId } from '../model/types.js';

export interface CachedAudio {
  fileId: FileId;
  buffer: AudioBuffer;
  /** Mono peak envelope for waveform drawing (normalised 0..1). */
  peaks: Float32Array;
  /** Onset times in seconds, relative to the file start. */
  transients: number[];
}

const PEAK_BUCKETS = 4096;
const CACHE_CAP = 12;

const cache = new Map<FileId, CachedAudio>();
const pending = new Map<FileId, Promise<CachedAudio>>();

export function getCached(fileId: FileId): CachedAudio | undefined {
  const hit = cache.get(fileId);
  if (hit) { cache.delete(fileId); cache.set(fileId, hit); }   // LRU touch
  return hit;
}

export function cacheSize(): number { return cache.size; }

export function clearAudioCache(): void { cache.clear(); pending.clear(); }

/** Mono-summed peak envelope, normalised so the loudest bucket reads 1. */
export function computePeaks(buffer: AudioBuffer, buckets = PEAK_BUCKETS): Float32Array {
  const out = new Float32Array(buckets);
  const ch0 = buffer.getChannelData(0);
  const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : ch0;
  const per = buffer.length / buckets;
  for (let b = 0; b < buckets; b++) {
    const from = Math.floor(b * per);
    const to = Math.min(buffer.length, Math.floor((b + 1) * per));
    const stride = Math.max(1, Math.floor((to - from) / 96));
    let peak = 0;
    for (let i = from; i < to; i += stride) {
      const v = Math.max(Math.abs(ch0[i] ?? 0), Math.abs(ch1[i] ?? 0));
      if (v > peak) peak = v;
    }
    out[b] = peak;
  }
  let max = 0;
  for (let i = 0; i < out.length; i++) max = Math.max(max, out[i] ?? 0);
  if (max > 0 && max < 1) for (let i = 0; i < out.length; i++) out[i] = (out[i] ?? 0) / max;
  return out;
}

/** Mono sum of a buffer — the input transient detection wants. */
export function monoSum(buffer: AudioBuffer): Float32Array {
  const length = buffer.length;
  const out = new Float32Array(length);
  const channels = buffer.numberOfChannels;
  for (let c = 0; c < channels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < length; i++) out[i] = (out[i] ?? 0) + (data[i] ?? 0);
  }
  if (channels > 1) for (let i = 0; i < length; i++) out[i] = (out[i] ?? 0) / channels;
  return out;
}

export function analyzeBuffer(fileId: FileId, buffer: AudioBuffer): CachedAudio {
  const entry: CachedAudio = {
    fileId,
    buffer,
    peaks: computePeaks(buffer),
    transients: detectTransients(monoSum(buffer), buffer.sampleRate),
  };
  cache.set(fileId, entry);
  while (cache.size > CACHE_CAP) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return entry;
}

/**
 * Decode a file (or return the cached result).  Concurrent callers for the
 * same file share one decode.
 */
export async function loadAudio(
  ctx: BaseAudioContext, fileId: FileId, path: string,
): Promise<CachedAudio> {
  const hit = getCached(fileId);
  if (hit) return hit;
  const inFlight = pending.get(fileId);
  if (inFlight) return inFlight;

  const task = (async () => {
    const resp = await fetch(toFileUrl(path));
    if (!resp.ok) throw new Error(`오디오 로드 실패 (${resp.status}): ${path}`);
    const bytes = await resp.arrayBuffer();
    const buffer = await ctx.decodeAudioData(bytes);
    return analyzeBuffer(fileId, buffer);
  })();

  pending.set(fileId, task);
  try {
    return await task;
  } finally {
    pending.delete(fileId);
  }
}

// ── Decode-only context ───────────────────────────────────────────────────────
// The Edit window must draw waveforms before anyone presses play, and a live
// AudioContext cannot be created without a user gesture.  An
// OfflineAudioContext has decodeAudioData too and needs no gesture, so the UI
// decodes through this one and the transport keeps its own live context.

let decodeCtx: OfflineAudioContext | null = null;

export function decodeContext(): OfflineAudioContext | null {
  if (decodeCtx) return decodeCtx;
  const Ctor = (globalThis as unknown as { OfflineAudioContext?: typeof OfflineAudioContext }).OfflineAudioContext;
  if (!Ctor) return null;
  try { decodeCtx = new Ctor(1, 1, 48_000); } catch { decodeCtx = null; }
  return decodeCtx;
}

/** Decode a set of files for display.  Failures are reported, never thrown. */
export async function decodeForDisplay(
  files: ReadonlyArray<{ id: FileId; path: string }>,
): Promise<{ decoded: number; failed: string[] }> {
  const ctx = decodeContext();
  if (!ctx) return { decoded: 0, failed: files.map((f) => f.path) };
  const failed: string[] = [];
  let decoded = 0;
  await Promise.all(files.map(async (f) => {
    if (getCached(f.id)) { decoded += 1; return; }
    try { await loadAudio(ctx, f.id, f.path); decoded += 1; }
    catch { failed.push(f.path); }
  }));
  return { decoded, failed };
}

/** Transient marks for a file, or an empty list when it is not decoded yet. */
export function transientsFor(fileId: FileId): number[] {
  return getCached(fileId)?.transients ?? [];
}
