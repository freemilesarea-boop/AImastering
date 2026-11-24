import type { IpcMain, BrowserWindow } from 'electron';
import { dialog } from 'electron';
import { DEFAULT_UI_SCALE, isUiScale } from '@aimaster/shared-types';
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
  // The steps are the shared list, not a range — see UI_SCALES.  A renderer
  // that offered 1.3 would be refused here rather than quietly stored as a
  // value the settings page can never show as selected again.
  uiScale:            isUiScale,
};

/**
 * Put the stored scale on the window.
 *
 * Exported because two places need it and they must not each have their own
 * idea of what "no setting yet" means: the handler below, when the user picks
 * a step, and startup, which has to apply what was picked last time.  A
 * renderer that loads at 100 % and jumps a moment later is the same bug as not
 * applying it at all.
 */
export function applyUiScale(win: BrowserWindow | null): number {
  const stored = store.get('uiScale');
  const scale = isUiScale(stored) ? stored : DEFAULT_UI_SCALE;
  win?.webContents.setZoomFactor(scale);
  return scale;
}

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
    // Applied in the same call that stores it.  A separate `ui:set-zoom`
    // channel would be a second thing to keep in step with the first, and the
    // failure would be silent: the number saved, the window unchanged.
    if (key === 'uiScale') applyUiScale(win);
  });

  ipc.handle('settings:choose-output-dir', async () => {
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    return result.canceled ? null : result.filePaths[0];
  });
}
