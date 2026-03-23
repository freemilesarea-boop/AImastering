import crypto from 'node:crypto';
import { machineIdSync } from 'node-machine-id';
import type { LicenseInfo, LicenseTier } from '@aimaster/shared-types';

// Key format: AIMASTER-XXXX-XXXX-XXXX
const KEY_REGEX = /^AIMASTER-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const HMAC_SECRET = process.env['LICENSE_HMAC_SECRET'] ?? 'aimaster-local-secret-v1';
const OFFLINE_GRACE_DAYS = 7;
const TRIAL_MAX = 3;

export interface StoredLicense {
  key: string;
  tier: LicenseTier;
  activatedAt: string;
  expiresAt?: string;
  machineId: string;
  hmac: string;
}

// ── HMAC ──────────────────────────────────────────────────────────────────────

function sign(key: string, tier: LicenseTier, activatedAt: string, machineId: string): string {
  return crypto
    .createHmac('sha256', HMAC_SECRET)
    .update(`${key}|${tier}|${activatedAt}|${machineId}`)
    .digest('hex');
}

function verify(stored: StoredLicense): boolean {
  try {
    const expected = Buffer.from(
      sign(stored.key, stored.tier, stored.activatedAt, stored.machineId)
    );
    const actual = Buffer.from(stored.hmac);
    if (expected.length !== actual.length) return false;
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

// ── Validation ────────────────────────────────────────────────────────────────

export function validateKeyFormat(key: string): boolean {
  return KEY_REGEX.test(key.toUpperCase());
}

export function getMachineId(): string {
  return machineIdSync({ original: true });
}

// ── License info builder ──────────────────────────────────────────────────────

function buildInfo(stored: StoredLicense | null, trialUsed: number): LicenseInfo {
  if (!stored || !verify(stored)) {
    return {
      tier: 'free',
      trialUsed,
      trialMax: TRIAL_MAX,
      canSaveMasterWav: false,
      canExportReport: false,
      canUseAllPresets: false,
    };
  }
  return {
    tier: stored.tier,
    trialUsed,
    trialMax: TRIAL_MAX,
    key: stored.key,
    activatedAt: stored.activatedAt,
    expiresAt: stored.expiresAt,
    canSaveMasterWav: stored.tier === 'pro',
    canExportReport: stored.tier === 'pro',
    canUseAllPresets: stored.tier === 'pro',
  };
}

// ── LicenseService ────────────────────────────────────────────────────────────

export interface LicenseStore {
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  delete(key: string): void;
}

export class LicenseService {
  constructor(private readonly store: LicenseStore) {}

  getInfo(): LicenseInfo {
    const stored = this.store.get<StoredLicense>('license') ?? null;
    const trialUsed = this.store.get<number>('trialUsed') ?? 0;
    return buildInfo(stored, trialUsed);
  }

  /** Returns updated LicenseInfo after activation. Throws on invalid key. */
  async activate(key: string): Promise<LicenseInfo> {
    const normalized = key.toUpperCase().trim();
    if (!validateKeyFormat(normalized)) {
      throw new Error('올바른 라이선스 키 형식이 아닙니다. (AIMASTER-XXXX-XXXX-XXXX)');
    }

    // In production, validate against remote server here.
    // For now, any well-formed key activates as Pro.
    const machineId = getMachineId();
    const activatedAt = new Date().toISOString();
    const tier: LicenseTier = 'pro';

    const stored: StoredLicense = {
      key: normalized,
      tier,
      activatedAt,
      machineId,
      hmac: sign(normalized, tier, activatedAt, machineId),
    };

    this.store.set('license', stored);
    return buildInfo(stored, this.store.get<number>('trialUsed') ?? 0);
  }

  deactivate(): LicenseInfo {
    this.store.delete('license');
    const trialUsed = this.store.get<number>('trialUsed') ?? 0;
    return buildInfo(null, trialUsed);
  }

  /**
   * Call before each processing run.
   * Returns `{ allowed, isPaid, reason }`.
   */
  canProcess(): { allowed: boolean; isPaid: boolean; reason?: string } {
    const info = this.getInfo();
    if (info.tier === 'pro') return { allowed: true, isPaid: true };
    const remaining = info.trialMax - info.trialUsed;
    if (remaining <= 0) {
      return { allowed: false, isPaid: false, reason: '무료 체험 횟수(3회)를 모두 사용했습니다.' };
    }
    return { allowed: true, isPaid: false };
  }

  incrementTrial(): void {
    const current = this.store.get<number>('trialUsed') ?? 0;
    this.store.set('trialUsed', current + 1);
  }

  isOfflineGraceExpired(): boolean {
    const stored = this.store.get<StoredLicense>('license');
    if (!stored?.expiresAt) return false;
    const expiry = new Date(stored.expiresAt);
    const grace = new Date(expiry.getTime() + OFFLINE_GRACE_DAYS * 86_400_000);
    return Date.now() > grace.getTime();
  }
}

export type { LicenseInfo, LicenseTier };
