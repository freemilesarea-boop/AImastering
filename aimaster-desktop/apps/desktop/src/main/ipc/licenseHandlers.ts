import type { IpcMain } from 'electron';
import Store from 'electron-store';
import { LicenseService } from '@aimaster/license-core';

// Encrypted electron-store (AES-256-CBC via safeStorage or password-based).
// C-04 fix (audit 2026-05): the encryption key is now build-time injected
// by esbuild's `define` so production binaries don't expose the literal
// in source.  CI sets LICENSE_STORE_KEY at release-build time; dev
// builds fall back to a clearly-labelled DEV-ONLY value.
declare const __LICENSE_STORE_KEY__: string | undefined;
const STORE_KEY =
  (typeof __LICENSE_STORE_KEY__ !== 'undefined' && __LICENSE_STORE_KEY__)
  || process.env['LICENSE_STORE_KEY']
  || 'aimaster-enc-v1-DEV-ONLY';
const store = new Store({ name: 'license', encryptionKey: STORE_KEY });

/**
 * Shared service singleton.
 * Exported so audioHandlers can perform the license gate without a second store.
 */
export const licenseService = new LicenseService({
  get: <T>(k: string) => store.get(k) as T | undefined,
  set: (k, v) => store.set(k, v),
  delete: (k) => store.delete(k),
});

export function registerLicenseHandlers(ipc: IpcMain): void {
  // ── Read ──────────────────────────────────────────────────────────────
  ipc.handle('license:status',        () => licenseService.getLicenseState());
  ipc.handle('license:can-process',   () => licenseService.canProcess());
  ipc.handle('license:get-remaining', () => licenseService.getRemainingTrials());

  // ── Write ─────────────────────────────────────────────────────────────
  ipc.handle('license:activate',        (_e, key: string) => licenseService.activateLicense(key));
  ipc.handle('license:deactivate',      ()                => licenseService.deactivate());
  ipc.handle('license:decrement-trial', ()                => { licenseService.decrementTrialUsage(); });
}
