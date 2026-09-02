// Align a double to the lead — the verb, on top of the DTW in audio/align.ts.
//
// What comes out is WARP MARKERS on the target clip, not a new audio file.
// That is the whole design decision here.  The repo already has a warp engine
// that turns a source-time → timeline-time mapping into audio; alignment that
// rendered its own would be a second, worse copy of it.  More importantly,
// markers can be SEEN in the warp editor and dragged afterwards — an aligner
// whose one bad decision cannot be corrected is an aligner nobody trusts on a
// real vocal.
//
// The markers are pinned in seconds, not to the session tempo
// (`followTempo: false`).  The lead is plain audio sitting at a fixed place
// in time; a double that re-times itself when someone edits the tempo map
// would drift off the very thing it was aligned to.

import {
  alignFeature, alignHopSec, alignPath, alignPoints, driftOf,
  DEFAULT_ALIGN, type AlignOptions, type AlignPoint,
} from '../audio/align.js';
import { applyWarp, requireAudioClip } from './warp-actions.js';
import { getCached, monoSum } from '../engine/audio-cache.js';
import { nextId } from '../model/ids.js';
import { DEFAULT_WARP, type WarpConfig, type WarpMarker } from '../model/warp.js';
import type { Clip, ClipId, DawSession, TrackId } from '../model/types.js';

const EPS = 1e-9;

export interface ClipRef {
  trackId: TrackId;
  clipId: ClipId;
}

export interface AlignReport {
  markerCount: number;
  /** How far the double was out before, in ms. */
  maxDriftMs: number;
  meanDriftMs: number;
  /** Mean DTW step cost — 0 is identical, and a big number is a bad pairing. */
  cost: number;
  /** Hop the match ran at; larger than asked for on a very long take. */
  hopMs: number;
}

export interface AlignResult extends AlignReport {
  session: DawSession;
}

/** The clip's own span of its file, summed to mono, at its own sample rate. */
function clipMono(clip: Clip): { samples: Float32Array; sampleRate: number } | null {
  const cached = getCached(clip.fileId);
  if (!cached) return null;
  const rate = cached.buffer.sampleRate;
  const mono = monoSum(cached.buffer);
  const from = Math.max(0, Math.round(clip.offsetSec * rate));
  const to = Math.min(mono.length, Math.round((clip.offsetSec + clip.durationSec) * rate));
  if (to - from < rate * 0.05) return null;
  return { samples: mono.subarray(from, to) as Float32Array, sampleRate: rate };
}

/**
 * Turn the mapping into markers on the target clip.
 *
 * Two frames meet here.  The path is in each clip's OWN time; a marker wants
 * the position in the source FILE on one axis and the musical position from
 * the clip's start on the other.  The guide's moment on the timeline is
 * `guideClip.startSec + guideSec`, and the target has to sound there — so
 * the marker's musical position is that, measured from the target clip's own
 * start.  Two clips that begin at the same place make this look like an
 * identity; two that do not are exactly when getting it wrong is invisible
 * until you listen.
 */
export function alignMarkers(
  points: readonly AlignPoint[], guide: Clip, target: Clip, bpm: number,
): WarpMarker[] {
  const beatsPerSec = bpm / 60;
  const out: WarpMarker[] = [];
  for (const p of points) {
    const sourceSec = target.offsetSec + p.targetSec;
    const localSec = guide.startSec + p.guideSec - target.startSec;
    // A guide moment that falls before the target clip even starts has no
    // place to be marked; the warp map is only defined from the clip's start.
    if (localSec < -EPS) continue;
    const prev = out[out.length - 1];
    const beat = localSec * beatsPerSec;
    // Strictly increasing on both axes — buildWarpMap divides by the gaps.
    if (prev && (sourceSec <= prev.sourceSec + EPS || beat <= prev.beat + EPS)) continue;
    out.push({ id: nextId('warp'), sourceSec, beat });
  }
  return out;
}

/**
 * Align one clip to another.
 *
 * Throws rather than returning a half-answer: every failure here is something
 * the person can fix (decode the audio, pick a clip with material in it), and
 * a silent no-op is how an aligner gets blamed for "doing nothing".
 */
export function alignClipToGuide(
  session: DawSession, guideRef: ClipRef, targetRef: ClipRef,
  options: Partial<AlignOptions> = {},
): AlignResult {
  if (guideRef.trackId === targetRef.trackId && guideRef.clipId === targetRef.clipId) {
    throw new Error('가이드와 대상이 같은 클립입니다');
  }
  const guide = requireAudioClip(session, guideRef.trackId, guideRef.clipId);
  const target = requireAudioClip(session, targetRef.trackId, targetRef.clipId);

  const g = clipMono(guide);
  const t = clipMono(target);
  if (!g) throw new Error('가이드 오디오가 아직 읽히지 않았습니다');
  if (!t) throw new Error('대상 오디오가 아직 읽히지 않았습니다');

  const base: AlignOptions = { ...DEFAULT_ALIGN, ...options };
  // The hop is chosen from the material, not asked for: a ten-minute take at
  // 10 ms would be a matrix nobody has the memory for.
  const held: AlignOptions = {
    ...base,
    hopSec: alignHopSec(guide.durationSec, target.durationSec, base),
  };

  const path = alignPath(
    alignFeature(g.samples, g.sampleRate, held),
    alignFeature(t.samples, t.sampleRate, held),
    held,
  );
  if (!path) throw new Error('두 클립을 맞출 수 없습니다 — 너무 짧거나 어긋남이 허용치를 넘습니다');

  const points = alignPoints(path, held);
  const markers = alignMarkers(points, guide, target, session.tempoBpm);
  if (markers.length < 2) throw new Error('쓸 수 있는 정렬 지점이 부족합니다');

  const warp: WarpConfig = {
    ...DEFAULT_WARP,
    enabled: true,
    mode: 'tones',
    markers,
    baseBpm: session.tempoBpm,
    followTempo: false,
  };
  const drift = driftOf(points);
  return {
    session: applyWarp(session, targetRef.trackId, targetRef.clipId, warp, target.durationSec),
    markerCount: markers.length,
    maxDriftMs: drift.maxSec * 1000,
    meanDriftMs: drift.meanSec * 1000,
    cost: path.cost,
    hopMs: held.hopSec * 1000,
  };
}

/** `마커 42개 · 어긋남 평균 31ms / 최대 98ms` — the result, in one line. */
export function describeAlign(report: AlignReport): string {
  return `마커 ${report.markerCount}개 · 어긋남 평균 ${report.meanDriftMs.toFixed(0)}ms `
    + `/ 최대 ${report.maxDriftMs.toFixed(0)}ms`;
}
