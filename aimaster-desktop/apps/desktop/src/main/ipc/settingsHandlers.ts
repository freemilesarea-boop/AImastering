import type { IpcMain, BrowserWindow } from 'electron';
import { dialog } from 'electron';
import Store from 'electron-store';

const store = new Store({ name: 'settings' });

// Whitelist of persisted setting keys plus a per-key validator.  Anything
// the renderer hasn't been explicitly authorised to write is rejected —
// settings is a small, fixed surface so the table doubles as documentation.
const SETTING_VALIDATORS: Record<string, (v: unknown) => boolean> = {
  outputDir:          (v) => typeof v === 'string' && v.length > 0 && v.length < 4096 && !v.includes('\0'),
  defaultStyle:       (v) => v === 'balanced' || v === 'warm' || v === 'bright' || v === 'punch',
  defaultSampleRate:  (v) => v === 44100 || v === 48000 || v === 88200 || v === 96000,
  defaultBitDepth:    (v) => v === 16 || v === 24 || v === 32,
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
