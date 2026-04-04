import type { IpcMain, BrowserWindow } from 'electron';
import { app } from 'electron';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { v4 as uuidv4 } from 'uuid';
import {
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
import { licenseService } from './licenseHandlers.js';
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

/** Generate a temp file path under the OS temp directory. */
function tempPath(suffix: string): string {
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
    // ── License gate ──────────────────────────────────────────────────────
    const gate = licenseService.canProcess();
    if (!gate.allowed) {
      throw new AppError(
        'TRIAL_COUNT_ANOMALY',
        gate.reason ?? '처리 횟수 초과',
        `License gate blocked: ${gate.reason}`,
        false,
      );
    }

    // ── Write-permission pre-check (case 6) ───────────────────────────────
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

    // Generate temp paths — main process owns these
    const wavTempPath = tempPath('_master.wav');
    const mp3TempPath = tempPath('_preview.mp3');

    try {
      const result = await masterFile(b, filePath, wavTempPath, options);

      if (bridgeDied) {
        throw pythonProcessFailed('Bridge process exited during masterFile()', true);
      }

      // WAV download always available — no license restriction
      licenseService.decrementTrialUsage();

      return {
        ...result,
        outputPath:  result.outputPath,
        previewPath: result.previewPath || mp3TempPath,
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
