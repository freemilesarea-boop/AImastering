import type { IpcMain, BrowserWindow } from 'electron';
import { dialog, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

export function registerFileHandlers(ipc: IpcMain, win: BrowserWindow | null): void {
  // ── Open file picker ──────────────────────────────────────────────────
  ipc.handle('file:open-dialog', async () => {
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      filters: [{ name: 'Audio', extensions: ['wav', 'flac', 'aiff', 'aif', 'mp3', 'm4a'] }],
      properties: ['openFile'],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  // ── Generic save dialog (returns path only, no copy) ─────────────────
  ipc.handle('file:save-dialog', async (_e, defaultName: string) => {
    if (!win) return null;
    const result = await dialog.showSaveDialog(win, {
      defaultPath: defaultName,
      filters: [{ name: 'WAV', extensions: ['wav'] }],
    });
    return result.canceled ? null : result.filePath;
  });

  // ── Save WAV or MP3 — shows dialog, then copies from src ─────────────
  // Used by ResultPage for both WAV and MP3 export.
  ipc.handle('file:save-wav', async (_e, srcPath: string) => {
    if (!win || !srcPath) return null;

    const ext      = path.extname(srcPath).toLowerCase().replace('.', '');
    const isWav    = ext === 'wav';
    const filters  = isWav
      ? [{ name: 'WAV Audio', extensions: ['wav'] }]
      : [{ name: 'MP3 Audio', extensions: ['mp3'] }];

    const result = await dialog.showSaveDialog(win, {
      defaultPath: path.basename(srcPath),
      filters,
    });
    if (result.canceled || !result.filePath) return null;

    fs.copyFileSync(srcPath, result.filePath);
    return result.filePath;
  });

  // ── File info ─────────────────────────────────────────────────────────
  ipc.handle('file:get-info', (_e, filePath: string) => {
    const stat = fs.statSync(filePath);
    return {
      path:      filePath,
      name:      path.basename(filePath),
      sizeBytes: stat.size,
    };
  });

  // ── Reveal in Finder / Explorer ───────────────────────────────────────
  ipc.handle('file:open-in-finder', (_e, filePath: string) => {
    shell.showItemInFolder(filePath);
  });

  // ── Recent files (v1 stub) ────────────────────────────────────────────
  ipc.handle('file:get-recent', () => []);
}
