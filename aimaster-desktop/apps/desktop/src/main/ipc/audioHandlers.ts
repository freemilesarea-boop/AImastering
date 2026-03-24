import type { IpcMain, BrowserWindow } from 'electron';
import { app } from 'electron';
import path from 'node:path';
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

export function registerAudioHandlers(ipc: IpcMain, win: BrowserWindow | null): void {
  ipc.handle('audio:analyze', async (_e, filePath: string) => {
    const b = getBridge();
    return analyzeFile(b, filePath);
  });

  ipc.handle('audio:master', async (
    _e,
    filePath: string,
    outputPath: string,
    options: MasteringOptions,
  ) => {
    // ── License gate ──────────────────────────────────────────────────────
    const gate = licenseService.canProcess();
    if (!gate.allowed) {
      // Surface a user-readable error; the renderer shows the license modal
      throw new Error(gate.reason ?? '처리 횟수 초과');
    }

    const b = getBridge();

    // Deduplicate the progress listener on each call
    b.removeAllListeners('progress');
    b.on('progress', (msg) => {
      win?.webContents.send('audio:progress', msg);
    });

    // For free-tier users, we block WAV save by passing an empty outputPath
    // to the Python layer and returning an empty string in the result.
    // The MP3 preview path is always populated.
    const effectiveOutputPath = gate.isPaid ? outputPath : '';

    const result = await masterFile(b, filePath, effectiveOutputPath, options);

    // Consume one trial use after successful processing (free tier only)
    if (!gate.isPaid) {
      licenseService.decrementTrialUsage();
      log.info(`[license] trial used — ${licenseService.getRemainingTrials()} remaining`);
    }

    return {
      ...result,
      // Ensure the caller always knows whether WAV was saved
      outputPath: effectiveOutputPath,
    };
  });

  ipc.handle('audio:qc', async (_e, filePath: string, targetLufs: number, targetTp: number) => {
    const b = getBridge();
    return runQC(b, filePath, targetLufs, targetTp);
  });
}
