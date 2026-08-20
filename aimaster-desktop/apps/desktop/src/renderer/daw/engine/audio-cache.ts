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
//   1. Decoding is BOUNDED.  A few files are in flight at a time, never the
//      whole session at once, so peak memory is a handful of buffers above
//      what the cache already holds — not the sum of every file it references.
//   2. The cache is bounded in BYTES, not in entries.  Twelve five-minute
//      songs and twelve eight-bar loops are the same count and a hundredfold
//      difference in memory; only bytes describe the real limit.
//
// What survives eviction is the part the UI needs.  The peak envelope and the
// onset marks are a few kilobytes per file, so they are kept forever: waveforms
// still draw and Tab to Transient still works after the buffer is gone, and
// the buffer itself is re-decoded on demand when playback needs it back.

import { decodeContext, DECODE_SAMPLE_RATE } from '../../audio/decode-context.js';
import { canUseStore, ensureSource, ensureSources, getSource } from './pcm-store.js';
import { fromFileUrl, toFileUrl } from '../../utils/fileUrl.js';
import { detectTransients } from '../edit/transient.js';
import type { FileId } from '../model/types.js';

export interface CachedAudio {
  fileId: FileId;
  buffer: AudioBuffer;
  /** Mono peak envelope for waveform drawing (normalised 0..1). */
  peaks: Float32Array;
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
}

const PEAK_BUCKETS = 4096;
const CACHE_CAP = 12;
/** ~6 five-minute stereo songs at 48 kHz.  Past this the renderer is at risk. */
export const MAX_CACHE_BYTES = 700 * 1024 * 1024;

const cache = new Map<FileId, CachedAudio>();
const meta = new Map<FileId, FileMeta>();
/** Onset marks, found the first time something asks — see `transientsFor`. */
const onsets = new Map<FileId, number[]>();
const pending = new Map<FileId, Promise<CachedAudio>>();
let residentBytes = 0;
let pinnedIds: ReadonlySet<FileId> = new Set();

/**
 * The files the open session references.  They are never evicted.
 *
 * An eight-stem session is ~740 MB of float32 — more than any sensible cache
 * budget — so a budget alone evicts the stems it just decoded.  The scheduler
 * then finds no buffer for those clips and skips them, and the take plays back
 * missing its vocal with nothing reported: the cache did exactly what it was
 * told, and the session lost half its audio.
 *
 * Material that is open is not cache.  It is the work.  Only files nothing
 * references any more compete for the budget.
 */
export function pinFiles(ids: Iterable<FileId>): void {
  pinnedIds = new Set(ids);
}

export function pinnedBytes(): number {
  let total = 0;
  for (const [id, entry] of cache) if (pinnedIds.has(id)) total += bufferBytes(entry.buffer);
  return total;
}

/** float32 per sample per channel — what the buffer actually costs. */
export function bufferBytes(buffer: AudioBuffer): number {
  return buffer.length * buffer.numberOfChannels * 4;
}

function trace(step: string, path: string): void {
  // eslint-disable-next-line no-console
  console.info(`[audio-cache] ${step} — ${path.split(/[\\/]/).pop() ?? path}`);
}

export function getCached(fileId: FileId): CachedAudio | undefined {
  const hit = cache.get(fileId);
  if (hit) { cache.delete(fileId); cache.set(fileId, hit); }   // LRU touch
  return hit;
}

/**
 * Duration, peaks and channel count for a file.
 *
 * Answered from the PCM store when the samples are not resident, which is the
 * normal case now: a streamed track never loads into memory at all, and its
 * waveform still has to draw.
 */
export function getMeta(fileId: FileId): FileMeta | undefined {
  const known = meta.get(fileId);
  if (known) return known;
  const source = getSource(fileId);
  if (!source) return undefined;
  return {
    fileId,
    durationSec: source.durationSec,
    sampleRate: source.sampleRate,
    channels: source.channels,
    peaks: source.peaks,
  };
}

export function cacheSize(): number { return cache.size; }
export function cacheBytes(): number { return residentBytes; }

export function clearAudioCache(): void {
  cache.clear(); meta.clear(); onsets.clear(); pending.clear(); residentBytes = 0;
  pinnedIds = new Set();
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

/**
 * Mono sum of a buffer — the input transient detection wants.
 *
 * Written as a straight typed-array walk on purpose.  This runs over every
 * sample of every stem on the way in — eleven million per four-minute song —
 * and it runs on the thread that draws, so the `?? 0` bounds guards this file
 * uses everywhere else cost real frames here.  A local alias and a plain index
 * are safe because the loop bound IS the array length.
 */
export function monoSum(buffer: AudioBuffer): Float32Array {
  const length = buffer.length;
  const channels = buffer.numberOfChannels;
  const first = buffer.getChannelData(0);

  // Mono: the channel data is already the answer, so copy it once and stop.
  if (channels === 1) return first.slice();

  const out = new Float32Array(length);
  out.set(first);
  for (let c = 1; c < channels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < length; i++) out[i] = out[i]! + data[i]!;
  }
  const scale = 1 / channels;
  for (let i = 0; i < length; i++) out[i] = out[i]! * scale;
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
  entries: ReadonlyArray<{ id: FileId; bytes: number; pinned?: boolean }>,
  keep: FileId, maxEntries: number, maxBytes: number,
): FileId[] {
  let count = entries.length;
  let bytes = entries.reduce((sum, e) => sum + e.bytes, 0);
  const drop: FileId[] = [];
  for (const entry of entries) {
    if (count <= maxEntries && bytes <= maxBytes) break;
    if (entry.id === keep) continue;
    // The open session's audio is not a cache entry to be reclaimed — dropping
    // it makes a clip fall silent with nothing to say why.
    if (entry.pinned) continue;
    drop.push(entry.id);
    count -= 1;
    bytes -= entry.bytes;
  }
  return drop;
}

/** Drop least-recently-used buffers until both budgets are satisfied. */
function evictDownTo(keep: FileId): void {
  const order = [...cache].map(([id, entry]) => ({
    id, bytes: bufferBytes(entry.buffer), pinned: pinnedIds.has(id),
  }));
  for (const id of evictionPlan(order, keep, CACHE_CAP, MAX_CACHE_BYTES)) {
    const entry = cache.get(id);
    if (!entry) continue;
    cache.delete(id);
    residentBytes -= bufferBytes(entry.buffer);
  }
}

export function analyzeBuffer(fileId: FileId, buffer: AudioBuffer): CachedAudio {
  // Peaks only.  Onset detection has to mono-sum the whole file first, which
  // is ~0.7 s per four-minute stem ON THE THREAD THAT DRAWS — eight stems is
  // six seconds of frozen UI to compute marks that nothing has asked for.
  // `transientsFor` finds them the first time Tab to Transient or the warp
  // editor actually wants them.
  const peaks = computePeaks(buffer);
  const entry: CachedAudio = { fileId, buffer, peaks };
  onsets.delete(fileId);

  meta.set(fileId, {
    fileId,
    durationSec: buffer.duration,
    sampleRate: buffer.sampleRate,
    channels: buffer.numberOfChannels,
    peaks,
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
 * Turn a file into samples.
 *
 * FFmpeg in the main process does the decoding and hands back raw interleaved
 * float32; here that is copied into an AudioBuffer.  `createBuffer` +
 * `copyToChannel` is memory copying — it cannot fault, and it cannot take the
 * renderer process with it.
 *
 * `decodeAudioData` can.  It is native Chromium code, and on macOS it kills
 * the renderer outright (SIGSEGV) on real songs — no exception, no stack, just
 * a window painted in its own background colour because the process that would
 * have reported the error is gone.  It stays only as the fallback for
 * environments with no main process at all: the Node self-tests, and a browser
 * build if one is ever made.
 */
export async function decodeAudioFile(
  ctx: BaseAudioContext, pathOrUrl: string, fileId?: FileId,
): Promise<AudioBuffer> {
  const path = fromFileUrl(pathOrUrl);
  if (canUseStore()) {
    // The store already holds this file as float32; reading it whole is a
    // file read, not a decode.  Only the callers that genuinely need every
    // sample at once — offline render, spectral repair, warping — come here.
    const source = await ensureSource(fileId ?? path, path, ctx.sampleRate);
    const resp = await fetch(source.url);
    if (!resp.ok) throw new Error(`디코딩 결과를 읽지 못했습니다 (${resp.status})`);
    const pcm = new Uint8Array(await resp.arrayBuffer());
    return pcmToBuffer(ctx, {
      sampleRate: source.sampleRate,
      channels: source.channels,
      frames: source.frames,
      pcm,
    });
  }
  const resp = await fetch(toFileUrl(path));
  if (!resp.ok) throw new Error(`오디오 로드 실패 (${resp.status}): ${path}`);
  return ctx.decodeAudioData(await resp.arrayBuffer());
}

interface DecodedPcm {
  sampleRate: number;
  channels: number;
  frames: number;
  /** Interleaved float32 — `frames * channels` samples. */
  pcm: Uint8Array;
}

/**
 * De-interleave main's float32 into an AudioBuffer, one channel at a time.
 *
 * Mono skips the de-interleave entirely, and the stereo loop reads both
 * channels in one pass so the 92 MB of samples is walked once rather than
 * twice.  Same reasoning as `monoSum`: this is per-sample work on the thread
 * that draws the timeline.
 */
export function pcmToBuffer(ctx: BaseAudioContext, decoded: DecodedPcm): AudioBuffer {
  const { sampleRate, channels, frames, pcm } = decoded;
  if (!(frames > 0) || !(channels > 0)) throw new Error('디코딩 결과가 비어 있습니다');

  const bytes = pcm instanceof Uint8Array ? pcm : new Uint8Array(pcm as ArrayBufferLike);
  const store = bytes.buffer as ArrayBuffer;
  const interleaved = new Float32Array(store, bytes.byteOffset, frames * channels);
  const buffer = ctx.createBuffer(channels, frames, sampleRate);

  if (channels === 1) {
    buffer.copyToChannel(interleaved.subarray(0, frames), 0);
    return buffer;
  }

  if (channels === 2) {
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    for (let i = 0, j = 0; i < frames; i++, j += 2) {
      left[i] = interleaved[j]!;
      right[i] = interleaved[j + 1]!;
    }
    buffer.copyToChannel(left, 0);
    buffer.copyToChannel(right, 1);
    return buffer;
  }

  const scratch = new Float32Array(frames);
  for (let c = 0; c < channels; c++) {
    for (let i = 0; i < frames; i++) scratch[i] = interleaved[i * channels + c]!;
    buffer.copyToChannel(scratch, c);
  }
  return buffer;
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
    trace('decode', path);
    const buffer = await decodeAudioFile(ctx, path, fileId);
    trace(`analyze ${buffer.duration.toFixed(1)}s`, path);
    const entry = analyzeBuffer(fileId, buffer);
    trace('done', path);
    return entry;
  })();

  pending.set(fileId, task);
  try {
    return await task;
  } finally {
    pending.delete(fileId);
  }
}

// ── Decode context ────────────────────────────────────────────────────────────
// Re-exported so DAW code keeps importing it from here.  It is the app-wide
// live AudioContext — see audio/decode-context.ts for why decoding a song
// through a one-frame OfflineAudioContext kills the renderer outright.
export { decodeContext };

export type DecodeProgress = (done: number, total: number) => void;

/**
 * How many files decode at once.
 *
 * Decoding happens in the main process now — one FFmpeg child per file — so
 * the renderer is not the thing under load and strictly sequential decoding
 * just leaves the machine idle between files.  An eight-stem session took as
 * long to open as the sum of its stems.
 *
 * Three, not eight: each in-flight decode holds a full song's PCM in main and
 * again in the renderer while it is copied, so the ceiling is about peak
 * memory, not about how many cores are free.
 */
export const DECODE_CONCURRENCY = 3;

/** Run `task` over `items`, at most `limit` at a time, in order of completion. */
async function mapLimit<T>(
  items: readonly T[], limit: number, task: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      const item = items[index];
      if (item === undefined) return;
      await task(item);
    }
  });
  await Promise.all(workers);
}

/**
 * Decode a set of files for display.  Failures are reported, never thrown.
 *
 * A file whose peaks are already known is skipped even if its buffer has been
 * evicted — display does not need the samples back.
 */
export async function decodeForDisplay(
  files: ReadonlyArray<{ id: FileId; path: string }>,
  onProgress?: DecodeProgress,
): Promise<{ decoded: number; failed: string[] }> {
  // Drawing a timeline needs a peak envelope and a duration, not samples.
  // Main computes both while decoding into the store, so preparing a track
  // for display costs a 32 KB sidecar instead of 92 MB of resident PCM —
  // which is the whole reason a sixteen-track session can be opened at all.
  if (canUseStore()) {
    const { ready, failed } = await ensureSources(files, DECODE_SAMPLE_RATE, onProgress);
    return { decoded: ready, failed };
  }

  const ctx = decodeContext();
  if (!ctx) return { decoded: 0, failed: files.map((f) => f.path) };
  const failed: string[] = [];
  let decoded = 0;
  let seen = 0;

  await mapLimit(files, DECODE_CONCURRENCY, async (f) => {
    if (getCached(f.id) || meta.has(f.id)) {
      decoded += 1;
    } else {
      try { await loadAudio(ctx, f.id, f.path); decoded += 1; }
      catch { failed.push(f.path); }
    }
    seen += 1;
    onProgress?.(seen, files.length);
  });

  return { decoded, failed };
}

/**
 * Decode every file a playback or offline pass needs, one at a time.  A file
 * that will not decode is silence in the render, not a thrown render.
 */
export async function preloadAll(
  ctx: BaseAudioContext, files: ReadonlyArray<{ id: FileId; path: string }>,
): Promise<void> {
  await mapLimit(files, DECODE_CONCURRENCY, async (f) => {
    if (getCached(f.id)) return;
    try { await loadAudio(ctx, f.id, f.path); } catch { /* missing file → silence */ }
  });
}

/**
 * Transient marks for a file, or an empty list when it is not decoded yet.
 *
 * Found on first use and remembered from then on, including after the buffer
 * itself is evicted — the marks are a few hundred numbers.
 */
export function transientsFor(fileId: FileId): number[] {
  const known = onsets.get(fileId);
  if (known) return known;
  const cached = getCached(fileId);
  if (!cached) return [];
  const found = detectTransients(monoSum(cached.buffer), cached.buffer.sampleRate);
  onsets.set(fileId, found);
  return found;
}
