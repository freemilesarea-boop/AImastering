/**
 * AIMASTER License Core — v1
 *
 * Policy:
 *   Free  : up to TRIAL_MAX processing runs; WAV save locked, MP3 preview open
 *   Pro   : unlimited; all features unlocked
 *
 * Storage layout (electron-store, AES-256-CBC encrypted at rest):
 *   'license'  → StoredLicense  (key + tier + HMAC binding to machineId)
 *   'trial'    → TrialRecord    (usage count + HMAC binding to machineId)
 *
 * Tamper resistance:
 *   Both records carry an HMAC-SHA256 signature that covers the sensitive
 *   fields and the machine ID.  Signature verification uses timingSafeEqual
 *   to resist timing-based attacks.  If verification fails the record is
 *   treated as invalid (license → free, trial → maxed out).
 *
 * Server API readiness:
 *   Validation logic is behind the LicenseValidator interface.
 *   LocalValidator is the v1 implementation (format check only).
 *   Swap in a RemoteValidator when the server API is ready — no other
 *   changes required.
 */

import crypto from 'node:crypto';
import { machineIdSync } from 'node-machine-id';
import type { LicenseInfo, LicenseTier } from '@aimaster/shared-types';

// ── Developer log shim (avoids a circular dep on apps/desktop/logger) ─────────
// In production this is picked up by the Electron logger; in tests it goes
// to stderr so failures are still visible.
function devLog(level: 'warn' | 'error', msg: string, extra?: unknown): void {
  const line = `[license-core] [${level.toUpperCase()}] ${msg}${extra !== undefined ? ' ' + JSON.stringify(extra) : ''}`;
  if (level === 'error') {
    process.stderr.write(line + '\n');
  } else {
    process.stderr.write(line + '\n');
  }
}

// ── Constants ─────────────────────────────────────────────────────────────────

const KEY_REGEX   = /^AIMASTER-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const TRIAL_MAX   = 3;

/**
 * Dev-only fallback HMAC secret.  NEVER usable from a packaged production
 * build — `assertLicenseSecretReady()` (called by the host on app start
 * when `app.isPackaged === true`) refuses this value.
 *
 * In a production build the host MUST set `LICENSE_HMAC_SECRET` to a
 * sufficiently-long random secret BEFORE importing license-core, e.g. via
 * the installer environment, a build-time inject, or an env-baked entry
 * point.  Without it `assertLicenseSecretReady()` throws and the host is
 * expected to surface a fatal error and quit.
 */
export const DEV_FALLBACK_HMAC_SECRET = 'aimaster-local-secret-v1';

const HMAC_SECRET = process.env['LICENSE_HMAC_SECRET'] ?? DEV_FALLBACK_HMAC_SECRET;

/**
 * Returns true iff the active HMAC secret is a real production secret —
 * i.e. neither the dev fallback nor empty.  Production builds must call
 * `assertLicenseSecretReady()` at startup to refuse to run otherwise.
 */
export function isLicenseSecretProductionReady(): boolean {
  return typeof HMAC_SECRET === 'string'
      && HMAC_SECRET.length >= 16
      && HMAC_SECRET !== DEV_FALLBACK_HMAC_SECRET;
}

/**
 * Throw if the active HMAC secret is not safe for production.  Hosts call
 * this from the main process on startup when `app.isPackaged === true`
 * (or another reliable production signal).  Dev / unpackaged builds skip
 * this check and the dev fallback is used.
 *
 * The error message is intentionally explicit so a packager who forgot to
 * inject the secret can self-diagnose.
 */
export function assertLicenseSecretReady(): void {
  if (isLicenseSecretProductionReady()) return;
  throw new Error(
    '[license-core] LICENSE_HMAC_SECRET missing or set to the dev fallback. ' +
    'Production builds must inject a strong (>= 16 char) secret via the ' +
    'LICENSE_HMAC_SECRET environment variable BEFORE the main process imports ' +
    'license-core.  Refusing to run with the dev secret in production.',
  );
}

// ── Storage types ─────────────────────────────────────────────────────────────

/** License activation record — stored encrypted. */
export interface StoredLicense {
  key: string;
  tier: LicenseTier;
  activatedAt: string;
  expiresAt?: string;
  machineId: string;
  /** HMAC-SHA256 over key|tier|activatedAt|machineId */
  hmac: string;
}

/** Trial usage record — stored alongside license. */
interface TrialRecord {
  used: number;
  machineId: string;
  /** HMAC-SHA256 over trial|used|machineId */
  hmac: string;
}

// ── HMAC helpers ──────────────────────────────────────────────────────────────

function signLicense(
  key: string, tier: LicenseTier, activatedAt: string, machineId: string
): string {
  return crypto
    .createHmac('sha256', HMAC_SECRET)
    .update(`${key}|${tier}|${activatedAt}|${machineId}`)
    .digest('hex');
}

function verifyLicense(stored: StoredLicense): boolean {
  try {
    const expected = Buffer.from(
      signLicense(stored.key, stored.tier, stored.activatedAt, stored.machineId)
    );
    const actual = Buffer.from(stored.hmac);
    if (expected.length !== actual.length) return false;
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function signTrial(used: number, machineId: string): string {
  return crypto
    .createHmac('sha256', HMAC_SECRET)
    .update(`trial|${used}|${machineId}`)
    .digest('hex');
}

function verifyTrial(record: TrialRecord): boolean {
  try {
    const expected = Buffer.from(signTrial(record.used, record.machineId));
    const actual   = Buffer.from(record.hmac);
    if (expected.length !== actual.length) {
      // Case 9: HMAC length mismatch — possible store corruption or tampering
      devLog('error', 'Trial HMAC length mismatch — treating as maxed-out (corruption or tamper)', {
        expectedLen: expected.length,
        actualLen:   actual.length,
        used:        record.used,
      });
      return false;
    }
    const ok = crypto.timingSafeEqual(expected, actual);
    if (!ok) {
      // Case 9: HMAC mismatch — log for developer
      devLog('error', 'Trial HMAC verification failed — treating as maxed-out (possible tamper)', {
        used:      record.used,
        machineId: record.machineId,
      });
    }
    return ok;
  } catch (err) {
    // Case 9: unexpected exception during verification
    devLog('error', 'Trial HMAC verification threw — treating as maxed-out', { err: String(err) });
    return false;
  }
}

// ── Pluggable validator interface ─────────────────────────────────────────────

/** Validation response from any validator implementation. */
export interface ValidatorResponse {
  valid: boolean;
  tier: LicenseTier;
  expiresAt?: string;
  /** Human-readable rejection reason (shown in UI on invalid key). */
  reason?: string;
}

/**
 * Pluggable license key validator.
 *
 * v1 implementation: LocalValidator (format check only).
 * Future: swap in a RemoteValidator that calls the activation server.
 * The rest of LicenseService is unchanged when the validator is swapped.
 */
export interface LicenseValidator {
  validate(key: string, machineId: string): Promise<ValidatorResponse>;
}

/**
 * v1 LocalValidator — any correctly formatted key activates as Pro.
 * Replace with a server-side validator before production launch.
 */
export class LocalValidator implements LicenseValidator {
  async validate(key: string): Promise<ValidatorResponse> {
    if (!KEY_REGEX.test(key)) {
      return {
        valid:  false,
        tier:   'free',
        reason: '올바른 라이선스 키 형식이 아닙니다. (AIMASTER-XXXX-XXXX-XXXX)',
      };
    }
    return { valid: true, tier: 'pro' };
  }
}

// ── Store interface ───────────────────────────────────────────────────────────

export interface LicenseStore {
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  delete(key: string): void;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

export function validateKeyFormat(key: string): boolean {
  return KEY_REGEX.test(key.toUpperCase().trim());
}

export function getMachineId(): string {
  return machineIdSync(true);
}

// ── LicenseService ────────────────────────────────────────────────────────────

export class LicenseService {
  private readonly validator: LicenseValidator;

  constructor(
    private readonly store: LicenseStore,
    validator?: LicenseValidator,
  ) {
    this.validator = validator ?? new LocalValidator();
  }

  // ── Internal readers ───────────────────────────────────────────────────────

  private _readLicense(): StoredLicense | null {
    let stored: StoredLicense | undefined;
    try {
      stored = this.store.get<StoredLicense>('license');
    } catch (err) {
      // Case 9: store read threw (corrupted electron-store file)
      devLog('error', 'Failed to read license record from store — falling back to free tier', { err: String(err) });
      return null;
    }
    if (!stored) return null;
    if (!verifyLicense(stored)) {
      // Case 9: HMAC mismatch on license record
      devLog('error', 'License HMAC verification failed — falling back to free tier', {
        key:  stored.key,
        tier: stored.tier,
      });
      return null;
    }
    return stored;
  }

  private _readTrialUsed(): number {
    const machineId = getMachineId();
    let record: TrialRecord | undefined;

    try {
      record = this.store.get<TrialRecord>('trial');
    } catch (err) {
      // Case 9: store read threw (possibly corrupted electron-store file)
      devLog('error', 'Failed to read trial record from store — treating as maxed-out', { err: String(err) });
      return TRIAL_MAX;
    }

    if (!record) return 0;

    // Case 9: machineId mismatch (device change or store corruption)
    if (record.machineId !== machineId) {
      devLog('warn', 'Trial record machineId mismatch — treating as maxed-out', {
        stored:  record.machineId,
        current: machineId,
      });
      return TRIAL_MAX;
    }

    // Case 9: HMAC verification fails → tamper or corruption
    if (!verifyTrial(record)) return TRIAL_MAX;

    // Case 10: trial count anomaly — used > TRIAL_MAX indicates tampering or corruption
    if (record.used > TRIAL_MAX) {
      devLog('error', 'Trial count anomaly detected — used exceeds maximum', {
        used:     record.used,
        trialMax: TRIAL_MAX,
      });
      return TRIAL_MAX;
    }

    if (record.used < 0) {
      devLog('error', 'Trial count anomaly detected — negative usage count', {
        used: record.used,
      });
      return TRIAL_MAX;
    }

    return record.used;
  }

  private _writeTrialUsed(used: number): void {
    const machineId = getMachineId();
    const record: TrialRecord = {
      used,
      machineId,
      hmac: signTrial(used, machineId),
    };
    this.store.set('trial', record);
  }

  private _buildInfo(stored: StoredLicense | null, trialUsed: number): LicenseInfo {
    if (!stored) {
      return {
        tier: 'free',
        trialUsed,
        trialMax: TRIAL_MAX,
        canSaveMasterWav: false,
        canExportReport:  false,
        canUseAllPresets: false,
      };
    }
    return {
      tier:          stored.tier,
      trialUsed,
      trialMax:      TRIAL_MAX,
      key:           stored.key,
      activatedAt:   stored.activatedAt,
      ...(stored.expiresAt ? { expiresAt: stored.expiresAt } : {}),
      canSaveMasterWav: stored.tier === 'pro',
      canExportReport:  stored.tier === 'pro',
      canUseAllPresets: stored.tier === 'pro',
    };
  }

  // ── Spec-required public API ───────────────────────────────────────────────

  /**
   * Return the current license state including trial usage.
   * (Spec: getLicenseState)
   */
  getLicenseState(): LicenseInfo {
    const stored    = this._readLicense();
    const trialUsed = this._readTrialUsed();
    return this._buildInfo(stored, trialUsed);
  }

  /**
   * Activate with the given license key.
   * Validates via LicenseValidator — swap implementation for server-side check.
   * Throws with a Korean message on invalid key.
   * (Spec: activateLicense)
   */
  async activateLicense(key: string): Promise<LicenseInfo> {
    const normalized = key.toUpperCase().trim();
    const machineId  = getMachineId();

    const result = await this.validator.validate(normalized, machineId);
    if (!result.valid) {
      throw new Error(result.reason ?? '유효하지 않은 라이선스 키입니다.');
    }

    const activatedAt = new Date().toISOString();
    const stored: StoredLicense = {
      key:         normalized,
      tier:        result.tier,
      activatedAt,
      ...(result.expiresAt ? { expiresAt: result.expiresAt } : {}),
      machineId,
      hmac:        signLicense(normalized, result.tier, activatedAt, machineId),
    };

    this.store.set('license', stored);
    return this._buildInfo(stored, this._readTrialUsed());
  }

  /**
   * Consume one trial use.  Call after each successful processing run
   * when the user is on the free tier.
   * (Spec: decrementTrialUsage)
   */
  decrementTrialUsage(): void {
    // Dev bypass: don't consume trial counts in development mode
    if (process.env['NODE_ENV'] === 'development' || process.env['AIMASTER_DEV_LICENSE'] === '1') {
      return;
    }
    const current = this._readTrialUsed();
    // Never exceed TRIAL_MAX (belt-and-suspenders)
    this._writeTrialUsed(Math.min(current + 1, TRIAL_MAX));
  }

  /**
   * Check whether processing is allowed right now.
   * Returns: { allowed, isPaid, remaining, reason? }
   * (Spec: canProcess)
   */
  canProcess(): { allowed: boolean; isPaid: boolean; remaining: number; reason?: string } {
    // Dev bypass: skip all license checks in development mode
    if (process.env['NODE_ENV'] === 'development' || process.env['AIMASTER_DEV_LICENSE'] === '1') {
      return { allowed: true, isPaid: true, remaining: Infinity };
    }

    const stored    = this._readLicense();
    const trialUsed = this._readTrialUsed();

    if (stored?.tier === 'pro') {
      return { allowed: true, isPaid: true, remaining: Infinity };
    }

    const remaining = TRIAL_MAX - trialUsed;
    if (remaining <= 0) {
      return {
        allowed:   false,
        isPaid:    false,
        remaining: 0,
        reason:    `무료 체험 ${TRIAL_MAX}회를 모두 사용했습니다. 라이선스 키를 입력하면 계속 사용할 수 있습니다.`,
      };
    }
    return { allowed: true, isPaid: false, remaining };
  }

  /**
   * Return the number of remaining free processing runs.
   * Returns Infinity for paid users.
   * (Spec: getRemainingTrials)
   */
  getRemainingTrials(): number {
    const stored = this._readLicense();
    if (stored?.tier === 'pro') return Infinity;
    return Math.max(0, TRIAL_MAX - this._readTrialUsed());
  }

  // ── Additional helpers ─────────────────────────────────────────────────────

  /** Remove the stored license (revert to free tier). */
  deactivate(): LicenseInfo {
    this.store.delete('license');
    return this._buildInfo(null, this._readTrialUsed());
  }

  /** @deprecated Use getLicenseState(). Kept for backward compatibility. */
  getInfo(): LicenseInfo {
    return this.getLicenseState();
  }

  /** @deprecated Use activateLicense(). Kept for backward compatibility. */
  async activate(key: string): Promise<LicenseInfo> {
    return this.activateLicense(key);
  }

  /** @deprecated Use decrementTrialUsage(). Kept for backward compatibility. */
  incrementTrial(): void {
    this.decrementTrialUsage();
  }
}

export type { LicenseInfo, LicenseTier };
