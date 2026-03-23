import type { IpcMain, BrowserWindow } from 'electron';
import { dialog } from 'electron';
import Store from 'electron-store';

const store = new Store({ name: 'settings' });

export function registerSettingsHandlers(ipc: IpcMain, win: BrowserWindow | null): void {
  ipc.handle('settings:get', (_e, key: string) => store.get(key));
  ipc.handle('settings:set', (_e, key: string, value: unknown) => { store.set(key, value); });

  ipc.handle('settings:choose-output-dir', async () => {
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    return result.canceled ? null : result.filePaths[0];
  });
}
