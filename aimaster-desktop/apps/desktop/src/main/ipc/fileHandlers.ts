import type { IpcMain, BrowserWindow } from 'electron';
import { dialog, shell } from 'electron';
import fs from 'node:fs';

export function registerFileHandlers(ipc: IpcMain, win: BrowserWindow | null): void {
  ipc.handle('file:open-dialog', async () => {
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      filters: [{ name: 'Audio', extensions: ['wav', 'flac', 'aiff', 'mp3', 'm4a'] }],
      properties: ['openFile'],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipc.handle('file:save-dialog', async (_e, defaultName: string) => {
    if (!win) return null;
    const result = await dialog.showSaveDialog(win, {
      defaultPath: defaultName,
      filters: [{ name: 'WAV', extensions: ['wav'] }],
    });
    return result.canceled ? null : result.filePath;
  });

  ipc.handle('file:get-info', (_e, filePath: string) => {
    const stat = fs.statSync(filePath);
    return { path: filePath, name: filePath.split('/').pop(), sizeBytes: stat.size };
  });

  ipc.handle('file:open-in-finder', (_e, filePath: string) => {
    shell.showItemInFolder(filePath);
  });
}
