import type { IpcMain, BrowserWindow } from 'electron';
import { app } from 'electron';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { v4 as uuidv4 } from 'uuid';
import { PythonBridge, analyzeFile, masterFile, runQC } from '@aimaster/audio-engine';
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
  bridge = new PythonBridge({ pythonPath, scriptPath });
  bridge.on('log', (line: string) => log.info('[python]', line));
  bridge.spawn();
  return bridge;
}

/** Generate a temp file path under the OS temp directory. */
function tempPath(suffix: string): string {
  return path.join(os.tmpdir(), `aimaster_${uuidv4()}${suffix}`);
}

export function registerAudioHandlers(ipc: IpcMain, win: BrowserWindow | null): void {
  ipc.handle('audio:analyze', async (_e, filePath: string) => {
    const b = getBridge();
    return analyzeFile(b, filePath);
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
      throw new Error(gate.reason ?? '처리 횟수 초과');
    }

    const b = getBridge();

    // Deduplicate progress listener on each call
    b.removeAllListeners('progress');
    b.on('progress', (msg) => {
      win?.webContents.send('audio:progress', msg);
    });

    // Generate temp paths — main process owns these
    const wavTempPath = tempPath('_master.wav');
    const mp3TempPath = tempPath('_preview.mp3');

    // For free tier, we pass the WAV temp path but delete it after
    const result = await masterFile(b, filePath, wavTempPath, options);

    if (gate.isPaid) {
      // Paid: return WAV path so UI can offer "Save As"
      licenseService.decrementTrialUsage();   // no-op for paid (remains TRIAL_MAX)
    } else {
      // Free: delete the WAV, return empty path
      try { fs.unlinkSync(wavTempPath); } catch { /* already gone */ }
      result.outputPath = '';
      // Consume trial
      licenseService.decrementTrialUsage();
      log.info(`[license] trial used — ${licenseService.getRemainingTrials()} remaining`);
    }

    return {
      ...result,
      outputPath:  result.outputPath,
      previewPath: result.previewPath || mp3TempPath,
    };
  });

  ipc.handle('audio:qc', async (_e, filePath: string, targetLufs: number, targetTp: number) => {
    const b = getBridge();
    return runQC(b, filePath, targetLufs, targetTp);
  });
}
