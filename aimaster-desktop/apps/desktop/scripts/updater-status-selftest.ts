// updater-status-selftest — which update errors reach the user, and which are
// silence.
//
// `updater.ts` had no test, because it imports electron and electron-updater
// at module load.  The rule it got wrong was the one it was written for.
//
// It classified "no release published yet" with four regexes over
// `err.message`.  Measured against the shapes the INSTALLED library produces
// (this file builds them with the library's own `newError` and `HttpError`, so
// a string change upstream shows up here rather than silently drifting):
//
//   · `/HttpError:\s*404/i` can never match: `new HttpError(404).message` is
//     "HTTP error: Not found".  The status is in `statusCode` and `code`.
//   · `/404.*latest\.yml/i` can never match: the real wrapped message names
//     the file first and carries no "404".
//   · `ERR_UPDATER_LATEST_VERSION_NOT_FOUND` — "please ensure a production
//     release exists" — matched NONE of the four, so the error that states
//     the silent case in words was shown to the user as a fatal toast.
//
// The library sets a deliberate code on every one of these, so that is what
// the classifier reads now.
//
// Run: pnpm --filter @aimaster/desktop test:updater-status

export {};

import { HttpError, newError } from 'builder-util-runtime';
import {
  NO_RELEASE_CODES, NO_RELEASE_PATTERNS, REAL_FAILURE_CODES,
  errorCode, errorMessage, isNoReleaseError,
} from '../src/main/updater-status.js';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail: string): void {
  if (ok) { passed++; console.log(`[PASS] ${name} — ${detail}`); }
  else { failed++; console.error(`[FAIL] ${name} — ${detail}`); }
}

/** The four patterns `updater.ts` used to decide this with. */
const LEGACY: ReadonlyArray<readonly [RegExp, string]> = [
  [/No published versions on GitHub/i, 'No published versions on GitHub'],
  [/404.*latest(-mac|-linux)?\.yml/i, '404 … latest*.yml'],
  [/Cannot find latest(-mac|-linux)?\.yml/i, 'Cannot find latest*.yml'],
  [/HttpError:\s*404/i, 'HttpError: 404'],
];
const legacySoft = (err: unknown): boolean =>
  LEGACY.some(([re]) => re.test(errorMessage(err)));

const YML_URL = 'https://github.com/o/r/releases/latest/download/latest-linux.yml';
const http404 = new HttpError(404);

/** The errors the installed library throws, built by its own constructors. */
const SILENT: ReadonlyArray<readonly [string, Error]> = [
  ['no GitHub Release at all',
    newError('No published versions on GitHub', 'ERR_UPDATER_NO_PUBLISHED_VERSIONS')],
  ['cannot resolve a latest version',
    newError(`Unable to find latest version on GitHub (${YML_URL}), please ensure a `
      + `production release exists: ${http404.stack ?? ''}`, 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND')],
  ['a release with no latest.yml in it (github provider)',
    newError(`Cannot find latest-linux.yml in the latest release artifacts (${YML_URL}): `
      + `${http404.stack ?? ''}`, 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND')],
  ['a release with no latest.yml in it (generic provider)',
    newError(`Cannot find channel "latest-linux.yml" update info: ${http404.stack ?? ''}`,
      'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND')],
];

/** Errors reached only AFTER an update was offered: the user must hear these. */
const LOUD: ReadonlyArray<readonly [string, Error]> = [
  ['the installer is missing from the release',
    newError('Cannot find asset "LV DAW-3.7.0.AppImage" in: [ … ]', 'ERR_UPDATER_ASSET_NOT_FOUND')],
  ['the blockmap for a delta download is missing',
    newError('Cannot find blockmap file for 3.7.0 in GitHub assets', 'ERR_UPDATER_BLOCKMAP_FILE_NOT_FOUND')],
  ['the download is not signed by us',
    newError('New version 3.7.0 is not signed by the application owner', 'ERR_UPDATER_INVALID_SIGNATURE')],
  ['the metadata does not parse',
    newError('Invalid update info: missing version', 'ERR_UPDATER_INVALID_UPDATE_INFO')],
  ['no checksum to verify against',
    newError('Checksum is not available', 'ERR_UPDATER_NO_CHECKSUM')],
  ['the server is down',
    new HttpError(503)],
];

function main(): void {
  console.log('\n=== WHAT THE LIBRARY ACTUALLY SAYS ===\n');

  check(
    "HttpError puts the status in `code`, not in the message — so the old `HttpError: 404` pattern was dead",
    http404.message === 'HTTP error: Not found'
      && errorCode(http404) === 'HTTP_ERROR_404'
      && !/HttpError:\s*404/i.test(http404.message),
    `message "${http404.message}", code ${errorCode(http404)}`,
  );

  {
    const dead = LEGACY.filter(([re]) =>
      ![...SILENT, ...LOUD].some(([, e]) => re.test(errorMessage(e))));
    check(
      'two of the four old patterns match nothing the library emits',
      dead.length === 2
        && dead.some(([, n]) => n === '404 … latest*.yml')
        && dead.some(([, n]) => n === 'HttpError: 404'),
      `dead: ${dead.map(([, n]) => n).join(', ') || '(none)'}`,
    );
  }

  console.log('\n=== SILENCE, INCLUDING THE ONE THAT USED TO SHOUT ===\n');

  for (const [label, err] of SILENT) {
    const now = isNoReleaseError(err);
    const before = legacySoft(err);
    check(
      `silent: ${label}`,
      now,
      before ? 'silent before and after' : `now silent — the old patterns called this FATAL (${errorCode(err)})`,
    );
  }

  {
    const regressed = SILENT.filter(([, e]) => !legacySoft(e)).map(([l]) => l);
    check(
      'the fix is not cosmetic: errors that used to reach the user as failures',
      regressed.length === 2,
      regressed.length ? regressed.join(' | ') : 'none, which would mean nothing changed',
    );
  }

  console.log('\n=== AND NOISE, BECAUSE AN OFFER THAT CANNOT INSTALL IS NOT SILENCE ===\n');

  for (const [label, err] of LOUD) {
    check(`loud: ${label}`, !isNoReleaseError(err), `code ${errorCode(err) ?? '(none)'}`);
  }

  {
    // The sharpest case: a real failure whose message happens to contain a
    // phrase from the pattern list.  A blockmap is named after the file it
    // belongs to, so "Cannot find latest-linux.yml.blockmap" reads to the
    // patterns exactly like the benign "Cannot find latest-linux.yml".  The
    // code has to win.  (The first version of this check used a message that
    // did NOT match any pattern, so it proved nothing and said so by
    // failing.)
    const trap = newError(
      'Cannot find latest-linux.yml.blockmap in GitHub assets',
      'ERR_UPDATER_BLOCKMAP_FILE_NOT_FOUND',
    );
    check(
      'a real failure whose text matches a pattern is still a failure',
      !isNoReleaseError(trap) && NO_RELEASE_PATTERNS.some((re) => re.test(trap.message)),
      'the code decides, and the message agrees it would have been fooled',
    );
  }

  console.log('\n=== AND NOTHING FALLS BETWEEN THE TWO LISTS ===\n');

  check(
    'no code is in both lists',
    NO_RELEASE_CODES.every((c) => !REAL_FAILURE_CODES.includes(c)),
    `${NO_RELEASE_CODES.length} silent + ${REAL_FAILURE_CODES.length} loud, no overlap`,
  );
  check(
    'an error with no code at all still falls back to the message',
    isNoReleaseError(new Error('No published versions on GitHub'))
      && !isNoReleaseError(new Error('socket hang up')),
    'uncoded soft message silent, uncoded real message loud',
  );
  check(
    'and nothing a caller can pass makes the classifier throw',
    [undefined, null, 'a string', 42, {}, { code: 7 }, new Error('x')]
      .every((v) => { try { isNoReleaseError(v); return true; } catch { return false; } }),
    'undefined, null, string, number, bare object, numeric code, Error',
  );

  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
  if (failed > 0) process.exit(1);
}

main();
