import { app, BrowserWindow, ipcMain, protocol, net } from 'electron';
import path from 'node:path';
import { checkFFmpeg } from '@aimaster/audio-engine';
import { registerAudioHandlers, killBridge } from './ipc/audioHandlers.js';
import { registerFileHandlers } from './ipc/fileHandlers.js';
import { registerSettingsHandlers } from './ipc/settingsHandlers.js';
import { initUpdater } from './updater.js';
import { log } from './utils/logger.js';
import { recordFailure } from './utils/failureLog.js';
import { localUrlToFileUrl } from './utils/localFileUrl.js';
import { applyBundledFfmpegEnv } from './utils/ffmpegEnv.js';

// ── License gate REMOVED (v3.6.0-rc.1+1) ─────────────────────────────────────
// The previous LICENSE_HMAC_SECRET startup gate has been removed for the
// internal RC test cycle.  License-key activation is not used in this build,
// so requiring a production secret was blocking testers without giving the
// app any real protection.  License IPC handlers / UI are also disabled —
// see preload/index.ts and renderer/App.tsx.

const isDev = !app.isPackaged;

let mainWindow: BrowserWindow | null = null;

// ── Local-file protocol (for audio preview in renderer) ───────────────────────
// Renderer loads from http://localhost:5173 (dev) or file:// (prod).
// Chromium blocks file:// resources from http:// origins, so we register a
// custom scheme that proxies local file reads without relaxing webSecurity.
// `standard: true` is required so the renderer parses URLs consistently and
// — critically — so <audio>/<video> can issue HTTP Range requests against
// the scheme (media metadata loading + seeking need 206 responses).
protocol.registerSchemesAsPrivileged([
  { scheme: 'aimaster-local', privileges: { standard: true, secure: true, bypassCSP: true, supportFetchAPI: true, stream: true } },
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

  // ── Renderer crash listeners (긴급 크래시 분석) ─────────────────────────
  // renderer process가 갑자기 죽으면 reason + exitCode를 정확히 기록.
  // ErrorBoundary가 못 잡는 종류 (native crash, OOM, IPC 등)의 원인 표시.
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    log.error('[CRASH] webContents render-process-gone:', JSON.stringify({
      reason: details.reason,   // 'crashed' | 'killed' | 'oom' | 'launch-failed' | etc.
      exitCode: details.exitCode,
    }));
    recordFailure('engine', `renderer render-process-gone: reason=${details.reason} exit=${details.exitCode}`);
    // DO NOT auto-reload — first time we want the user/devtools to see the state.
    mainWindow?.show();
  });
  mainWindow.webContents.on('unresponsive', () => {
    log.error('[CRASH] webContents unresponsive (renderer event loop blocked)');
    recordFailure('engine', 'renderer unresponsive');
  });
  mainWindow.webContents.on('responsive', () => {
    log.info('[CRASH] webContents responsive again');
  });
  // Capture console errors from the renderer into the main log so they
  // survive a renderer crash that wipes DevTools.
  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) { // 2=warning, 3=error
      log.warn(`[renderer-console L${level}] ${message} (${sourceId}:${line})`);
    }
  });
  mainWindow.webContents.on('preload-error', (_e, preloadPath, error) => {
    log.error('[CRASH] preload-error', { preloadPath, message: error.message, stack: error.stack });
    recordFailure('engine', `preload-error: ${error.message}`);
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
  // aimaster-local:///<absolute-path> → reads from local filesystem.
  //
  // Two things matter for <audio> playback of large WAVs:
  //   1. Robust path decode — parse via the URL API (handles spaces, Korean,
  //      Windows drive letters) and rebuild a proper file:// URL.
  //   2. Range requests — forward the media element's `Range` header so
  //      net.fetch returns 206 Partial Content; without it Chromium's media
  //      pipeline often fails to load metadata (duration stays 0:00).
  protocol.handle('aimaster-local', (request) => {
    // localUrlToFsPath handles spaces / Korean / `#` / `?` and — critically
    // for Windows — strips the leading slash before a drive letter so
    // `/C:/Users/…` decodes to a valid `C:/Users/…` path (otherwise audio
    // preview, waveforms, and live tweak all fail to load on Windows).
    const fileUrl = localUrlToFileUrl(request.url);
    const range = request.headers.get('Range') ?? request.headers.get('range');
    return net.fetch(fileUrl, range ? { headers: { Range: range } } : undefined);
  });

  // ── 1. 창을 먼저 생성 ─────────────────────────────────────────────────────
  // IPC 핸들러에 mainWindow 참조를 전달하려면 createWindow()가 먼저 실행되어야 함.
  // 이전 코드에서는 registerXxxHandlers() 이후 createWindow()가 호출되어
  // mainWindow = null 이 넘어가고 파일 다이얼로그 등이 동작하지 않았음.
  createWindow();

  // ── 2. FFmpeg 상태 확인 (실패해도 창은 유지) ──────────────────────────────
  // Point AIMASTER_FFMPEG/FFPROBE at the bundled binaries BEFORE the first
  // resolution so checkFFmpeg() — and every later consumer that resolves with
  // no opts (export transcode, Rust offline render, the Python engine) —
  // finds the bundled binary on a clean machine regardless of call order.
  applyBundledFfmpegEnv(app.isPackaged, process.resourcesPath);
  let ffmpeg;
  try {
    ffmpeg = checkFFmpeg({ packaged: app.isPackaged, resourcesPath: process.resourcesPath });
    log.info('FFmpeg status', ffmpeg);
    if (!ffmpeg?.available) {
      recordFailure('ffmpeg', 'checkFFmpeg() returned available=false', { ffmpeg });
    } else if (!ffmpeg?.ffprobeAvailable) {
      recordFailure('ffmpeg', 'checkFFmpeg() returned ffprobeAvailable=false', { ffmpeg });
    }
  } catch (err) {
    log.error('checkFFmpeg failed (app continues):', err);
    recordFailure('ffmpeg', `checkFFmpeg threw: ${(err as Error).message}`);
    ffmpeg = { available: false, ffprobeAvailable: false };
  }

  ipcMain.handle('system:ffmpeg-status', () => ffmpeg);

  // ── Worklet/WASM asset reader (packaged file:// + asar safe) ───────────
  // Chromium's fetch()/audioWorklet.addModule() of file:// resources inside
  // app.asar is unreliable/blocked.  The main process reads these assets via
  // Node fs (which understands asar) and hands the bytes to the renderer,
  // which compiles the wasm directly and loads the JS via a blob: URL — no
  // file:// fetch.  Allow-list only the known worklet assets.
  {
    const ALLOWED = new Set([
      'loui-mastering-wasm.nomodules.wasm',
      'loui-mastering-wasm.nomodules.js',
      'mastering-chain.worklet.js',
      'analyzer-tap.worklet.js',
    ]);
    // Renderer assets sit next to index.html: dist/renderer/<name>.
    // __dirname = dist-electron/main, so ../../dist/renderer.
    const rendererDir = path.join(__dirname, '../..', 'dist', 'renderer');
    ipcMain.handle('loui:read-worklet-asset', async (_e, name: unknown) => {
      if (typeof name !== 'string' || !ALLOWED.has(name)) {
        throw new Error(`blocked asset: ${String(name)}`);
      }
      const fs = await import('node:fs/promises');
      const full = path.join(rendererDir, name);
      const buf = await fs.readFile(full);
      const isText = name.endsWith('.js');
      log.info(`[worklet-asset] read ${name} ${buf.byteLength} ${isText ? 'text' : 'binary'}`);
      // Return text for JS (renderer makes a Blob), bytes for wasm.
      return isText
        ? { kind: 'text', name, text: buf.toString('utf8'), size: buf.byteLength }
        : { kind: 'bytes', name, bytes: new Uint8Array(buf), size: buf.byteLength };
    });
  }

  // ── 3. IPC 핸들러 등록 (mainWindow가 이미 생성된 뒤) ─────────────────────
  // License IPC handlers intentionally NOT registered — license gate
  // disabled for the internal RC test cycle.  See main/index.ts header
  // comment.  licenseHandlers.ts is left in the tree as dead code so a
  // future re-enable doesn't require fishing it out of git history.
  try {
    registerAudioHandlers(ipcMain, mainWindow);
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

// Kill the Python engine subprocess before the app exits so it can't
// outlive Electron as a zombie (most painful on macOS Cmd+Q where the
// window-all-closed → app.quit chain is skipped for the dock-resident
// process).  before-quit fires for every quit path: Cmd+Q, app.quit(),
// even SIGINT from the terminal in dev.
//
// killBridge() is async (it awaits the child's actual exit via SIGTERM,
// escalating to SIGKILL after ~500 ms), so we preventDefault() the first
// before-quit, run the cleanup, then re-quit.  `_engineCleanupDone`
// short-circuits the second before-quit so we don't recurse.
let _engineCleanupDone = false;
app.on('before-quit', (event) => {
  if (_engineCleanupDone) return;
  event.preventDefault();
  void (async () => {
    try {
      await killBridge();
    } catch (err) {
      log.warn('[before-quit] killBridge threw', err);
    } finally {
      _engineCleanupDone = true;
      app.quit();
    }
  })();
});

// ── App-level renderer crash catch-all (긴급 크래시 분석) ───────────────────
// Catches renderer crashes from any window, including ones that fire too
// early for the per-window listener to register.
app.on('render-process-gone', (_e, webContents, details) => {
  log.error('[CRASH] app.render-process-gone:', JSON.stringify({
    reason: details.reason,
    exitCode: details.exitCode,
    url: webContents.getURL(),
  }));
  recordFailure('engine', `app render-process-gone: reason=${details.reason} exit=${details.exitCode}`);
});
app.on('child-process-gone', (_e, details) => {
  log.error('[CRASH] app.child-process-gone:', JSON.stringify({
    type: details.type,        // 'GPU' | 'Pepper Plugin' | 'Utility' | 'Zygote' | etc.
    reason: details.reason,
    exitCode: details.exitCode,
    name: details.name,
  }));
  recordFailure('engine', `child-process-gone: type=${details.type} reason=${details.reason}`);
});

process.on('uncaughtException', (err) => {
  log.error('[CRASH] Uncaught exception', err);
  recordFailure('engine', `uncaughtException: ${err.message}`);
});
process.on('unhandledRejection', (reason) => {
  log.error('[CRASH] Unhandled rejection', reason);
  recordFailure('engine', `unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}`);
});
