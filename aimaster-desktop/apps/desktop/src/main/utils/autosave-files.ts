// The autosave files on disk — naming them, writing them, finding them again.
//
// Pulled out of `ipc/autosaveHandlers.ts` so these decisions can be tested.
// The handlers import `electron` at runtime for `app.getPath('userData')`,
// which makes every rule in them — the atomic write, the generation that is
// kept, the directory guard that stops a renderer path escaping — unreachable
// from a test.  Nothing here imports electron: the directory is an argument.
//
// ── The write is atomic ──────────────────────────────────────────────────────
//
// Writing straight to the recovery file means a crash DURING the write leaves
// a half-written file — and a crash during a write is not a remote scenario
// here, because the thing being defended against is the app dying.  So it is
// written to a temp name and RENAMED over the target.  Rename is atomic on
// every platform this ships to: after it, the file is either entirely the old
// one or entirely the new one, never a mixture.
//
// ── There are two of them, and BOTH are reachable ────────────────────────────
//
// The previous autosave is kept as `.bak` before the new one lands, because
// if the crash happened while the session was already broken — a bad import,
// a runaway edit — the newest autosave faithfully preserves the broken thing.
//
// That paragraph was in the handler for a long time while `autosave:list`
// filtered `*.louisession`, so the `.bak` was written, swept after thirty
// days, deleted on a clean save — and never once offered to anybody.  The
// promise is now kept: a listing carries both generations, each labelled, and
// the restore prompt offers the previous one as a second choice.
import fs from 'node:fs';
import path from 'node:path';

/** Suffix of the kept previous generation. */
export const BACKUP_SUFFIX = '.bak';
/** Extension of an autosave file.  `.bak` files carry it too, plus the suffix. */
export const AUTOSAVE_EXT = '.louisession';
/** Bigger than this is not a session, it is a mistake.  Counted in BYTES. */
export const MAX_BYTES = 64 * 1024 * 1024;
/** Autosaves older than this are swept — a month-old crash is not coming back. */
export const KEEP_DAYS = 30;
/** How many records a listing returns, newest first. */
export const LIST_LIMIT = 20;

/** Which of the two copies a record is. */
export type Generation = 'latest' | 'previous';

export interface AutosaveRecord {
  path: string;
  savedAtMs: number;
  sessionName: string;
  bytes: number;
  /**
   * The session this belongs to.
   *
   * Read out of the file rather than taken from the filename, which has been
   * through `safeKey` and cannot be turned back into an id.  The renderer
   * needs it to ask whether this project has been saved by hand since.
   */
  sessionId: string;
  generation: Generation;
}

/** Session ids come from the renderer, so they never reach the filesystem raw. */
export function safeKey(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'session';
}

/** The file a session's autosave lives in, inside `dir`. */
export function autosaveFile(dir: string, id: string): string {
  return path.join(dir, `${safeKey(id)}${AUTOSAVE_EXT}`);
}

/** Both files a session can leave behind — the order `autosave:clear` uses. */
export function autosaveFiles(dir: string, id: string): string[] {
  const target = autosaveFile(dir, id);
  return [target, `${target}${BACKUP_SUFFIX}`];
}

/** Is this name an autosave, and which generation?  `null` for anything else. */
export function generationOf(name: string): Generation | null {
  if (name.endsWith(`${AUTOSAVE_EXT}${BACKUP_SUFFIX}`)) return 'previous';
  if (name.endsWith(AUTOSAVE_EXT)) return 'latest';
  return null;
}

/** Refuse a payload before it is written.  Returns the reason, or null. */
export function writeProblem(data: string): string | null {
  if (data.length === 0) return 'autosave:write: 크기가 올바르지 않습니다';
  // Counted in bytes, which is what lands on the disk and what MAX_BYTES
  // says.  `data.length` is UTF-16 code units: a session of Korean text can
  // be three times its own character count, so the two are not the same
  // ceiling even if an ordinary session (1,696 chars → 1,714 bytes) is close.
  if (Buffer.byteLength(data, 'utf8') > MAX_BYTES) {
    return 'autosave:write: 크기가 올바르지 않습니다';
  }
  return null;
}

export function readMeta(file: string): AutosaveRecord | null {
  const generation = generationOf(path.basename(file));
  if (generation === null) return null;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size === 0) return null;
    // The name is read out of the JSON rather than the filename so the prompt
    // says what the user called the project, not what we called the file.
    // `id` and `name` are the second and third keys the serializer writes, so
    // the first match inside the head is the session's own and not a track's.
    let sessionName = '이름 없는 세션';
    let sessionId = '';
    try {
      const head = fs.readFileSync(file, 'utf8').slice(0, 4096);
      const match = /"name"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(head);
      if (match?.[1]) sessionName = JSON.parse(`"${match[1]}"`) as string;
      const idMatch = /"id"\s*:\s*"([^"\\]*)"/.exec(head);
      if (idMatch?.[1]) sessionId = idMatch[1];
    } catch { /* a truncated file still has a size and a time */ }
    return { path: file, savedAtMs: stat.mtimeMs, sessionName, bytes: stat.size, sessionId, generation };
  } catch {
    return null;
  }
}

/** Remove autosaves nobody is coming back for. */
export function sweep(dir: string, nowMs: number = Date.now()): void {
  const cutoff = nowMs - KEEP_DAYS * 24 * 60 * 60 * 1000;
  try {
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      try {
        if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
      } catch { /* gone already, or in use */ }
    }
  } catch { /* no directory yet */ }
}

/**
 * What is recoverable, newest first — BOTH generations.
 *
 * The caller pairs them: a `previous` record belongs to the `latest` whose
 * path it extends, and it is never offered on its own.  Sorting is by time
 * across the whole set, which is why the pairing is by path and not by order.
 */
export function listAutosaves(dir: string): AutosaveRecord[] {
  try {
    const out: AutosaveRecord[] = [];
    for (const name of fs.readdirSync(dir)) {
      if (generationOf(name) === null) continue;
      const meta = readMeta(path.join(dir, name));
      if (meta) out.push(meta);
    }
    return out
      .sort((a, b) => (
        // Newest first, and on a tie the newest GENERATION first.  Two writes
        // inside the same millisecond are ordinary for a small session, and
        // without this the order falls through to `readdir` — which could put
        // a `.bak` ahead of the autosave it backs up, in the one prompt that
        // has to be trusted.
        b.savedAtMs - a.savedAtMs
        || (a.generation === b.generation ? 0 : a.generation === 'latest' ? -1 : 1)
      ))
      .slice(0, LIST_LIMIT);
  } catch {
    return [];
  }
}

/**
 * Is `raw` a path inside `dir`?
 *
 * The renderer only ever gets paths from a listing, but this is the one place
 * a path from the renderer opens a file, so it is checked rather than trusted.
 */
export function isInsideDir(dir: string, raw: string): boolean {
  const resolved = path.resolve(raw);
  return resolved.startsWith(path.resolve(dir) + path.sep);
}

/** Write the session, keeping the previous generation.  Returns the target. */
export function writeAutosave(dir: string, id: string, data: string): string {
  const target = autosaveFile(dir, id);
  const backup = `${target}${BACKUP_SUFFIX}`;
  // A distinct temp name per write, so two writes racing cannot share one.
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    // Keep the previous one BEFORE the new bytes are written, and the order
    // matters for a reason that is not obvious.  `rename` preserves the temp
    // file's mtime, so writing the temp first and copying the backup second
    // left the newest autosave timestamped EARLIER than its own backup —
    // measured at 32.9 ms on a 10 MB session, and the gap is however long the
    // write takes.  Two things read that timestamp: the restore prompt, which
    // would have said the newest copy was older than the one before it, and
    // the staleness rule, which compares it against the last manual save and
    // would have withheld the newest work for understating its own age.
    //
    // Copying first costs nothing in safety: a death between the copy and the
    // rename leaves the target untouched and a backup identical to it.
    if (fs.existsSync(target)) {
      try { fs.copyFileSync(target, backup); } catch { /* best effort */ }
    }
    fs.writeFileSync(temp, data, 'utf8');
    // Atomic: after this the file is entirely old or entirely new.
    fs.renameSync(temp, target);
    return target;
  } catch (err) {
    try { fs.unlinkSync(temp); } catch { /* already gone */ }
    throw err;
  }
}
