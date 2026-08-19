// Bring audio files into a session.
//
// One file → one track → one clip at the play head, which is what dropping
// files into a DAW does.  Duration comes from the decoded buffer, so a clip
// is never longer than its source.

import { addFile, addTrack, createClip, createTrack, updateClips } from './session-ops.js';
import { decodeForDisplay, getCached } from '../engine/audio-cache.js';
import { nextId } from './ids.js';
import type { AudioFileRef, DawSession, TrackId } from './types.js';

export interface ImportAudioResult {
  session: DawSession;
  trackIds: TrackId[];
  failed: string[];
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
): Promise<ImportAudioResult> {
  const refs: AudioFileRef[] = paths.map((p) => ({
    id: nextId('file'),
    path: p,
    name: baseName(p),
    durationSec: 0,
    sampleRate: session.sampleRate,
    channels: 2,
  }));

  const { failed } = await decodeForDisplay(refs);
  const failedSet = new Set(failed);

  let out = session;
  const trackIds: TrackId[] = [];

  for (const ref of refs) {
    if (failedSet.has(ref.path)) continue;
    const cached = getCached(ref.id);
    const resolved: AudioFileRef = cached
      ? {
          ...ref,
          durationSec: cached.buffer.duration,
          sampleRate: cached.buffer.sampleRate,
          channels: cached.buffer.numberOfChannels,
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
