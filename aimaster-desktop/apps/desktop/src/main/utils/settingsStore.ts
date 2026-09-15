// settingsStore — the one persisted-settings store, and the settings that the
// rest of the main process reads out of it.
//
// `settings:set` used to be the end of the line: the renderer wrote a key,
// electron-store persisted it, and nothing ever read it back.  All four keys on
// the settings page were like that, so the page told people their choice was
// saved and then ignored it.  The store lives here now rather than inside the
// IPC handlers so the code that USES a setting does not have to go through an
// IPC round trip to learn it.
//
// The rules for turning a stored path into a dialog default are in
// utils/savePath.ts, which has no Electron import and so can be tested.

import Store from 'electron-store';
import fs from 'node:fs';
import { resolveOutputDir, joinSavePath } from './savePath.js';

export const settingsStore = new Store({ name: 'settings' });

function isDirectory(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/** The folder the user chose for exports, or null — see `resolveOutputDir`. */
export function outputDir(): string | null {
  return resolveOutputDir(settingsStore.get('outputDir'), isDirectory);
}

/** `defaultPath` for a save dialog suggesting `basename` — see `joinSavePath`. */
export function defaultSavePath(basename: string): string {
  return joinSavePath(basename, outputDir());
}
