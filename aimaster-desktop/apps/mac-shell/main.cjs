// macOS wrapper for the apps/mobile on-device mastering app.
//
// It loads the *built* mobile SPA (apps/mobile/dist, copied to ./www) in a
// BrowserWindow and nothing else: no preload, no python engine. The web app
// runs its WEB fallbacks (Capacitor.isNativePlatform() === false) — file
// <input> for picking, <a download> for saving, navigator.share→download for
// sharing — and masters audio ENTIRELY on-device (Web Audio API). No server.
//
// The SPA is served through a custom `app://` scheme rather than file:// so that
// Vite's ES-module <script type=module> tags load (file:// blocks module CORS).
//
// Diagnostics (P0 macOS "black screen at result/export"): this app previously
// had NO crash handling, so any renderer/GPU crash left the window showing its
// backgroundColor (#0b0d12 ≈ black) with no log and no recovery. We now log
// every crash path (main uncaught, render-process-gone, GPU/child-process-gone,
// did-fail-load, unresponsive, and forwarded renderer console) to stderr + a
// file, and on a renderer crash show a visible error screen instead of black.
const { app, BrowserWindow, protocol, net, shell, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const WWW = path.join(__dirname, 'www');
const DEBUG = process.env.LOUI_DEBUG === '1';

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

// Opt-in lever for the classic macOS Electron GPU "black screen": only takes
// effect when set, so it changes nothing by default. Use it to A/B test if the
// diagnostics below report a GPU child-process-gone.
if (process.env.LOUI_DISABLE_HW_ACCEL === '1') {
  app.disableHardwareAcceleration();
}

// ── Logging ──────────────────────────────────────────────────────────────────
let logFile = null;
function logPath() {
  try {
    return path.join(app.getPath('userData'), 'loui-mac-shell.log');
  } catch {
    return path.join(require('node:os').tmpdir(), 'loui-mac-shell.log');
  }
}
function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts
    .map((p) => (typeof p === 'string' ? p : safeStringify(p)))
    .join(' ')}\n`;
  process.stderr.write(line);
  try {
    if (!logFile) logFile = logPath();
    fs.appendFileSync(logFile, line);
  } catch {
    /* best-effort */
  }
}
function safeStringify(o) {
  try {
    return JSON.stringify(o);
  } catch {
    return String(o);
  }
}

// ── Main-process crash visibility ─────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  log('MAIN uncaughtException:', err && err.stack ? err.stack : String(err));
});
process.on('unhandledRejection', (reason) => {
  log('MAIN unhandledRejection:', reason && reason.stack ? reason.stack : safeStringify(reason));
});

// GPU process is the prime suspect for a macOS "whole window goes black + frozen"
// failure. type is one of 'GPU' | 'renderer' | 'utility' | …
app.on('child-process-gone', (_e, details) => {
  log('child-process-gone:', details);
});
app.on('render-process-gone', (_e, _wc, details) => {
  log('app render-process-gone:', details);
});

// Built-in error screen so a renderer crash is never a silent black window.
function errorScreen(reason) {
  const safe = String(reason || 'unknown').replace(/[<>&]/g, ' ');
  const html = `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;height:100%;background:#0b0d12;color:#e6e9ef;
font:15px/1.5 -apple-system,BlinkMacSystemFont,sans-serif;display:flex;
align-items:center;justify-content:center}.b{max-width:340px;padding:24px;text-align:center}
h1{font-size:17px;margin:0 0 8px}p{opacity:.75;margin:0 0 18px}
button{font:inherit;padding:10px 18px;border:0;border-radius:10px;background:#3a6df0;color:#fff}
code{opacity:.6;font-size:12px;word-break:break-all}</style>
<div class="b"><h1>화면을 다시 불러왔어요</h1>
<p>마스터링 결과 화면에서 문제가 발생해 앱을 복구했습니다. 다시 시도해 주세요.</p>
<button onclick="location.replace('app://localhost/')">다시 시작</button>
<p style="margin-top:16px"><code>${safe}</code></p></div>`;
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

// ── DEPRECATION NOTICE (default) ──────────────────────────────────────────────
// The mobile SPA masters audio in the renderer via the Web Audio API
// (OfflineAudioContext + manual WAV encode). On macOS that path SIGSEGVs the
// renderer (render-process-gone reason:"crashed" exitCode:11), with HW accel on
// OR off — a native crash that cannot be fixed from JS and cannot be moved off
// the renderer (Node main/worker/utility processes have no Web Audio). The
// macOS product is apps/desktop (Louver Mastering AI — local Python/FFmpeg
// engine). So mac-shell defaults to a notice and does NOT run the crashing
// engine. Set LOUI_RUN_SPA=1 to force-load the SPA (diagnostics only).
const RUN_SPA = process.env.LOUI_RUN_SPA === '1';
function noticeUrl() {
  const html = `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;height:100%;background:#0b0d12;color:#e6e9ef;
font:15px/1.6 -apple-system,BlinkMacSystemFont,sans-serif;display:flex;
align-items:center;justify-content:center}.b{max-width:360px;padding:28px;text-align:center}
h1{font-size:18px;margin:0 0 10px}p{opacity:.8;margin:0 0 12px}
.s{opacity:.55;font-size:12px;margin-top:18px}</style>
<div class="b"><h1>macOS는 데스크톱 앱을 사용해 주세요</h1>
<p>이 macOS 빌드는 더 이상 마스터링을 실행하지 않습니다. macOS 마스터링은
<b>Louver Mastering AI</b> 데스크톱 앱을 이용해 주세요.</p>
<p class="s">(mac-shell deprecated — on-device Web Audio mastering crashes the
macOS renderer. See apps/mac-shell/README.md)</p></div>`;
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}
// The URL the window should show on launch and recover to after a crash.
function startUrl() {
  return RUN_SPA ? 'app://localhost/' : noticeUrl();
}

function createWindow() {
  const win = new BrowserWindow({
    width: 460,
    height: 900,
    minWidth: 380,
    minHeight: 620,
    title: 'Loui Mastering',
    backgroundColor: '#0b0d12',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const wc = win.webContents;

  // Forward ALL renderer console output (incl. uncaught errors / unhandled
  // rejections, which Chromium logs at level "error") to our log. level:
  // 0 verbose · 1 info · 2 warning · 3 error.
  wc.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2 || DEBUG) {
      log(`renderer console[${level}] ${message} (${sourceId}:${line})`);
    }
  });

  wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    log('did-fail-load:', { code, desc, url, isMainFrame });
  });

  wc.on('unresponsive', () => log('webContents unresponsive (renderer hung)'));
  wc.on('responsive', () => log('webContents responsive again'));
  wc.on('did-finish-load', () => log('did-finish-load:', wc.getURL()));

  // The crash that produces the black screen. Recover with a backoff so a
  // deterministic crash can't loop: reload once, but after repeated crashes
  // within a short window show the static error screen instead.
  let crashTimes = [];
  wc.on('render-process-gone', (_e, details) => {
    log('render-process-gone:', details);
    const now = Date.now();
    crashTimes = crashTimes.filter((t) => now - t < 8000);
    crashTimes.push(now);
    if (win.isDestroyed()) return;
    if (crashTimes.length >= 3) {
      log('render-process-gone: too many crashes — showing error screen');
      win.loadURL(errorScreen(details && details.reason));
    } else {
      log('render-process-gone: recovering →', RUN_SPA ? 'app://localhost/' : 'notice');
      win.loadURL(startUrl());
    }
  });

  // External links open in the default browser, never a new Electron window.
  wc.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });

  if (DEBUG) wc.openDevTools({ mode: 'detach' });

  win.loadURL(startUrl());
  log('window created; mode:', RUN_SPA ? 'SPA (LOUI_RUN_SPA=1)' : 'deprecation-notice',
    '· log file:', logPath());
}

app.whenReady().then(() => {
  // Serve ./www over app:// (maps app://localhost/<path> → www/<path>).
  protocol.handle('app', (req) => {
    let rel = decodeURIComponent(new URL(req.url).pathname);
    if (!rel || rel === '/') rel = '/index.html';
    const filePath = path.normalize(path.join(WWW, rel));
    if (!filePath.startsWith(WWW)) return new Response('forbidden', { status: 403 });
    return net.fetch(pathToFileURL(filePath).toString());
  });

  // Standard macOS app menu (enables ⌘C/⌘V/⌘Q etc.) without custom logic.
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]));

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
