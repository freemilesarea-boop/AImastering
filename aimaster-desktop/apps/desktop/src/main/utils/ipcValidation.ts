// Lightweight input-validation helpers shared by IPC handlers.
//
// IPC inputs are untrusted: even though the renderer is sandboxed and
// contextIsolation is on, defence-in-depth blocks obvious abuse (null-byte
// injection, non-absolute paths, missing string types).  The validators
// throw a plain Error so the renderer sees a deterministic IPC rejection.

import path from 'node:path';

/**
 * Reject the input unless it is a non-empty string with no null bytes that
 * is already an ABSOLUTE filesystem path.  Returns it resolved, so callers
 * can use the result directly without re-resolving.
 *
 * # The check that could not fail
 *
 * This used to resolve first and then ask whether the RESULT was absolute:
 *
 *     const resolved = path.resolve(input);
 *     if (!path.isAbsolute(resolved)) throw ...
 *
 * `path.resolve()` always returns an absolute path — it joins its argument
 * onto `process.cwd()` when it has to — so the condition was never true and
 * the throw was dead code.  The comment above has always said non-absolute
 * paths are blocked.  They were not; they were silently resolved against
 * whatever directory the main process happened to start in:
 *
 *     "foo.wav"                 → <cwd>/foo.wav
 *     "../../../../etc/passwd"  → <four levels above cwd>/etc/passwd
 *     "~/secret.wav"            → <cwd>/~/secret.wav   (a literal ~ folder)
 *     "."                       → <cwd>
 *
 * Every real caller sends a path that came from a file dialog, a drop, or
 * an engine output path, so all of them are absolute already and none of
 * them lose anything.  What the app gains is that the guarantee in the
 * signature is now a fact: a handler that writes to its argument cannot be
 * steered into a cwd-relative location.
 *
 * # What is still resolved, and why
 *
 * An absolute path can carry traversal segments of its own
 * (`/a/b/../../etc/passwd`), so the return value is resolved: the segments
 * are collapsed once, here, and the caller works with the normalised form
 * instead of each handler deciding separately.
 *
 * # What this deliberately does NOT do
 *
 * It does not confine the path to any root.  These channels exist to open
 * and save the user's own files anywhere on their disk, so containment
 * would be wrong.  Where a path arrives from CONTENT rather than from the
 * user — a `sample=` line inside somebody else's .sfz, a stem name — that
 * is a different job with a different answer, and `samplePath.ts` /
 * `stemPath.ts` do it: refuse absolute, then require containment.
 */
export function validateAbsoluteFilePath(input: unknown, channel: string): string {
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error(`${channel}: filePath must be a non-empty string`);
  }
  if (input.includes('\0')) {
    throw new Error(`${channel}: null byte in path`);
  }
  if (!path.isAbsolute(input)) {
    throw new Error(`${channel}: path must be absolute`);
  }
  return path.resolve(input);
}
