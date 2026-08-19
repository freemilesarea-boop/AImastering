// Spectral repair as a session edit.
//
// The pure DSP lives in daw/audio/spectral-edit.ts; this is the part that
// makes it an EDIT: render the fixed audio to the scratch dir, register it as
// a new source file, and repoint the clip at it.  The original file is left
// alone, so undo is a pointer move and the take you imported is never
// overwritten.

import {
  applySpectralEditChannels, describeSpectralEdit,
  type SpectralEditOptions, type SpectralOp, type SpectralRegion,
} from '../audio/spectral-edit.js';
import { analyzeBuffer, getCached } from '../engine/audio-cache.js';
import { writeTempChannels } from '../engine/offline-render.js';
import { nextId } from '../model/ids.js';
import { addFile, findTrack, trackClips, updateClip } from '../model/session-ops.js';
import type { AudioFileRef, ClipId, DawSession, TrackId } from '../model/types.js';

export interface SpectralRepairResult {
  session: DawSession;
  file: AudioFileRef;
  description: string;
}

/**
 * Apply one spectral edit to a clip's source audio.
 *
 * `region` is in FILE time (the spectrogram's own axis), not timeline time —
 * the view that draws the spectrogram already knows the offset.
 */
export async function repairClipSpectrum(
  session: DawSession, trackId: TrackId, clipId: ClipId,
  region: SpectralRegion, op: SpectralOp, options: SpectralEditOptions = {},
): Promise<SpectralRepairResult> {
  const track = findTrack(session, trackId);
  if (!track) throw new Error('트랙을 찾을 수 없습니다');
  const clip = trackClips(track).find((c) => c.id === clipId);
  if (!clip) throw new Error('클립을 찾을 수 없습니다');
  if (clip.kind !== 'audio') throw new Error('오디오 클립에만 적용할 수 있습니다');

  const cached = getCached(clip.fileId);
  if (!cached) throw new Error('오디오가 아직 디코딩되지 않았습니다');
  const source = cached.buffer;

  const channels: Float32Array[] = [];
  for (let c = 0; c < source.numberOfChannels; c++) channels.push(source.getChannelData(c).slice());
  const edited = applySpectralEditChannels(channels, source.sampleRate, region, op, options);

  const sourceFile = session.files.find((f) => f.id === clip.fileId);
  const baseName = sourceFile?.name ?? clip.name;
  const path = await writeTempChannels(edited, source.sampleRate, `${baseName}-spectral`);

  const file: AudioFileRef = {
    id: nextId('file'),
    path,
    name: `${baseName} (repaired)`,
    durationSec: source.duration,
    sampleRate: source.sampleRate,
    channels: source.numberOfChannels,
  };

  // Seed the cache from the samples we already have, so the waveform and the
  // spectrogram redraw without a decode round trip.
  const ctor = (globalThis as unknown as {
    AudioBuffer?: new (o: { length: number; sampleRate: number; numberOfChannels: number }) => AudioBuffer;
  }).AudioBuffer;
  if (ctor) {
    const buffer = new ctor({
      length: source.length, sampleRate: source.sampleRate, numberOfChannels: edited.length,
    });
    for (let c = 0; c < edited.length; c++) buffer.getChannelData(c).set(edited[c] ?? new Float32Array(0));
    analyzeBuffer(file.id, buffer);
  }

  const next = updateClip(addFile(session, file), trackId, clipId, (c) => ({ ...c, fileId: file.id }));
  return { session: next, file, description: describeSpectralEdit(region, op) };
}
