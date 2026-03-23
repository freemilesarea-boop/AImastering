import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { checkFFmpeg } from '@aimaster/audio-engine';
import { registerAudioHandlers } from './ipc/audioHandlers.js';
import { registerLicenseHandlers } from './ipc/licenseHandlers.js';
import { registerFileHandlers } from './ipc/fileHandlers.js';
import { registerSettingsHandlers } from './ipc/settingsHandlers.js';
import { log } from './utils/logger.js';

const isDev = !app.isPackaged;

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 740,
    minWidth: 900,
    minHeight: 620,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#09090b',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (isDev) {
    void mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(() => {
  const ffmpeg = checkFFmpeg();
  log.info('FFmpeg status', ffmpeg);

  ipcMain.handle('system:ffmpeg-status', () => ffmpeg);

  registerAudioHandlers(ipcMain, mainWindow);
  registerLicenseHandlers(ipcMain);
  registerFileHandlers(ipcMain, mainWindow);
  registerSettingsHandlers(ipcMain, mainWindow);

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

process.on('uncaughtException', (err) => {
  log.error('Uncaught exception', err);
});
