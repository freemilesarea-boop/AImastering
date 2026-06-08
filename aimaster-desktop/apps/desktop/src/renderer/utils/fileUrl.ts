/**
 * fileUrl — convert an absolute filesystem path into the
 * `aimaster-local://` URL the renderer hands to <audio>, <img>, fetch()
 * etc.  The custom scheme is registered + served (fs streaming with HTTP
 * Range) in `main/index.ts`, sidestepping Chromium's block on file://
 * resources from the renderer origin.
 *
 * ── URL format (v3.7) ───────────────────────────────────────────────────────
 *   aimaster-local://local/<encodeURIComponent(absolutePathWithForwardSlashes)>
 *
 * The ENTIRE path is encoded as ONE opaque segment under a fixed `local`
 * host.  This is the critical detail for cross-platform correctness:
 *
 * Chromium parses a `standard` scheme like http, so it pulls the first path
 * segment into the URL authority (host).  The earlier format
 * (`aimaster-local:///C:/Users/…`, drive in the path) was rewritten by
 * Chromium to `aimaster-local://c:/Users/…` — the drive letter became the
 * host, the `:` was parsed as a port delimiter, and the main side decoded a
 * mangled `/c/Users/…` that does not exist.  The file never loaded, so on
 * Windows the audio preview, waveform, and live detailed-controls (all gated
 * on the <audio> element's `loadedmetadata`) silently did nothing.  POSIX
 * paths survived only because `/Users/…` → host `Users` round-tripped back.
 *
 * Encoding the whole path (slashes → %2F, `:` → %3A, spaces/Korean → %xx)
 * under a constant host means Chromium has nothing to pull into the authority;
 * the encoded blob survives canonicalization verbatim on macOS AND Windows.
 * Verified against real Electron/Chromium for POSIX, Korean+spaces, and
 * `C:\…` drive paths.
 *
 * The helper is a pure function — tested directly without a DOM.
 */

const SCHEME = 'aimaster-local';
/** Fixed authority so Chromium never pulls a path segment / drive into the host. */
export const LOCAL_HOST = 'local';
const PREFIX = `${SCHEME}://`;

/** Convert an absolute path to an `aimaster-local://local/<encoded>` URL. */
export function toFileUrl(p: string): string {
  if (!p) return '';
  const normalized = p.replace(/\\/g, '/');
  return `${PREFIX}${LOCAL_HOST}/${encodeURIComponent(normalized)}`;
}

/** Inverse — decode the URL form back to a filesystem path.  Used by tests. */
export function fromFileUrl(u: string): string {
  if (!u.startsWith(PREFIX)) return u;
  try {
    const url = new URL(u);
    if (url.host === LOCAL_HOST) {
      const seg = url.pathname.startsWith('/') ? url.pathname.slice(1) : url.pathname;
      return decodeURIComponent(seg);
    }
  } catch { /* fall through to legacy decode */ }
  // Legacy (pre-v3.7) per-segment form.
  return decodeURIComponent(u.slice(PREFIX.length));
}
