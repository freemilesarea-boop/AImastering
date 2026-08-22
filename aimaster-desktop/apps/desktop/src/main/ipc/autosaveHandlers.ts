// The autosave file, and why it is written the way it is.
//
// An autosave exists for exactly one moment: the app died and the user wants
// the last twenty minutes back.  Everything here follows from that.
//
// ── The write is atomic ──────────────────────────────────────────────────────
//
// Writing straight to the recovery file means a crash DURING the write leaves
// a half-written file — and a crash during a write is not a remote scenario
// here, because the thing being defended against is the app dying.  The
// failure mode is the worst possible one: the recovery file exists, the user
// says yes, and gets a truncated session.
//
// So it is written to a temp name and RENAMED over the target.  Rename is
// atomic on every platform this ships to: after it, the file is either
// entirely the old one or entirely the new one, never a mixture.
//
// ── There are two of them ────────────────────────────────────────────────────
//
// The previous autosave is kept as `.bak` before the new one lands.  If the
// crash happened while the session was already broken — a bad import, a
// runaway edit — the newest autosave faithfully preserves the broken thing,
// and the one before it is the way out.
//
// ── It is per-session, not global ────────────────────────────────────────────
//
// Keyed by the session's own id, so two windows on two projects do not write
// over each other and reopening one project does not offer the other's work.

import type { IpcMain } from 'electron';
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { recordFailure } from '../utils/failureLog.js';

/** Bigger than this is not a session, it is a mistake. */
const MAX_BYTES = 64 * 1024 * 1024;
/** Autosaves older than this are swept — a month-old crash is not coming back. */
const KEEP_DAYS = 30;

function autosaveDir(): string {
  const dir = path.join(app.getPath('userData'), 'autosave');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Session ids come from the renderer, so they never reach the filesystem raw. */
function safeKey(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'session';
}

export interface AutosaveRecord {
  path: string;
  savedAtMs: number;
  sessionName: string;
  bytes: number;
}

function readMeta(file: string): AutosaveRecord | null {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size === 0) return null;
    // The name is read out of the JSON rather than the filename so the prompt
    // says what the user called the project, not what we called the file.
    let sessionName = '이름 없는 세션';
    try {
      const head = fs.readFileSync(file, 'utf8').slice(0, 4096);
      const match = /"name"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(head);
      if (match?.[1]) sessionName = JSON.parse(`"${match[1]}"`) as string;
    } catch { /* a truncated file still has a size and a time */ }
    return { path: file, savedAtMs: stat.mtimeMs, sessionName, bytes: stat.size };
  } catch {
    return null;
  }
}

/** Remove autosaves nobody is coming back for. */
function sweep(dir: string): void {
  const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
  try {
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      try {
        if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
      } catch { /* gone already, or in use */ }
    }
  } catch { /* no directory yet */ }
}

export function registerAutosaveHandlers(ipc: IpcMain): void {
  ipc.handle('autosave:write', (_e, raw: unknown) => {
    if (typeof raw !== 'object' || raw === null) throw new Error('autosave:write: 형식이 잘못됐습니다');
    const { id, data } = raw as { id?: unknown; data?: unknown };
    if (typeof id !== 'string' || typeof data !== 'string') {
      throw new Error('autosave:write: id 와 data 가 필요합니다');
    }
    if (data.length === 0 || data.length > MAX_BYTES) {
      throw new Error('autosave:write: 크기가 올바르지 않습니다');
    }

    const dir = autosaveDir();
    const target = path.join(dir, `${safeKey(id)}.louisession`);
    const backup = `${target}.bak`;
    // A distinct temp name per write, so two writes racing cannot share one.
    const temp = `${target}.${process.pid}.${Date.now()}.tmp`;

    try {
      fs.writeFileSync(temp, data, 'utf8');
      // Keep the previous one before it is replaced — see the header.
      if (fs.existsSync(target)) {
        try { fs.copyFileSync(target, backup); } catch { /* best effort */ }
      }
      // Atomic: after this the file is entirely old or entirely new.
      fs.renameSync(temp, target);
      return { ok: true, path: target, savedAtMs: Date.now() };
    } catch (err) {
      try { fs.unlinkSync(temp); } catch { /* already gone */ }
      recordFailure('session', `autosave:write failed: ${(err as Error).message}`);
      throw err;
    }
  });

  /** What is recoverable, newest first.  Never throws — this runs at startup. */
  ipc.handle('autosave:list', () => {
    try {
      const dir = autosaveDir();
      sweep(dir);
      const out: AutosaveRecord[] = [];
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.louisession')) continue;
        const meta = readMeta(path.join(dir, name));
        if (meta) out.push(meta);
      }
      return out.sort((a, b) => b.savedAtMs - a.savedAtMs).slice(0, 20);
    } catch {
      return [];
    }
  });

  ipc.handle('autosave:read', (_e, raw: unknown) => {
    if (typeof raw !== 'string' || raw.length === 0) throw new Error('autosave:read: 경로가 필요합니다');
    const dir = autosaveDir();
    const resolved = path.resolve(raw);
    // The renderer only ever gets paths from `autosave:list`, but this is the
    // one place a path from the renderer opens a file, so it is checked.
    if (!resolved.startsWith(dir + path.sep)) {
      throw new Error('autosave:read: 자동 저장 폴더 밖입니다');
    }
    return fs.readFileSync(resolved, 'utf8');
  });

  /** Called after a clean manual save — the crash never happened. */
  ipc.handle('autosave:clear', (_e, raw: unknown) => {
    if (typeof raw !== 'string') return { ok: false };
    const target = path.join(autosaveDir(), `${safeKey(raw)}.louisession`);
    for (const file of [target, `${target}.bak`]) {
      try { fs.unlinkSync(file); } catch { /* not there */ }
    }
    return { ok: true };
  });
}
