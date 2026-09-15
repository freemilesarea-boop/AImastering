// batch-fade.ts — the same fade on everything you selected.
//
// `setFades` has been in clip-edit.ts since fades existed and NOTHING has ever
// called it.  The corner-drag calls `setClipFade` (one clip), the F key calls
// `fadeToCursor` (one edge, at the play head), and the batch verb sat there
// with no way to reach it.
//
// The job it does is real: after a comp you have twenty clip boundaries that
// all want the same 5 ms declick, and doing that by dragging twenty corners is
// the work the command exists to replace.
//
// Two decisions:
//
//   • The fade is CAPPED at half the clip.  A 500 ms fade asked for on a
//     200 ms clip is not a fade, it is the clip disappearing — and Pro Tools'
//     batch fades refuse rather than shrink, which leaves you guessing which
//     ones took.  Capping applies it everywhere and reports what it changed.
//   • Fading only the OUTER edges of a run is available, because that is what
//     "top and tail this comp" means: the joins inside are already crossfaded
//     and putting a fade on each of them makes twenty holes.

import type { Clip, DawSession, Fade, FadeShape } from '../model/types.js';
import { clipEnd, findTrack, trackClips, updateClips } from '../model/session-ops.js';
import { overlapsSelection, type TimeSelection } from './clip-edit.js';

const EPS = 1e-6;

/** The shortest fade worth calling one — below this it is a click either way. */
export const MIN_BATCH_FADE_SEC = 0.001;
export const MAX_BATCH_FADE_SEC = 5;

export type FadeEdges = 'both' | 'in' | 'out' | 'outer';

export const EDGE_LABELS: Record<FadeEdges, string> = {
  both:  '양쪽 끝',
  in:    '시작만',
  out:   '끝만',
  outer: '바깥쪽만 (붙어 있는 클립 사이는 건너뜀)',
};

export interface BatchFadeOptions {
  durationSec: number;
  shape: FadeShape;
  edges: FadeEdges;
}

export const DEFAULT_BATCH_FADE: BatchFadeOptions = {
  durationSec: 0.005, shape: 'equalPower', edges: 'both',
};

export function clampFadeSec(sec: number): number {
  if (!Number.isFinite(sec)) return MIN_BATCH_FADE_SEC;
  return Math.max(MIN_BATCH_FADE_SEC, Math.min(MAX_BATCH_FADE_SEC, sec));
}

export interface BatchFadeSummary {
  /** Clips the selection covers. */
  clips: number;
  /** Fades actually written. */
  fades: number;
  /** Clips whose fade had to be shortened to fit. */
  shortened: number;
  /** The shortest fade that ended up on anything. */
  shortestSec: number;
}

/** True when `b` starts where `a` ends — the join inside a comped run. */
function touches(a: Clip, b: Clip): boolean {
  return Math.abs(clipEnd(a) - b.startSec) <= 0.001;
}

/**
 * Apply the same fade to every clip the selection covers.
 *
 * Per track, because "outer" needs to know what a clip's neighbours are and
 * neighbours are a per-track idea.
 */
export function batchFade(
  session: DawSession, sel: TimeSelection, options: Partial<BatchFadeOptions> = {},
): { session: DawSession; summary: BatchFadeSummary } {
  const opts: BatchFadeOptions = { ...DEFAULT_BATCH_FADE, ...options };
  const wanted = clampFadeSec(opts.durationSec);
  const summary: BatchFadeSummary = { clips: 0, fades: 0, shortened: 0, shortestSec: Infinity };

  let out = session;
  for (const trackId of sel.trackIds) {
    if (!findTrack(out, trackId)) continue;
    out = updateClips(out, trackId, (clips) => {
      const sorted = [...clips].sort((a, b) => a.startSec - b.startSec);
      return sorted.map((clip, i) => {
        if (clip.kind !== 'audio' || !overlapsSelection(clip, sel)) return clip;
        summary.clips++;

        const prev = sorted[i - 1];
        const next = sorted[i + 1];
        // "Outer" skips the edge that butts against a neighbour: those joins
        // are already continuous, and a fade there is a hole.
        const doIn = opts.edges === 'both' || opts.edges === 'in'
          || (opts.edges === 'outer' && !(prev && touches(prev, clip)));
        const doOut = opts.edges === 'both' || opts.edges === 'out'
          || (opts.edges === 'outer' && !(next && touches(clip, next)));
        if (!doIn && !doOut) return clip;

        // Half the clip each side at most, so in + out can never eat it whole.
        const room = Math.max(0, clip.durationSec / 2 - EPS);
        const seconds = Math.min(wanted, room);
        if (seconds <= EPS) return clip;
        if (seconds < wanted - EPS) summary.shortened++;
        summary.shortestSec = Math.min(summary.shortestSec, seconds);

        const fade: Fade = { durationSec: seconds, shape: opts.shape };
        let next2 = clip;
        if (doIn)  { next2 = { ...next2, fadeIn: fade };  summary.fades++; }
        if (doOut) { next2 = { ...next2, fadeOut: fade }; summary.fades++; }
        return next2;
      });
    });
  }

  if (summary.shortestSec === Infinity) summary.shortestSec = 0;
  return { session: out, summary };
}

/** Take every fade off the selected clips — the undo you reach for by hand. */
export function clearFades(session: DawSession, sel: TimeSelection): DawSession {
  let out = session;
  const none: Fade = { durationSec: 0, shape: 'equalPower' };
  for (const trackId of sel.trackIds) {
    if (!findTrack(out, trackId)) continue;
    out = updateClips(out, trackId, (clips) => clips.map((c) =>
      (overlapsSelection(c, sel) ? { ...c, fadeIn: none, fadeOut: none } : c)));
  }
  return out;
}

/** How many clips the selection would touch, for the dialog's preview. */
export function countSelectedClips(session: DawSession, sel: TimeSelection): number {
  let n = 0;
  for (const trackId of sel.trackIds) {
    const track = findTrack(session, trackId);
    if (!track) continue;
    for (const clip of trackClips(track)) {
      if (clip.kind === 'audio' && overlapsSelection(clip, sel)) n++;
    }
  }
  return n;
}

export function describeBatchFade(summary: BatchFadeSummary): string {
  if (summary.clips === 0) return '선택한 클립이 없습니다';
  if (summary.fades === 0) return `${summary.clips}개 클립 — 넣을 페이드가 없습니다`;
  const short = summary.shortened > 0
    ? `, ${summary.shortened}개는 클립이 짧아 ${(summary.shortestSec * 1000).toFixed(0)} ms 로 줄임`
    : '';
  return `${summary.clips}개 클립에 페이드 ${summary.fades}개${short}`;
}
