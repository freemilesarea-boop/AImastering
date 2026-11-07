// The autosave IPC surface.
//
// Every rule about the files themselves — the atomic write, the previous
// generation that is kept, the size ceiling, the directory guard — lives in
// `../utils/autosave-files.js`, which takes the directory as an argument and
// imports no electron.  That is what makes those rules testable; this file is
// the part that cannot be: argument validation, `app.getPath`, and reporting
// a failure.
//
// An autosave exists for exactly one moment: the app died and the user wants
// the last twenty minutes back.
//
// It is per-session, not global — keyed by the session's own id, so two
// windows on two projects do not write over each other and reopening one
// project does not offer the other's work.
import type { IpcMain } from 'electron';
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { recordFailure } from '../utils/failureLog.js';
import {
  autosaveFiles, isInsideDir, listAutosaves, sweep, writeAutosave, writeProblem,
} from '../utils/autosave-files.js';

export type { AutosaveRecord } from '../utils/autosave-files.js';

function autosaveDir(): string {
  const dir = path.join(app.getPath('userData'), 'autosave');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function registerAutosaveHandlers(ipc: IpcMain): void {
  ipc.handle('autosave:write', (_e, raw: unknown) => {
    if (typeof raw !== 'object' || raw === null) throw new Error('autosave:write: 형식이 잘못됐습니다');
    const { id, data } = raw as { id?: unknown; data?: unknown };
    if (typeof id !== 'string' || typeof data !== 'string') {
      throw new Error('autosave:write: id 와 data 가 필요합니다');
    }
    const problem = writeProblem(data);
    if (problem) throw new Error(problem);

    try {
      const target = writeAutosave(autosaveDir(), id, data);
      return { ok: true, path: target, savedAtMs: Date.now() };
    } catch (err) {
      recordFailure('session', `autosave:write failed: ${(err as Error).message}`);
      throw err;
    }
  });

  /**
   * What is recoverable, newest first, BOTH generations.
   *
   * Never throws — this runs at startup, and an app that will not open
   * because its crash-recovery code crashed is a very bad joke.
   */
  ipc.handle('autosave:list', () => {
    try {
      const dir = autosaveDir();
      sweep(dir);
      return listAutosaves(dir);
    } catch {
      return [];
    }
  });

  ipc.handle('autosave:read', (_e, raw: unknown) => {
    if (typeof raw !== 'string' || raw.length === 0) throw new Error('autosave:read: 경로가 필요합니다');
    const dir = autosaveDir();
    if (!isInsideDir(dir, raw)) throw new Error('autosave:read: 자동 저장 폴더 밖입니다');
    return fs.readFileSync(path.resolve(raw), 'utf8');
  });

  /** Called after a clean manual save — the crash never happened. */
  ipc.handle('autosave:clear', (_e, raw: unknown) => {
    if (typeof raw !== 'string') return { ok: false };
    for (const file of autosaveFiles(autosaveDir(), raw)) {
      try { fs.unlinkSync(file); } catch { /* not there */ }
    }
    return { ok: true };
  });
}
