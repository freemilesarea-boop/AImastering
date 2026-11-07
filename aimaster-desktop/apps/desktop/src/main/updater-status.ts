// Which update errors the user should hear about, and which are silence.
//
// "No release published yet" is not a failure: on a tag build whose GitHub
// Release exists but carries no `latest.yml`, or before the first release ever,
// electron-updater throws and the app must say nothing.  Everything else — an
// asset missing from a release we just offered, a signature that does not
// check out, a server that is down — the user needs.
//
// `updater.ts` decided this with four regexes over `err.message`.  Measured
// against the shapes the installed library actually produces:
//
//   /No published versions on GitHub/i      live
//   /Cannot find latest(-mac|-linux)?\.yml/ live
//   /404.*latest(-mac|-linux)?\.yml/i       DEAD — the real wrapped message is
//                                           `Cannot find latest-linux.yml in
//                                           the latest release artifacts (…):
//                                           HttpError: HTTP error: Not found`,
//                                           so the filename comes first and
//                                           there is no "404" in it at all
//   /HttpError:\s*404/i                     DEAD — `new HttpError(404).message`
//                                           is "HTTP error: Not found"; the
//                                           status lives in `statusCode` and
//                                           `code` ("HTTP_ERROR_404"), never in
//                                           the message
//
// And the gap that mattered: `ERR_UPDATER_LATEST_VERSION_NOT_FOUND`, whose
// message reads "Unable to find latest version on GitHub (…), please ensure a
// production release exists", matched NONE of the four — so the one error that
// says in words what the docblock set out to silence reached the user as a
// fatal error toast.
//
// The library sets a deliberate `code` on every one of these (`newError(msg,
// code)` in builder-util-runtime), so that is what this classifies on.  The
// two live patterns stay as a fallback for an error that arrives wrapped by
// something else, or from a version that does not set a code.

/** Codes that mean "there is nothing to offer yet", which is not a failure. */
export const NO_RELEASE_CODES: readonly string[] = [
  // No GitHub Release at all, or the feed has no entries.
  'ERR_UPDATER_NO_PUBLISHED_VERSIONS',
  // "please ensure a production release exists" — the same thing, said while
  // resolving the latest version.
  'ERR_UPDATER_LATEST_VERSION_NOT_FOUND',
  // The release exists but has no `latest.yml` yet: created, not published.
  'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND',
];

/**
 * Codes that are real failures, listed so the distinction is written down
 * rather than implied by the absence of a pattern.
 *
 * Every one of these is reached AFTER an update was found, which is why they
 * must not be silent: the user was offered something the app then could not
 * install.  `ERR_UPDATER_RELEASE_NOT_FOUND` is deliberately here and not
 * above — it only arises in the GitLab provider's download flow, by which
 * point a version had already been offered.
 */
export const REAL_FAILURE_CODES: readonly string[] = [
  'ERR_UPDATER_ASSET_NOT_FOUND',
  'ERR_UPDATER_BLOCKMAP_FILE_NOT_FOUND',
  'ERR_UPDATER_INVALID_SIGNATURE',
  'ERR_UPDATER_INVALID_UPDATE_INFO',
  'ERR_UPDATER_INVALID_VERSION',
  'ERR_UPDATER_NO_CHECKSUM',
  'ERR_UPDATER_NO_FILES_PROVIDED',
  'ERR_UPDATER_OLD_FILE_NOT_FOUND',
  'ERR_UPDATER_RELEASE_NOT_FOUND',
  'ERR_UPDATER_ZIP_FILE_NOT_FOUND',
];

/**
 * Message patterns for an error that reaches us without a usable code.
 *
 * Only the two that were measured to fire are here.  A pattern that cannot
 * match is not a safety net, it is a line that reads like one.
 */
export const NO_RELEASE_PATTERNS: readonly RegExp[] = [
  /No published versions on GitHub/i,
  // Both the GitHub provider ("Cannot find latest-linux.yml in the latest
  // release artifacts") and the generic one ("Cannot find channel
  // \"latest-linux.yml\" update info") say it this way.
  /Cannot find (channel ")?latest(-mac|-linux)?\.yml/i,
];

/** The error's `code`, when it has a string one. */
export function errorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === 'string') return m;
  }
  return String(err);
}

/**
 * Is this "no release published yet" rather than a failure?
 *
 * The code decides when there is one, including when it says the opposite —
 * a `REAL_FAILURE_CODES` error whose message happens to contain one of the
 * patterns is still a failure.  Only a coded-but-unknown or uncoded error
 * falls through to the patterns.
 */
export function isNoReleaseError(err: unknown): boolean {
  const code = errorCode(err);
  if (code !== undefined) {
    if (NO_RELEASE_CODES.includes(code)) return true;
    if (REAL_FAILURE_CODES.includes(code)) return false;
    // An HTTP status on its own says nothing about whether a release exists:
    // a 404 on `latest.yml` is silence, a 404 on the installer is not, and
    // the code is the same.  Fall through to the message.
  }
  return NO_RELEASE_PATTERNS.some((re) => re.test(errorMessage(err)));
}
