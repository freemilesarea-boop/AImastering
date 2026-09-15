// snap-modes.ts — the four ways a drag can land somewhere useful.
//
// Until now the timeline had one snap: absolute grid, on in Grid edit mode and
// off everywhere else.  That is the least useful of the four, because it can
// only make things land ON the grid — and most of the time what you want is to
// move a clip by exactly a bar while KEEPING the eighth of swing it was
// dragged in with, or to land on the edge of the clip next door, which is not
// on the grid at all.
//
// Pro Tools names the four:
//   • Grid (absolute)   — the result lands on a grid line.
//   • Relative Grid     — the DISTANCE moved is a whole number of grid units.
//                         The clip keeps its offset from the line.
//   • Magnetic (Cursor) — snap only when you are already close; further away
//                         nothing happens and the drag is free.
//   • Events            — snap to what is actually there: clip edges, markers,
//                         the play head, the selection edges.
//
// Everything here is pure.  It takes a context of candidate times and a
// tempo map, and returns a time — no store, no DOM, so a selftest can drive it
// and the caller decides where the candidates come from.

import type { TempoMap } from './types.js';
import { snapSecToBeats, secToBeat, beatToSec } from './tempo-map.js';

export type SnapMode = 'off' | 'grid' | 'relative' | 'magnetic' | 'events';

export const SNAP_MODES: readonly SnapMode[] = ['off', 'grid', 'relative', 'magnetic', 'events'];

export const SNAP_LABELS: Record<SnapMode, string> = {
  off:      '스냅 끔',
  grid:     '그리드',
  relative: '상대 그리드',
  magnetic: '자석',
  events:   '이벤트',
};

/**
 * How close a magnetic or event snap has to be, in PIXELS.
 *
 * Pixels, not seconds, because the whole point is "close enough that the user
 * meant it", and that is a property of the screen: zoomed out, a pixel is a
 * bar and snapping across one would be wrong.
 */
export const SNAP_RADIUS_PX = 12;

export interface SnapContext {
  tempoMap: TempoMap;
  /** Musical division in quarter notes — 0.25 is a sixteenth, 4 a 4/4 bar. */
  gridDivision: number;
  /** Zoom, so a pixel radius can be turned into seconds. */
  pxPerSec: number;
  /**
   * Times worth landing on: clip edges, markers, the play head.
   *
   * The caller collects them.  Unsorted and duplicated is fine — `nearestOf`
   * does not care, and asking every caller to sort would be a trap.
   */
  events?: readonly number[];
}

/** The snap radius in seconds at the current zoom. */
export function radiusSec(ctx: Pick<SnapContext, 'pxPerSec'>): number {
  return ctx.pxPerSec > 0 ? SNAP_RADIUS_PX / ctx.pxPerSec : 0;
}

/**
 * The candidate nearest `sec`, or null when the list is empty.
 *
 * Ties go to the EARLIER time so the result does not depend on the order the
 * caller happened to collect them in.
 */
export function nearestOf(candidates: readonly number[], sec: number): number | null {
  let best: number | null = null;
  let bestGap = Infinity;
  for (const c of candidates) {
    const gap = Math.abs(c - sec);
    if (gap < bestGap || (gap === bestGap && best !== null && c < best)) { best = c; bestGap = gap; }
  }
  return best;
}

/**
 * Where a bare time lands — a click on the ruler, a play head drop, the start
 * of a new selection.  No previous position, so Relative has nothing relative
 * to work with and behaves as absolute Grid.
 */
export function snapTime(mode: SnapMode, ctx: SnapContext, sec: number): number {
  const at = Math.max(0, sec);
  switch (mode) {
    case 'off':
      return at;
    case 'grid':
    case 'relative':
      return ctx.gridDivision > 0 ? snapSecToBeats(ctx.tempoMap, at, ctx.gridDivision) : at;
    case 'magnetic': {
      if (!(ctx.gridDivision > 0)) return at;
      const line = snapSecToBeats(ctx.tempoMap, at, ctx.gridDivision);
      return Math.abs(line - at) <= radiusSec(ctx) ? line : at;
    }
    case 'events': {
      const near = nearestOf(ctx.events ?? [], at);
      return near !== null && Math.abs(near - at) <= radiusSec(ctx) ? Math.max(0, near) : at;
    }
    default:
      return at;
  }
}

/**
 * Where a MOVE lands: the thing was at `fromSec`, the mouse says `toSec`.
 *
 * This is the call that separates the modes, and the reason `snapTime` is not
 * enough on its own.  Relative moves by a whole number of grid units from
 * where the clip WAS; Events snaps the clip's own edge onto something else's
 * edge; Magnetic leaves the drag alone unless it is already nearly right.
 */
export function snapMove(mode: SnapMode, ctx: SnapContext, fromSec: number, toSec: number): number {
  const target = Math.max(0, toSec);
  if (mode === 'relative') {
    if (!(ctx.gridDivision > 0)) return target;
    const map = ctx.tempoMap;
    // On the BEAT axis, so a move of "one bar" stays one bar through a tempo
    // change — the same reason absolute grid rounds there.
    const fromBeat = secToBeat(map, Math.max(0, fromSec));
    const toBeat = secToBeat(map, target);
    const steps = Math.round((toBeat - fromBeat) / ctx.gridDivision);
    return Math.max(0, beatToSec(map, fromBeat + steps * ctx.gridDivision));
  }
  return snapTime(mode, ctx, target);
}

/**
 * The same move, expressed as the DELTA to apply.
 *
 * A drag usually moves several clips at once, and they have to move by the
 * SAME amount or the group comes apart.  So the caller snaps the one clip
 * under the mouse and applies this delta to the rest.
 */
export function snapDelta(mode: SnapMode, ctx: SnapContext, fromSec: number, toSec: number): number {
  return snapMove(mode, ctx, fromSec, toSec) - fromSec;
}

/**
 * Collect the times an Events snap can land on.
 *
 * Deduplicated and sorted: two clips butted together give one edge, not two,
 * and a sorted list is what a ruler wants to draw.
 */
export function eventTimes(...groups: readonly (readonly number[])[]): number[] {
  const seen = new Set<number>();
  for (const g of groups) for (const t of g) if (t >= 0) seen.add(t);
  return [...seen].sort((a, b) => a - b);
}

/** Step to the next mode — what one key press cycles through. */
export function cycleSnap(mode: SnapMode): SnapMode {
  const i = SNAP_MODES.indexOf(mode);
  return SNAP_MODES[(i + 1) % SNAP_MODES.length] as SnapMode;
}

export function describeSnap(mode: SnapMode, gridDivision: number): string {
  if (mode === 'off') return SNAP_LABELS.off;
  if (mode === 'events') return `${SNAP_LABELS.events} — 클립 경계·마커에 붙음`;
  const grid = gridDivision >= 4 ? `${gridDivision / 4}마디`
    : gridDivision >= 1 ? `${gridDivision}박`
    : `1/${Math.round(4 / gridDivision)}`;
  if (mode === 'relative') return `${SNAP_LABELS.relative} — ${grid} 단위로 이동, 어긋난 위치 유지`;
  if (mode === 'magnetic') return `${SNAP_LABELS.magnetic} — ${grid} 선에 ${SNAP_RADIUS_PX}px 안에서만 붙음`;
  return `${SNAP_LABELS.grid} — ${grid}`;
}
