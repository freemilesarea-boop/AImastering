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
import { validateText } from '../utils/ipcValidation.js';

// `encryptionKey` here is TAMPER OBFUSCATION, not protection, and the comment
// that used to sit on this line said "AES-256-CBC via safeStorage".  Measured
// against the library: `conf` derives a key with
// `pbkdf2Sync(encryptionKey, iv, 10_000, 32, 'sha512')` and runs
// `aes-256-cbc` — so the cipher half was right — but safeStorage is not
// involved at any point, and the key is the string on this line, compiled
// into the app.  `conf`'s own readme says it in as many words: "Note that
// this is not intended for security purposes, since the encryption key would
// be easily found inside a plain-text Node.js app."
//
// What actually protects a licence is the SERVER: `RemoteValidator` checks
// the key and the machine id, and the stored record carries an HMAC.  A build
// with no endpoint falls back to `LocalValidator`, which is no protection at
// all — hence the warning below, which is the honest line about this file.
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
  // Validated rather than passed through: `activateLicense`'s first act is
  // `key.toUpperCase()`, so anything that was not a string used to surface as
  // `key.toUpperCase is not a function` instead of the domain error.
  ipc.handle('license:activate', (_e, key: unknown) =>
    licenseService.activateLicense(validateText(key, 'license:activate')));
  ipc.handle('license:deactivate',      ()                => licenseService.deactivate());
  ipc.handle('license:decrement-trial', ()                => { licenseService.decrementTrialUsage(); });
  ipc.handle('license:revalidate',      ()                => licenseService.revalidate());
}
