// options-history.ts — undo / redo stack for the mastering options.
//
// Pure data structure (no React, no zustand) so it can be unit-tested and
// reused.  The workspace store owns one instance of it; Mod+Z / Mod+Shift+Z
// move through it and push the resulting snapshot back into audioStore.
//
// Coalescing (a slider drag = one undo step, not sixty) is the caller's job —
// `record` only rejects entries that are deep-equal to the current present.

export interface History<T> {
  past: T[];
  present: T;
  future: T[];
}

/** Hard cap so a long tweaking session cannot grow without bound. */
export const HISTORY_LIMIT = 100;

export function initHistory<T>(present: T): History<T> {
  return { past: [], present, future: [] };
}

/** Structural equality via JSON — options are plain JSON-safe objects. */
export function sameSnapshot<T>(a: T, b: T): boolean {
  if (a === b) return true;
  try { return JSON.stringify(a) === JSON.stringify(b); }
  catch { return false; }
}

/**
 * Push a new present.  A no-op when the value is unchanged.  Recording always
 * clears the redo branch — the standard linear-undo model.
 */
export function record<T>(h: History<T>, next: T): History<T> {
  if (sameSnapshot(h.present, next)) return h;
  const past = [...h.past, h.present];
  if (past.length > HISTORY_LIMIT) past.splice(0, past.length - HISTORY_LIMIT);
  return { past, present: next, future: [] };
}

export function canUndo<T>(h: History<T>): boolean { return h.past.length > 0; }
export function canRedo<T>(h: History<T>): boolean { return h.future.length > 0; }

export function undo<T>(h: History<T>): History<T> {
  if (h.past.length === 0) return h;
  const previous = h.past[h.past.length - 1] as T;
  return {
    past:    h.past.slice(0, -1),
    present: previous,
    future:  [h.present, ...h.future],
  };
}

export function redo<T>(h: History<T>): History<T> {
  if (h.future.length === 0) return h;
  const next = h.future[0] as T;
  return {
    past:    [...h.past, h.present],
    present: next,
    future:  h.future.slice(1),
  };
}

/** Drop everything and restart from `present` (used when the file changes). */
export function resetHistory<T>(present: T): History<T> {
  return initHistory(present);
}
