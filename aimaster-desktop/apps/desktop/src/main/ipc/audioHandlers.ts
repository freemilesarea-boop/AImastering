import type { IpcMain, BrowserWindow } from 'electron';
import { app } from 'electron';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { v4 as uuidv4 } from 'uuid';import {
  PythonBridge,
  analyzeFile,
  masterFile,
  runQC,
  AppError,
  classifyFFmpegError,
  outputDirNotWritable,
  pythonProcessFailed,
  unknownError,
  pathEncodingError,
} from '@aimaster/audio-engine';
import type { MasteringOptions } from '@aimaster/shared-types';
import { log } from '../utils/logger.js';

let bridge: PythonBridge | null = null;

function getBridge(): PythonBridge {
  if (bridge) return bridge;
  const pythonPath = process.env['AIMASTER_PYTHON'] ?? 'python3';
  const scriptPath = app.isPackaged
    ? path.join(process.resourcesPath, 'python-audio', 'app', 'main.py')
    : path.join(__dirname, '../../../../services/python-audio/app/main.py');

  // Python script does `from app.analyzers.analyzer import ...`
  // so PYTHONPATH must include the directory that contains the `app` package
  // (i.e. services/python-audio/, not services/python-audio/app/)
  const pythonRoot = path.dirname(path.dirname(scriptPath));
  process.env['PYTHONPATH'] = pythonRoot;

  bridge = new PythonBridge({ pythonPath, scriptPath });
  bridge.on('log', (line: string) => log.info('[python]', line));
  bridge.spawn();
  return bridge;
}

/**
 * Remove characters that are illegal in filenames on Windows or Unix.
 * Spaces are replaced with underscores; the result is trimmed.
 * Falls back to 'untitled' if the result is empty.
 */
function sanitizeFilename(name: string): string {
  return (
    name
      // eslint-disable-next-line no-control-regex
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')  // illegal on Windows/Unix
      .replace(/\s+/g, '_')                     // spaces → underscores
      .replace(/\.+$/, '')                      // trailing dots (Windows disallows)
      .trim()
  ) || 'untitled';
}

/**
 * Build `{tmpDir}/{sanitized_basename}_master.ext`, incrementing a numeric
 * suffix when the path already exists:
 *   song_master.wav → song_master(1).wav → song_master(2).wav …
 *
 * UUID is never exposed in the output filename; it is used only as an
 * emergency fallback if all 999 numeric slots are somehow taken.
 */
function resolveOutputPath(inputFilePath: string, ext: string): string {
  const tmpDir  = os.tmpdir();
  const rawBase = path.basename(inputFilePath, path.extname(inputFilePath));
  const safe    = sanitizeFilename(rawBase);
  const stem    = `${safe}_master`;

  const primary = path.join(tmpDir, `${stem}${ext}`);
  if (!fs.existsSync(primary)) return primary;

  for (let i = 1; i < 1000; i++) {
    const candidate = path.join(tmpDir, `${stem}(${i})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }

  // Emergency fallback — should never be reached in normal usage
  return path.join(tmpDir, `${stem}_${uuidv4().slice(0, 8)}${ext}`);
}

/** UUID-based temp path — for internal / ephemeral files only (not user-visible). */
function internalTempPath(suffix: string): string {
  return path.join(os.tmpdir(), `aimaster_${uuidv4()}${suffix}`);
}

/**
 * Check that the OS temp directory is writable.
 * Throws AppError(OUTPUT_DIR_NOT_WRITABLE) if not.
 */
function assertTmpWritable(): void {
  const dir = os.tmpdir();
  try {
    fs.accessSync(dir, fs.constants.W_OK);
  } catch {
    throw outputDirNotWritable(dir);
  }
}

/**
 * Convert any thrown value into an AppError and re-throw.
 * This is the boundary function that wraps Python bridge + FFmpeg errors.
 */
function toAppError(err: unknown, filePath = ''): never {
  if (err instanceof AppError) throw err;

  const msg = (err as Error).message ?? String(err);

  // Python / JSON-RPC bridge errors carry a 'code' field
  const anyErr = err as Record<string, unknown>;
  if (typeof anyErr['code'] === 'number') {
    const rpcCode = anyErr['code'] as number;
    const detail  = `JSON-RPC code=${rpcCode}: ${msg}`;
    // -32700 parse / -32601 method / -32602 params are developer errors
    // -32000 is an application-level error from the Python pipeline
    throw pythonProcessFailed(detail, rpcCode === -32000);
  }

  // Path encoding issues
  if (/ENOENT|EINVAL|ENAMETOOLONG/i.test(msg) && filePath) {
    throw pathEncodingError(filePath, msg);
  }

  // Classify as FFmpeg error if it looks like one
  try {
    throw classifyFFmpegError(err, false, filePath);
  } catch (classified) {
    if (classified instanceof AppError) throw classified;
  }

  throw unknownError(msg);
}

export function registerAudioHandlers(ipc: IpcMain, win: BrowserWindow | null): void {
  ipc.handle('audio:analyze', async (_e, filePath: string) => {
    try {
      const b = getBridge();
      return await analyzeFile(b, filePath);
    } catch (err) {
      log.error('[audio:analyze] error', { filePath, err: (err as Error).message });
      toAppError(err, filePath);
    }
  });

  ipc.handle('audio:master', async (
    _e,
    filePath: string,
    _outputPath: string,   // ignored — we always generate temp paths here
    options: MasteringOptions,
  ) => {
    // ── Write-permission pre-check ────────────────────────────────────────
    assertTmpWritable();

    const b = getBridge();

    // Deduplicate progress listener on each call
    b.removeAllListeners('progress');
    b.on('progress', (msg) => {
      win?.webContents.send('audio:progress', msg);
    });

    // Handle bridge death mid-processing (case 8)
    let bridgeDied = false;
    const bridgeExitHandler = () => { bridgeDied = true; };
    b.once('exit', bridgeExitHandler);

    // ── Output path: original-filename-based, not UUID ────────────────────
    // Python derives the preview MP3 path as: outputPath_without_ext + "_preview.mp3"
    // so naming the WAV correctly automatically names the preview correctly too.
    const wavTempPath = resolveOutputPath(filePath, '.wav');
    // Fallback MP3 path — used only if Python fails to generate the preview
    const mp3FallbackPath = internalTempPath('_preview.mp3');

    try {
      const result = await masterFile(b, filePath, wavTempPath, options);

      if (bridgeDied) {
        throw pythonProcessFailed('Bridge process exited during masterFile()', true);
      }

      return {
        ...result,
        outputPath:  result.outputPath,
        previewPath: result.previewPath || mp3FallbackPath,
      };
    } catch (err) {
      // Clean up temp WAV on any error to avoid leaking disk space
      try { fs.unlinkSync(wavTempPath); } catch { /* already gone */ }

      log.error('[audio:master] error', {
        filePath,
        err: (err as Error).message,
        bridgeDied,
      });

      // If bridge died, reset so next call spawns a fresh process
      if (bridgeDied) {
        bridge = null;
        throw pythonProcessFailed('Bridge process exited unexpectedly', true);
      }

      toAppError(err, filePath);
    } finally {
      b.removeListener('exit', bridgeExitHandler);
    }
  });

  ipc.handle('audio:qc', async (_e, filePath: string, targetLufs: number, targetTp: number) => {
    try {
      const b = getBridge();
      return await runQC(b, filePath, targetLufs, targetTp);
    } catch (err) {
      log.error('[audio:qc] error', { filePath, err: (err as Error).message });
      toAppError(err, filePath);
    }
  });
}
