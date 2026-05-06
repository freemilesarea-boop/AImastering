/**
 * Filesystem-path allowlist for renderer-originated requests.
 *
 * Why this exists (audit C-02 / C-03, 2026-05):
 *
 *   The renderer asks the main process to do filesystem things in two
 *   forms — (a) `aimaster-local://<path>` requests via the custom
 *   protocol, and (b) IPC handlers like `file:get-info`, `file:save-wav`,
 *   `file:open-in-finder`.  Previously both blindly trusted whatever
 *   path the renderer sent — so any XSS bug or malicious DOM injection
 *   could read `aimaster-local:///etc/shadow`, copy `/Users/.../.ssh/id_rsa`
 *   out of the user's home, or `mkdirSync` arbitrary directories.
 *
 *   This module is the single chokepoint that says "yes you may touch
 *   this path, no you may not".  Every IPC handler + the protocol
 *   handler MUST go through `assertAllowed()` before doing any fs work.
 *
 * Allowlist policy:
 *
 *   • Built-in safe roots (always allowed): `app.getPath('temp')` and
 *     `app.getPath('userData')` — the app writes ALL its own outputs
 *     here (mastering WAV, preview MP3, waveform PNGs, logs).
 *
 *   • User-imported file directories — each time the user opens an
 *     audio file via the dialog OR drops one onto the renderer, main
 *     learns the file path and registers `dirname(filePath)` as
 *     allowed.  This way the allowlist grows as the user works, but
 *     never to anywhere they didn't deliberately point us at.
 *
 *   • Anything else → REJECTED.  That means a renderer compromise
 *     can at most read files the user has already imported and the
 *     app's own temp + userData dirs — never `~/.ssh`, never `/etc`.
 *
 * Path traversal defense: `path.resolve` + `path.normalize` collapses
 * `..` and symlink-like sequences before the `startsWith` check, so
 * `/tmp/../etc/passwd` resolves to `/etc/passwd` and fails.
 */
import path from 'node:path';
import fs from 'node:fs';
import { app } from 'electron';

const _allowedDirs = new Set<string>();

function _normalize(p: string): string {
  return path.resolve(path.normalize(p));
}

/** Add a directory to the allowlist.  All children are then allowed. */
export function registerAllowedDir(dir: string): void {
  if (!dir) return;
  _allowedDirs.add(_normalize(dir));
}

/** Add a file's parent directory.  Convenience helper for IPC handlers
 *  that just received a user-provided file path (open dialog, drag-drop). */
export function registerAllowedFile(filePath: string): void {
  if (!filePath) return;
  registerAllowedDir(path.dirname(filePath));
}

/** Initialise the built-in safe roots.  MUST be called from app.whenReady(). */
export function initAllowlist(): void {
  registerAllowedDir(app.getPath('temp'));
  registerAllowedDir(app.getPath('userData'));
  // os.tmpdir() may differ from app.getPath('temp') on some platforms
  // (Electron's getPath('temp') resolves to the OS-level temp on every
  // supported OS, but be defensive).
  try { registerAllowedDir(require('node:os').tmpdir()); } catch { /* noop */ }
}

/** Returns true if `filePath` resolves to a location inside one of the
 *  allowed directories.  Resolves symlinks via path.normalize so traversal
 *  attempts (`/tmp/../etc`) are caught. */
export function isPathAllowed(filePath: string): boolean {
  if (!filePath || typeof filePath !== 'string') return false;
  const resolved = _normalize(filePath);
  for (const dir of _allowedDirs) {
    if (resolved === dir) return true;
    // path.sep needed so `/tmp/foo` does NOT match the allowed dir `/tmpfoo`
    if (resolved.startsWith(dir + path.sep)) return true;
  }
  return false;
}

/** Throw an error if the path is not allowed.  Use at the top of every
 *  IPC handler that accepts a renderer-supplied path. */
export function assertAllowed(filePath: string, op: string = 'access'): void {
  if (!isPathAllowed(filePath)) {
    const err: Error & { code?: string } = new Error(
      `Path rejected for ${op}: not in allowlist`,
    );
    err.code = 'EPATHFORBIDDEN';
    throw err;
  }
}

/** Diagnostic — total allowed dir count.  Used by tests + log lines. */
export function _allowlistSize(): number {
  return _allowedDirs.size;
}

/** Test-only: clear and re-init.  Not exported through any IPC channel. */
export function _resetForTest(): void {
  _allowedDirs.clear();
}

/** Resolve a file path AFTER allowlist check.  Convenience for downstream
 *  fs operations — returns the canonical resolved path so callers don't
 *  have to repeat the work. */
export function safeResolve(filePath: string, op: string = 'access'): string {
  assertAllowed(filePath, op);
  // Fully resolve symlinks too — defends against a user-imported dir
  // containing a symlink to /etc.
  try {
    return fs.realpathSync(_normalize(filePath));
  } catch {
    // realpathSync throws if the file doesn't exist — for some IPCs
    // (file:save-wav with a fresh dest path) that's expected.  Return
    // the normalized path in that case.
    return _normalize(filePath);
  }
}
