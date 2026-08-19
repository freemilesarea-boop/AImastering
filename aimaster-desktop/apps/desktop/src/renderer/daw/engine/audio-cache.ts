// Decoded-audio cache.
//
// Clip playback, waveform drawing and transient detection all need the same
// decoded buffer, and decoding a 5-minute stereo WAV is ~200 ms — so it is
// decoded once per file and shared.  Peaks and transient marks are derived
// once too and cached alongside, because Tab to Transient must be instant.
//
// ── Memory is the constraint here, not speed ────────────────────────────────
// A five-minute stereo song at 48 kHz decodes to ~115 MB of float32.  Decoding
// twenty of them AT ONCE — exactly what "load an album on the home screen,
// then open the DAW" used to do — asks for well over two gigabytes in a single
// burst, and the renderer process is killed before anything is drawn.  The
// window then shows its own background colour: a black screen with no error,
// because there is no renderer left to report one.
//
// Two rules prevent that:
//
//   1. Decoding is SEQUENTIAL.  One file is in flight at a time, so peak
//      memory is one buffer above whatever the cache already holds — not the
//      sum of every file the session references.
//   2. The cache is bounded in BYTES, not in entries.  Twelve five-minute
//      songs and twelve eight-bar loops are the same count and a hundredfold
//      difference in memory; only bytes describe the real limit.
//
// What survives eviction is the part the UI needs.  The peak envelope and the
// onset marks are a few kilobytes per file, so they are kept forever: waveforms
// still draw and Tab to Transient still works after the buffer is gone, and
// the buffer itself is re-decoded on demand when playback needs it back.

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

/**
 * Everything about a file except the samples.  Kilobytes, so it outlives the
 * buffer — the timeline must keep its waveform when the audio is evicted.
 */
export interface FileMeta {
  fileId: FileId;
  durationSec: number;
  sampleRate: number;
  channels: number;
  peaks: Float32Array;
  transients: number[];
}

const PEAK_BUCKETS = 4096;
const CACHE_CAP = 12;
/** ~6 five-minute stereo songs at 48 kHz.  Past this the renderer is at risk. */
export const MAX_CACHE_BYTES = 700 * 1024 * 1024;

const cache = new Map<FileId, CachedAudio>();
const meta = new Map<FileId, FileMeta>();
const pending = new Map<FileId, Promise<CachedAudio>>();
let residentBytes = 0;

/** float32 per sample per channel — what the buffer actually costs. */
export function bufferBytes(buffer: AudioBuffer): number {
  return buffer.length * buffer.numberOfChannels * 4;
}

export function getCached(fileId: FileId): CachedAudio | undefined {
  const hit = cache.get(fileId);
  if (hit) { cache.delete(fileId); cache.set(fileId, hit); }   // LRU touch
  return hit;
}

/** Duration, peaks and onsets for a file — present even after eviction. */
export function getMeta(fileId: FileId): FileMeta | undefined {
  return meta.get(fileId);
}

export function cacheSize(): number { return cache.size; }
export function cacheBytes(): number { return residentBytes; }

export function clearAudioCache(): void {
  cache.clear(); meta.clear(); pending.clear(); residentBytes = 0;
}

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

/**
 * Which buffers to drop, given the cache in least-recently-used order.
 *
 * Pure so the rule can be tested without allocating a gigabyte: walk from the
 * oldest entry and drop until BOTH budgets are met, never touching the file
 * the caller just asked for — evicting that one would make the call pointless.
 */
export function evictionPlan(
  entries: ReadonlyArray<{ id: FileId; bytes: number }>,
  keep: FileId, maxEntries: number, maxBytes: number,
): FileId[] {
  let count = entries.length;
  let bytes = entries.reduce((sum, e) => sum + e.bytes, 0);
  const drop: FileId[] = [];
  for (const entry of entries) {
    if (count <= maxEntries && bytes <= maxBytes) break;
    if (entry.id === keep) continue;
    drop.push(entry.id);
    count -= 1;
    bytes -= entry.bytes;
  }
  return drop;
}

/** Drop least-recently-used buffers until both budgets are satisfied. */
function evictDownTo(keep: FileId): void {
  const order = [...cache].map(([id, entry]) => ({ id, bytes: bufferBytes(entry.buffer) }));
  for (const id of evictionPlan(order, keep, CACHE_CAP, MAX_CACHE_BYTES)) {
    const entry = cache.get(id);
    if (!entry) continue;
    cache.delete(id);
    residentBytes -= bufferBytes(entry.buffer);
  }
}

export function analyzeBuffer(fileId: FileId, buffer: AudioBuffer): CachedAudio {
  const peaks = computePeaks(buffer);
  const transients = detectTransients(monoSum(buffer), buffer.sampleRate);
  const entry: CachedAudio = { fileId, buffer, peaks, transients };

  meta.set(fileId, {
    fileId,
    durationSec: buffer.duration,
    sampleRate: buffer.sampleRate,
    channels: buffer.numberOfChannels,
    peaks,
    transients,
  });

  const previous = cache.get(fileId);
  if (previous) residentBytes -= bufferBytes(previous.buffer);
  cache.delete(fileId);
  cache.set(fileId, entry);
  residentBytes += bufferBytes(buffer);
  evictDownTo(fileId);
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

export type DecodeProgress = (done: number, total: number) => void;

/**
 * Decode a set of files for display.  Failures are reported, never thrown.
 *
 * One at a time: twenty songs decoded in parallel is a two-gigabyte spike that
 * kills the renderer.  A file whose peaks are already known is skipped even if
 * its buffer has been evicted — display does not need the samples back.
 */
export async function decodeForDisplay(
  files: ReadonlyArray<{ id: FileId; path: string }>,
  onProgress?: DecodeProgress,
): Promise<{ decoded: number; failed: string[] }> {
  const ctx = decodeContext();
  if (!ctx) return { decoded: 0, failed: files.map((f) => f.path) };
  const failed: string[] = [];
  let decoded = 0;
  let seen = 0;
  for (const f of files) {
    seen += 1;
    if (getCached(f.id) || meta.has(f.id)) {
      decoded += 1;
    } else {
      try { await loadAudio(ctx, f.id, f.path); decoded += 1; }
      catch { failed.push(f.path); }
    }
    onProgress?.(seen, files.length);
  }
  return { decoded, failed };
}

/**
 * Decode every file a playback or offline pass needs, one at a time.  A file
 * that will not decode is silence in the render, not a thrown render.
 */
export async function preloadAll(
  ctx: BaseAudioContext, files: ReadonlyArray<{ id: FileId; path: string }>,
): Promise<void> {
  for (const f of files) {
    if (getCached(f.id)) continue;
    try { await loadAudio(ctx, f.id, f.path); } catch { /* missing file → silence */ }
  }
}

/** Transient marks for a file, or an empty list when it is not decoded yet. */
export function transientsFor(fileId: FileId): number[] {
  return getCached(fileId)?.transients ?? meta.get(fileId)?.transients ?? [];
}
