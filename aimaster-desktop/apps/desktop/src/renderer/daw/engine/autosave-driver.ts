// The thing that actually writes the autosave.
//
// The decision — when to write — is a pure function in model/autosave.ts.
// This is the impure half: it watches the session for real changes, asks that
// function on a slow poll, and does the IPC.
//
// Two details are worth stating because both are ways to lose work.
//
// A CHANGE IS A NEW SESSION OBJECT, NOT A STORE EMISSION.  The store emits on
// playback position, scroll, zoom and selection, none of which touch the
// session.  Watching emissions would write a file twenty times a second while
// the transport rolls, which is both wasteful and — because it never goes
// idle — would never let a real edit through the idle gate.
//
// THE REVISION IS CAPTURED BEFORE THE WRITE, NOT AFTER.  Writing is
// asynchronous, so edits can arrive while it is in flight.  Marking the
// CURRENT revision clean when an OLDER one is what landed is exactly how an
// autosave quietly loses the last thing you did.
//
// EVERY PATH THAT CHANGES THE SESSION HAS TO SAY SO.  This one used to be
// told by the store's `apply` alone, which left out `applyTransient` — the
// path every drag takes, and so every clip move, fade, automation curve,
// note drag and plugin knob — and undo and redo besides.  A mixing pass made
// entirely of drags produced no autosave at all, and an undo left the disk
// holding the thing that had just been taken back.  The rules in
// model/autosave.ts were written for exactly that traffic: the idle gate is
// there so a drag's hundred changes a second are not written, and the
// ceiling is there so a long pass is not lost for never going idle.

import {
  INITIAL_AUTOSAVE, isDirty, noteChange, noteSaved, shouldSave, type AutosaveState,
} from '../model/autosave.js';
import { serializeDawSession } from '../model/session-io.js';
import type { DawSession } from '../model/types.js';

/** How often the decision is asked.  Cheap: it is two subtractions. */
const POLL_MS = 1000;

export interface AutosaveDeps {
  session: () => DawSession;
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  now?: () => number;
  onError?: (message: string) => void;
}

export class AutosaveDriver {
  private state: AutosaveState = INITIAL_AUTOSAVE;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastSeen: DawSession | null = null;
  private writing = false;
  private deps: AutosaveDeps | null = null;

  start(deps: AutosaveDeps): void {
    this.stop();
    this.deps = deps;
    this.lastSeen = deps.session();
    this.state = INITIAL_AUTOSAVE;
    this.timer = setInterval(() => { void this.poll(); }, POLL_MS);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  get dirty(): boolean { return isDirty(this.state); }

  /**
   * Tell the driver the session changed.
   *
   * Called from every store path that replaces the session — `apply`,
   * `applyTransient`, undo and redo — far more reliable than diffing on a
   * timer.  Cheap enough to call on every mouse move: an identity check, a
   * clock read and one small object.
   */
  noteEdit(session: DawSession): void {
    const now = this.deps?.now?.() ?? Date.now();
    if (session === this.lastSeen) return;
    this.lastSeen = session;
    this.state = noteChange(this.state, now);
  }

  /**
   * A different project is on screen now.
   *
   * The baseline moves with it and the dirty flag goes back to nothing: a
   * project that has just been opened has no unsaved work to recover, and
   * carrying the previous one's dirty state across would write THIS
   * project's file to satisfy an edit made to THAT one.
   */
  noteLoaded(session: DawSession): void {
    this.lastSeen = session;
    this.state = INITIAL_AUTOSAVE;
  }

  /** A clean manual save makes the recovery file unnecessary. */
  async clear(sessionId: string): Promise<void> {
    this.state = noteSaved(this.state, this.state.revision, this.deps?.now?.() ?? Date.now());
    await this.deps?.invoke('autosave:clear', sessionId).catch(() => undefined);
  }

  private async poll(): Promise<void> {
    const deps = this.deps;
    if (!deps || this.writing) return;
    const now = deps.now?.() ?? Date.now();
    if (!shouldSave(this.state, now).save) return;

    // Captured BEFORE the await — see the header.
    const writingRevision = this.state.revision;
    const session = deps.session();
    this.writing = true;
    try {
      await deps.invoke('autosave:write', {
        id: session.id,
        data: serializeDawSession(session),
      });
      this.state = noteSaved(this.state, writingRevision, deps.now?.() ?? Date.now());
    } catch (err) {
      // A failed autosave is reported once and then left alone: retrying every
      // second on a full disk turns one problem into a stream of toasts.
      deps.onError?.(`자동 저장 실패: ${(err as Error).message}`);
      this.state = noteSaved(this.state, writingRevision, deps.now?.() ?? Date.now());
    } finally {
      this.writing = false;
    }
  }
}

export const autosaveDriver = new AutosaveDriver();

// ── Recovery ──────────────────────────────────────────────────────────────────

import { deserializeDawSession } from '../model/session-io.js';
import { describeRecovery, isRecoverable, type RecoveryInfo } from '../model/autosave.js';

export interface RecoveryOffer {
  info: RecoveryInfo;
  label: string;
}

/**
 * What is worth offering back, newest first.
 *
 * Runs at startup and must never throw: an app that will not open because its
 * crash-recovery code crashed is a very bad joke.
 */
export async function findRecoveries(
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>,
  nowMs = Date.now(),
): Promise<RecoveryOffer[]> {
  try {
    const raw = await invoke('autosave:list');
    if (!Array.isArray(raw)) return [];
    const out: RecoveryOffer[] = [];
    for (const entry of raw as RecoveryInfo[]) {
      if (!entry || typeof entry.path !== 'string') continue;
      // No manual-save time is known here, so the caller passes null: the
      // session that was open is the one that knows when it was last saved.
      if (!isRecoverable(entry, null).offer) continue;
      out.push({ info: entry, label: describeRecovery(entry, nowMs) });
    }
    return out;
  } catch {
    return [];
  }
}

/** Read one back.  A file that no longer parses is reported, not thrown. */
export async function loadRecovery(
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>,
  info: RecoveryInfo,
): Promise<{ session: DawSession } | { error: string }> {
  try {
    const raw = await invoke('autosave:read', info.path);
    if (typeof raw !== 'string') return { error: '자동 저장 파일을 읽지 못했습니다' };
    const parsed = deserializeDawSession(raw);
    if (!parsed.ok) return { error: parsed.error };
    return { session: parsed.session };
  } catch (err) {
    return { error: (err as Error).message };
  }
}
