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

/**
 * Reject the input unless it is a plausible audio sample rate.
 *
 * `daw:host-apply` took the renderer's number and passed it through to
 * `host.open(uid, sampleRate, channels)` — a call into a native AudioUnit
 * host.  `Number(undefined)` is NaN, and NaN was not refused anywhere on the
 * way: the handler checked `frames` and `channels` and skipped this one, so
 * the only unbounded value in the request was the one that reached C.
 *
 * The range is the same one `daw:pcm-source` has always enforced, because
 * there is no reason for two handlers to disagree about what a sample rate is.
 */
export const MIN_SAMPLE_RATE = 8000;
export const MAX_SAMPLE_RATE = 384_000;

export function validateSampleRate(input: unknown, channel: string): number {
  const rate = Number(input);
  if (!Number.isFinite(rate) || rate < MIN_SAMPLE_RATE || rate > MAX_SAMPLE_RATE) {
    throw new Error(`${channel}: sampleRate out of range`);
  }
  return rate;
}

/**
 * Reject the input unless it is a non-empty single-line string, trimmed.
 *
 * For the values that are text rather than paths — a licence key, a name.
 * `license:activate` handed the renderer's value straight to
 * `activateLicense`, whose first act is `key.toUpperCase()`: anything that is
 * not a string came back as `key.toUpperCase is not a function` instead of
 * the domain error the renderer knows how to show.
 */
export function validateText(
  input: unknown, channel: string, maxLength = 200,
): string {
  if (typeof input !== 'string') throw new Error(`${channel}: 문자열이 필요합니다`);
  const text = input.trim();
  if (text.length === 0) throw new Error(`${channel}: 값이 비어 있습니다`);
  if (text.length > maxLength) throw new Error(`${channel}: 값이 너무 깁니다`);
  // A control character in a licence key or a name is never intentional, and
  // it is how a newline ends up inside an HTTP header further down.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(text)) throw new Error(`${channel}: 제어 문자가 있습니다`);
  return text;
}
