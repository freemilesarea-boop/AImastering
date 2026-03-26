/**
 * Electron preload API exposed via contextBridge.
 * Kept intentionally narrow — only channels explicitly listed in preload/index.ts.
 */
declare interface Window {
  // preload가 로드되지 않은 경우 undefined일 수 있으므로 optional로 선언
  electronAPI?: {
    invoke(channel: string, ...args: unknown[]): Promise<unknown>;
    on(channel: string, listener: (...args: unknown[]) => void): () => void;
    platform: 'darwin' | 'win32' | 'linux';
    version: string;
  };
}
