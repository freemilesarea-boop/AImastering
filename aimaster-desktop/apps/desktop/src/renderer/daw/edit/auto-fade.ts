// Auto crossfade — two clips that overlap should not click.
//
// The manual crossfade (X) has always been here and it only works on clips
// that BUTT: it looks for `clipEnd(prev) === next.startSec` and puts half a
// fade either side of the seam.  What it cannot do is the case that actually
// produces the click — one clip dragged so it lies ON TOP of another.  There
// the two are both playing over the overlap, and the later one starts at
// whatever sample it starts at, full level, mid-waveform.
//
// A crossfade over the overlap fixes both problems at once: no step at the
// join, and no doubled level through the middle.  Equal power rather than
// linear, because the two clips are different material — a linear pair dips
// about 3 dB in the middle, which on a drop-in reads as a hole.
//
// Pure, so the rule can be checked without a mouse: overlaps in, fades out.

import { clipEnd, sortClips, updateClips } from '../model/session-ops.js';
import type { Clip, DawSession, Fade, TrackId } from '../model/types.js';

const EPS = 1e-9;

/** The shortest overlap worth fading — below this it is a rounding error. */
export const MIN_AUTO_FADE_SEC = 0.002;

/**
 * Longest auto crossfade.
 *
 * A drag that lands a clip half over its neighbour means "put it here", not
 * "blend two seconds of these together".  Past this the overlap is an
 * arrangement decision and the fade handles are the right tool, so the auto
 * one stops and leaves the corners where they can be seen.
 */
export const MAX_AUTO_FADE_SEC = 0.5;

export interface Overlap {
  earlier: Clip;
  later: Clip;
  startSec: number;
  endSec: number;
}

export function overlapLength(overlap: Overlap): number {
  return Math.max(0, overlap.endSec - overlap.startSec);
}

/**
 * Adjacent pairs of clips that overlap.
 *
 * Adjacent in time after sorting, not every pair: three clips stacked on one
 * spot is not an arrangement anyone made on purpose, and fading every pair of
 * them would write fades that contradict each other.
 */
export function overlapsOn(clips: readonly Clip[]): Overlap[] {
  const sorted = sortClips([...clips]);
  const out: Overlap[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const earlier = sorted[i - 1]!;
    const later = sorted[i]!;
    const startSec = later.startSec;
    const endSec = Math.min(clipEnd(earlier), clipEnd(later));
    if (endSec - startSec > EPS) out.push({ earlier, later, startSec, endSec });
  }
  return out;
}

/**
 * Write a crossfade across every overlap on a track.
 *
 * The fade is the whole overlap, capped.  Anything shorter would leave part
 * of the overlap at doubled level, which is the loudness bump people hear as
 * "the edit is louder than the take".
 *
 * An existing longer fade is left alone: a fade someone drew by hand is a
 * decision, and quietly shortening it the next time a neighbour is nudged is
 * how an "auto" feature earns being switched off.
 */
export function autoCrossfadeTrack(
  session: DawSession, trackId: TrackId, shape: Fade['shape'] = 'equalPower',
): DawSession {
  return updateClips(session, trackId, (clips) => {
    const overlaps = overlapsOn(clips);
    if (overlaps.length === 0) return clips;

    const fadeOutFor = new Map<string, number>();
    const fadeInFor = new Map<string, number>();
    for (const overlap of overlaps) {
      const length = Math.min(overlapLength(overlap), MAX_AUTO_FADE_SEC);
      if (length < MIN_AUTO_FADE_SEC) continue;
      fadeOutFor.set(overlap.earlier.id, Math.max(fadeOutFor.get(overlap.earlier.id) ?? 0, length));
      fadeInFor.set(overlap.later.id, Math.max(fadeInFor.get(overlap.later.id) ?? 0, length));
    }
    if (fadeOutFor.size === 0 && fadeInFor.size === 0) return clips;

    let touched = false;
    const next = clips.map((c) => {
      const out = fadeOutFor.get(c.id);
      const into = fadeInFor.get(c.id);
      if (out === undefined && into === undefined) return c;
      // Never longer than the clip, and never so long the two fades on one
      // clip pass through each other.
      const room = c.durationSec / 2;
      const fadeOut = out === undefined ? c.fadeOut
        : { durationSec: Math.max(c.fadeOut.durationSec, Math.min(out, room)), shape };
      const fadeIn = into === undefined ? c.fadeIn
        : { durationSec: Math.max(c.fadeIn.durationSec, Math.min(into, room)), shape };
      if (fadeOut === c.fadeOut && fadeIn === c.fadeIn) return c;
      touched = true;
      return { ...c, fadeIn, fadeOut };
    });
    return touched ? next : clips;
  });
}

/** `2군데 크로스페이드 (평균 84ms)` — for the toast. */
export function describeAutoFade(overlaps: readonly Overlap[]): string {
  const used = overlaps.filter((o) => overlapLength(o) >= MIN_AUTO_FADE_SEC);
  if (used.length === 0) return '겹친 곳이 없습니다';
  const mean = used.reduce((n, o) => n + Math.min(overlapLength(o), MAX_AUTO_FADE_SEC), 0) / used.length;
  return `${used.length}군데 크로스페이드 (평균 ${(mean * 1000).toFixed(0)}ms)`;
}
