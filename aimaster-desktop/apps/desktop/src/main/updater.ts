/**
 * Auto-update orchestrator for the Electron main process (v3.4.5).
 *
 * Gating:
 *   1. `app.isPackaged`           — never check from dev/`pnpm dev`.
 *   2. `__AUTO_UPDATE_ENABLED__`  — baked at build time by esbuild.
 *      true  : production tag-build installer (CI sets AUTO_UPDATE_ENABLED=true
 *              on `refs/tags/v*` only).
 *      false : Actions branch artefact, workflow_dispatch artefact, dev build,
 *              local `pnpm dist` test build.  Never queries GitHub.
 *
 *   Both must be true for any network activity to happen.  This eliminates
 *   the "No published versions on GitHub" toast that appeared when users
 *   ran a CI artefact built from a branch where no GitHub Release exists.
 *
 * Soft-error reclassification:
 *   "No published versions on GitHub" is the literal message electron-updater
 *   emits when latest.yml is absent (e.g. release was created but not yet
 *   published).  This is NOT a fatal error — the user just hasn't been
 *   offered a release yet.  We map it to a `no-release` status that the
 *   renderer renders as silence (no toast).
 *
 * Renderer-facing IPC bridge (events + commands)
 *   · checkForUpdates()         → main triggers an immediate check
 *   · downloadUpdate()          → user accepted the offer
 *   · quitAndInstall()          → user clicked "restart now"
 *   · onStatus(callback)        → stream of typed UpdaterStatus events
 *
 * Manual download flow (autoDownload = false): user gets a "new version
 * available — download?" prompt before any bytes move.
 *
 * SIGNING / NOTARIZATION CAVEATS:
 *   - Windows NSIS: works without code-signing for unsigned installers,
 *     but Windows SmartScreen will warn until the installer is signed.
 *     v3.5 task.
 *   - macOS: auto-update REQUIRES a code-signed + notarized .app inside
 *     the .zip / .dmg.  Without notarization the OS refuses to launch the
 *     replacement and electron-updater reports
 *     "Could not get code signature for running application".
 *     See `mac.identity` placeholder in electron-builder.yml — currently
 *     no Apple Developer cert is configured, so mac auto-update will fail
 *     gracefully with a clear error event.  v3.5 task.
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

// Build-time constant injected by esbuild (`define`).  Default false at the
// type level so an unbundled run (e.g. tsc unit tests) doesn't crash.
declare const __AUTO_UPDATE_ENABLED__: boolean;

// ── Types shared with renderer (also declared in preload typings) ───────────

export type UpdaterStatus =
  | { type: 'idle' }
  | { type: 'checking' }
  | { type: 'available';        info: UpdateInfo }
  | { type: 'not-available';    info: UpdateInfo }
  | { type: 'no-release' }                                  // v3.4.5
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

/**
 * Patterns that indicate "no release published yet" rather than a real
 * failure.  electron-updater wraps these as Errors with the literal text
 * shown in the message.
 */
const SOFT_NO_RELEASE_PATTERNS: RegExp[] = [
  /No published versions on GitHub/i,
  /404.*latest(-mac|-linux)?\.yml/i,
  /Cannot find latest(-mac|-linux)?\.yml/i,
  /HttpError:\s*404/i,                  // bare 404 on the metadata file
];

function _isNoReleaseError(message: string): boolean {
  return SOFT_NO_RELEASE_PATTERNS.some(re => re.test(message));
}

/** True when the build was produced for a real release channel. */
function _autoUpdateEnabled(): boolean {
  // Both gates required: packaged binary + tag-build flag baked in.
  return app.isPackaged && (typeof __AUTO_UPDATE_ENABLED__ === 'boolean'
    ? __AUTO_UPDATE_ENABLED__
    : false);
}


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
  autoUpdater.autoDownload = false;
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
    const message = err.message ?? String(err);
    // Soft error — release just hasn't been published yet.  Treat as
    // benign "no release" rather than a fatal error toast.
    if (_isNoReleaseError(message)) {
      log.info('[updater] no published release yet — silent');
      _send({ type: 'no-release' });
      return;
    }
    log.error('[updater] error:', err);
    const code = (err as { code?: string }).code;
    const status: UpdaterStatus = code
      ? { type: 'error', message, code }
      : { type: 'error', message };
    _send(status);
  });
}


/**
 * Set up the updater.  Safe to call multiple times — only initializes once.
 * In dev OR when AUTO_UPDATE_ENABLED is false (branch/workflow_dispatch
 * artefact builds), the IPC handlers are still registered but every
 * network-touching call returns { ok: false, reason: ... } so the renderer
 * UI can stay quiet.
 */
export function initUpdater(mainWindow: BrowserWindow, ipcMain: IpcMain): void {
  if (_initialized) {
    _mainWindow = mainWindow;
    return;
  }
  _initialized = true;
  _mainWindow  = mainWindow;

  const enabled = _autoUpdateEnabled();

  // ── IPC handlers (always registered, gated internally) ──
  ipcMain.handle('updater:check', async () => {
    if (!enabled) {
      log.info('[updater] check requested but auto-update disabled in this build');
      return { ok: false, reason: app.isPackaged ? 'no_release_channel' : 'dev_build' };
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
    if (!enabled) {
      return { ok: false, reason: app.isPackaged ? 'no_release_channel' : 'dev_build' };
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
    if (!enabled) {
      log.info('[updater] quit-and-install requested but auto-update disabled');
      return { ok: false, reason: app.isPackaged ? 'no_release_channel' : 'dev_build' };
    }
    autoUpdater.quitAndInstall(false, true);
    return { ok: true };
  });

  ipcMain.handle('updater:get-status', () => _lastStatus);

  if (!enabled) {
    log.info(`[updater] auto-update disabled (packaged=${app.isPackaged}, ` +
             `buildEnabled=${typeof __AUTO_UPDATE_ENABLED__ === 'boolean' ? __AUTO_UPDATE_ENABLED__ : 'undef'})`);
    return;
  }

  _wireAutoUpdaterEvents();

  // Schedule the first automatic check.
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      const message = (err as Error)?.message ?? String(err);
      // Initial check can also hit the same soft "no release" path before
      // the event handler is wired for it; suppress the same way.
      if (_isNoReleaseError(message)) {
        log.info('[updater] initial check: no published release yet — silent');
        _send({ type: 'no-release' });
        return;
      }
      log.error('[updater] initial check failed:', err);
    });
  }, FIRST_CHECK_DELAY_MS);
}


/**
 * Manual entry point for tests / future "Check for updates…" menu item.
 */
export async function checkForUpdates(): Promise<void> {
  if (!_autoUpdateEnabled()) {
    log.info('[updater] manual check skipped — auto-update disabled');
    return;
  }
  await autoUpdater.checkForUpdates();
}
