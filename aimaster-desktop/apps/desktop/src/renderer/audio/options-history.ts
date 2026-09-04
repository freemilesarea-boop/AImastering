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

/** How a history decides whether two snapshots are the same value. */
export type SameSnapshot<T> = (a: T, b: T) => boolean;

/**
 * Structural equality via JSON.
 *
 * The right test for the MASTERING OPTIONS, which are small plain objects a
 * caller genuinely does rebuild — loading a preset constructs a fresh object
 * that may equal the current one field for field, and recording that as an
 * undo step would put an entry in the list that changes nothing.
 *
 * The WRONG test for anything large.  It serialises both sides in full, so it
 * costs time proportional to the value: measured on a DAW session, 0.08 ms at
 * 40 clips and 4.5 ms at 1920, paid on every single edit.  See `sameByReference`.
 */
export function sameSnapshot<T>(a: T, b: T): boolean {
  if (a === b) return true;
  try { return JSON.stringify(a) === JSON.stringify(b); }
  catch { return false; }
}

/**
 * Reference equality — the right test for an immutably-updated value.
 *
 * A DAW session is only ever produced by copying-with-changes, so two distinct
 * objects are two distinct sessions and `===` is the complete answer.  The
 * caller has usually established it already: `dawStore.apply` returns early on
 * `next === current`, so by the time `record` is reached the answer is known
 * and the JSON comparison is re-deriving it at the cost of the whole session.
 */
export function sameByReference<T>(a: T, b: T): boolean {
  return a === b;
}

/**
 * Push a new present.  A no-op when the value is unchanged.  Recording always
 * clears the redo branch — the standard linear-undo model.
 *
 * `same` decides what "unchanged" means; it defaults to the JSON comparison
 * the mastering options need, and callers holding something big should pass
 * `sameByReference`.
 */
export function record<T>(
  h: History<T>, next: T, same: SameSnapshot<T> = sameSnapshot,
): History<T> {
  if (same(h.present, next)) return h;
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
