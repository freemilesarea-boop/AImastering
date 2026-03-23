import type { IpcMain, BrowserWindow } from 'electron';
import { app } from 'electron';
import path from 'node:path';
import { PythonBridge, analyzeFile, masterFile, runQC } from '@aimaster/audio-engine';
import type { MasteringOptions } from '@aimaster/shared-types';
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

  ipc.handle('audio:master', async (_e, filePath: string, outputPath: string, options: MasteringOptions) => {
    const b = getBridge();
    b.on('progress', (msg) => {
      win?.webContents.send('audio:progress', msg);
    });
    return masterFile(b, filePath, outputPath, options);
  });

  ipc.handle('audio:qc', async (_e, filePath: string, targetLufs: number, targetTp: number) => {
    const b = getBridge();
    return runQC(b, filePath, targetLufs, targetTp);
  });
}
