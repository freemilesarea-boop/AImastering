/**
 * Auto-update orchestrator for the Electron main process (v3.4.3).
 *
 * Wraps `electron-updater` with:
 *
 *   · Renderer-facing IPC bridge (events + commands)
 *   · Production-only activation (dev launches never check)
 *   · Manual download flow (autoDownload = false) so the user gets a
 *     "new version available — download?" prompt first
 *   · Structured status events streamed to the renderer for the toast UI
 *
 * Update server:
 *   GitHub Releases — provider configured in electron-builder.yml.
 *   The published .yml metadata files (latest.yml / latest-mac.yml /
 *   latest-linux.yml) are read by electron-updater.
 *
 * SIGNING / NOTARIZATION CAVEATS:
 *   - Windows NSIS: works without code-signing for unsigned installers,
 *     but Windows SmartScreen will warn users until the installer is
 *     signed.  Signing is on the v3.5 roadmap — see TODO below.
 *   - macOS: auto-update REQUIRES a code-signed + notarized .app inside
 *     the .zip / .dmg.  Without notarization the OS refuses to launch the
 *     replacement, and electron-updater reports
 *     "Could not get code signature for running application".
 *     See `mac.identity` placeholder in electron-builder.yml — currently
 *     no Apple Developer cert is configured, so mac auto-update will
 *     gracefully fail with a clear error event.  v3.5 task.
 *
 * PRIVATE REPO:
 *   If the GitHub repo becomes private, electron-updater needs a personal
 *   access token at runtime (env GH_TOKEN).  Currently the repo is public
 *   so no token is needed.  TODO: surface a "configure update token" UI
 *   if/when the repo goes private.
 */
import { app, BrowserWindow } from 'electron';
import type { IpcMain } from 'electron';
import log from 'electron-log/main';
import { autoUpdater, type UpdateInfo, type ProgressInfo } from 'electron-updater';

// ── Types shared with renderer (also declared in preload typings) ───────────

export type UpdaterStatus =
  | { type: 'idle' }
  | { type: 'checking' }
  | { type: 'available';        info: UpdateInfo }
  | { type: 'not-available';    info: UpdateInfo }
  | { type: 'download-progress'; progress: ProgressInfo }
  | { type: 'downloaded';       info: UpdateInfo }
  | { type: 'error';            message: string; code?: string };

// ── Module state ────────────────────────────────────────────────────────────

let _initialized = false;
let _mainWindow: BrowserWindow | null = null;
let _lastStatus: UpdaterStatus = { type: 'idle' };

// ── Configuration ───────────────────────────────────────────────────────────

/**
 * Time after `app.whenReady()` before the first automatic update check.
 * Renderer is given a few seconds to mount + display the toast UI before
 * the first event lands.
 */
const FIRST_CHECK_DELAY_MS = 5_000;


function _send(status: UpdaterStatus): void {
  _lastStatus = status;
  if (!_mainWindow || _mainWindow.isDestroyed()) return;
  try {
    _mainWindow.webContents.send('updater:status', status);
  } catch (err) {
    log.warn('[updater] send failed:', err);
  }
}


function _wireAutoUpdaterEvents(): void {
  autoUpdater.logger = log;
  // We surface the prompt manually so the user can choose to download.
  autoUpdater.autoDownload = false;
  // After download, we surface a "restart now" UI rather than auto-quitting.
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    log.info('[updater] checking-for-update');
    _send({ type: 'checking' });
  });

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    log.info('[updater] update-available:', info.version);
    _send({ type: 'available', info });
  });

  autoUpdater.on('update-not-available', (info: UpdateInfo) => {
    log.info('[updater] update-not-available:', info.version);
    _send({ type: 'not-available', info });
  });

  autoUpdater.on('download-progress', (progress: ProgressInfo) => {
    _send({ type: 'download-progress', progress });
  });

  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    log.info('[updater] update-downloaded:', info.version);
    _send({ type: 'downloaded', info });
  });

  autoUpdater.on('error', (err: Error) => {
    log.error('[updater] error:', err);
    const code = (err as { code?: string }).code;
    const status: UpdaterStatus = code
      ? { type: 'error', message: err.message ?? String(err), code }
      : { type: 'error', message: err.message ?? String(err) };
    _send(status);
  });
}


/**
 * Set up the updater.  Safe to call multiple times — only initializes once.
 * In dev (app.isPackaged === false) this is a no-op so devs never see
 * "you're not on a packaged build" errors.
 */
export function initUpdater(mainWindow: BrowserWindow, ipcMain: IpcMain): void {
  if (_initialized) {
    _mainWindow = mainWindow;
    return;
  }
  _initialized = true;
  _mainWindow  = mainWindow;

  // ── IPC handlers (always registered, even in dev — they just no-op) ──
  ipcMain.handle('updater:check', async () => {
    if (!app.isPackaged) {
      log.info('[updater] check requested in dev — skipping');
      return { ok: false, reason: 'dev_build' };
    }
    try {
      await autoUpdater.checkForUpdates();
      return { ok: true };
    } catch (err) {
      log.error('[updater] checkForUpdates failed:', err);
      return { ok: false, reason: (err as Error).message };
    }
  });

  ipcMain.handle('updater:download', async () => {
    if (!app.isPackaged) {
      return { ok: false, reason: 'dev_build' };
    }
    try {
      await autoUpdater.downloadUpdate();
      return { ok: true };
    } catch (err) {
      log.error('[updater] downloadUpdate failed:', err);
      return { ok: false, reason: (err as Error).message };
    }
  });

  ipcMain.handle('updater:quit-and-install', () => {
    if (!app.isPackaged) {
      log.info('[updater] quit-and-install requested in dev — ignoring');
      return { ok: false, reason: 'dev_build' };
    }
    // isSilent=false so user sees installer progress; isForceRunAfter=true
    // so the new app launches immediately after install.
    autoUpdater.quitAndInstall(false, true);
    return { ok: true };
  });

  ipcMain.handle('updater:get-status', () => _lastStatus);

  if (!app.isPackaged) {
    log.info('[updater] dev build — auto-update disabled');
    return;
  }

  _wireAutoUpdaterEvents();

  // Schedule the first automatic check.  Wrapped in a setTimeout so the
  // renderer has time to mount its toast before any event lands.
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      log.error('[updater] initial check failed:', err);
    });
  }, FIRST_CHECK_DELAY_MS);
}


/**
 * Manual entry point for tests / future "Check for updates…" menu item.
 */
export async function checkForUpdates(): Promise<void> {
  if (!app.isPackaged) {
    log.info('[updater] manual check skipped in dev');
    return;
  }
  await autoUpdater.checkForUpdates();
}
