/**
 * Electron preload API exposed via contextBridge.
 * Kept intentionally narrow — only channels explicitly listed in preload/index.ts.
 */
declare interface Window {
  electronAPI: {
    invoke(channel: string, ...args: unknown[]): Promise<unknown>;
    on(channel: string, listener: (...args: unknown[]) => void): () => void;
    platform: 'darwin' | 'win32' | 'linux';
    version: string;
  };
}
