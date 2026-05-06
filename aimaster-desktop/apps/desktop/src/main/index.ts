import { app, BrowserWindow, dialog, ipcMain, protocol, net } from 'electron';
import path from 'node:path';
import { checkFFmpeg } from '@aimaster/audio-engine';
import { assertLicenseSecretReady } from '@aimaster/license-core';
import { registerAudioHandlers } from './ipc/audioHandlers.js';
import { registerLicenseHandlers } from './ipc/licenseHandlers.js';
import { registerFileHandlers } from './ipc/fileHandlers.js';
import { registerSettingsHandlers } from './ipc/settingsHandlers.js';
import { initUpdater } from './updater.js';
import { log } from './utils/logger.js';

const isDev = !app.isPackaged;

// ── Production-only license-secret gate ──────────────────────────────────────
// In a packaged build LICENSE_HMAC_SECRET MUST be set to a real (non-dev,
// >=16 char) value before license-core is loaded — otherwise an attacker
// could forge "Pro" license records since every machine would validate
// against the same dev secret.
//
// We refuse to start in that state.  Dev / unpackaged builds skip the gate
// so local development still works without the env var.
if (!isDev) {
  try {
    assertLicenseSecretReady();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('[fatal] license secret gate failed:', msg);
    // Show a blocking dialog if we can — otherwise just exit.  app.whenReady
    // hasn't fired yet so dialog.showErrorBox is the only safe API here.
    try { dialog.showErrorBox('AIMaster — startup blocked', msg); } catch { /* no display */ }
    app.exit(1);
  }
}

let mainWindow: BrowserWindow | null = null;

// ── Local-file protocol (for audio preview in renderer) ───────────────────────
// Renderer loads from http://localhost:5173 (dev) or file:// (prod).
// Chromium blocks file:// resources from http:// origins, so we register a
// custom scheme that proxies local file reads without relaxing webSecurity.
protocol.registerSchemesAsPrivileged([
  { scheme: 'aimaster-local', privileges: { bypassCSP: true, supportFetchAPI: true, stream: true } },
]);

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

  // 로드 실패 시에도 창을 표시하고 에러를 기록
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    log.error('did-fail-load', { code, desc, url });
    mainWindow?.show();
  });

  // Cmd+Option+I (Mac) / Ctrl+Shift+I (Win) 로 DevTools 열기
  mainWindow.webContents.on('before-input-event', (_e, input) => {
    const isMac = process.platform === 'darwin';
    const devtoolsShortcut = isMac
      ? input.meta && input.alt && input.key === 'i'
      : input.control && input.shift && input.key === 'I';
    if (devtoolsShortcut) {
      mainWindow?.webContents.openDevTools();
    }
  });

  if (isDev) {
    void mainWindow.loadURL('http://localhost:5173');
  } else {
    // Main process is at dist-electron/main/index.js; renderer is at
    // dist/renderer/index.html.  Both live inside app.asar at runtime, so
    // the relative path from main → renderer is up-two-levels then into dist/.
    const rendererPath = path.join(__dirname, '../..', 'dist', 'renderer', 'index.html');
    log.info('Loading renderer from:', rendererPath);
    void mainWindow.loadFile(rendererPath);
  }
}

app.whenReady().then(() => {
  // ── 0. 로컬 파일 프로토콜 핸들러 ─────────────────────────────────────────
  // aimaster-local:///<absolute-path> → reads from local filesystem
  protocol.handle('aimaster-local', (request) => {
    const filePath = decodeURIComponent(request.url.slice('aimaster-local://'.length));
    return net.fetch(`file://${filePath}`);
  });

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

  // ── 4. Auto-updater (프로덕션 빌드에서만 실제로 체크) ─────────────────────
  // dev 빌드에선 IPC 핸들러는 등록되지만 checkForUpdates() 호출이 no-op.
  if (mainWindow) {
    try {
      initUpdater(mainWindow, ipcMain);
    } catch (err) {
      log.error('Updater init failed (app continues):', err);
    }
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
