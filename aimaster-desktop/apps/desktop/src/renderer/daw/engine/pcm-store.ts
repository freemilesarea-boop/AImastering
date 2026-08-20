// What the renderer knows about a source file, without holding its samples.
//
// Opening a session used to mean decoding every track into RAM: 23 MB per
// minute per stereo track, so a sixteen-track song is a gigabyte and a half
// before you have played a note.  That is the ceiling a DAW has to get past,
// and the way past it is to stop treating "I can see this track" and "these
// samples are in memory" as the same thing.
//
// Main decodes each source once into a float32 store on disk and hands back
// this: a URL, a few numbers, and the peak envelope.  32 KB per track instead
// of 92 MB.  The timeline draws from it, the transport streams from it, and
// nothing is resident that nobody is reading.

import { toFileUrl } from '../../utils/fileUrl.js';
import type { FileId } from '../model/types.js';

export interface PcmSource {
  fileId: FileId;
  /** Store key - the same source resolves to the same key across runs. */
  key: string;
  /** Where the samples are, ready for range reads. */
  url: string;
  sampleRate: number;
  channels: number;
  frames: number;
  durationSec: number;
  /** Peak envelope, 0..1, computed by main while decoding. */
  peaks: Float32Array;
}

interface PcmSourceReply {
  key: string;
  pcmPath: string;
  sampleRate: number;
  channels: number;
  frames: number;
  peaks: number[];
}

interface Bridge {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
}

const sources = new Map<FileId, PcmSource>();
const pending = new Map<FileId, Promise<PcmSource>>();

export function getSource(fileId: FileId): PcmSource | undefined {
  return sources.get(fileId);
}

export function sourceCount(): number { return sources.size; }

export function clearSources(): void { sources.clear(); pending.clear(); }

/** True where main can decode for us - false in the Node self-tests. */
export function canUseStore(): boolean {
  return (globalThis as unknown as { electronAPI?: Bridge }).electronAPI !== undefined;
}

/**
 * Make sure a file has been decoded into the store, and remember what came
 * back.  Concurrent callers for the same file share one decode.
 */
export async function ensureSource(
  fileId: FileId, path: string, sampleRate: number,
): Promise<PcmSource> {
  const known = sources.get(fileId);
  if (known) return known;
  const inFlight = pending.get(fileId);
  if (inFlight) return inFlight;

  const api = (globalThis as unknown as { electronAPI?: Bridge }).electronAPI;
  if (!api) throw new Error('PCM 스토어를 사용할 수 없습니다');

  const task = (async () => {
    const reply = await api.invoke('daw:pcm-source', { path, sampleRate }) as PcmSourceReply;
    const source: PcmSource = {
      fileId,
      key: reply.key,
      url: toFileUrl(reply.pcmPath),
      sampleRate: reply.sampleRate,
      channels: reply.channels,
      frames: reply.frames,
      durationSec: reply.frames / reply.sampleRate,
      peaks: Float32Array.from(reply.peaks),
    };
    sources.set(fileId, source);
    return source;
  })();

  pending.set(fileId, task);
  try { return await task; } finally { pending.delete(fileId); }
}

export type SourceProgress = (done: number, total: number) => void;

/**
 * How many sources to prepare at once.
 *
 * Each one is an FFmpeg child process in main, and nothing large crosses into
 * the renderer, so this is bounded by how much work the machine should be
 * doing at once rather than by memory.  On a warm store every one of these is
 * a file-stat and a 32 KB read.
 */
const PREPARE_CONCURRENCY = 4;

/** Prepare a set of files, reporting progress.  Failures are collected. */
export async function ensureSources(
  files: ReadonlyArray<{ id: FileId; path: string }>, sampleRate: number,
  onProgress?: SourceProgress,
): Promise<{ ready: number; failed: string[] }> {
  const failed: string[] = [];
  let ready = 0;
  let seen = 0;
  let next = 0;

  const workers = Array.from(
    { length: Math.min(PREPARE_CONCURRENCY, files.length) },
    async () => {
      for (;;) {
        const file = files[next++];
        if (file === undefined) return;
        try { await ensureSource(file.id, file.path, sampleRate); ready += 1; }
        catch { failed.push(file.path); }
        seen += 1;
        onProgress?.(seen, files.length);
      }
    },
  );
  await Promise.all(workers);
  return { ready, failed };
}
