import type { IpcMain, BrowserWindow } from 'electron';
import { dialog } from 'electron';
import { settingsStore as store } from '../utils/settingsStore.js';

// Whitelist of persisted setting keys plus a per-key validator.  Anything
// the renderer hasn't been explicitly authorised to write is rejected —
// settings is a small, fixed surface so the table doubles as documentation.
const SETTING_VALIDATORS: Record<string, (v: unknown) => boolean> = {
  outputDir:          (v) => typeof v === 'string' && v.length > 0 && v.length < 4096 && !v.includes('\0'),
  defaultStyle:       (v) => v === 'balanced' || v === 'warm' || v === 'bright' || v === 'punch',
  // Exactly what the settings page offers and what MasteringOptions can
  // hold.  These used to be wider (88.2 kHz, 32-bit) than either, which was
  // invisible while nothing read the keys back; now that startup hydrates
  // from them, a value the option type cannot hold would be a value the
  // renderer has to throw away on every launch.
  defaultSampleRate:  (v) => v === 44100 || v === 48000 || v === 96000,
  defaultBitDepth:    (v) => v === 16 || v === 24,
};

export function registerSettingsHandlers(ipc: IpcMain, win: BrowserWindow | null): void {
  ipc.handle('settings:get', (_e, key: unknown) => {
    if (typeof key !== 'string' || !(key in SETTING_VALIDATORS)) {
      throw new Error(`settings:get: unknown key '${String(key)}'`);
    }
    return store.get(key);
  });

  ipc.handle('settings:set', (_e, key: unknown, value: unknown) => {
    if (typeof key !== 'string' || !(key in SETTING_VALIDATORS)) {
      throw new Error(`settings:set: unknown key '${String(key)}'`);
    }
    const validator = SETTING_VALIDATORS[key];
    if (!validator || !validator(value)) {
      throw new Error(`settings:set: value rejected for key '${key}'`);
    }
    store.set(key, value);
  });

  ipc.handle('settings:choose-output-dir', async () => {
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    return result.canceled ? null : result.filePaths[0];
  });
}
