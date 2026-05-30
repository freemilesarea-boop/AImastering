// Lightweight input-validation helpers shared by IPC handlers.
//
// IPC inputs are untrusted: even though the renderer is sandboxed and
// contextIsolation is on, defence-in-depth blocks obvious abuse (null-byte
// injection, non-absolute paths, missing string types).  The validators
// throw a plain Error so the renderer sees a deterministic IPC rejection.

import path from 'node:path';

/**
 * Reject the input unless it is a non-empty string, contains no null bytes,
 * and resolves to an absolute filesystem path.  Returns the resolved form
 * so callers can use it directly without re-resolving.
 */
export function validateAbsoluteFilePath(input: unknown, channel: string): string {
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error(`${channel}: filePath must be a non-empty string`);
  }
  if (input.includes('\0')) {
    throw new Error(`${channel}: null byte in path`);
  }
  const resolved = path.resolve(input);
  if (!path.isAbsolute(resolved)) {
    throw new Error(`${channel}: path must resolve to an absolute location`);
  }
  return resolved;
}

/** Reject the input unless it is a non-null, non-array plain object. */
export function validatePlainObject(input: unknown, channel: string): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(`${channel}: payload must be a JSON object`);
  }
  return input as Record<string, unknown>;
}
