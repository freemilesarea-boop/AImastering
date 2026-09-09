// Loading a sample library, and holding it.
//
// The samples are decoded once and kept as AudioBuffers keyed by path, so a
// piano's 300 files are read from disk once rather than once per note.  There
// is exactly one loaded library at a time: a second one would need a second
// cache, a second eviction rule and a way to say which track uses which, and
// none of that is worth building before anyone has asked for two.

import { parseSfz } from './sfz.js';
import { buildSampleSet, describeSampleSet, type SampleSet, type SampleSetReport } from './sampler.js';

export interface SfzOpenReply { path: string; root: string; name: string; text: string }
interface SampleReadReply { path: string; bytes: Uint8Array }

export interface LoadedLibrary {
  set: SampleSet;
  report: SampleSetReport;
  /** Decoded audio, keyed by the path the zone resolved to. */
  buffers: Map<string, AudioBuffer>;
  /** Samples the library named that could not be read or decoded. */
  missing: string[];
}

let loaded: LoadedLibrary | null = null;

export function loadedLibrary(): LoadedLibrary | null { return loaded; }
export function clearLibrary(): void { loaded = null; }

/** The buffer for a zone, if the library actually had it. */
export function bufferFor(path: string): AudioBuffer | undefined {
  return loaded?.buffers.get(path);
}

export type LoadProgress = (done: number, total: number) => void;

/**
 * Open a .sfz through the dialog and decode everything it names.
 *
 * Returns null when the user cancels.  A sample that cannot be read does not
 * abort the load — half the free libraries reference a file they did not
 * ship — but every one is collected in `missing` so the panel can say so
 * rather than leaving silent keys for the user to discover.
 */
export async function openSampleLibrary(
  ctx: BaseAudioContext | null, onProgress?: LoadProgress,
): Promise<LoadedLibrary | null> {
  const opened = await pickSfz();
  if (!opened) return null;
  return loadLibraryFrom(ctx, opened, onProgress);
}

/** The dialog, alone.  Returns null when the user cancels. */
export async function pickSfz(): Promise<SfzOpenReply | null> {
  const api = window.electronAPI;
  if (!api?.invoke) throw new Error('파일 접근을 사용할 수 없습니다');
  return await api.invoke('daw:sfz-open') as SfzOpenReply | null;
}

/**
 * Everything after the dialog: parse, read, decode, report.
 *
 * Split from the picker so the load can be driven without a dialog — a test
 * harness needs that (a native dialog under a headless X server never
 * returns), and so will "reopen the library this session was saved with".
 */
export async function loadLibraryFrom(
  ctx: BaseAudioContext | null, opened: SfzOpenReply, onProgress?: LoadProgress,
): Promise<LoadedLibrary> {
  const api = window.electronAPI;
  if (!api?.invoke) throw new Error('파일 접근을 사용할 수 없습니다');

  // Decoding does not need the LIVE context, and must not wait for it.  The
  // DAW's AudioContext is created on the first user gesture that starts
  // playback, so a user whose first action is "load my piano" would be told
  // the engine is not ready — a message that is both true and useless, since
  // nothing they do in this editor creates it.  A throwaway context decodes
  // just as well, and AudioBuffers outlive the context that made them.
  const temp = ctx ?? decodingContext();
  const set = buildSampleSet(opened.name, opened.root, parseSfz(opened.text));
  const buffers = new Map<string, AudioBuffer>();
  const missing: string[] = [];

  // The same file appears in many zones — a round robin is three zones over
  // three files, but a velocity split can be two zones over one.  Decode the
  // distinct set.
  const wanted = [...new Set(set.zones.map((z) => z.resolvedPath))];
  let done = 0;
  for (const full of wanted) {
    // The handler re-derives the path from the root, so what it is given is
    // the part BELOW the root rather than the joined path it produced.
    const relative = full.startsWith(`${opened.root}/`)
      ? full.slice(opened.root.length + 1)
      : full;
    try {
      const reply = await api.invoke('daw:sample-read', { root: opened.root, path: relative }) as SampleReadReply;
      const bytes = reply.bytes instanceof Uint8Array ? reply.bytes : new Uint8Array(reply.bytes);
      // `decodeAudioData` detaches the buffer it is given, so it gets a copy —
      // otherwise a retry, or anything else holding these bytes, reads zeroes.
      const copy = bytes.slice().buffer as ArrayBuffer;
      buffers.set(full, await (temp as unknown as BaseAudioContext & {
        decodeAudioData: (b: ArrayBuffer) => Promise<AudioBuffer>;
      }).decodeAudioData(copy));
    } catch {
      missing.push(relative);
    }
    done += 1;
    onProgress?.(done, wanted.length);
  }

  loaded = { set, report: describeSampleSet(set), buffers, missing };
  return loaded;
}

/** The rate to decode at when the live context does not exist yet. */
export const DECODE_FALLBACK_RATE = 48000;

/**
 * A context that exists only to decode.
 *
 * It is OFFLINE, deliberately.  A real AudioContext would report the hardware
 * sample rate, which is the nicer answer — but constructing one opens the
 * output device, and on a machine with no working output that call **blocks
 * the renderer thread**.  Measured here: `new AudioContext()` under Xvfb with
 * no audio device wedged the whole window, and it stayed wedged.  A library
 * load must not be able to do that, and the cost of being wrong about the
 * rate is one resample of a sampler that resamples every off-root note
 * anyway.
 */
function decodingContext(): BaseAudioContext {
  return new OfflineAudioContext(1, 1, DECODE_FALLBACK_RATE);
}

/** A one-line summary of what got loaded, for the panel and the log. */
export function describeLoad(lib: LoadedLibrary): string {
  const r = lib.report;
  const range = `${r.lowestKey}–${r.highestKey}`;
  const parts = [
    `${lib.set.name}: ${r.zones}존`,
    `건반 ${range}`,
    `벨로시티 ${r.velocityLayers}겹`,
  ];
  if (r.roundRobin > 1) parts.push(`라운드로빈 ${r.roundRobin}`);
  if (r.releaseZones > 0) parts.push(`릴리스 ${r.releaseZones}`);
  if (r.gaps.length > 0) parts.push(`빈 건반 ${r.gaps.length}개`);
  if (lib.missing.length > 0) parts.push(`읽지 못한 파일 ${lib.missing.length}개`);
  return parts.join(' · ');
}
