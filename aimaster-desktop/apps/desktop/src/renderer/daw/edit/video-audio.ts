// The picture's own sound, on the timeline where the rest of the mix is.
//
// The video element is muted and always will be — a `<video>` that made
// noise would be a second clock and a second signal path, with none of the
// trimming, metering, inserts or bounce that everything else gets.  The
// design has always said "import it as a normal audio track"; what was
// missing was anything that did.
//
// The obvious implementation is to demux the audio to a WAV beside the film
// and import that.  This does not do it, and the reason is worth stating: a
// ninety-minute stereo reel is about a gigabyte and a half of WAV, written
// once, then forgotten about, then stale the first time somebody hands over
// a new cut.  The decode path this app already has takes ANY file and pulls
// its first audio stream — `-map 0:a:0` — so the audio track's file
// reference points AT THE FILM.  No second copy, nothing to go stale,
// nothing to clean up.
//
// The link between the two is that shared path, and it is not decoration:
// the picture can be moved now (see `edit/video-move.ts`), and audio that
// silently stayed behind would be worse than no import at all.  So the
// picture's audio is recognisable, and re-alignable, by the fact that it
// plays the same file the picture does.

import {
  addFile, addTrack, createClip, createTrack, findFile, trackClips, updateClips,
} from '../model/session-ops.js';
import { videoOf } from '../model/video.js';
import { decodeForDisplay, getMeta } from '../engine/audio-cache.js';
import type { DecodeProgress } from '../engine/audio-cache.js';
import { nextId } from '../model/ids.js';
import type { AudioFileRef, DawSession, Track, TrackId } from '../model/types.js';

/** Tracks that play the film's own audio stream. */
export function videoAudioTracks(session: DawSession): Track[] {
  const video = videoOf(session);
  if (!video) return [];
  return session.tracks.filter((track) => trackClips(track).some((clip) => {
    const file = findFile(session, clip.fileId);
    return file?.path === video.path;
  }));
}

export function hasVideoAudio(session: DawSession): boolean {
  return videoAudioTracks(session).length > 0;
}

export interface ImportVideoAudioResult {
  session: DawSession;
  trackId: TrackId | null;
  /** Why nothing was imported, when nothing was. */
  reason: string | null;
}

export interface ImportVideoAudioOptions {
  onProgress?: DecodeProgress;
  /** Import a second copy even though one is already here. */
  force?: boolean;
  /**
   * The decode step, injected.
   *
   * The real one reaches the main process through the audio cache, which a
   * test has no way to stand up.  Injecting it is what lets the PLACEMENT —
   * the part with the arithmetic in it — be tested without a codec.
   */
  decode?: (refs: AudioFileRef[]) => Promise<{ failed: string[] }>;
  meta?: (id: string) => { durationSec: number; sampleRate: number; channels: number } | undefined;
}

/**
 * Put the film's audio on a track, lined up with the picture.
 *
 * Lined up means BOTH numbers: the clip starts where the picture starts, and
 * it starts as far into the file as the picture does.  Importing at zero and
 * leaving the user to nudge it is how a scoring session begins with the
 * dialogue a bar out.
 */
export async function importVideoAudio(
  session: DawSession, options: ImportVideoAudioOptions = {},
): Promise<ImportVideoAudioResult> {
  const video = videoOf(session);
  if (!video) return { session, trackId: null, reason: '픽처가 없습니다' };
  if (!options.force && hasVideoAudio(session)) {
    return { session, trackId: null, reason: '영상 오디오는 이미 가져와 있습니다' };
  }

  const ref: AudioFileRef = {
    id: nextId('file'),
    path: video.path,
    name: `${video.name} (오디오)`,
    durationSec: 0,
    sampleRate: session.sampleRate,
    channels: 2,
  };

  const runDecode = options.decode
    ?? ((refs: AudioFileRef[]) => decodeForDisplay(
      refs, options.onProgress === undefined ? undefined : options.onProgress));
  const { failed } = await runDecode([ref]);
  if (failed.includes(ref.path)) {
    return {
      session, trackId: null,
      reason: '영상에서 소리를 꺼내지 못했습니다 — 오디오 트랙이 없거나 코덱을 읽을 수 없습니다',
    };
  }

  const info = (options.meta ?? getMeta)(ref.id);
  const durationSec = info?.durationSec ?? 0;
  if (!(durationSec > 0)) {
    return { session, trackId: null, reason: '영상의 오디오 길이가 0 입니다' };
  }

  const resolved: AudioFileRef = info
    ? { ...ref, durationSec, sampleRate: info.sampleRate, channels: info.channels }
    : ref;

  let out = addFile(session, resolved);
  const track = createTrack(`${video.name} 오디오`, 'audio');
  out = addTrack(out, track);
  out = updateClips(out, track.id, () => [clipForPicture(resolved, session)]);
  return { session: out, trackId: track.id, reason: null };
}

/** One clip, positioned and trimmed exactly like the picture. */
function clipForPicture(file: AudioFileRef, session: DawSession) {
  const video = videoOf(session);
  const startSec = video?.startSec ?? 0;
  const offsetSec = Math.min(video?.offsetSec ?? 0, Math.max(0, file.durationSec - 0.001));
  return createClip(file.id, file.name, {
    startSec,
    offsetSec,
    durationSec: Math.max(0.001, file.durationSec - offsetSec),
  });
}

// ── Keeping it with the picture ───────────────────────────────────────────────

export interface AlignResult {
  session: DawSession;
  /** How many clips were out of place and are not any more. */
  moved: number;
  reason: string | null;
}

/**
 * Put the film's audio back under the film.
 *
 * Offered rather than automatic.  The audio is a normal clip once it is on
 * the timeline — it can be split, trimmed and moved deliberately — so a
 * picture move that silently dragged it would undo somebody's edit.  What
 * this does instead is make the fix one button, and `videoAudioOffsetSec`
 * makes the problem visible before it is heard.
 */
export function alignVideoAudio(session: DawSession): AlignResult {
  const video = videoOf(session);
  if (!video) return { session, moved: 0, reason: '픽처가 없습니다' };
  const tracks = videoAudioTracks(session);
  if (tracks.length === 0) {
    return { session, moved: 0, reason: '영상 오디오 트랙이 없습니다' };
  }

  let out = session;
  let moved = 0;
  for (const track of tracks) {
    const clips = trackClips(track);
    if (clips.length !== 1) {
      // Split into several pieces: this is an edit, and putting it back
      // together is not something a "re-align" button should decide.
      return {
        session, moved: 0,
        reason: `${track.name} — 여러 클립으로 나뉘어 있어 자동으로 맞추지 않았습니다`,
      };
    }
    const clip = clips[0]!;
    const file = findFile(session, clip.fileId);
    if (!file) continue;
    const offsetSec = Math.min(video.offsetSec, Math.max(0, file.durationSec - 0.001));
    if (Math.abs(clip.startSec - video.startSec) < 1e-9
      && Math.abs(clip.offsetSec - offsetSec) < 1e-9) continue;
    out = updateClips(out, track.id, (list) => list.map((c) => (c.id === clip.id
      ? {
        ...c,
        startSec: video.startSec,
        offsetSec,
        durationSec: Math.max(0.001, file.durationSec - offsetSec),
      }
      : c)));
    moved++;
  }
  return { session: out, moved, reason: null };
}

/**
 * How far the film's audio has drifted from the picture, in seconds.
 *
 * Null when there is nothing to compare.  Zero is the answer that lets a
 * button hide itself; anything else is worth showing before somebody hears
 * it as a sync error and blames the file.
 */
export function videoAudioOffsetSec(session: DawSession): number | null {
  const video = videoOf(session);
  if (!video) return null;
  let worst: number | null = null;
  for (const track of videoAudioTracks(session)) {
    for (const clip of trackClips(track)) {
      const drift = (clip.startSec - clip.offsetSec) - (video.startSec - video.offsetSec);
      if (worst === null || Math.abs(drift) > Math.abs(worst)) worst = drift;
    }
  }
  return worst;
}

export function describeVideoAudio(session: DawSession): string {
  const tracks = videoAudioTracks(session);
  if (tracks.length === 0) return '영상 오디오 없음';
  const drift = videoAudioOffsetSec(session) ?? 0;
  if (Math.abs(drift) < 1e-6) return `${tracks[0]!.name} · 픽처와 맞음`;
  const ms = Math.round(drift * 1000);
  return `${tracks[0]!.name} · 픽처보다 ${ms > 0 ? `${ms} ms 늦음` : `${-ms} ms 빠름`}`;
}
