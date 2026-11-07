// The record the app leaves behind.
//
// Every rule about what a record SAYS lives in `log-format.ts`, which imports
// no electron and is therefore testable; this file keeps the parts that are
// not: `app.getPath`, the file handle, stdout, and the once-per-process sweep.
// That split is why `[CRASH] Uncaught exception {}` went unnoticed for so
// long — the formatting sat next to an electron import, where nothing could
// reach it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import { logLine, staleLogs } from './log-format.js';

function logDir(): string {
  try {
    return path.join(app.getPath('userData'), 'logs');
  } catch {
    // Fallback when userData is unavailable (e.g. very early startup).
    // Use os.tmpdir() — `/tmp` does not exist on Windows, so a hardcoded
    // POSIX path would silently drop logs there.
    return path.join(os.tmpdir(), 'aimaster-logs');
  }
}

let swept = false;

/** Delete the log files nobody is coming back for.  Once per process. */
function sweepOnce(dir: string): void {
  if (swept) return;
  swept = true;
  try {
    for (const name of staleLogs(fs.readdirSync(dir), Date.now())) {
      try { fs.unlinkSync(path.join(dir, name)); } catch { /* gone, or in use */ }
    }
  } catch { /* no directory yet */ }
}

function logFile(): string {
  const dir = logDir();
  fs.mkdirSync(dir, { recursive: true });
  sweepOnce(dir);
  const date = new Date().toISOString().slice(0, 10);
  return path.join(dir, `${date}.log`);
}

/**
 * Write one record.
 *
 * Nothing in here may throw.  The old shape built the line OUTSIDE the `try`,
 * so an extra holding a cycle or a BigInt threw out of the log call itself —
 * including out of the `unhandledRejection` handler, whose whole job is to be
 * the last thing that still works.  `logLine` cannot throw; stdout can
 * (EPIPE, a closed handle in a packaged app), so it is guarded too.
 */
function write(level: string, msg: string, extra?: unknown): void {
  const line = logLine(level, msg, extra, new Date().toISOString());
  try { process.stdout.write(line); } catch { /* no stdout to write to */ }
  try {
    fs.appendFileSync(logFile(), line);
  } catch {
    // non-critical
  }
}

export const log = {
  info:  (msg: string, extra?: unknown) => write('INFO',  msg, extra),
  warn:  (msg: string, extra?: unknown) => write('WARN',  msg, extra),
  error: (msg: string, extra?: unknown) => write('ERROR', msg, extra),
};
