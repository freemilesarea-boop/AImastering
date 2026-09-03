// history-log.ts — turn a stack of session snapshots into a readable list.
//
// The undo stack holds whole `DawSession` snapshots and nothing else.  That
// design is right — it cannot drift out of step with what you hear, and no
// call site has to remember to record anything — but it means the stack has no
// LABELS, and a history panel showing "step 7, step 8, step 9" is a worse
// version of pressing Mod+Z nine times.
//
// The alternative would be to label at the source: make `apply` take a string.
// Two hundred and ten call sites would each have to pass one, every new one
// would have to remember, and the ones that forgot would silently read
// "Unknown".  So instead the label is DERIVED here, by diffing the pair of
// snapshots the step sits between.  A step that adds a track can only be "track
// added" — the diff cannot be out of date the way a hand-written string can.
//
// The diff is deliberately shallow and ordered: it reports the FIRST thing that
// explains the change, most specific first, and stops.  A rename that also
// moved a clip is vanishingly rare; "renamed" plus "moved a clip" in one line
// is noise for the common case where only one of them happened.

import type { Clip, DawSession, Track } from '../model/types.js';
import { trackClips } from '../model/session-ops.js';

const EPS = 1e-6;

export interface HistoryEntry {
  /**
   * Where the step sits.  0 is the OLDEST snapshot in `past`; the entry whose
   * index equals `past.length` is the present.
   */
  index: number;
  label: string;
  /** True for the one you are on — the panel marks it and clicking it does nothing. */
  current: boolean;
  /** Steps after the present, reachable with redo, are drawn dimmed. */
  future: boolean;
}

/**
 * What changed between two snapshots.
 *
 * Returned rather than formatted so a caller can branch on it — and so the
 * selftest can assert the KIND, not a Korean string that a copy edit would
 * break.
 */
export type ChangeKind =
  | 'none'
  | 'tracks-added' | 'tracks-removed' | 'track-order'
  | 'track-renamed' | 'session-renamed'
  | 'clips-added' | 'clips-removed' | 'clips-moved' | 'clips-trimmed'
  | 'clip-gain' | 'clip-fades'
  | 'mix' | 'inserts' | 'sends' | 'automation'
  | 'markers' | 'tempo' | 'other';

export interface SessionChange {
  kind: ChangeKind;
  /** How many things of that kind — 3 clips added, 2 tracks removed. */
  count: number;
  /** The one name worth showing, when there is exactly one. */
  name?: string;
}

const trackById = (s: DawSession): Map<string, Track> =>
  new Map(s.tracks.map((t) => [t.id, t]));

/** Every clip on every track, keyed by clip id, so a move is a lookup not a search. */
function clipsById(s: DawSession): Map<string, Clip> {
  const out = new Map<string, Clip>();
  for (const track of s.tracks) for (const clip of trackClips(track)) out.set(clip.id, clip);
  return out;
}

/**
 * Name the difference between `before` and `after`.
 *
 * Order matters and is the design: structural changes first (a track appearing
 * is the headline even if its fader also differs from the default), then clip
 * changes, then the per-channel settings, then the things that are almost
 * always incidental.
 */
export function diffSessions(before: DawSession, after: DawSession): SessionChange {
  if (before === after) return { kind: 'none', count: 0 };

  // ── Tracks ────────────────────────────────────────────────────────────────
  const wasT = trackById(before);
  const nowT = trackById(after);
  const added = after.tracks.filter((t) => !wasT.has(t.id));
  const removed = before.tracks.filter((t) => !nowT.has(t.id));
  if (added.length > 0) return one('tracks-added', added.map((t) => t.name));
  if (removed.length > 0) return one('tracks-removed', removed.map((t) => t.name));
  if (before.tracks.length === after.tracks.length
      && before.tracks.some((t, i) => t.id !== after.tracks[i]?.id)) {
    return { kind: 'track-order', count: after.tracks.length };
  }

  const renamed = after.tracks.filter((t) => wasT.get(t.id)?.name !== t.name);
  if (renamed.length > 0) return one('track-renamed', renamed.map((t) => t.name));
  if (before.name !== after.name) return { kind: 'session-renamed', count: 1, name: after.name };

  // ── Clips ─────────────────────────────────────────────────────────────────
  const wasC = clipsById(before);
  const nowC = clipsById(after);
  const newClips = [...nowC.values()].filter((c) => !wasC.has(c.id));
  const goneClips = [...wasC.values()].filter((c) => !nowC.has(c.id));
  if (newClips.length > 0) return one('clips-added', newClips.map((c) => c.name));
  if (goneClips.length > 0) return one('clips-removed', goneClips.map((c) => c.name));

  const moved: Clip[] = [];
  const trimmed: Clip[] = [];
  const gained: Clip[] = [];
  const faded: Clip[] = [];
  for (const [id, now] of nowC) {
    const was = wasC.get(id);
    if (!was || was === now) continue;
    // Start moved but length did not: a move.  Length changed: a trim — and a
    // trim from the head moves the start too, which is why length is asked
    // about first.
    if (Math.abs(was.durationSec - now.durationSec) > EPS
        || Math.abs(was.offsetSec - now.offsetSec) > EPS) trimmed.push(now);
    else if (Math.abs(was.startSec - now.startSec) > EPS) moved.push(now);
    else if (was.gainDb !== now.gainDb) gained.push(now);
    else if (!same(was.fadeIn, now.fadeIn) || !same(was.fadeOut, now.fadeOut)) faded.push(now);
  }
  if (moved.length > 0) return one('clips-moved', moved.map((c) => c.name));
  if (trimmed.length > 0) return one('clips-trimmed', trimmed.map((c) => c.name));
  if (gained.length > 0) return one('clip-gain', gained.map((c) => c.name));
  if (faded.length > 0) return one('clip-fades', faded.map((c) => c.name));

  // ── Channels ──────────────────────────────────────────────────────────────
  const inserts = after.tracks.filter((t) => !same(wasT.get(t.id)?.inserts, t.inserts));
  if (inserts.length > 0) return one('inserts', inserts.map((t) => t.name));
  const sends = after.tracks.filter((t) => !same(wasT.get(t.id)?.sends, t.sends));
  if (sends.length > 0) return one('sends', sends.map((t) => t.name));
  const auto = after.tracks.filter((t) => !same(wasT.get(t.id)?.automation, t.automation));
  if (auto.length > 0) return one('automation', auto.map((t) => t.name));
  const mixed = after.tracks.filter((t) => {
    const w = wasT.get(t.id);
    return !!w && (w.volumeDb !== t.volumeDb || w.pan !== t.pan
      || w.mute !== t.mute || w.solo !== t.solo);
  });
  if (mixed.length > 0) return one('mix', mixed.map((t) => t.name));

  // ── The rest ──────────────────────────────────────────────────────────────
  if (!same(before.markers, after.markers)) return { kind: 'markers', count: 1 };
  if (before.tempoBpm !== after.tempoBpm || !same(before.tempoMap, after.tempoMap)) {
    return { kind: 'tempo', count: 1 };
  }
  return { kind: 'other', count: 1 };
}

function one(kind: ChangeKind, names: string[]): SessionChange {
  const out: SessionChange = { kind, count: names.length };
  if (names.length === 1 && names[0]) out.name = names[0];
  return out;
}

/** Structural equality via JSON — everything compared here is JSON-safe. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try { return JSON.stringify(a ?? null) === JSON.stringify(b ?? null); }
  catch { return false; }
}

const KIND_LABELS: Record<ChangeKind, string> = {
  'none':           '변화 없음',
  'tracks-added':   '트랙 추가',
  'tracks-removed': '트랙 삭제',
  'track-order':    '트랙 순서',
  'track-renamed':  '트랙 이름',
  'session-renamed': '세션 이름',
  'clips-added':    '클립 추가',
  'clips-removed':  '클립 삭제',
  'clips-moved':    '클립 이동',
  'clips-trimmed':  '클립 길이',
  'clip-gain':      '클립 게인',
  'clip-fades':     '페이드',
  'mix':            '믹스',
  'inserts':        '인서트',
  'sends':          '센드',
  'automation':     '오토메이션',
  'markers':        '마커',
  'tempo':          '템포',
  'other':          '편집',
};

/** One line: "클립 이동 — Vox A" or "클립 추가 ×3". */
export function describeChange(change: SessionChange): string {
  const base = KIND_LABELS[change.kind];
  if (change.name) return `${base} — ${change.name}`;
  return change.count > 1 ? `${base} ×${change.count}` : base;
}

/**
 * The whole panel, oldest first.
 *
 * The first entry is the session as it was OPENED — it has no predecessor to
 * diff against, so it is named for what it is rather than for a change that
 * has no meaning.
 */
export function historyEntries(
  history: { past: readonly DawSession[]; present: DawSession; future: readonly DawSession[] },
): HistoryEntry[] {
  const chain = [...history.past, history.present, ...history.future];
  const presentIndex = history.past.length;
  return chain.map((snapshot, i) => ({
    index: i,
    label: i === 0 ? '세션 열기' : describeChange(diffSessions(chain[i - 1] as DawSession, snapshot)),
    current: i === presentIndex,
    future: i > presentIndex,
  }));
}

/**
 * How many undos or redos jumping to `index` takes.
 *
 * Negative is undo, positive is redo, so the caller loops one way or the other
 * rather than reaching into the history's internals to build a new one.  Going
 * through undo/redo is what keeps the audio graph and the autosave in step.
 */
export function stepsTo(pastLength: number, index: number): number {
  return index - pastLength;
}

/** Where the play head should be to see the step — the clip the step touched. */
export function focusSecOf(before: DawSession, after: DawSession): number | null {
  const wasC = clipsById(before);
  const nowC = clipsById(after);
  for (const [id, now] of nowC) {
    const was = wasC.get(id);
    if (!was) return now.startSec;
    if (was.startSec !== now.startSec || was.durationSec !== now.durationSec) {
      return Math.min(was.startSec, now.startSec);
    }
  }
  for (const [, was] of wasC) if (!nowC.has(was.id)) return was.startSec;
  return null;
}
