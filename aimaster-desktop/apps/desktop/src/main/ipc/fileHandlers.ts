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
import { licenseService } from './licenseHandlers.js';
import { getEntitlementPaid } from '../services/entitlementBridge.js';
import { log } from '../utils/logger.js';
import type { SaveAudioRequest, SaveAudioResponse, ExportFormat } from '@aimaster/shared-types';

const FORMAT_FILTERS: Record<ExportFormat, { name: string; extensions: string[] }> = {
  wav:  { name: 'WAV Audio',  extensions: ['wav'] },
  flac: { name: 'FLAC Audio', extensions: ['flac'] },
  mp3:  { name: 'MP3 Audio',  extensions: ['mp3'] },
  aiff: { name: 'AIFF Audio', extensions: ['aiff', 'aif'] },
  ogg:  { name: 'OGG Audio',  extensions: ['ogg'] },
};

// ── Commercial paywall (v3.6) ────────────────────────────────────────────────
// Master-quality exports (lossless: wav / flac / aiff) require a paid license.
// The MP3 preview stays free so trial users still hear the result.  Enforced
// here in the MAIN process so it can't be bypassed from the renderer/devtools.
// Renderer detects the `LICENSE_REQUIRED:` prefix and opens the activation modal.
const LICENSE_REQUIRED = 'LICENSE_REQUIRED: 마스터 음원(WAV/FLAC/AIFF) 저장은 라이선스가 필요합니다. 라이선스를 활성화해 주세요.';
const FREE_EXPORT_EXTS = new Set(['mp3', 'ogg']);

function licensePaid(): boolean {
  try { return licenseService.canProcess().isPaid; } catch { return false; }
}

type GateSource = 'license' | 'entitlement' | 'license+entitlement' | 'none';

/**
 * Phase C — ADDITIVE gate: `paid = licensePaid || entitlementPaid`.
 *
 * `entitlementPaid` (entitlementBridge) defaults to false and is only true
 * when the renderer pushed an active-pro snapshot under BOTH feature flags.
 * So with the flags off (default) this is exactly the prior license-only
 * behavior, and an entitlement outage (→ false) can never block a paying
 * license user.  No license logic changed; the free policy is unchanged.
 */
function paidStatus(): { paid: boolean; source: GateSource } {
  const lic = licensePaid();
  const ent = getEntitlementPaid();
  const paid = lic || ent;
  const source: GateSource = !paid
    ? 'none'
    : (lic && ent ? 'license+entitlement' : (lic ? 'license' : 'entitlement'));
  return { paid, source };
}

/** True when the given extension/format is a paid (lossless master) export. */
function isMasterExport(extOrFormat: string): boolean {
  return !FREE_EXPORT_EXTS.has(extOrFormat.toLowerCase().replace('.', ''));
}

/**
 * Validate a renderer-supplied audio payload.  The renderer is trusted code,
 * but a malformed payload must not become an unbounded write, so the size is
 * capped at a value no legitimate session bounce reaches (2 GB WAV ≈ 3 h
 * stereo 24-bit).
 */
const MAX_RENDER_BYTES = 2 * 1024 * 1024 * 1024;

function readAudioPayload(req: unknown): { name: string; bytes: Buffer } {
  if (!req || typeof req !== 'object') throw new Error('invalid render payload');
  const o = req as { name?: unknown; data?: unknown };
  const name = typeof o.name === 'string' ? o.name : 'render';
  const data = o.data;
  if (!(data instanceof Uint8Array) && !(data instanceof ArrayBuffer)) {
    throw new Error('render payload must carry audio bytes');
  }
  const bytes = Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
  if (bytes.length === 0) throw new Error('render payload is empty');
  if (bytes.length > MAX_RENDER_BYTES) throw new Error('render payload too large');
  return { name, bytes };
}

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

    // Paywall: lossless master export requires paid (license OR entitlement).
    if (isMasterExport(ext)) {
      const gate = paidStatus();
      log.info(`[export-gate] save-wav ext=${ext} paid=${gate.paid} source=${gate.source}`);
      if (!gate.paid) throw new Error(LICENSE_REQUIRED);
    }

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

    // Paywall: lossless master export requires paid (license OR entitlement).
    if (isMasterExport(req.format)) {
      const gate = paidStatus();
      log.info(`[export-gate] save-audio fmt=${req.format} paid=${gate.paid} source=${gate.source}`);
      if (!gate.paid) return { savedPath: null, error: LICENSE_REQUIRED };
    }

    const sourceExt = path.extname(req.sourcePath).replace('.', '');
    const spec = {
      format: req.format,
      sampleRate: req.sampleRate,
      bitDepth: req.bitDepth,
      dither: req.dither,
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

    // Paywall: if the batch contains any lossless master file, require paid.
    if (validSrcs.some((p) => isMasterExport(path.extname(p)))) {
      const gate = paidStatus();
      log.info(`[export-gate] batch-save-wav paid=${gate.paid} source=${gate.source}`);
      if (!gate.paid) throw new Error(LICENSE_REQUIRED);
    }

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

  // ── DAW render output (Bounce / Freeze / Consolidate) ─────────────────
  // The renderer renders through an OfflineAudioContext and hands us the
  // encoded WAV bytes.  Two destinations:
  //   • daw:write-temp-audio — a session-scratch file that Freeze and
  //     Consolidate reference as a clip source.  Never shown to the user, so
  //     no dialog and no license gate (nothing leaves the app).
  //   • daw:bounce-audio     — a real export, so it goes through the same
  //     save dialog and paid-export gate as every other master.

  const dawTempDir = (): string => {
    const dir = path.join(app.getPath('temp'), 'loui-daw');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };

  ipc.handle('daw:write-temp-audio', (_e, req: unknown) => {
    const { name, bytes } = readAudioPayload(req);
    const safe = name.replace(/[^\w.\-가-힣 ]+/g, '_').slice(0, 80) || 'render';
    const dest = path.join(dawTempDir(), `${Date.now()}-${safe}.wav`);
    try {
      fs.writeFileSync(dest, bytes);
      return dest;
    } catch (err) {
      recordFailure('export', `daw:write-temp-audio failed: ${(err as Error).message}`);
      throw err;
    }
  });

  ipc.handle('daw:bounce-audio', async (_e, req: unknown) => {
    if (!win) return null;
    const { name, bytes } = readAudioPayload(req);
    // Same paywall as every other lossless master export.
    const gate = paidStatus();
    log.info(`[export-gate] daw-bounce paid=${gate.paid} source=${gate.source}`);
    if (!gate.paid) throw new Error(LICENSE_REQUIRED);
    const result = await dialog.showSaveDialog(win, {
      defaultPath: `${name || 'bounce'}.wav`,
      filters: [FORMAT_FILTERS.wav],
    });
    if (result.canceled || !result.filePath) return null;
    try {
      fs.writeFileSync(result.filePath, bytes);
      log.info(`[daw] bounced ${bytes.length} bytes → ${result.filePath}`);
      return result.filePath;
    } catch (err) {
      recordFailure('export', `daw:bounce-audio failed: ${(err as Error).message}`);
      throw err;
    }
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

  // User plugin presets — a small JSON file, so a sound someone spent an
  // afternoon on can leave the machine.  localStorage does not survive a
  // reinstall; a file does.
  ipc.handle('daw:presets-export', async (_e, payload: unknown) => {
    if (!win) return null;
    if (typeof payload !== 'string' || payload.length > 8 * 1024 * 1024) {
      throw new Error('daw:presets-export: payload rejected');
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const result = await dialog.showSaveDialog(win, {
      defaultPath: `loui-presets-${stamp}.louipreset`,
      filters: [
        { name: 'Loui Preset', extensions: ['louipreset'] },
        { name: 'JSON',        extensions: ['json'] },
      ],
    });
    if (result.canceled || !result.filePath) return null;
    try {
      fs.writeFileSync(result.filePath, payload, 'utf8');
      return result.filePath;
    } catch (err) {
      recordFailure('session', `daw:presets-export failed: ${(err as Error).message}`);
      throw err;
    }
  });

  ipc.handle('daw:presets-import', async () => {
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      filters: [{ name: 'Loui Preset', extensions: ['louipreset', 'json'] }],
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const chosen = result.filePaths[0];
    try {
      const stat = fs.statSync(chosen);
      // A preset file is kilobytes.  Anything enormous is not one, and
      // reading it would be the renderer's problem rather than the dialog's.
      if (stat.size > 8 * 1024 * 1024) throw new Error('프리셋 파일이 너무 큽니다');
      return fs.readFileSync(chosen, 'utf8');
    } catch (err) {
      recordFailure('session', `daw:presets-import failed: ${(err as Error).message}`);
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
