/**
 * What plugins are installed, and where the app looked.
 *
 * Scanning touches the filesystem and shells out to `plutil` on macOS, so it
 * lives in main.  The result is cached: a scan walks several directories and
 * reads a file per bundle, and a user with three hundred plugins should not
 * pay for that every time they open a menu.
 */

import { app, type IpcMain } from 'electron';
import { spawnSync } from 'node:child_process';
import { scanPlugins, type ScanResult } from '../plugins/scan.js';
import { log } from '../utils/logger.js';

let cached: ScanResult | null = null;

/** Run a system tool and return its stdout, or null if it is unavailable. */
function runTool(bin: string, args: string[]): string | null {
  try {
    const result = spawnSync(bin, args, { encoding: 'utf8', timeout: 5000, windowsHide: true });
    if (result.status !== 0 || result.error) return null;
    return result.stdout;
  } catch {
    return null;
  }
}

export function registerPluginHandlers(ipc: IpcMain): void {
  ipc.handle('plugins:scan', (_e, force: unknown): ScanResult => {
    if (cached && force !== true) return cached;
    const started = Date.now();
    cached = scanPlugins({ home: app.getPath('home'), runTool });
    log.info(
      `[plugins] ${cached.plugins.length} found in ${Date.now() - started} ms`
      + ` (${cached.searched.length} folders, ${cached.skipped.length} skipped)`,
    );
    return cached;
  });
}
