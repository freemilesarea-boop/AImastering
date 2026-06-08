// localFileResponse — pure helpers for serving a local file over the
// `aimaster-local://` protocol with correct HTTP Range semantics.
//
// ── Why this exists ─────────────────────────────────────────────────────────
// The protocol handler used to do `net.fetch('file://…', { headers: { Range }})`.
// Electron's `net.fetch` does NOT honour Range requests for the `file://`
// scheme consistently across platforms — on Windows the byte-range is ignored
// and the response is a plain 200 with the whole body (or none at all for a
// media element issuing a range probe).  Chromium's media pipeline relies on a
// `206 Partial Content` reply to read a file's metadata; when it never gets one
// the `<audio>` element's `loadedmetadata` event never fires, `duration` stays
// 0:00, and downstream code that gates on it (the realtime DSP install + the
// preview play button) silently does nothing.  That is the "preview + detailed
// controls don't respond on Windows" bug.
//
// Serving the file ourselves with `fs.createReadStream({ start, end })` makes
// the 206 reply identical on every platform.  These helpers are pure so the
// Range parsing + content-type mapping can be unit-tested without Electron.

import path from 'node:path';

/** Map a file extension to a media/image content type for the <audio>/<img>. */
const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  '.wav':  'audio/wav',
  '.wave': 'audio/wav',
  '.mp3':  'audio/mpeg',
  '.flac': 'audio/flac',
  '.aiff': 'audio/aiff',
  '.aif':  'audio/aiff',
  '.ogg':  'audio/ogg',
  '.oga':  'audio/ogg',
  '.m4a':  'audio/mp4',
  '.mp4':  'audio/mp4',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
};

/** Best-effort content type for a filesystem path (defaults to octet-stream). */
export function contentTypeForPath(fsPath: string): string {
  return CONTENT_TYPE_BY_EXT[path.extname(fsPath).toLowerCase()] ?? 'application/octet-stream';
}

export type RangeResult =
  | { kind: 'full' }                                   // no/empty Range → whole file
  | { kind: 'range'; start: number; end: number }      // satisfiable byte range (inclusive)
  | { kind: 'unsatisfiable' };                         // → 416

/**
 * Parse a single-range HTTP `Range` header against a known total size.
 *
 * Supports the forms the media element actually emits:
 *   bytes=0-          → from 0 to end
 *   bytes=START-END   → inclusive byte range
 *   bytes=-SUFFIX     → the last SUFFIX bytes
 * Multi-range (comma) and non-`bytes` units fall back to a full-body reply,
 * which is a valid (if non-optimal) response.  `end` is clamped to size-1.
 */
export function parseRangeHeader(rangeHeader: string | null | undefined, totalSize: number): RangeResult {
  if (!rangeHeader) return { kind: 'full' };
  const trimmed = rangeHeader.trim();
  const m = /^bytes=(\d*)-(\d*)$/.exec(trimmed);
  if (!m) return { kind: 'full' };           // multi-range / unknown unit → whole file

  const hasStart = m[1] !== '';
  const hasEnd = m[2] !== '';
  if (!hasStart && !hasEnd) return { kind: 'full' };

  // An empty file can't satisfy any concrete range.
  if (totalSize <= 0) return { kind: 'unsatisfiable' };

  let start: number;
  let end: number;
  if (!hasStart) {
    // Suffix range: last N bytes.
    const suffix = parseInt(m[2]!, 10);
    if (suffix <= 0) return { kind: 'unsatisfiable' };
    start = Math.max(0, totalSize - suffix);
    end = totalSize - 1;
  } else {
    start = parseInt(m[1]!, 10);
    end = hasEnd ? parseInt(m[2]!, 10) : totalSize - 1;
    if (end >= totalSize) end = totalSize - 1;
  }

  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= totalSize) {
    return { kind: 'unsatisfiable' };
  }
  return { kind: 'range', start, end };
}
