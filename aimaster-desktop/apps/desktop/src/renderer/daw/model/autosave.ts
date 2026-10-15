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
  /**
   * The session this belongs to, so the caller can ask whether THAT project
   * has been saved by hand since.  Absent on a file written by a build that
   * did not record it; the staleness rule then has nothing to compare and
   * the offer stands, which is the safe direction.
   */
  sessionId?: string;
  /**
   * Which of the two copies on disk this is.
   *
   * The main process keeps the autosave before last as a `.bak`, for the case
   * where the newest one faithfully preserves a session that was already
   * broken.  Absent on a listing from a build that only reported one, and
   * treated as `'latest'` then — that build had nothing else to offer.
   */
  generation?: 'latest' | 'previous';
}

/** A newest autosave, with the copy before it when one survived. */
export interface RecoveryPair {
  latest: RecoveryInfo;
  previous?: RecoveryInfo;
}

/**
 * Pair each newest autosave with the generation before it.
 *
 * By PATH, not by position: the listing is sorted by time across every
 * project, so one session's `.bak` can sit between another session's newest
 * and its own.  A `previous` whose `latest` is not in the listing is dropped
 * rather than promoted — the pair exists to give a second chance at one
 * project, and alone it is a file nobody asked about.
 */
export function pairGenerations(records: readonly RecoveryInfo[]): RecoveryPair[] {
  const latest = records.filter((r) => (r.generation ?? 'latest') === 'latest');
  const byPath = new Map(latest.map((r) => [r.path, r] as const));
  const previousFor = new Map<string, RecoveryInfo>();
  for (const r of records) {
    if ((r.generation ?? 'latest') !== 'previous') continue;
    const ownerPath = r.path.slice(0, -'.bak'.length);
    if (!r.path.endsWith('.bak') || !byPath.has(ownerPath)) continue;
    const held = previousFor.get(ownerPath);
    // More than one cannot happen today, but if it ever does, the newer copy
    // is the one worth keeping.
    if (!held || r.savedAtMs > held.savedAtMs) previousFor.set(ownerPath, r);
  }
  return latest.map((r) => {
    const prev = previousFor.get(r.path);
    return prev ? { latest: r, previous: prev } : { latest: r };
  });
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

/** `3분 전` / `방금 전` / `2시간 전` — how long ago, for a prompt. */
export function describeAge(info: RecoveryInfo, nowMs: number): string {
  const ageMs = Math.max(0, nowMs - info.savedAtMs);
  const minutes = Math.floor(ageMs / 60_000);
  return minutes < 1 ? '방금 전'
    : minutes < 60 ? `${minutes}분 전`
    : `${Math.floor(minutes / 60)}시간 전`;
}

/** `3분 전 · 내 곡` — the restore prompt. */
export function describeRecovery(info: RecoveryInfo, nowMs: number): string {
  return `${describeAge(info, nowMs)} · ${info.sessionName}`;
}

/**
 * `그 전 · 12분 전` — the second choice.
 *
 * Deliberately does NOT repeat the session name: it sits under the newest
 * offer for the same project, and repeating it reads as a second project.
 */
export function describePrevious(info: RecoveryInfo, nowMs: number): string {
  return `그 전 · ${describeAge(info, nowMs)}`;
}
