// Reverse — the one clip operation that has to make new audio.
//
// Rename is metadata and normalize is a gain, so both are pure functions over
// the session (see clip-dsp.ts).  Reversing is not: the samples have to come
// out backwards, which means decoding, processing and writing a file.
//
// It follows the path the pitch editor already established, and for the same
// reasons: THE ORIGINAL FILE IS NEVER TOUCHED.  A reverse produces a new file
// in the session scratch directory and re-points the clip at it, so undo
// restores the take exactly and the source on disk is still the source.
//
// Only the CLIP'S OWN SPAN is rendered, not the whole file.  Reversing a
// four-second clip inside a four-minute take should cost four seconds of work
// and four seconds of disk, and — more importantly — reversing the whole file
// and pointing into it would put the wrong four seconds under the clip.

import { getCached, loadAudio, decodeContext, analyzeBuffer } from '../engine/audio-cache.js';
import { writeTempChannels } from '../engine/offline-render.js';
import { addFile } from '../model/session-ops.js';
import { nextId } from '../model/ids.js';
import { findClipIn, replaceClip, reverseChannels, reversedClip, spanOf } from './clip-dsp.js';
import type { AudioBufferLike } from '../../audio/loudnessCore.js';
import type { ClipId, DawSession, TrackId } from '../model/types.js';

/**
 * The clip's decoded audio, decoding on demand.
 *
 * Returns null rather than throwing when there is no decoder — outside
 * Electron (a test, Storybook) there is nothing to decode with, and the caller
 * already has to handle "cannot read this file".
 */
async function clipBuffer(
  session: DawSession, fileId: string,
): Promise<AudioBufferLike | null> {
  const cached = getCached(fileId);
  if (cached) return cached.buffer;
  const file = session.files.find((f) => f.id === fileId);
  const ctx = decodeContext();
  if (!file || !ctx) return null;
  const loaded = await loadAudio(ctx, file.id, file.path);
  return loaded.buffer;
}

export interface ReverseResult {
  session: DawSession;
  /** Why nothing happened, when nothing did. */
  error?: string;
}

/**
 * Reverse one clip.
 *
 * The new file is exactly the clip's span, so the replacement clip points at
 * offset 0 — and its fades swap ends, because a fade-in at the head of a
 * passage is a fade-out at its tail once the passage runs backwards.
 */
export async function reverseClip(
  session: DawSession, trackId: TrackId, clipId: ClipId,
): Promise<ReverseResult> {
  const clip = findClipIn(session, trackId, clipId);
  if (!clip) return { session, error: '클립을 찾지 못했습니다' };
  if (clip.kind !== 'audio') return { session, error: '오디오 클립만 뒤집을 수 있습니다' };

  const buffer = await clipBuffer(session, clip.fileId);
  if (!buffer) return { session, error: '오디오를 디코딩할 수 없습니다' };

  const span = spanOf(buffer, clip.offsetSec, clip.durationSec);
  const length = span.getChannelData(0).length;
  if (length === 0) return { session, error: '클립에 샘플이 없습니다' };

  const channels: Float32Array[] = [];
  for (let c = 0; c < span.numberOfChannels; c++) channels.push(span.getChannelData(c));
  const reversed = reverseChannels(channels);

  const path = await writeTempChannels(reversed, span.sampleRate, `${clip.name}-reverse`);
  const ref = {
    id: nextId('file'),
    path,
    name: `${clip.name} (reverse)`,
    durationSec: length / span.sampleRate,
    sampleRate: span.sampleRate,
    channels: reversed.length,
  };

  // Seed the cache so the waveform redraws immediately rather than after a
  // round trip through the decoder — the same trick the pitch render uses.
  const ctx = decodeContext();
  if (ctx) {
    const decoded = ctx.createBuffer(reversed.length, length, span.sampleRate);
    for (let c = 0; c < reversed.length; c++) decoded.getChannelData(c).set(reversed[c]!);
    analyzeBuffer(ref.id, decoded);
  }

  const withRef = addFile(session, ref);
  return { session: replaceClip(withRef, trackId, clipId, reversedClip(clip, ref.id)) };
}
