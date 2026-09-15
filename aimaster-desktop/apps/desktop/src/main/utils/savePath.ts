// savePath — where a save dialog should open, decided without touching disk.
//
// Split out of settingsStore.ts so it can be tested: that module constructs an
// electron-store, which needs a running Electron app, and this is the part with
// the rules in it.

import path from 'node:path';

/**
 * Validate a stored output directory.
 *
 * `isDirectory` is injected rather than called here so a test does not need a
 * filesystem — and so the one caller that does touch the disk is the one place
 * that has to think about a path that throws.
 *
 * Null when unset, not a string, empty, or no longer a folder on this machine.
 * An unplugged drive and a deleted folder both have to read as "no choice":
 * handing a dead path to a save dialog is worse than handing it nothing,
 * because macOS silently opens somewhere else and Windows shows an error the
 * user cannot act on.
 */
export function resolveOutputDir(
  raw: unknown,
  isDirectory: (p: string) => boolean,
): string | null {
  if (typeof raw !== 'string' || raw === '') return null;
  return isDirectory(raw) ? raw : null;
}

/**
 * What to hand a save dialog as `defaultPath` for a file called `basename`.
 *
 * With a directory, the dialog opens there.  Without one, this is the bare
 * basename and Electron opens wherever the user last saved — which is exactly
 * what every one of these dialogs did before the setting was wired up, so an
 * unset preference changes nothing.
 *
 * `basename` is taken as a name, never a path: a caller that passed something
 * with separators in it could otherwise steer the dialog out of the chosen
 * folder, which is the one thing this is for.
 */
export function joinSavePath(basename: string, dir: string | null): string {
  const name = path.basename(basename);
  return dir === null ? name : path.join(dir, name);
}
