// Bring audio files into a session.
//
// One file → one track → one clip at the play head, which is what dropping
// files into a DAW does.  Duration comes from the decoded buffer, so a clip
// is never longer than its source.

import { addFile, addTrack, createClip, createTrack, updateClips } from './session-ops.js';
import { decodeForDisplay, getMeta, type DecodeProgress } from '../engine/audio-cache.js';
import { nextId } from './ids.js';
import type { AudioFileRef, DawSession, TrackId } from './types.js';

export interface ImportAudioResult {
  session: DawSession;
  trackIds: TrackId[];
  failed: string[];
}

/**
 * Should the DAW adopt the files the user loaded on the home screen?
 *
 * Only when it has nothing of its own.  The DAW used to always open on an
 * empty session and ignore the home screen entirely, so "load five songs,
 * open the DAW" showed a blank timeline and there was no way to start a
 * project from the music you had just imported.
 *
 * Adopting is safe precisely because the session is empty — there is nothing
 * to overwrite.  Once it has any material, the user is in charge and files
 * only arrive when they ask for them.
 */
export function shouldAdoptQueue(session: DawSession, queueLength: number): boolean {
  if (queueLength <= 0) return false;
  return !session.tracks.some((t) => t.kind === 'audio' || t.kind === 'instrument');
}

function baseName(p: string): string {
  return p.split('/').pop()?.split('\\').pop()?.replace(/\.[^.]+$/, '') ?? p;
}

/**
 * Add each path as a new audio track with one clip starting at `atSec`.
 * Files that fail to decode are reported instead of creating an empty track.
 */
export async function importAudioFiles(
  session: DawSession, paths: readonly string[], atSec = 0,
  onProgress?: DecodeProgress,
): Promise<ImportAudioResult> {
  const refs: AudioFileRef[] = paths.map((p) => ({
    id: nextId('file'),
    path: p,
    name: baseName(p),
    durationSec: 0,
    sampleRate: session.sampleRate,
    channels: 2,
  }));

  const { failed } = await decodeForDisplay(refs, onProgress);
  const failedSet = new Set(failed);

  let out = session;
  const trackIds: TrackId[] = [];

  for (const ref of refs) {
    if (failedSet.has(ref.path)) continue;
    // Read the duration off the metadata, not the buffer: with an album's
    // worth of files the earliest buffers are already evicted by the time the
    // last one lands, and a clip built from a missing buffer would be 0 s long.
    const info = getMeta(ref.id);
    const resolved: AudioFileRef = info
      ? {
          ...ref,
          durationSec: info.durationSec,
          sampleRate: info.sampleRate,
          channels: info.channels,
        }
      : ref;

    out = addFile(out, resolved);
    const track = createTrack(resolved.name, 'audio');
    out = addTrack(out, track);
    out = updateClips(out, track.id, () => [createClip(resolved.id, resolved.name, {
      startSec: Math.max(0, atSec),
      offsetSec: 0,
      durationSec: resolved.durationSec,
    })]);
    trackIds.push(track.id);
  }

  return { session: out, trackIds, failed };
}
