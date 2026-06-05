// localFileUrl — decode an `aimaster-local://` URL (built by the renderer's
// `toFileUrl`) back into an absolute filesystem path on the MAIN side, then
// into a `file://` URL that `net.fetch` can read.
//
// This is the inverse of `renderer/utils/fileUrl.ts#toFileUrl` and is the
// single source of truth for the protocol handler in `main/index.ts`.  It is
// a pure function so the Windows / macOS / Korean / spaces edge cases can be
// unit-tested without spinning up Electron (see phase-e-paths-safety.ts).
//
// ── The Windows bug this fixes ────────────────────────────────────────────
// `toFileUrl('C:\\Users\\foo\\song.wav')` produces
//   aimaster-local:///C%3A/Users/foo/song.wav
// because it normalises backslashes to `/` and prepends a leading `/` to every
// path.  Decoding that yields `/C:/Users/foo/song.wav` — note the leading
// slash BEFORE the drive letter.  On Windows `pathToFileURL`/`path.resolve`
// treat `/C:/...` as a drive-relative path and mangle it to `\C:\...`, which
// is not a valid path, so `net.fetch` fails and the renderer's <audio>,
// waveform fetch, and live-preview decode all silently get nothing — the
// "preview doesn't work on Windows" report.  Stripping the leading slash when
// the path looks like `/<letter>:/` restores a valid `C:/Users/...` path.
// macOS/Linux paths (`/Users/...`, `/home/...`) never match the drive regex,
// so they are untouched.

import { pathToFileURL } from 'node:url';

const PREFIX = 'aimaster-local://';
// Matches a leading-slash-before-drive-letter, e.g. `/C:/` or `/C:\`.
const LEADING_SLASH_DRIVE = /^\/([A-Za-z]:[\\/])/;

/** Decode an `aimaster-local://…` URL into an absolute filesystem path. */
export function localUrlToFsPath(rawUrl: string): string {
  let absPath: string;
  try {
    const u = new URL(rawUrl);
    // `standard` scheme → host is usually empty and the path is in pathname.
    // On Windows a drive path can surface as the host (`C:`) — recombine.
    const raw = u.host ? `/${u.host}${u.pathname}` : u.pathname;
    absPath = decodeURIComponent(raw);
  } catch {
    absPath = decodeURIComponent(rawUrl.slice(PREFIX.length));
  }
  // Windows drive paths arrive as `/C:/Users/...`; drop the leading slash so
  // the drive letter leads and `pathToFileURL` produces a valid path.
  return absPath.replace(LEADING_SLASH_DRIVE, '$1');
}

/** Decode an `aimaster-local://…` URL into a `file://…` URL for `net.fetch`. */
export function localUrlToFileUrl(rawUrl: string): string {
  return pathToFileURL(localUrlToFsPath(rawUrl)).toString();
}
