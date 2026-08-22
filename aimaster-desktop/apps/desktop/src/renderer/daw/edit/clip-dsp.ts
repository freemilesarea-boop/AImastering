// Clip-level processing: rename, normalize, reverse.
//
// Three things that look like one feature and are three different kinds of
// operation, which is why they are worth separating carefully.
//
//   RENAME    is metadata.  Nothing about the audio changes.
//   NORMALIZE is a GAIN.  Nothing about the audio changes either — see below.
//   REVERSE   is the only one that has to make new samples.
//
// ── Why normalize does not render ────────────────────────────────────────────
//
// The obvious implementation writes a new file with the gain baked in.  Doing
// it as clip gain instead is better on every axis that matters: it is
// instant, it is one undo step, it costs no disk, it can be nudged afterwards
// without re-rendering, and — the real point — it is REVERSIBLE.  A baked
// normalize on a quiet take followed by a baked normalize on the result is
// two generations of processing; setting a number twice is setting a number.
//
// The clip gain range is finite (−60…+24 dB), so a take that needs more than
// that is told, rather than silently normalized to "as far as I could go".
//
// ── Why the target is TRUE peak ──────────────────────────────────────────────
//
// A sample peak of −0.1 dBFS can reconstruct to +0.5 dBTP in a converter or an
// encoder.  Normalizing to sample peak therefore produces files that measure
// clean and clip on playback.  The app already has a BS.1770-4 true-peak meter
// and it is used here rather than a max() over the samples.

import { getLoudnessMetrics, type AudioBufferLike } from '../../audio/loudnessCore.js';
import { findTrack, trackClips, updateClips } from '../model/session-ops.js';
import { clampClipGain, CLIP_GAIN_MAX_DB, CLIP_GAIN_MIN_DB, overlapsSelection, type TimeSelection } from './clip-edit.js';
import type { Clip, ClipId, DawSession, TrackId } from '../model/types.js';

// ── Rename ────────────────────────────────────────────────────────────────────

/** Longer than this is not a name, it is a paragraph in a narrow lane. */
export const MAX_CLIP_NAME = 48;

export function cleanClipName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, MAX_CLIP_NAME);
}

/**
 * Rename one clip.
 *
 * An empty name is REFUSED rather than accepted: a clip with no name draws as
 * a blank block, and "I cleared the box and now I cannot tell which take is
 * which" is a worse outcome than not being allowed to clear it.
 */
export function renameClip(
  session: DawSession, trackId: TrackId, clipId: ClipId, name: string,
): DawSession {
  const clean = cleanClipName(name);
  if (clean.length === 0) return session;
  return updateClips(session, trackId, (clips) =>
    clips.map((c) => (c.id === clipId ? { ...c, name: clean } : c)));
}

/** Rename every clip the selection touches — `Vox 1`, `Vox 2`, … */
export function renameSelection(
  session: DawSession, sel: TimeSelection, base: string,
): DawSession {
  const clean = cleanClipName(base);
  if (clean.length === 0) return session;
  let out = session;
  let n = 0;
  for (const trackId of sel.trackIds) {
    out = updateClips(out, trackId, (clips) => clips.map((c) => {
      if (!overlapsSelection(c, sel)) return c;
      n += 1;
      return { ...c, name: cleanClipName(`${clean} ${n}`) };
    }));
  }
  return out;
}

// ── Measuring one clip's span ─────────────────────────────────────────────────

export interface ClipMeasure {
  /** BS.1770-4 true peak, dBTP.  −Infinity for digital silence. */
  truePeakDbtp: number;
  integratedLufs: number;
  /** Nothing audible in this span. */
  silent: boolean;
}

/**
 * A window onto part of a decoded file, without copying it.
 *
 * `subarray` is a view, so measuring a four-second clip inside a four-minute
 * file costs nothing but the meter's own work.
 */
export function spanOf(
  buffer: AudioBufferLike, offsetSec: number, durationSec: number,
): AudioBufferLike {
  const rate = buffer.sampleRate;
  const total = buffer.getChannelData(0).length;
  const from = Math.max(0, Math.min(total, Math.round(offsetSec * rate)));
  const to = Math.max(from, Math.min(total, Math.round((offsetSec + durationSec) * rate)));
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    channels.push(buffer.getChannelData(c).subarray(from, to));
  }
  return {
    sampleRate: rate,
    numberOfChannels: buffer.numberOfChannels,
    length: to - from,
    getChannelData: (c: number) => channels[c] ?? channels[0] ?? new Float32Array(0),
  };
}

export function measureClip(buffer: AudioBufferLike, clip: Clip): ClipMeasure {
  const span = spanOf(buffer, clip.offsetSec, clip.durationSec);
  if (span.getChannelData(0).length === 0) {
    return { truePeakDbtp: -Infinity, integratedLufs: -Infinity, silent: true };
  }
  const metrics = getLoudnessMetrics(span);
  const silent = !Number.isFinite(metrics.truePeakDbtp) || metrics.truePeakDbtp < -90;
  return {
    truePeakDbtp: metrics.truePeakDbtp,
    integratedLufs: metrics.integratedLufs,
    silent,
  };
}

// ── Normalize ─────────────────────────────────────────────────────────────────

export type NormalizeMode = 'peak' | 'loudness';

export interface NormalizeTarget {
  mode: NormalizeMode;
  /** dBTP for `peak`, LUFS for `loudness`. */
  targetDb: number;
}

/** −1 dBTP leaves room for the reconstruction overshoot a converter adds. */
export const DEFAULT_NORMALIZE: NormalizeTarget = { mode: 'peak', targetDb: -1 };

export interface NormalizePlan {
  /** The gain to SET on the clip.  Absolute, not a delta. */
  gainDb: number;
  /** What the gain would have been without the clip-gain limit. */
  wantedDb: number;
  clamped: boolean;
  /** Why nothing can be done, when nothing can. */
  refused?: string;
}

/**
 * What gain puts this clip on target.
 *
 * Absolute rather than relative to whatever gain is already set, so
 * normalizing twice is the same as normalizing once — which is what "put it at
 * −1 dBTP" means, and what makes it safe to press again after an edit.
 */
export function normalizePlan(
  measure: ClipMeasure, target: NormalizeTarget = DEFAULT_NORMALIZE,
): NormalizePlan {
  if (measure.silent) {
    return { gainDb: 0, wantedDb: 0, clamped: false, refused: '이 클립에는 소리가 없습니다' };
  }
  const from = target.mode === 'peak' ? measure.truePeakDbtp : measure.integratedLufs;
  if (!Number.isFinite(from)) {
    return { gainDb: 0, wantedDb: 0, clamped: false, refused: '레벨을 재지 못했습니다' };
  }
  const wantedDb = target.targetDb - from;
  const gainDb = clampClipGain(wantedDb);
  return {
    gainDb,
    wantedDb,
    clamped: Math.abs(gainDb - wantedDb) > 1e-6,
  };
}

/** `+6.2 dB (트루 피크 −7.2 → −1.0 dBTP)` — the plan, before applying it. */
export function describeNormalize(
  measure: ClipMeasure, plan: NormalizePlan, target: NormalizeTarget = DEFAULT_NORMALIZE,
): string {
  if (plan.refused) return plan.refused;
  const unit = target.mode === 'peak' ? 'dBTP' : 'LUFS';
  const from = target.mode === 'peak' ? measure.truePeakDbtp : measure.integratedLufs;
  const sign = plan.gainDb >= 0 ? '+' : '';
  const base = `${sign}${plan.gainDb.toFixed(1)} dB (${from.toFixed(1)} → ${target.targetDb.toFixed(1)} ${unit})`;
  return plan.clamped
    ? `${base} — 클립 게인 한계(${CLIP_GAIN_MIN_DB}…+${CLIP_GAIN_MAX_DB} dB)에서 잘렸습니다`
    : base;
}

export function applyNormalize(
  session: DawSession, trackId: TrackId, clipId: ClipId, plan: NormalizePlan,
): DawSession {
  if (plan.refused) return session;
  return updateClips(session, trackId, (clips) =>
    clips.map((c) => (c.id === clipId ? { ...c, gainDb: plan.gainDb } : c)));
}

// ── Reverse ───────────────────────────────────────────────────────────────────

/** Reverse each channel in place-free fashion.  Pure over arrays. */
export function reverseChannels(
  channels: ReadonlyArray<Float32Array>,
): Float32Array[] {
  return channels.map((channel) => {
    const out = new Float32Array(channel.length);
    for (let i = 0; i < channel.length; i++) out[i] = channel[channel.length - 1 - i] ?? 0;
    return out;
  });
}

/**
 * The clip a reversed render should replace the original with.
 *
 * Three things move, and the second is the one people forget:
 *
 *   `offsetSec` becomes 0.  The new file IS the clip's span, so pointing part
 *   way into it would play part way into the reversed passage.
 *
 *   THE FADES SWAP.  A fade-in at the head of a passage is a fade-out at its
 *   tail once the passage is backwards.  Leaving them alone puts the fade on
 *   the wrong end, which sounds exactly like a broken edit.
 *
 *   The name says so, because a reversed clip that still reads "Vox 3" is a
 *   clip you will wonder about in an hour.
 */
export function reversedClip(clip: Clip, fileId: string): Clip {
  return {
    ...clip,
    fileId,
    offsetSec: 0,
    fadeIn: clip.fadeOut,
    fadeOut: clip.fadeIn,
    name: cleanClipName(`${clip.name} ↩`),
  };
}

export function replaceClip(
  session: DawSession, trackId: TrackId, clipId: ClipId, next: Clip,
): DawSession {
  return updateClips(session, trackId, (clips) =>
    clips.map((c) => (c.id === clipId ? next : c)));
}

// ── Finding ───────────────────────────────────────────────────────────────────

export function findClipIn(
  session: DawSession, trackId: TrackId, clipId: ClipId,
): Clip | undefined {
  const track = findTrack(session, trackId);
  return track ? trackClips(track).find((c) => c.id === clipId) : undefined;
}

/** Every audio clip the selection touches, with its track. */
export function selectedAudioClips(
  session: DawSession, sel: TimeSelection,
): Array<{ trackId: TrackId; clip: Clip }> {
  const out: Array<{ trackId: TrackId; clip: Clip }> = [];
  for (const trackId of sel.trackIds) {
    const track = findTrack(session, trackId);
    if (!track) continue;
    for (const clip of trackClips(track)) {
      if (clip.kind === 'audio' && overlapsSelection(clip, sel)) out.push({ trackId, clip });
    }
  }
  return out;
}


