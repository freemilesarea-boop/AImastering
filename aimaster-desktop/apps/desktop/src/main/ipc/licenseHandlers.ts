import type { IpcMain } from 'electron';
import Store from 'electron-store';
import { LicenseService } from '@aimaster/license-core';

const store = new Store({ name: 'license', encryptionKey: 'aimaster-enc-v1' });
const service = new LicenseService({
  get: <T>(k: string) => store.get(k) as T | undefined,
  set: (k, v) => store.set(k, v),
  delete: (k) => store.delete(k),
});

export function registerLicenseHandlers(ipc: IpcMain): void {
  ipc.handle('license:status', () => service.getInfo());
  ipc.handle('license:activate', (_e, key: string) => service.activate(key));
  ipc.handle('license:deactivate', () => service.deactivate());
}
