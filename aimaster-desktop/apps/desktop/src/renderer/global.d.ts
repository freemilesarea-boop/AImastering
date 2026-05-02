/// <reference types="vite/client" />

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
}
