// localFileUrl — decode an `aimaster-local://` URL (built by the renderer's
// `toFileUrl`) back into an absolute filesystem path on the MAIN side.
//
// This is the inverse of `renderer/utils/fileUrl.ts#toFileUrl` and is the
// single source of truth for the protocol handler in `main/index.ts`.  It is
// a pure function so the Windows / macOS / Korean / spaces edge cases can be
// unit-tested without spinning up Electron (see phase-e-paths-safety.ts).
//
// ── URL format (v3.7) ───────────────────────────────────────────────────────
// `toFileUrl` now emits a fixed-host, single-encoded-segment URL:
//   aimaster-local://local/<encodeURIComponent(absolutePathWithForwardSlashes)>
// so Chromium's standard-scheme parser can't pull a path segment (POSIX) or a
// drive letter (Windows `C:`) into the authority.  See fileUrl.ts for the full
// rationale + the Windows bug this fixes.  We still accept the LEGACY
// per-segment form (drive-in-path or drive-as-host) so an in-flight URL from
// an older renderer bundle never hard-fails.

import { pathToFileURL } from 'node:url';

const PREFIX = 'aimaster-local://';
const LOCAL_HOST = 'local';
// Matches a leading-slash-before-drive-letter, e.g. `/C:/` or `/C:\` (legacy).
const LEADING_SLASH_DRIVE = /^\/([A-Za-z]:[\\/])/;

/** Decode an `aimaster-local://…` URL into an absolute filesystem path. */
export function localUrlToFsPath(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    // ── v3.7 format: fixed `local` host + whole path as one encoded segment ──
    if (u.host === LOCAL_HOST) {
      const seg = u.pathname.startsWith('/') ? u.pathname.slice(1) : u.pathname;
      return decodeURIComponent(seg);
    }
    // ── Legacy per-segment form ──
    // `standard` scheme → host is usually empty and the path is in pathname.
    // On Windows a drive path could surface as the host (`C:`) — recombine.
    const raw = u.host ? `/${u.host}${u.pathname}` : u.pathname;
    return decodeURIComponent(raw).replace(LEADING_SLASH_DRIVE, '$1');
  } catch {
    const legacy = decodeURIComponent(rawUrl.slice(PREFIX.length));
    return legacy.replace(LEADING_SLASH_DRIVE, '$1');
  }
}

/** Decode an `aimaster-local://…` URL into a `file://…` URL.  (Legacy helper —
 *  the protocol handler now streams the file directly via fs, but this is kept
 *  for any caller that still wants a file:// URL.) */
export function localUrlToFileUrl(rawUrl: string): string {
  return pathToFileURL(localUrlToFsPath(rawUrl)).toString();
}
