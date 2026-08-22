// Autosave — deciding WHEN, which is the whole problem.
//
// Writing the session to disk is easy.  Knowing when to is not, and getting it
// wrong is expensive in both directions: too often and every keystroke fights
// a file write on the same thread that draws the waveform; too rarely and the
// thing exists but did not have your last twenty minutes in it.
//
// The rules here are the ones that make it cheap AND useful:
//
//   IDLE, NOT PERIODIC.  A save fires when editing PAUSES, not on a timer.
//   Someone dragging a clip generates a hundred changes a second and wants
//   none of them written; the moment they stop is exactly when the session is
//   in a state worth keeping.
//
//   BUT NOT NEVER.  A long continuous edit — drawing a five-minute automation
//   pass — would never be idle, so a hard ceiling forces a save through.
//
//   NOTHING CHANGED IS NOTHING WRITTEN.  Playback, scrolling, zooming and
//   selecting all re-render and none of them touch the session.  A save keyed
//   on "the store emitted" would write constantly while the transport rolls.
//
// The decision is a pure function of two timestamps and a revision counter, so
// every rule above is tested without a clock, a disk or a store.

/** Editing has stopped for this long → write. */
export const IDLE_MS = 4000;
/** Never go longer than this between writes while edits keep arriving. */
export const MAX_INTERVAL_MS = 60_000;

export interface AutosaveState {
  /** Bumped by every real session change.  Nothing else. */
  revision: number;
  /** The revision that is already on disk. */
  savedRevision: number;
  /** When the most recent change arrived. */
  lastChangeMs: number;
  /** When the last successful write finished. */
  lastSaveMs: number;
}

export const INITIAL_AUTOSAVE: AutosaveState = {
  revision: 0, savedRevision: 0, lastChangeMs: 0, lastSaveMs: 0,
};

export type SaveReason = 'idle' | 'ceiling';

export interface SaveDecision {
  save: boolean;
  reason?: SaveReason;
}

/**
 * Should we write, right now?
 *
 * `nowMs` is passed in rather than read, so the tests can run a whole editing
 * session in a few lines and assert about a clock they control.
 */
export function shouldSave(state: AutosaveState, nowMs: number): SaveDecision {
  // The one rule that stops the transport from writing a file every tick.
  if (state.revision === state.savedRevision) return { save: false };

  if (nowMs - state.lastChangeMs >= IDLE_MS) return { save: true, reason: 'idle' };

  // A long continuous edit never goes idle; the ceiling is what stops it from
  // never being saved.
  const since = nowMs - state.lastSaveMs;
  if (since >= MAX_INTERVAL_MS) return { save: true, reason: 'ceiling' };

  return { save: false };
}

export function noteChange(state: AutosaveState, nowMs: number): AutosaveState {
  return { ...state, revision: state.revision + 1, lastChangeMs: nowMs };
}

/**
 * Record a write that SUCCEEDED.
 *
 * Takes the revision that was actually written rather than reading the current
 * one, because a write is asynchronous: edits that arrived while it was in
 * flight belong to the next save, and marking them clean here is exactly how
 * an autosave silently loses the last thing you did.
 */
export function noteSaved(
  state: AutosaveState, savedRevision: number, nowMs: number,
): AutosaveState {
  return { ...state, savedRevision, lastSaveMs: nowMs };
}

export function isDirty(state: AutosaveState): boolean {
  return state.revision !== state.savedRevision;
}

// ── What a recovery offer looks like ──────────────────────────────────────────

export interface RecoveryInfo {
  /** Absolute path of the autosave file. */
  path: string;
  savedAtMs: number;
  sessionName: string;
  /** Bytes, so a zero-length file can be refused before it is parsed. */
  bytes: number;
}

/**
 * Is this autosave worth offering to restore?
 *
 * An empty or near-empty file is a write that was interrupted, and offering to
 * restore one is offering to replace a session with nothing.  A session that
 * was cleanly saved by hand afterwards makes the autosave stale, and offering
 * a stale one is how people lose the save they deliberately made.
 */
export function isRecoverable(
  info: RecoveryInfo | null, lastManualSaveMs: number | null,
): { offer: boolean; reason?: string } {
  if (!info) return { offer: false };
  if (info.bytes < 64) return { offer: false, reason: '자동 저장 파일이 비어 있습니다' };
  if (lastManualSaveMs !== null && lastManualSaveMs >= info.savedAtMs) {
    return { offer: false, reason: '수동 저장이 더 최신입니다' };
  }
  return { offer: true };
}

/** `3분 전 · 내 곡` — the restore prompt. */
export function describeRecovery(info: RecoveryInfo, nowMs: number): string {
  const ageMs = Math.max(0, nowMs - info.savedAtMs);
  const minutes = Math.floor(ageMs / 60_000);
  const when = minutes < 1 ? '방금 전'
    : minutes < 60 ? `${minutes}분 전`
    : `${Math.floor(minutes / 60)}시간 전`;
  return `${when} · ${info.sessionName}`;
}
