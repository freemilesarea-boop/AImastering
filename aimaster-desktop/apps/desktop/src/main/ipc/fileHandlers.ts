import type { IpcMain, BrowserWindow } from 'electron';
import { app, dialog, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { recordFailure } from '../utils/failureLog.js';
import { validateAbsoluteFilePath } from '../utils/ipcValidation.js';
import {
  buildSupportBundle,
  supportBundleToJson,
} from '../utils/supportBundle.js';
import { needsTranscode, transcodeToTemp } from '../utils/audioTranscode.js';
import type { SaveAudioRequest, SaveAudioResponse, ExportFormat } from '@aimaster/shared-types';

const FORMAT_FILTERS: Record<ExportFormat, { name: string; extensions: string[] }> = {
  wav:  { name: 'WAV Audio',  extensions: ['wav'] },
  flac: { name: 'FLAC Audio', extensions: ['flac'] },
  mp3:  { name: 'MP3 Audio',  extensions: ['mp3'] },
  aiff: { name: 'AIFF Audio', extensions: ['aiff', 'aif'] },
  ogg:  { name: 'OGG Audio',  extensions: ['ogg'] },
};

// ── Export gating: removed ───────────────────────────────────────────────────
// Lossless master exports (wav / flac / aiff) used to require an activated
// licence, with the MP3 preview left free so a trial user could still hear
// the result.  The product is sold as a paid download, so every copy that
// runs is already paid for — the gate could only ever fire on a customer.
// It did: saving a WAV opened the activation dialog and refused the export.
//
// Enforcement lived in the MAIN process at three call sites (`file:save-wav`,
// `file:save-audio`, `file:batch-save-wav`) so it could not be bypassed from
// devtools.  All three are gone, along with the helpers that fed them, and so
// are the renderer helpers that recognised the `LICENSE_REQUIRED:` prefix and
// opened the activation dialog -- nothing can resurrect this by accident.

export function registerFileHandlers(ipc: IpcMain, win: BrowserWindow | null): void {
  // ── Open file picker (single) ─────────────────────────────────────────
  ipc.handle('file:open-dialog', async () => {
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      filters: [{ name: 'Audio', extensions: ['wav', 'flac', 'aiff', 'aif', 'mp3', 'm4a'] }],
      properties: ['openFile'],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  // ── Open file picker (multi, up to 20) ────────────────────────────────
  ipc.handle('file:open-dialog-multi', async () => {
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      filters: [{ name: 'Audio', extensions: ['wav', 'flac', 'aiff', 'aif', 'mp3', 'm4a'] }],
      properties: ['openFile', 'multiSelections'],
    });
    if (result.canceled) return null;
    return result.filePaths.slice(0, 20);
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
  ipc.handle('file:save-wav', async (_e, srcPath: unknown) => {
    if (!win) return null;
    const safeSrc = validateAbsoluteFilePath(srcPath, 'file:save-wav');

    const ext      = path.extname(safeSrc).toLowerCase().replace('.', '');
    const isWav    = ext === 'wav';

    const filters  = isWav
      ? [{ name: 'WAV Audio', extensions: ['wav'] }]
      : [{ name: 'MP3 Audio', extensions: ['mp3'] }];

    try {
      const result = await dialog.showSaveDialog(win, {
        defaultPath: path.basename(safeSrc),
        filters,
      });
      if (result.canceled || !result.filePath) return null;

      fs.copyFileSync(safeSrc, result.filePath);
      return result.filePath;
    } catch (err) {
      recordFailure('export', `file:save-wav failed: ${(err as Error).message}`, {
        ext, srcPath: safeSrc,
      });
      throw err;
    }
  });

  // ── Save audio with optional transcode (M3-P-NEXT-5D-2-d) ────────────
  // NEW channel — file:save-wav above is untouched.  Saves a source WAV
  // to a user location, transcoding to the chosen format / quality /
  // dither via ffmpeg when needed.  Returns a typed response (never
  // throws) so the renderer handles cancel / warning / error uniformly.
  ipc.handle('file:save-audio', async (_e, req: SaveAudioRequest): Promise<SaveAudioResponse> => {
    const t0 = Date.now();
    if (!win || !req?.sourcePath || !req?.format) {
      return { savedPath: null, error: 'invalid request' };
    }
    const filter = FORMAT_FILTERS[req.format];
    if (!filter) return { savedPath: null, error: `unsupported format: ${req.format}` };

    const sourceExt = path.extname(req.sourcePath).replace('.', '');
    const spec = {
      format: req.format,
      sampleRate: req.sampleRate,
      bitDepth: req.bitDepth,
      dither: req.dither,
      sourceAlreadyDithered: req.sourceAlreadyDithered,
    };

    try {
      // Save dialog with a default name in the target extension.
      const defaultBase = (req.suggestedName ?? path.basename(req.sourcePath, path.extname(req.sourcePath)))
        .replace(/\.[^.]+$/, '');
      const result = await dialog.showSaveDialog(win, {
        defaultPath: `${defaultBase}.${filter.extensions[0]}`,
        filters: [filter],
      });
      if (result.canceled || !result.filePath) {
        return { savedPath: null };   // user cancelled
      }
      const dest = result.filePath;

      if (!needsTranscode(sourceExt, spec)) {
        // WAV passthrough — plain copy (no ffmpeg).
        fs.copyFileSync(req.sourcePath, dest);
        return { savedPath: dest, format: req.format, transcoded: false, durationMs: Date.now() - t0 };
      }

      // Transcode to a temp file, then copy to the chosen destination.
      const { outputPath: tmp, warning } = await transcodeToTemp(req.sourcePath, spec);
      try {
        fs.copyFileSync(tmp, dest);
      } finally {
        try { fs.unlinkSync(tmp); } catch { /* temp already gone */ }
      }
      return {
        savedPath: dest, format: req.format, transcoded: true,
        durationMs: Date.now() - t0,
        ...(warning ? { warning } : {}),
      };
    } catch (err) {
      const msg = (err as Error).message;
      recordFailure('export', `file:save-audio failed: ${msg}`, { format: req.format, sourcePath: req.sourcePath });
      return { savedPath: null, error: msg };   // dest never written; source intact
    }
  });

  // ── Support bundle (v3.6 QA) ─────────────────────────────────────────
  // Returns the JSON snapshot in-memory.  No filesystem write — the
  // renderer can copy to clipboard or hand off to the export helper.
  ipc.handle('support:bundle', () => {
    return buildSupportBundle();
  });

  // Renderer-side failure ingest.  Renderer hooks (preview <audio>,
  // AudioWorklet, export download) call this so a single support bundle
  // surfaces both main- and renderer-side errors.
  ipc.handle('support:record-failure', (
    _e,
    payload: { category?: string; message?: string; data?: Record<string, unknown> },
  ) => {
    const allowed = new Set([
      'preview', 'worklet', 'ffmpeg', 'engine',
      'export', 'pipeline', 'license', 'unknown',
    ]);
    const cat = allowed.has(String(payload?.category)) ? payload!.category as
      'preview' | 'worklet' | 'ffmpeg' | 'engine' | 'export' | 'pipeline' | 'license' | 'unknown'
      : 'unknown';
    const msg = typeof payload?.message === 'string' ? payload.message : 'unknown failure';
    recordFailure(cat, msg, payload?.data);
    return { ok: true };
  });

  // Save the support bundle to a path the user picks.  Mirrors the
  // export-report flow used by Phase-E so users can do "Help → Export
  // diagnostic bundle" from anywhere in the app.
  ipc.handle('support:bundle-export', async () => {
    if (!win) return null;
    const bundle = buildSupportBundle();
    const json   = supportBundleToJson(bundle);
    try {
      const stamp  = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const result = await dialog.showSaveDialog(win, {
        defaultPath: `aimaster-support-${stamp}.json`,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (result.canceled || !result.filePath) return null;
      fs.writeFileSync(result.filePath, json, 'utf8');
      return { savedTo: result.filePath, sizeBytes: Buffer.byteLength(json, 'utf8') };
    } catch (err) {
      recordFailure('export', `support:bundle-export failed: ${(err as Error).message}`);
      throw err;
    }
  });

  // ── File info ─────────────────────────────────────────────────────────
  // Renderer-supplied paths are untrusted — even though Electron's IPC
  // boundary is private, defence-in-depth blocks obvious abuse (null-byte
  // injection, non-absolute paths, non-files).  Returning metadata for
  // arbitrary system files is the only thing this handler can leak, but we
  // refuse to participate in path-traversal probing all the same.
  ipc.handle('file:get-info', (_e, filePath: unknown) => {
    if (typeof filePath !== 'string' || filePath.length === 0) {
      throw new Error('file:get-info: filePath must be a non-empty string');
    }
    if (filePath.includes('\0')) {
      throw new Error('file:get-info: null byte in path');
    }
    const resolved = path.resolve(filePath);
    if (!path.isAbsolute(resolved)) {
      throw new Error('file:get-info: path must resolve to an absolute location');
    }
    try {
      const stat = fs.statSync(resolved);
      if (!stat.isFile()) {
        throw new Error('file:get-info: not a regular file');
      }
      return {
        path:      resolved,
        name:      path.basename(resolved),
        sizeBytes: stat.size,
      };
    } catch (err) {
      recordFailure('export', `file:get-info failed: ${(err as Error).message}`);
      throw err;
    }
  });

  // ── Reveal in Finder / Explorer ───────────────────────────────────────
  // Special token 'logs' resolves to (and may create) the app log directory.
  // Any other value must be a real existing path; we DO NOT mkdir arbitrary
  // renderer-supplied paths (that would let the renderer scatter empty
  // directories anywhere on the filesystem).
  ipc.handle('file:open-in-finder', (_e, filePath: unknown) => {
    if (typeof filePath !== 'string' || filePath.length === 0 || filePath.includes('\0')) {
      throw new Error('file:open-in-finder: invalid path');
    }
    if (filePath === 'logs') {
      const logDir = path.join(app.getPath('userData'), 'logs');
      if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
      shell.showItemInFolder(logDir);
      return;
    }
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) {
      throw new Error('file:open-in-finder: path does not exist');
    }
    shell.showItemInFolder(resolved);
  });

  // ── Batch save: folder picker → copy all WAV/MP3 files ───────────────
  ipc.handle('file:batch-save-wav', async (_e, srcPaths: unknown) => {
    if (!win || !Array.isArray(srcPaths) || !srcPaths.length) return null;

    // Validate every source path up-front so we never go through the
    // dialog with garbage that would silently no-op the whole batch.
    const validSrcs: string[] = [];
    for (const src of srcPaths) {
      try {
        validSrcs.push(validateAbsoluteFilePath(src, 'file:batch-save-wav'));
      } catch {
        // Skip individual invalid entries rather than failing the whole
        // batch — the caller may legitimately have a mix of paths.
      }
    }
    if (!validSrcs.length) return null;

    const folderResult = await dialog.showOpenDialog(win, {
      title: '저장할 폴더 선택',
      buttonLabel: '이 폴더에 저장',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (folderResult.canceled || !folderResult.filePaths[0]) return null;

    const destDir = folderResult.filePaths[0];
    let saved = 0;
    for (const src of validSrcs) {
      try {
        const dest = path.join(destDir, path.basename(src));
        fs.copyFileSync(src, dest);
        saved++;
      } catch (err) {
        recordFailure('export', `file:batch-save-wav copy failed: ${(err as Error).message}`, {
          src, destDir,
        });
      }
    }
    return { destDir, saved };
  });

  // ── Recent files (v1 stub) ────────────────────────────────────────────
  ipc.handle('file:get-recent', () => []);

  // ── Session save / load (.louisession) ────────────────────────────────

  ipc.handle('session:save', async (_e, sessionData: string) => {
    if (!win) return null;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const result = await dialog.showSaveDialog(win, {
      defaultPath: `loui-session-${stamp}.louisession`,
      filters: [
        { name: 'Loui Session', extensions: ['louisession'] },
        { name: 'JSON',         extensions: ['json'] },
      ],
    });
    if (result.canceled || !result.filePath) return null;
    try {
      fs.writeFileSync(result.filePath, sessionData, 'utf8');
      return result.filePath;
    } catch (err) {
      recordFailure('session', `session:save failed: ${(err as Error).message}`);
      throw err;
    }
  });

  ipc.handle('session:load', async () => {
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      filters: [
        { name: 'Loui Session', extensions: ['louisession', 'json'] },
      ],
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const chosen = result.filePaths[0];
    try {
      const data = fs.readFileSync(chosen, 'utf8');
      // Validate JSON shape here so a corrupted .louisession can't crash
      // the renderer with a thrown SyntaxError during JSON.parse().  We
      // only check that the top-level value is a non-null object; the
      // renderer is still responsible for schema-level validation of the
      // specific session fields it consumes.
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch (err) {
        const msg = (err as Error).message;
        recordFailure('session', `session:load invalid JSON: ${msg}`, { path: chosen });
        throw new Error(`Session file is not valid JSON: ${msg}`);
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        recordFailure('session', 'session:load JSON root is not an object', { path: chosen });
        throw new Error('Session file root must be a JSON object');
      }
      return { path: chosen, data };
    } catch (err) {
      // Don't double-record JSON-parse failures (already recorded above).
      if (!/JSON|object/.test((err as Error).message)) {
        recordFailure('session', `session:load failed: ${(err as Error).message}`);
      }
      throw err;
    }
  });
}
