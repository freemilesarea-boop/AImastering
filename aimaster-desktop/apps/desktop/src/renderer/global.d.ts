/// <reference types="vite/client" />

/** Vite-injected build-time constants (see vite.config.ts `define`). */
declare const __APP_VERSION__: string;
declare const __APP_NAME__:    string;

/**
 * Electron preload API exposed via contextBridge.
 * Kept intentionally narrow — only channels explicitly listed in preload/index.ts.
 *
 * App.tsx 가 마운트 시점에 `window.electronAPI` 존재를 확인하고,
 * 없으면 NoApiUI 만 렌더하므로, 페이지 컴포넌트들은 항상 정의돼 있다고
 * 가정한다 (non-optional).
 */
declare interface Window {
  electronAPI: {
    invoke(channel: string, ...args: unknown[]): Promise<unknown>;
    on(channel: string, listener: (...args: unknown[]) => void): () => void;
    platform: 'darwin' | 'win32' | 'linux';
    version: string;
  };
  updater: {
    checkForUpdates(): Promise<{ ok: boolean; reason?: string }>;
    downloadUpdate():  Promise<{ ok: boolean; reason?: string }>;
    quitAndInstall():  Promise<{ ok: boolean; reason?: string }>;
    getStatus():       Promise<UpdaterStatus>;
    onStatus(listener: (status: UpdaterStatus) => void): () => void;
  };
}

/** v3.4.3+ — Auto-update status events, mirrored from src/main/updater.ts */
type UpdaterStatus =
  | { type: 'idle' }
  | { type: 'checking' }
  | { type: 'available';         info: { version: string; releaseNotes?: string | null } }
  | { type: 'not-available';     info: { version: string } }
  /** v3.4.5 — release server reachable but no published version yet.
      Renderer should treat this as silent (no toast). */
  | { type: 'no-release' }
  | { type: 'download-progress'; progress: {
      percent: number; bytesPerSecond: number;
      transferred: number; total: number;
    } }
  | { type: 'downloaded';        info: { version: string } }
  | { type: 'error';             message: string; code?: string };
