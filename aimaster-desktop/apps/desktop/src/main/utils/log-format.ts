// What a log record says, and the four ways it used to say nothing.
//
// `logger.ts` built every record with `' ' + JSON.stringify(extra)`.  Measured,
// with the value the call site actually passes:
//
//   new Error('boom')                → " {}"
//   Error with .code = 'ENOENT'      → " {\"code\":\"ENOENT\"}"   (message gone)
//   'python said hello'              → " \"python said hello\""   (quoted)
//   JSON.stringify({reason:'oom'})   → " \"{\\\"reason\\\":\\\"oom\\\"}\""
//   an object holding itself         → THROWS  (circular structure)
//   { big: 1n }                      → THROWS  (BigInt)
//
// `JSON.stringify` of an Error returns `{}` because `message` and `stack` are
// not enumerable own properties.  Eleven call sites in the main process pass a
// raw error, and two of them are the ones that matter most:
//
//   log.error('[CRASH] Uncaught exception', err);
//   log.error('[CRASH] Unhandled rejection', reason);
//
// So the file left behind after a crash read `[CRASH] Uncaught exception {}`,
// and a rejection carrying a cycle — a value holding a socket or a response is
// the ordinary case — threw INSIDE the handler, because the old `try` wrapped
// only the `appendFileSync` and not the formatting above it.
//
// Nothing here imports electron, so all of it is testable.  `logger.ts` keeps
// the parts that cannot be: `app.getPath`, the file handle, stdout.
import path from 'node:path';

/** One record stays readable; a dump does not become the log. */
export const MAX_EXTRA_CHARS = 4000;
/** How far down an error's `cause` chain a record follows. */
export const MAX_CAUSE_DEPTH = 3;
/** Log files older than this are swept.  A month-old crash is not coming back. */
export const KEEP_DAYS = 30;

function clip(text: string): string {
  if (text.length <= MAX_EXTRA_CHARS) return text;
  return `${text.slice(0, MAX_EXTRA_CHARS)} …(+${text.length - MAX_EXTRA_CHARS} chars)`;
}

/** JSON that cannot throw: cycles, BigInts and getters that fail are named. */
export function safeJson(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (_k, v: unknown) => {
      if (typeof v === 'bigint') return `${v}n`;
      if (typeof v === 'function') return '[function]';
      if (typeof v === 'object' && v !== null) {
        if (seen.has(v)) return '[circular]';
        seen.add(v);
      }
      return v;
    }) ?? String(value);
  } catch {
    // A throwing getter, a Proxy that refuses, a toJSON that throws.
    try { return String(value); } catch { return '[unserializable]'; }
  }
}

function isError(v: unknown): v is Error {
  return v instanceof Error
    // Across a context boundary `instanceof` fails, and an error from a
    // worker or a bundled copy of a library is still an error.
    || (typeof v === 'object' && v !== null
        && typeof (v as { message?: unknown }).message === 'string'
        && typeof (v as { stack?: unknown }).stack === 'string');
}

function describeError(err: Error, depth: number): string {
  const e = err as Error & { code?: unknown; cause?: unknown };
  const name = err.name || 'Error';
  const head = `${name}: ${err.message || '(no message)'}`
    + (e.code !== undefined ? ` (code=${String(e.code)})` : '');
  // The stack's own first line repeats name and message, so it is dropped
  // rather than printed twice.
  const frames = typeof err.stack === 'string'
    ? err.stack.split('\n').slice(1).join('\n')
    : '';
  // Anything the thrower attached beyond the standard fields is worth having:
  // this is where a wrapped HTTP status or a path usually lives.
  // `name`, `message` and `stack` are already in the head and the frames.  On
  // a real Error they are not own enumerable keys and never appear here; on an
  // error-shaped object from another context they are, and printing them again
  // put the whole stack in the record twice.
  const SAID = new Set(['code', 'cause', 'name', 'message', 'stack']);
  const own = Object.keys(e).filter((k) => !SAID.has(k));
  const extras = own.length > 0
    ? ` ${safeJson(Object.fromEntries(own.map((k) => [k, (e as unknown as Record<string, unknown>)[k]])))}`
    : '';
  let out = head + extras + (frames ? `\n${frames}` : '');
  if (e.cause !== undefined && depth < MAX_CAUSE_DEPTH) {
    out += `\ncaused by: ${isError(e.cause)
      ? describeError(e.cause as Error, depth + 1)
      : safeJson(e.cause)}`;
  }
  return out;
}

/**
 * The `extra` half of a record.  Returns '' or a leading-space string, and
 * never throws — a log call is not allowed to be the thing that fails.
 */
export function formatExtra(extra: unknown): string {
  if (extra === undefined) return '';
  try {
    // A string is already what it wants to say.  The old code quoted and
    // escaped it, which made `log.info('[python]', line)` unreadable and the
    // three pre-stringified `[CRASH]` records doubly escaped.
    if (typeof extra === 'string') return extra === '' ? '' : ` ${clip(extra)}`;
    if (isError(extra)) return ` ${clip(describeError(extra, 0))}`;
    return ` ${clip(safeJson(extra))}`;
  } catch {
    return ' [log formatting failed]';
  }
}

/** A whole record, newline included. */
export function logLine(level: string, msg: string, extra: unknown, nowIso: string): string {
  return `[${nowIso}] [${level}] ${msg}${formatExtra(extra)}\n`;
}

/**
 * Which of these log files are old enough to delete.
 *
 * Pure, and by the DATE IN THE NAME rather than mtime: a file is named for the
 * day it covers, and an mtime is whatever the filesystem last felt like
 * saying.  Anything that is not a dated log file is left alone — this runs in
 * a directory the app does not own exclusively.
 */
export function staleLogs(names: readonly string[], nowMs: number, keepDays = KEEP_DAYS): string[] {
  const cutoff = nowMs - keepDays * 24 * 60 * 60 * 1000;
  const out: string[] = [];
  for (const name of names) {
    const match = /^(\d{4})-(\d{2})-(\d{2})\.log$/.exec(path.basename(name));
    if (!match) continue;
    const day = Date.parse(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`);
    if (Number.isNaN(day)) continue;
    // The end of that day, so today's file is never swept on the day itself.
    if (day + 24 * 60 * 60 * 1000 < cutoff) out.push(name);
  }
  return out;
}
