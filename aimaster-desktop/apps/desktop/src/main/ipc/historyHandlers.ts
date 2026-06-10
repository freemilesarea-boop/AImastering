import type { IpcMain } from 'electron';
import Store from 'electron-store';

// Durable mastering-history persistence (P2).  The renderer owns the schema
// (see renderer/audio/mastering-history.ts); the main process is a dumb, bounded
// key-value store — it persists the serialized blob the renderer sends after a
// shape + size check, and never interprets the contents.

const store = new Store({ name: 'mastering-history' });
const KEY = 'history';
// ~2 MB cap: 100 entries × an options snapshot is comfortably under this.
const MAX_BYTES = 2 * 1024 * 1024;

export function registerHistoryHandlers(ipc: IpcMain): void {
  ipc.handle('history:get', () => {
    return store.get(KEY) ?? null;
  });

  ipc.handle('history:set', (_e, value: unknown) => {
    // Must be a JSON-serializable plain object under the size cap.
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('history:set: value must be a plain object');
    }
    let json: string;
    try {
      json = JSON.stringify(value);
    } catch {
      throw new Error('history:set: value is not JSON-serializable');
    }
    if (json.length > MAX_BYTES) {
      throw new Error(`history:set: payload too large (${json.length} > ${MAX_BYTES})`);
    }
    store.set(KEY, JSON.parse(json));
  });
}
