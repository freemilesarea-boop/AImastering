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

// ── Constants ─────────────────────────────────────────────────────────────────

const KEY_REGEX   = /^AIMASTER-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const TRIAL_MAX   = 3;
const HMAC_SECRET = process.env['LICENSE_HMAC_SECRET'] ?? 'aimaster-local-secret-v1';

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
    if (expected.length !== actual.length) return false;
    return crypto.timingSafeEqual(expected, actual);
  } catch {
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
  return machineIdSync({ original: true });
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
    const stored = this.store.get<StoredLicense>('license') ?? null;
    if (!stored) return null;
    return verifyLicense(stored) ? stored : null;
  }

  private _readTrialUsed(): number {
    const machineId = getMachineId();
    const record    = this.store.get<TrialRecord>('trial');

    if (!record) return 0;
    // If HMAC verification fails, treat as maxed-out (tamper denial)
    if (!verifyTrial(record) || record.machineId !== machineId) return TRIAL_MAX;
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
      expiresAt:     stored.expiresAt,
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
      expiresAt:   result.expiresAt,
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
