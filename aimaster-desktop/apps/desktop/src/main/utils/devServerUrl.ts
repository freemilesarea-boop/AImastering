// devServerUrl — which URL the dev window loads, and whether to trust it.
//
// `main/index.ts` hardcoded `http://localhost:5173`.  `VITE_DEV_SERVER_URL`
// looks exactly like the override for that and was read nowhere: a dev server
// started on any other port simply was not what the window loaded, silently.
// Time went into that twice — once writing `ui-hit-test`, once before it.
//
// ── Why this validates rather than trusting the string ──────────────────────
//
// An environment variable that decides what a BrowserWindow loads is a remote
// code path if it is ever read outside development: the renderer runs with
// this app's preload and its IPC surface.  The caller only consults this in
// the `isDev` branch, which is the real guard — but a second one that lives
// with the parsing costs nothing and does not depend on the caller staying
// careful.  Loopback http only: no other host, no file://, no data:.
//
// A rejected value is REPORTED, not silently swapped for the default.  Quietly
// ignoring a malformed override is the same failure as never reading it.

export const DEFAULT_DEV_SERVER = 'http://localhost:5173';

/** Hosts a dev server can legitimately be on. */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export interface DevServerChoice {
  /** The origin to load, always without a trailing slash. */
  origin: string;
  /** Set when an override was given and refused — worth logging. */
  rejected?: string;
}

/**
 * Pick the dev origin from the environment, falling back to the default.
 *
 * `raw` is `process.env.VITE_DEV_SERVER_URL`; undefined and empty both mean
 * "nobody asked for anything", which is not a rejection.
 */
export function devServerOrigin(raw: string | undefined): DevServerChoice {
  const trimmed = (raw ?? '').trim();
  if (trimmed === '') return { origin: DEFAULT_DEV_SERVER };

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { origin: DEFAULT_DEV_SERVER, rejected: `${trimmed} — not a URL` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { origin: DEFAULT_DEV_SERVER, rejected: `${trimmed} — only http(s)` };
  }
  if (!LOOPBACK.has(url.hostname)) {
    return { origin: DEFAULT_DEV_SERVER, rejected: `${trimmed} — only a loopback host` };
  }
  // `origin` drops any path, query or fragment the caller may have appended,
  // which matters because the page query is added below and two of them would
  // make a URL the router cannot read.
  return { origin: url.origin };
}

/**
 * The full URL for the dev window, including the start page when one is asked
 * for.  `page` is `LOUI_DEV_PAGE` — see `stores/appStore.ts`.
 */
export function devServerUrl(raw: string | undefined, page?: string | undefined): DevServerChoice {
  const choice = devServerOrigin(raw);
  const wanted = (page ?? '').trim();
  const origin = wanted === ''
    ? choice.origin
    : `${choice.origin}/?page=${encodeURIComponent(wanted)}`;
  return choice.rejected === undefined ? { origin } : { origin, rejected: choice.rejected };
}
