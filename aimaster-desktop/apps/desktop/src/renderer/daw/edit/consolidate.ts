// Consolidate / Bounce Selection — a pile of edits becomes one file.
//
// The verb every DAW has and every engineer reaches for once the comping is
// done: take the fragments left on a track, merge them into one continuous
// audio file, and put that single clip back where they were.
//
// The part that is easy to get wrong is the GAPS.  Between two fragments
// there is no audio at all, and a merge has to write something there.  It
// must be digital zero — samples of exactly 0.0, not "very quiet", not the
// tail of whatever the file held at that offset, not a fade.  Anything else
// is a noise floor the engineer did not ask for, printed permanently into a
// file they can no longer take it out of.
//
// What this module owns is the arithmetic — which clips, which bounds, where
// the silence goes, and what the track looks like afterwards.  All pure, so
// the boundary cases can be tested to the sample without an audio device.
// The render itself lives in engine/offline-render.ts.
//
// Two decisions worth stating, because both differ from a naive reading:
//
//   • The bounds are the EVENTS', not the selection's.  A loose drag that
//     starts in the middle of nothing and ends in the middle of nothing
//     still produces a file that begins exactly at the first event and ends
//     exactly at the last.  Bouncing a rough selection must not print the
//     slack around it, and must not truncate an event the selection only
//     half covers.
//   • One file PER TRACK.  Selecting across four tracks gives four
//     consolidated clips, not one mixdown — the selection is being tidied,
//     not summed.  Summing four tracks into one is a different verb with a
//     different name, and doing it here would silently destroy the mix.

import { clipEnd, findTrack, trackClips, updateClips, createClip } from '../model/session-ops.js';
import { overlapsSelection, type TimeSelection } from './clip-edit.js';
import type { Clip, ClipId, DawSession, TrackId } from '../model/types.js';

const EPS = 1e-9;

/** A stretch of the consolidated span that no event covers. */
export interface SilenceGap {
  startSec: number;
  endSec: number;
}

/** One track's worth of work: which clips merge, over what span. */
export interface ConsolidationSpan {
  trackId: TrackId;
  clipIds: ClipId[];
  /** Total_Start — where the first event begins. */
  startSec: number;
  /** Total_End — where the last event ends. */
  endSec: number;
  /** The stretches that must come out as digital zero. */
  gaps: SilenceGap[];
}

export function spanDurationSec(span: ConsolidationSpan): number {
  return Math.max(0, span.endSec - span.startSec);
}

/**
 * The holes between a set of clips.
 *
 * Walks a running REACH rather than comparing each clip to the one before
 * it.  Clips may overlap, and one may sit entirely inside another; comparing
 * neighbours would report a gap between the container's start and the next
 * clip that the container itself is covering.  Reach cannot make that
 * mistake — it only ever moves forward.
 */
export function gapsBetween(clips: readonly Clip[]): SilenceGap[] {
  const sorted = [...clips].sort((a, b) => a.startSec - b.startSec);
  const gaps: SilenceGap[] = [];
  let reach = Number.NEGATIVE_INFINITY;
  for (const clip of sorted) {
    if (reach === Number.NEGATIVE_INFINITY) { reach = clipEnd(clip); continue; }
    if (clip.startSec > reach + EPS) gaps.push({ startSec: reach, endSec: clip.startSec });
    reach = Math.max(reach, clipEnd(clip));
  }
  return gaps;
}

/** True when `timeSec` falls in one of the span's silent stretches. */
export function isSilentAt(span: ConsolidationSpan, timeSec: number): boolean {
  return span.gaps.some((g) => timeSec >= g.startSec - EPS && timeSec < g.endSec - EPS);
}

/** Total silence the render will write, in seconds. */
export function silenceSec(span: ConsolidationSpan): number {
  return span.gaps.reduce((sum, g) => sum + (g.endSec - g.startSec), 0);
}

/**
 * The work for one track, or null when the selection touches no audio there.
 *
 * A track with a single clip is still work: the bounce bakes that clip's
 * gain and fades into the file, which is exactly what someone consolidating
 * a lone fragment is asking for.
 */
export function spanForTrack(
  session: DawSession, trackId: TrackId, sel: TimeSelection,
): ConsolidationSpan | null {
  const track = findTrack(session, trackId);
  if (!track) return null;
  const clips = trackClips(track).filter((c) => c.kind === 'audio' && overlapsSelection(c, sel));
  if (clips.length === 0) return null;

  let startSec = Infinity;
  let endSec = -Infinity;
  for (const c of clips) {
    startSec = Math.min(startSec, c.startSec);
    endSec = Math.max(endSec, clipEnd(c));
  }
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec - startSec <= EPS) return null;

  return { trackId, clipIds: clips.map((c) => c.id), startSec, endSec, gaps: gapsBetween(clips) };
}

/** One span per selected track that has audio in the selection. */
export function consolidationSpans(session: DawSession, sel: TimeSelection): ConsolidationSpan[] {
  const spans: ConsolidationSpan[] = [];
  for (const trackId of sel.trackIds) {
    const span = spanForTrack(session, trackId, sel);
    if (span) spans.push(span);
  }
  return spans;
}

/**
 * Put the rendered file back: the merged clips go, one clip takes their place.
 *
 * By id, not by overlap.  An unselected clip that happens to sit inside the
 * span — the take that was deliberately left out of the comp — must survive,
 * and a filter on time would eat it.
 */
export function applyConsolidatedSpan(
  session: DawSession, span: ConsolidationSpan, fileId: string, name: string,
): DawSession {
  const merged = new Set<ClipId>(span.clipIds);
  return updateClips(session, span.trackId, (clips) => [
    ...clips.filter((c) => !merged.has(c.id)),
    createClip(fileId, name, {
      startSec: span.startSec,
      offsetSec: 0,
      durationSec: spanDurationSec(span),
    }),
  ]);
}

/** What a finished consolidation did, for the message that reports it. */
export interface ConsolidationOutcome {
  tracks: number;
  clipsMerged: number;
  gaps: number;
  silenceSec: number;
}

export function outcomeOf(spans: readonly ConsolidationSpan[]): ConsolidationOutcome {
  return {
    tracks: spans.length,
    clipsMerged: spans.reduce((n, s) => n + s.clipIds.length, 0),
    gaps: spans.reduce((n, s) => n + s.gaps.length, 0),
    silenceSec: spans.reduce((n, s) => n + silenceSec(s), 0),
  };
}

export function describeOutcome(outcome: ConsolidationOutcome): string {
  const parts = [`${outcome.tracks}개 트랙`, `클립 ${outcome.clipsMerged}개 → ${outcome.tracks}개`];
  if (outcome.gaps > 0) parts.push(`무음 ${outcome.gaps}구간 (${outcome.silenceSec.toFixed(2)}초)`);
  return parts.join(' · ');
}
