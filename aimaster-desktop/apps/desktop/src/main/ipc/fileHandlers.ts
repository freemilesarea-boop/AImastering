import type { IpcMain, BrowserWindow } from 'electron';
import { app, dialog, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { log } from '../utils/logger.js';
import {
  registerAllowedFile,
  assertAllowed,
  isPathAllowed,
} from '../utils/pathAllowlist.js';

// C-03 fix (audit 2026-05): every handler that touches a renderer-supplied
// path now goes through the path allowlist.  Prior behaviour blindly
// trusted whatever string the renderer sent, allowing read/copy of any
// file (`/etc/shadow`, `~/.ssh/id_rsa`) and even mkdirSync on arbitrary
// directories from `file:open-in-finder`.

export function registerFileHandlers(ipc: IpcMain, win: BrowserWindow | null): void {
  // ── Open file picker (single) — registers chosen path's dir ──────────
  ipc.handle('file:open-dialog', async () => {
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      filters: [{ name: 'Audio', extensions: ['wav', 'flac', 'aiff', 'aif', 'mp3', 'm4a'] }],
      properties: ['openFile'],
    });
    if (result.canceled) return null;
    const fp = result.filePaths[0];
    if (fp) registerAllowedFile(fp);
    return fp;
  });

  // ── Open file picker (multi, up to 20) ────────────────────────────────
  ipc.handle('file:open-dialog-multi', async () => {
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      filters: [{ name: 'Audio', extensions: ['wav', 'flac', 'aiff', 'aif', 'mp3', 'm4a'] }],
      properties: ['openFile', 'multiSelections'],
    });
    if (result.canceled) return null;
    const paths = result.filePaths.slice(0, 20);
    for (const p of paths) registerAllowedFile(p);
    return paths;
  });

  // ── Drag-and-drop registration channel (NEW, C-02 / C-03 fix) ─────────
  // Renderer drops files onto the window via the OS DnD layer; main
  // never sees those paths via dialog so we expose this channel for the
  // renderer to register them BEFORE invoking any path-bearing IPC.
  ipc.handle('file:register-paths', (_e, paths: unknown) => {
    if (!Array.isArray(paths)) return { registered: 0 };
    let n = 0;
    for (const p of paths) {
      if (typeof p !== 'string' || !p) continue;
      registerAllowedFile(p);
      n++;
    }
    return { registered: n };
  });

  // ── Generic save dialog (returns path only, no copy) ─────────────────
  ipc.handle('file:save-dialog', async (_e, defaultName: string) => {
    if (!win) return null;
    const result = await dialog.showSaveDialog(win, {
      defaultPath: defaultName,
      filters: [{ name: 'WAV', extensions: ['wav'] }],
    });
    if (result.canceled || !result.filePath) return null;
    // Allow subsequent reads of the directory we're about to write to.
    registerAllowedFile(result.filePath);
    return result.filePath;
  });

  // ── Save WAV or MP3 — shows dialog, then copies from src ─────────────
  // src MUST be a path our pipeline produced (lives in os.tmpdir()) OR
  // a path the user previously imported.  Anything else is rejected.
  ipc.handle('file:save-wav', async (_e, srcPath: string) => {
    if (!win || !srcPath) return null;
    try {
      assertAllowed(srcPath, 'file:save-wav (src)');
    } catch (err) {
      log.warn('[file:save-wav] BLOCKED:', srcPath);
      throw err;
    }

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
    // Register the new destination so the renderer can read it back via
    // aimaster-local: if needed (e.g. immediate playback after save).
    registerAllowedFile(result.filePath);
    return result.filePath;
  });

  // ── File info ─────────────────────────────────────────────────────────
  ipc.handle('file:get-info', (_e, filePath: string) => {
    if (!filePath) return null;
    try {
      assertAllowed(filePath, 'file:get-info');
    } catch (err) {
      log.warn('[file:get-info] BLOCKED:', filePath);
      throw err;
    }
    const stat = fs.statSync(filePath);
    return {
      path:      filePath,
      name:      path.basename(filePath),
      sizeBytes: stat.size,
    };
  });

  // ── Reveal in Finder / Explorer ───────────────────────────────────────
  // Special token 'logs' resolves to the app log directory.  Any other
  // path must be in the allowlist.  We NEVER mkdirSync renderer-supplied
  // paths (the previous implementation did that and gave the renderer
  // arbitrary directory creation).
  ipc.handle('file:open-in-finder', (_e, filePath: string) => {
    let resolved: string;
    if (filePath === 'logs') {
      resolved = path.join(app.getPath('userData'), 'logs');
      // Only the logs token may auto-create — it's a known internal dir.
      if (!fs.existsSync(resolved)) fs.mkdirSync(resolved, { recursive: true });
    } else {
      try {
        assertAllowed(filePath, 'file:open-in-finder');
      } catch (err) {
        log.warn('[file:open-in-finder] BLOCKED:', filePath);
        throw err;
      }
      resolved = filePath;
      if (!fs.existsSync(resolved)) {
        // Don't auto-create user paths — that was a renderer-driven
        // mkdir vector.  Just refuse if it's gone.
        log.warn('[file:open-in-finder] path missing, refusing to create:', resolved);
        return;
      }
    }
    shell.showItemInFolder(resolved);
  });

  // ── Batch save: folder picker → copy all WAV/MP3 files ───────────────
  ipc.handle('file:batch-save-wav', async (_e, srcPaths: string[]) => {
    if (!win || !Array.isArray(srcPaths) || !srcPaths.length) return null;

    const folderResult = await dialog.showOpenDialog(win, {
      title: '저장할 폴더 선택',
      buttonLabel: '이 폴더에 저장',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (folderResult.canceled || !folderResult.filePaths[0]) return null;

    const destDir = folderResult.filePaths[0];
    registerAllowedFile(destDir);
    let saved = 0;
    let blocked = 0;
    for (const src of srcPaths) {
      if (!src) continue;
      // Validate every source path before copying.
      if (!isPathAllowed(src)) {
        blocked++;
        log.warn('[file:batch-save-wav] BLOCKED src:', src);
        continue;
      }
      try {
        const dest = path.join(destDir, path.basename(src));
        fs.copyFileSync(src, dest);
        saved++;
      } catch { /* skip missing/inaccessible files */ }
    }
    return { destDir, saved, blocked };
  });

  // ── Recent files (v1 stub) ────────────────────────────────────────────
  ipc.handle('file:get-recent', () => []);
}
