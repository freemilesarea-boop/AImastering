/**
 * fileUrl — convert an absolute filesystem path into the
 * `aimaster-local://` URL the renderer hands to <audio>, <img>, fetch()
 * etc.  The custom scheme is registered in `main/index.ts` and proxies
 * to `net.fetch('file://...')`, sidestepping Chromium's block on
 * file:// resources from http:// dev origins.
 *
 * Edge cases handled:
 *
 *   • Backslashes (Windows)        — normalised to '/'
 *   • Spaces                       — encoded as `%20`
 *   • Fragment delimiter `#`       — encoded as `%23`
 *   • Query delimiter   `?`        — encoded as `%3F`
 *   • Korean / non-ASCII (UTF-8)   — encoded per-segment
 *   • Drive letters `C:\foo\bar`   — preserved as `/C:/foo/bar`
 *
 * The original v3.5 helper used a single `encodeURI()` call which
 * left `#` and `?` un-escaped — those characters are reserved URI
 * delimiters and would truncate the path on its way to the main-side
 * `decodeURIComponent(request.url.slice(prefix.length))`.  We now
 * `encodeURIComponent` every segment between `/` separators, which is
 * round-trip-safe with the existing main-side decoder.
 *
 * The helper is a pure function — tested directly without a DOM.
 */

/** Convert an absolute path to an `aimaster-local://...` URL. */
export function toFileUrl(p: string): string {
  if (!p) return '';
  const normalized = p.replace(/\\/g, '/');
  const withSlash  = normalized.startsWith('/') ? normalized : `/${normalized}`;
  // Preserve the leading slash, encode each segment.  Empty segments
  // (consecutive slashes) round-trip as `//` which Chromium accepts.
  const encoded = withSlash
    .split('/')
    .map(encodeURIComponent)
    .join('/');
  return `aimaster-local://${encoded}`;
}

/** Inverse — decode the URL form back to a filesystem path.  Used by tests. */
export function fromFileUrl(u: string): string {
  const prefix = 'aimaster-local://';
  if (!u.startsWith(prefix)) return u;
  return decodeURIComponent(u.slice(prefix.length));
}
