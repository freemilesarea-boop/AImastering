// repeat-fill.ts — repeat the clipboard until the selected range is full.
//
// Pro Tools calls it Repeat Paste to Fill Selection, Cubase gets there with
// Fill Loop.  It is the difference between "paste a two-bar loop sixteen
// times and hope the last one lands on the bar" and "select thirty-two bars
// and press one key".
//
// Two decisions carry the feature:
//
//   • The LAST copy is trimmed to the selection edge, never allowed past it.
//     A fill that overshoots is not a fill — it is a paste that damaged the
//     bar after the range you asked about.  Pro Tools asks whether to trim;
//     we always trim, because leaving it hanging out is never what a selection
//     meant.
//   • That trim happens to the CLIPBOARD, before the paste, not to the result
//     afterwards.  An overwrite paste clears where it lands, so a full-length
//     final copy would erase the bar past the selection edge and then be
//     trimmed back off it, leaving a hole where the user's material used to
//     be.  Trimming first means the last paste only ever touches the range
//     that was selected.
//
// The repeat itself goes through `pasteAt` per copy, so the landing clear, the
// file merge and the id-per-paste rules are the clipboard's, not a second
// implementation that will drift from it.

import type { Clip, DawSession } from '../model/types.js';
import { clipEnd, sortClips } from '../model/session-ops.js';
import { pasteAt, type EditClipboard, type PasteResult } from './clipboard.js';
import { hasRange, trimClipEnd, type TimeSelection } from './clip-edit.js';

const EPS = 1e-6;

/** A ceiling, so a 30-minute selection with a 10 ms clipboard cannot hang the UI. */
export const MAX_FILL_COPIES = 512;

export interface FillPlan {
  /** Copies that fit whole. */
  whole: number;
  /** True when a final, trimmed copy is needed to reach the edge. */
  partial: boolean;
  /** How long that final copy is.  0 when `partial` is false. */
  partialSec: number;
  /** Total copies placed, whole plus the partial. */
  total: number;
  /** Set when the plan was cut short by MAX_FILL_COPIES. */
  capped: boolean;
}

/**
 * How many copies a range takes, before touching the session.
 *
 * Split out so the caller can say "16 copies, last one trimmed" BEFORE the
 * user commits — a fill is a big edit and finding out afterwards is late.
 */
export function planFill(lengthSec: number, rangeSec: number): FillPlan | null {
  if (!(lengthSec > EPS) || !(rangeSec > EPS)) return null;
  let whole = Math.floor(rangeSec / lengthSec + EPS);
  const remainder = rangeSec - whole * lengthSec;
  let partial = remainder > EPS;
  let capped = false;

  if (whole >= MAX_FILL_COPIES) { whole = MAX_FILL_COPIES; partial = false; capped = true; }
  else if (whole + 1 > MAX_FILL_COPIES && partial) { partial = false; capped = true; }

  return {
    whole,
    partial,
    partialSec: partial ? remainder : 0,
    total: whole + (partial ? 1 : 0),
    capped,
  };
}

/**
 * A clipboard cut down to `lengthSec`.
 *
 * Clips are in LOCAL time (0 is the start of the copied range), so the trim is
 * the same arithmetic as trimming on the timeline.  A clip that starts at or
 * past the new edge is dropped rather than kept at zero length.
 */
export function trimClipboard(clipboard: EditClipboard, lengthSec: number): EditClipboard {
  if (!(lengthSec > EPS)) return { ...clipboard, lengthSec: 0, lanes: clipboard.lanes.map((l) => ({ ...l, clips: [] })) };
  if (lengthSec >= clipboard.lengthSec - EPS) return clipboard;
  return {
    ...clipboard,
    lengthSec,
    lanes: clipboard.lanes.map((lane) => ({
      ...lane,
      clips: sortClips(lane.clips.flatMap((clip): Clip[] => {
        if (clipEnd(clip) <= lengthSec + EPS) return [clip];
        if (clip.startSec >= lengthSec - EPS) return [];
        return [trimClipEnd(clip, lengthSec)];
      })),
    })),
  };
}

export interface FillResult extends PasteResult {
  plan: FillPlan | null;
}

/**
 * Fill `sel` with `clipboard`, repeating from the selection start.
 *
 * The selection's own tracks are the targets — a fill is defined by a range on
 * particular tracks, so asking the caller for a second track list would let
 * the two disagree.
 */
export function repeatFill(
  session: DawSession, clipboard: EditClipboard, sel: TimeSelection,
): FillResult {
  if (!hasRange(sel) || sel.trackIds.length === 0) {
    return { session, selection: sel, problems: ['채울 구간을 먼저 선택하세요'], plan: null };
  }
  const plan = planFill(clipboard.lengthSec, sel.endSec - sel.startSec);
  if (!plan || plan.total === 0) {
    return { session, selection: sel, problems: ['구간이 클립보드 한 번보다 짧습니다'], plan };
  }

  let out = session;
  const problems: string[] = [];
  for (let i = 0; i < plan.total; i++) {
    const last = plan.partial && i === plan.total - 1;
    const piece = last ? trimClipboard(clipboard, plan.partialSec) : clipboard;
    const result = pasteAt(out, piece, sel.startSec + i * clipboard.lengthSec, sel.trackIds, 'overwrite');
    out = result.session;
    // Only the first copy's problems — the same complaint repeated sixteen
    // times is noise, and every copy pastes the same lanes onto the same
    // tracks, so they cannot differ.
    if (i === 0) problems.push(...result.problems);
  }

  if (plan.capped) problems.push(`복사 ${MAX_FILL_COPIES}개에서 멈췄습니다 — 구간이 너무 깁니다`);

  return { session: out, selection: sel, problems, plan };
}

export function describeFill(plan: FillPlan | null): string {
  if (!plan || plan.total === 0) return '채울 것이 없습니다';
  const tail = plan.partial ? `, 마지막 ${plan.partialSec.toFixed(2)}s는 잘림` : ' (딱 맞음)';
  const cap = plan.capped ? ' — 상한에서 멈춤' : '';
  return `복사 ${plan.total}개${tail}${cap}`;
}
