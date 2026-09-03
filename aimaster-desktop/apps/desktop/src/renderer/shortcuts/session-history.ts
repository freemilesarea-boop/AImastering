// session-history — undo/redo for the stem session.
//
// Ctrl+Z is the shortcut an engineer reaches for without deciding to, and a
// DAW that answers it with nothing is a DAW you cannot experiment in. What
// there is to undo here is not a timeline edit — the stems never move — but
// everything else the session is: which tracks are in it, what each one is,
// where its fader and pan sit, and which plugins are on it.
//
// # Snapshots, not commands
//
// The alternative is an inverse operation per action, which means every new
// action arrives with a second chance to get its undo wrong. A session is a
// few kilobytes of plain data, so the whole thing is copied. The cost is
// bounded by `LIMIT`, and the correctness is structural: undo restores a
// state that was definitely real, because the app was in it.
//
// # Coalescing
//
// Dragging a fader emits a value on every pointer move. Recording each of
// those would make Ctrl+Z walk back through a drag one pixel at a time, so
// consecutive edits of the same KIND on the same track inside
// `COALESCE_MS` replace each other rather than stacking. A drag is one undo
// step, which is what the hand expects.

/** What one undo step restores. Deliberately plain data. */
export interface SessionSnapshot {
  /** The session's tracks, already serialised by the caller. */
  tracks: unknown[];
  masterPresetId: string | null;
  masterTargetLufs: number | null;
  /** Which track was selected — restoring the edit without the focus is jarring. */
  selectedId: string | null;
}

/**
 * A label for what produced this snapshot.
 *
 * Used only for coalescing: two edits merge when their keys match. Include
 * the track id, or moving one fader would swallow the next track's move.
 */
export type EditKey = string;

export const LIMIT = 100;
export const COALESCE_MS = 500;

interface Entry {
  snapshot: SessionSnapshot;
  key: EditKey;
  at: number;
}

export interface History {
  past: Entry[];
  future: Entry[];
  /** The state the session is in right now. */
  present: Entry | null;
}

export function emptyHistory(): History {
  return { past: [], future: [], present: null };
}

/** Deep-ish copy — snapshots must not alias live store objects. */
function clone(s: SessionSnapshot): SessionSnapshot {
  return {
    tracks: JSON.parse(JSON.stringify(s.tracks)) as unknown[],
    masterPresetId: s.masterPresetId,
    masterTargetLufs: s.masterTargetLufs,
    selectedId: s.selectedId,
  };
}

/**
 * Seed the history with the state the session opens in.
 *
 * Without this the first undo has nothing to go back to and the first edit
 * is unrecoverable — the one edit a user is most likely to want back.
 */
export function begin(snapshot: SessionSnapshot, now = Date.now()): History {
  return { past: [], future: [], present: { snapshot: clone(snapshot), key: 'init', at: now } };
}

/**
 * Record the state BEFORE an edit.
 *
 * Called with the snapshot as it is at the moment of the change; the entry
 * that was `present` moves onto the past stack.
 */
export function record(h: History, snapshot: SessionSnapshot, key: EditKey, now = Date.now()): History {
  const entry: Entry = { snapshot: clone(snapshot), key, at: now };
  if (!h.present) return { past: [], future: [], present: entry };

  // A continuing drag replaces the head rather than stacking on it.
  const merge = h.present.key === key && now - h.present.at < COALESCE_MS;
  if (merge) {
    return { past: h.past, future: [], present: { ...entry, at: h.present.at } };
  }

  const past = [...h.past, h.present];
  return {
    past: past.length > LIMIT ? past.slice(past.length - LIMIT) : past,
    future: [],
    present: entry,
  };
}

export function canUndo(h: History): boolean {
  return h.past.length > 0;
}

export function canRedo(h: History): boolean {
  return h.future.length > 0;
}

/** Step back. Returns the snapshot to apply, or null when there is none. */
export function undo(h: History): { history: History; snapshot: SessionSnapshot } | null {
  const prev = h.past[h.past.length - 1];
  if (!prev || !h.present) return null;
  return {
    history: {
      past: h.past.slice(0, -1),
      future: [h.present, ...h.future],
      present: prev,
    },
    snapshot: clone(prev.snapshot),
  };
}

/** Step forward again. */
export function redo(h: History): { history: History; snapshot: SessionSnapshot } | null {
  const next = h.future[0];
  if (!next || !h.present) return null;
  return {
    history: {
      past: [...h.past, h.present],
      future: h.future.slice(1),
      present: next,
    },
    snapshot: clone(next.snapshot),
  };
}
