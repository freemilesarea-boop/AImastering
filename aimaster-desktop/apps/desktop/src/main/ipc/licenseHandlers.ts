import type { IpcMain } from 'electron';
import Store from 'electron-store';
import {
  LicenseService,
  LocalValidator,
  RemoteValidator,
  LICENSE_API_URL,
  LICENSE_API_KEY,
} from '@aimaster/license-core';
import { log } from '../utils/logger.js';

// Encrypted electron-store (AES-256-CBC via safeStorage or password-based)
const store = new Store({ name: 'license', encryptionKey: 'aimaster-enc-v1' });

// Server-backed validation when the build injected a license API endpoint
// (production).  Dev builds with no endpoint fall back to LocalValidator so
// testers can activate any well-formed key.
const validator = (LICENSE_API_URL && LICENSE_API_KEY)
  ? new RemoteValidator(LICENSE_API_URL, LICENSE_API_KEY)
  : new LocalValidator();

if (!(LICENSE_API_URL && LICENSE_API_KEY)) {
  log.warn('[license] LICENSE_API_URL/KEY not injected — using LocalValidator (DEV ONLY, no real protection).');
}

/**
 * Shared service singleton.
 * Exported so audioHandlers can perform the license gate without a second store.
 */
export const licenseService = new LicenseService(
  {
    get: <T>(k: string) => store.get(k) as T | undefined,
    set: (k, v) => store.set(k, v),
    delete: (k) => store.delete(k),
  },
  validator,
);

export function registerLicenseHandlers(ipc: IpcMain): void {
  // ── Read ──────────────────────────────────────────────────────────────
  ipc.handle('license:status',        () => licenseService.getLicenseState());
  ipc.handle('license:can-process',   () => licenseService.canProcess());
  ipc.handle('license:get-remaining', () => licenseService.getRemainingTrials());

  // ── Write ─────────────────────────────────────────────────────────────
  ipc.handle('license:activate',        (_e, key: string) => licenseService.activateLicense(key));
  ipc.handle('license:deactivate',      ()                => licenseService.deactivate());
  ipc.handle('license:decrement-trial', ()                => { licenseService.decrementTrialUsage(); });
  ipc.handle('license:revalidate',      ()                => licenseService.revalidate());
}
