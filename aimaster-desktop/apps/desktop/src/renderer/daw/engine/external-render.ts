// Applying third-party plugins, at the only time this engine can.
//
// The realtime graph is Web Audio; it cannot call out to native code, so an
// external plugin is an OFFLINE device — bypassed while you monitor, applied
// when the track is frozen, committed or bounced.  That is the same deal every
// DAW offers for a device too heavy to run live, and it is the deal the engine
// already had a shape for.
//
// What happens here: the rendered track goes to main as interleaved float32,
// main hands it to an isolated host process, and what comes back is read
// through the same file protocol the PCM store uses.  One crossing, in the
// direction that is cheap, at a moment when nobody is listening in real time.

import { pcmToBuffer } from './audio-cache.js';
import { decodeContext } from '../../audio/decode-context.js';
import { toFileUrl } from '../../utils/fileUrl.js';
import type { Insert, Track } from '../model/types.js';

export interface ExternalStageReport {
  pluginId: string;
  name: string;
  applied: boolean;
  reason?: string;
}

export interface ExternalRenderResult {
  buffer: AudioBuffer;
  stages: ExternalStageReport[];
  /** Set when the host failed outright and the audio came back untouched. */
  error: string | null;
}

interface Bridge {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
}

interface HostReply {
  ok: boolean;
  error?: string;
  stages: ExternalStageReport[];
  outputPath: string | null;
}

/** The external devices on a track, in slot order. */
export function externalInserts(track: Track): Insert[] {
  return [...track.inserts]
    .filter((insert) => insert.external !== undefined)
    .sort((a, b) => a.slot - b.slot);
}

export function hasExternalInserts(track: Track): boolean {
  return track.inserts.some((insert) => insert.external !== undefined);
}

/** Interleave an AudioBuffer for the host, which works in frames. */
export function interleave(buffer: AudioBuffer): Float32Array {
  const { numberOfChannels: channels, length: frames } = buffer;
  const out = new Float32Array(frames * channels);
  for (let c = 0; c < channels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < frames; i++) out[i * channels + c] = data[i]!;
  }
  return out;
}

/**
 * Run a rendered track through its external plugins.
 *
 * Returns the original audio unchanged when there is nothing to apply or when
 * the host could not run — a bounce that loses the take because a plugin would
 * not load is a worse outcome than a bounce that is missing one device and
 * says so.
 */
export async function applyExternalInserts(
  buffer: AudioBuffer, track: Track,
): Promise<ExternalRenderResult> {
  const inserts = externalInserts(track);
  if (inserts.length === 0) return { buffer, stages: [], error: null };

  const api = (globalThis as unknown as { electronAPI?: Bridge }).electronAPI;
  if (!api) {
    return {
      buffer,
      stages: inserts.map((i) => ({
        pluginId: i.pluginId, name: i.label, applied: false, reason: '데스크톱 앱에서만 동작합니다',
      })),
      error: null,
    };
  }

  const pcm = interleave(buffer);
  const chain = inserts.map((insert) => ({
    pluginId: insert.pluginId,
    format: insert.external!.format,
    path: insert.external!.path,
    uid: insert.external!.uid,
    name: insert.label || insert.external!.name,
    params: insert.params,
    bypass: insert.bypass,
  }));

  let reply: HostReply;
  try {
    reply = await api.invoke('daw:host-apply', {
      pcm: new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength),
      frames: buffer.length,
      channels: buffer.numberOfChannels,
      sampleRate: buffer.sampleRate,
      chain,
    }) as HostReply;
  } catch (err) {
    return { buffer, stages: [], error: (err as Error).message };
  }

  if (!reply.ok || !reply.outputPath) {
    return { buffer, stages: reply.stages ?? [], error: reply.error ?? '알 수 없는 오류' };
  }

  // Nothing was actually applied: skip the read and keep the buffer we have.
  if (!reply.stages.some((stage) => stage.applied)) {
    return { buffer, stages: reply.stages, error: null };
  }

  const ctx = decodeContext();
  if (!ctx) return { buffer, stages: reply.stages, error: '오디오 컨텍스트를 사용할 수 없습니다' };

  try {
    const response = await fetch(toFileUrl(reply.outputPath));
    if (!response.ok) throw new Error(`결과를 읽지 못했습니다 (${response.status})`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const processed = pcmToBuffer(ctx, {
      sampleRate: buffer.sampleRate,
      channels: buffer.numberOfChannels,
      frames: buffer.length,
      pcm: bytes,
    });
    return { buffer: processed, stages: reply.stages, error: null };
  } catch (err) {
    return { buffer, stages: reply.stages, error: (err as Error).message };
  }
}

/** One line describing what a host pass did, for the toast. */
export function describeExternalPass(result: ExternalRenderResult): string | null {
  if (result.error) return `외부 플러그인 적용 실패: ${result.error}`;
  if (result.stages.length === 0) return null;

  const applied = result.stages.filter((s) => s.applied);
  const skipped = result.stages.filter((s) => !s.applied);
  if (skipped.length === 0) return `외부 플러그인 ${applied.length}개 적용`;

  // Name the first thing that did not run and why: "2 skipped" sends someone
  // looking, and the answer is already here.
  const first = skipped[0]!;
  return applied.length > 0
    ? `외부 플러그인 ${applied.length}개 적용 · ${skipped.length}개 건너뜀 (${first.name}: ${first.reason})`
    : `외부 플러그인을 적용하지 못했습니다 — ${first.name}: ${first.reason}`;
}
