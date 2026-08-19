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
import type { AudioFileRef, Clip, ClipId, DawSession, TrackId } from '../model/types.js';

export interface SpectralRepairResult {
  session: DawSession;
  file: AudioFileRef;
  description: string;
}

/** The clip and its decoded channels, or a clear reason why not. */
export function clipAudio(
  session: DawSession, trackId: TrackId, clipId: ClipId,
): { clip: Clip; channels: Float32Array[]; sampleRate: number; buffer: AudioBuffer } {
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
  return { clip, channels, sampleRate: source.sampleRate, buffer: source };
}

/**
 * Write edited samples as a NEW source file and point the clip at it.
 *
 * Every destructive audio edit in the DAW goes through here: the original file
 * is never touched, so undo is a pointer move and the take you imported
 * survives whatever you did to it.
 */
export async function writeEditedClip(
  session: DawSession, trackId: TrackId, clipId: ClipId,
  edited: Float32Array[], sampleRate: number, suffix: string, label: string,
): Promise<{ session: DawSession; file: AudioFileRef }> {
  const track = findTrack(session, trackId);
  const clip = track ? trackClips(track).find((c) => c.id === clipId) : undefined;
  if (!clip) throw new Error('클립을 찾을 수 없습니다');

  const sourceFile = session.files.find((f) => f.id === clip.fileId);
  const baseName = sourceFile?.name ?? clip.name;
  const length = edited[0]?.length ?? 0;
  const path = await writeTempChannels(edited, sampleRate, `${baseName}-${suffix}`);

  const file: AudioFileRef = {
    id: nextId('file'),
    path,
    name: `${baseName} (${label})`,
    durationSec: length / sampleRate,
    sampleRate,
    channels: edited.length,
  };

  // Seed the cache from the samples we already have, so the waveform and the
  // spectrogram redraw without a decode round trip.
  const ctor = (globalThis as unknown as {
    AudioBuffer?: new (o: { length: number; sampleRate: number; numberOfChannels: number }) => AudioBuffer;
  }).AudioBuffer;
  if (ctor && length > 0) {
    const buffer = new ctor({ length, sampleRate, numberOfChannels: edited.length });
    for (let c = 0; c < edited.length; c++) buffer.getChannelData(c).set(edited[c] ?? new Float32Array(0));
    analyzeBuffer(file.id, buffer);
  }

  return {
    session: updateClip(addFile(session, file), trackId, clipId, (c) => ({ ...c, fileId: file.id })),
    file,
  };
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
  const { channels, sampleRate } = clipAudio(session, trackId, clipId);
  const edited = applySpectralEditChannels(channels, sampleRate, region, op, options);
  const written = await writeEditedClip(
    session, trackId, clipId, edited, sampleRate, 'spectral', 'repaired');
  return { ...written, description: describeSpectralEdit(region, op) };
}
