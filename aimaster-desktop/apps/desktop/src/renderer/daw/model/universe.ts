// universe.ts — the whole song at a glance, and the window you drag over it.
//
// The arrange window shows a few bars at a working zoom.  That is the right
// zoom for editing and the wrong one for everything else: you cannot see that
// the second chorus is missing a guitar, or that a vocal runs forty seconds
// past everything else, or where you are in a five-minute song.  The scroll
// bar knows the answer and refuses to draw it.
//
// The universe strip draws the whole session squeezed into one width — every
// track a thin row, every clip a small block — with a rectangle marking what
// the arrange window is currently looking at.  Drag the rectangle to scroll,
// drag its edges to zoom, click to jump.
//
// Everything here is pure arithmetic between three coordinate spaces, which
// is the entire reason it is a module and not a component:
//
//   SECONDS      what the session is written in
//   STRIP PIXELS the miniature, which is the whole song in `widthPx`
//   VIEW PIXELS  the arrange window, which is `pxPerSec` and a scroll
//
// Every bug this file can have is a confusion between two of those, and every
// one of them looks like "the little rectangle is in the wrong place" — which
// is unfalsifiable by eye on a five-minute song, and obvious in a test.

import { clipEnd, sessionEndSec, trackClips } from './session-ops.js';
import { MAX_PX_PER_SEC, MIN_PX_PER_SEC, type ViewChange, type Viewport } from './viewport.js';
import type { DawSession, Track, TrackKind } from './types.js';

/**
 * The kinds of track that can hold a clip.
 *
 * Aux, master and VCA channels carry none — their playlists stay empty by
 * design — so a row for them is always blank.  Drawing them would push every
 * real row thinner to make space for stripes that can never show anything.
 */
export const CLIP_TRACK_KINDS: ReadonlySet<TrackKind> =
  new Set<TrackKind>(['audio', 'instrument', 'folder']);

export function isUniverseTrack(track: Track): boolean {
  return CLIP_TRACK_KINDS.has(track.kind);
}

/**
 * The shortest song the strip will draw.
 *
 * An empty session has no length, and a strip scaled to nothing divides by
 * zero — or, worse, doesn't, and draws one clip filling the entire width as
 * though it were the whole song.  Thirty seconds is about a scroll of the
 * arrange window at a normal zoom, so a new session reads as "nearly empty"
 * rather than as "full".
 */
export const MIN_SPAN_SEC = 30;

/**
 * Extra room past the last sound, as a fraction of the song.
 *
 * Without it the last clip ends exactly at the right edge and there is
 * nowhere to drag anything to.  A twentieth is enough to grab.
 */
export const TAIL_FRACTION = 0.05;

/** Below this a row is not worth drawing; the strip just gets shorter. */
export const MIN_ROW_PX = 2;

/**
 * The narrowest the view rectangle is allowed to get, in strip pixels.
 *
 * On a long song at a close zoom the window is a fraction of a pixel wide.
 * Drawn honestly it is invisible and ungrabbable, which makes the one control
 * on the strip useless exactly when the strip is most useful.
 */
export const MIN_VIEW_PX = 6;

export interface UniverseSpan {
  startSec: number;
  endSec: number;
}

/**
 * How much time the strip covers.
 *
 * Always from zero: a song does not start at the first clip, it starts at the
 * beginning, and a strip whose left edge moved as you deleted the first clip
 * would make every position on it mean something different.
 */
export function universeSpan(session: DawSession): UniverseSpan {
  const end = sessionEndSec(session);
  const padded = end * (1 + TAIL_FRACTION);
  return { startSec: 0, endSec: Math.max(MIN_SPAN_SEC, padded) };
}

export function spanSeconds(span: UniverseSpan): number {
  return Math.max(1e-6, span.endSec - span.startSec);
}

/** Strip pixels per second. */
export function universeScale(span: UniverseSpan, widthPx: number): number {
  return Math.max(0, widthPx) / spanSeconds(span);
}

export function secToStripPx(span: UniverseSpan, widthPx: number, sec: number): number {
  return (sec - span.startSec) * universeScale(span, widthPx);
}

export function stripPxToSec(span: UniverseSpan, widthPx: number, px: number): number {
  const scale = universeScale(span, widthPx);
  if (scale <= 0) return span.startSec;
  return span.startSec + px / scale;
}

// ── What to draw ────────────────────────────────────────────────────────────

export interface UniverseBlock {
  clipId: string;
  x: number;
  width: number;
  muted: boolean;
}

export interface UniverseRow {
  trackId: string;
  name: string;
  color: string;
  /** Empty for a track with no clips — the row is still drawn. */
  blocks: UniverseBlock[];
}

export interface UniverseOptions {
  /** Tracks to leave out — a hidden or folded track has no row. */
  hiddenTrackIds?: ReadonlySet<string>;
}

/**
 * One row per track, in the session's own order.
 *
 * A track with no clips STILL gets a row.  The strip is read against the
 * arrangement beside it, and a strip that silently skipped empty tracks would
 * put every row below the gap next to the wrong track name.
 */
export function universeRows(
  session: DawSession, widthPx: number, options: UniverseOptions = {},
): UniverseRow[] {
  const span = universeSpan(session);
  const scale = universeScale(span, widthPx);
  const rows: UniverseRow[] = [];

  for (const track of session.tracks) {
    if (!isUniverseTrack(track)) continue;
    if (options.hiddenTrackIds?.has(track.id)) continue;
    const blocks: UniverseBlock[] = [];
    for (const clip of trackClips(track)) {
      const x = (clip.startSec - span.startSec) * scale;
      // A clip narrower than a pixel is still a clip.  Rounded away it
      // vanishes, and a strip that does not show a short take is lying about
      // what is in the song.
      const width = Math.max(1, (clipEnd(clip) - clip.startSec) * scale);
      blocks.push({ clipId: clip.id, x, width, muted: clip.muted });
    }
    rows.push({
      trackId: track.id,
      name: track.name,
      color: track.color,
      blocks,
    });
  }
  return rows;
}

/** Row height that fits every row in the strip, or the floor. */
export function rowHeightPx(rowCount: number, heightPx: number): number {
  if (rowCount <= 0) return MIN_ROW_PX;
  return Math.max(MIN_ROW_PX, heightPx / rowCount);
}

// ── The window rectangle ────────────────────────────────────────────────────

export interface ViewRect {
  x: number;
  width: number;
  /** True when the arrange window is showing the whole song already. */
  coversAll: boolean;
}

/**
 * Where the arrange window sits on the strip.
 *
 * Clamped INSIDE the strip on both sides, and never narrower than something
 * you can grab.  A rectangle that hangs off the end, or that is a third of a
 * pixel wide, is the one control the strip has.
 */
export function viewRect(
  view: Viewport, span: UniverseSpan, widthPx: number,
): ViewRect {
  const scale = universeScale(span, widthPx);
  const visibleSec = view.pxPerSec > 0 ? view.widthPx / view.pxPerSec : 0;
  const rawWidth = visibleSec * scale;
  const coversAll = visibleSec >= spanSeconds(span) - 1e-6;

  const width = Math.min(widthPx, Math.max(MIN_VIEW_PX, rawWidth));
  const rawX = (view.scrollSec - span.startSec) * scale;
  const x = Math.max(0, Math.min(widthPx - width, rawX));
  return { x, width, coversAll };
}

/**
 * Scroll so the window's LEFT EDGE lands at this strip position.
 *
 * Held inside the song: dragging the rectangle off the end should stop at the
 * end, not keep going and leave the arrange window looking at nothing.
 */
export function scrollForStripX(
  view: Viewport, span: UniverseSpan, widthPx: number, x: number,
): number {
  const visibleSec = view.pxPerSec > 0 ? view.widthPx / view.pxPerSec : 0;
  const wanted = stripPxToSec(span, widthPx, x);
  const last = Math.max(span.startSec, span.endSec - visibleSec);
  return Math.max(span.startSec, Math.min(last, wanted));
}

/**
 * Click anywhere on the strip: put that moment in the MIDDLE of the window.
 *
 * Not at the left edge.  A click is "show me this", and showing it at the
 * very edge of the window is the one place it is hardest to see.
 */
export function scrollForStripClick(
  view: Viewport, span: UniverseSpan, widthPx: number, x: number,
): number {
  const visibleSec = view.pxPerSec > 0 ? view.widthPx / view.pxPerSec : 0;
  const at = stripPxToSec(span, widthPx, x);
  return scrollForStripX(view, span, widthPx, secToStripPx(span, widthPx, at - visibleSec / 2));
}

/**
 * Drag one edge of the rectangle: zoom, keeping the OTHER edge still.
 *
 * That is what makes it feel like a handle rather than a slider — the side
 * you are not touching does not move, so you can widen the view onto exactly
 * the passage you want without chasing it.
 */
export function zoomForStripEdge(
  view: Viewport, span: UniverseSpan, widthPx: number,
  edge: 'left' | 'right', x: number,
): ViewChange | null {
  if (!(view.widthPx > 0)) return null;
  const rect = viewRect(view, span, widthPx);
  const anchorPx = edge === 'left' ? rect.x + rect.width : rect.x;
  const movedPx = Math.max(0, Math.min(widthPx, x));

  const anchorSec = stripPxToSec(span, widthPx, anchorPx);
  const movedSec = stripPxToSec(span, widthPx, movedPx);
  const visibleSec = Math.abs(anchorSec - movedSec);
  // Dragging an edge past the other one would invert the window.  Refusing is
  // better than flipping: the user is still holding the mouse down and will
  // drag back.
  if (!(visibleSec > 1e-6)) return null;

  const pxPerSec = Math.max(MIN_PX_PER_SEC, Math.min(MAX_PX_PER_SEC, view.widthPx / visibleSec));
  const startSec = Math.min(anchorSec, movedSec);
  const actualVisible = view.widthPx / pxPerSec;
  const last = Math.max(span.startSec, span.endSec - actualVisible);
  return {
    pxPerSec,
    scrollSec: Math.max(span.startSec, Math.min(last, startSec)),
  };
}

/** Frame the whole song in the arrange window — the strip's "show me it all". */
export function fitWholeSong(view: Viewport, span: UniverseSpan): ViewChange | null {
  if (!(view.widthPx > 0)) return null;
  const length = spanSeconds(span);
  const pxPerSec = Math.max(MIN_PX_PER_SEC, Math.min(MAX_PX_PER_SEC, view.widthPx / length));
  return { pxPerSec, scrollSec: span.startSec };
}

// ── Reading it back ─────────────────────────────────────────────────────────

export function describeUniverse(session: DawSession, view: Viewport): string {
  const span = universeSpan(session);
  const visibleSec = view.pxPerSec > 0 ? view.widthPx / view.pxPerSec : 0;
  const percent = Math.round((visibleSec / spanSeconds(span)) * 100);
  const tracks = session.tracks.filter(isUniverseTrack);
  const clips = tracks.reduce((n, t: Track) => n + trackClips(t).length, 0);
  return `${tracks.length}개 트랙 · 클립 ${clips}개 · 곡의 ${Math.max(1, Math.min(100, percent))}% 보는 중`;
}
