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
    // 콘텐츠가 준비되기 전에 검은 창이 노출되지 않도록 show: false 사용
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // 렌더러가 첫 페인트를 마친 뒤에 창을 표시
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  if (isDev) {
    void mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(() => {
  // ── 1. 창을 먼저 생성 ─────────────────────────────────────────────────────
  // IPC 핸들러에 mainWindow 참조를 전달하려면 createWindow()가 먼저 실행되어야 함.
  // 이전 코드에서는 registerXxxHandlers() 이후 createWindow()가 호출되어
  // mainWindow = null 이 넘어가고 파일 다이얼로그 등이 동작하지 않았음.
  createWindow();

  // ── 2. FFmpeg 상태 확인 (실패해도 창은 유지) ──────────────────────────────
  let ffmpeg;
  try {
    ffmpeg = checkFFmpeg();
    log.info('FFmpeg status', ffmpeg);
  } catch (err) {
    log.error('checkFFmpeg failed (app continues):', err);
    ffmpeg = { available: false, ffprobeAvailable: false };
  }

  ipcMain.handle('system:ffmpeg-status', () => ffmpeg);

  // ── 3. IPC 핸들러 등록 (mainWindow가 이미 생성된 뒤) ─────────────────────
  try {
    registerAudioHandlers(ipcMain, mainWindow);
    registerLicenseHandlers(ipcMain);
    registerFileHandlers(ipcMain, mainWindow);
    registerSettingsHandlers(ipcMain, mainWindow);
  } catch (err) {
    log.error('IPC handler registration failed:', err);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch((err) => {
  log.error('app.whenReady failed:', err);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

process.on('uncaughtException', (err) => {
  log.error('Uncaught exception', err);
});
