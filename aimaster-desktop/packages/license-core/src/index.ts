/**
 * AIMASTER License Core — v1
 *
 * Policy:
 *   This build SHIPS UNLICENSED — see LICENSE_ENFORCED below.  Nothing is
 *   counted and nothing is locked.
 *
 *   When enforcement is switched back on:
 *     Free  : up to TRIAL_MAX processing runs; WAV save locked, MP3 preview open
 *     Pro   : unlimited; all features unlocked
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
import { LICENSE_ENFORCED } from '@aimaster/shared-types';

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

// The switch lives in shared-types — see the note there for why.
export { LICENSE_ENFORCED } from '@aimaster/shared-types';

/**
 * Remote license server (Supabase edge function) — injected at build time via
 * esbuild `define` (see apps/desktop/esbuild.main.cjs).  When both are present
 * the host wires a {@link RemoteValidator}; otherwise it falls back to the
 * dev-only {@link LocalValidator}.
 */
export const LICENSE_API_URL = process.env.LICENSE_API_URL ?? '';
export const LICENSE_API_KEY = process.env.LICENSE_API_KEY ?? '';

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

const HMAC_SECRET = process.env.LICENSE_HMAC_SECRET || DEV_FALLBACK_HMAC_SECRET;

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
  /** Last successful server validation (ISO).  Used for offline reasoning. */
  lastValidated?: string;
  /** HMAC-SHA256 over key|tier|activatedAt|machineId|expiresAt */
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
  key: string, tier: LicenseTier, activatedAt: string, machineId: string, expiresAt = ''
): string {
  return crypto
    .createHmac('sha256', HMAC_SECRET)
    .update(`${key}|${tier}|${activatedAt}|${machineId}|${expiresAt}`)
    .digest('hex');
}

function verifyLicense(stored: StoredLicense): boolean {
  try {
    const expected = Buffer.from(
      signLicense(stored.key, stored.tier, stored.activatedAt, stored.machineId, stored.expiresAt ?? '')
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
 * DEV ONLY.  Production builds must use {@link RemoteValidator}.
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

/** Server rejection reason → Korean user message. */
function reasonToKorean(reason?: string): string {
  switch (reason) {
    case 'not_found':    return '등록되지 않은 라이선스 키입니다. 키를 다시 확인해주세요.';
    case 'expired':      return '구독이 만료되었습니다. 구독을 갱신하면 계속 사용할 수 있습니다.';
    case 'refunded':     return '환불된 라이선스입니다. 더 이상 사용할 수 없습니다.';
    case 'revoked':      return '해제된 라이선스입니다. 고객지원에 문의해주세요.';
    case 'device_limit': return '이 라이선스의 기기 등록 한도를 초과했습니다. 다른 기기에서 먼저 해제해주세요.';
    case 'missing_fields':
    case 'bad_request':  return '라이선스 요청이 올바르지 않습니다. 앱을 다시 시작해주세요.';
    default:             return '유효하지 않은 라이선스 키입니다.';
  }
}

/**
 * RemoteValidator — calls the Supabase edge function (aimaster-validate) which
 * checks the license against Paddle-synced state (status / expiry / device
 * limit) server-side.
 *
 * Semantics:
 *   - Network / server (5xx) failure → THROWS (caller must NOT treat as a
 *     definitive answer; activation fails with a retry message, re-validation
 *     keeps the existing license = offline grace).
 *   - A reachable server returning { valid:false } IS definitive → caller
 *     rejects activation or revokes the stored license.
 */
export class RemoteValidator implements LicenseValidator {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  async validate(key: string, machineId: string): Promise<ValidatorResponse> {
    if (!KEY_REGEX.test(key)) {
      return {
        valid:  false,
        tier:   'free',
        reason: '올바른 라이선스 키 형식이 아닙니다. (AIMASTER-XXXX-XXXX-XXXX)',
      };
    }

    const endpoint = `${this.baseUrl.replace(/\/+$/, '')}/functions/v1/aimaster-validate`;

    let resp: Response;
    try {
      resp = await fetch(endpoint, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'apikey':        this.apiKey,
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ key, machineId }),
      });
    } catch (err) {
      // Network unreachable — NOT a definitive rejection.
      throw new Error('LICENSE_NETWORK: 라이선스 서버에 연결할 수 없습니다. 인터넷 연결을 확인한 뒤 다시 시도해주세요.');
    }

    if (!resp.ok) {
      throw new Error(`LICENSE_NETWORK: 라이선스 서버 오류 (${resp.status}). 잠시 후 다시 시도해주세요.`);
    }

    let data: { valid?: boolean; tier?: string; expiresAt?: string; reason?: string };
    try {
      data = (await resp.json()) as { valid?: boolean; tier?: string; expiresAt?: string; reason?: string };
    } catch {
      throw new Error('LICENSE_NETWORK: 라이선스 서버 응답을 해석할 수 없습니다. 잠시 후 다시 시도해주세요.');
    }

    if (!data.valid) {
      return {
        valid:  false,
        tier:   'free',
        ...(data.expiresAt ? { expiresAt: data.expiresAt } : {}),
        reason: reasonToKorean(data.reason),
      };
    }

    return {
      valid: true,
      tier:  data.tier === 'pro' ? 'pro' : 'free',
      ...(data.expiresAt ? { expiresAt: data.expiresAt } : {}),
    };
  }
}

/** True if a definitive (non-network) validator error. */
export function isNetworkValidatorError(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith('LICENSE_NETWORK');
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

  /**
   * True if the stored license has not lapsed.  Lifetime licenses have no
   * `expiresAt` and never expire.  Monthly licenses carry the subscription
   * period end; once past, the license behaves as free until re-validation
   * picks up a renewal.
   */
  private _notExpired(stored: StoredLicense): boolean {
    if (!stored.expiresAt) return true;
    const end = Date.parse(stored.expiresAt);
    if (Number.isNaN(end)) return true;   // unparseable → don't lock the user out
    return Date.now() < end;
  }

  /** Effective paid state: pro tier AND not lapsed. */
  private _isPaid(stored: StoredLicense | null): boolean {
    return !!stored && stored.tier === 'pro' && this._notExpired(stored);
  }

  private _buildInfo(stored: StoredLicense | null, trialUsed: number): LicenseInfo {
    const paid = this._isPaid(stored);
    if (!paid) {
      // No license, or an expired one.  Surface key/expiry so the UI can show
      // a "renew" prompt, but keep tier='free' so all gates fall back to trial.
      return {
        tier: 'free',
        trialUsed,
        trialMax: TRIAL_MAX,
        ...(stored?.key ? { key: stored.key } : {}),
        ...(stored?.expiresAt ? { expiresAt: stored.expiresAt } : {}),
        // Unlicensed BUILD, not a locked user: the tier stays honestly 'free'
        // (nobody bought anything) while the capability flags say what is
        // actually true.  A status that says "you cannot save a master" while
        // the gate happily saves one is a second source of truth, and the next
        // person to read it will believe the wrong half.
        canSaveMasterWav: !LICENSE_ENFORCED,
        canExportReport:  !LICENSE_ENFORCED,
        canUseAllPresets: !LICENSE_ENFORCED,
      };
    }
    return {
      tier:          stored!.tier,
      trialUsed,
      trialMax:      TRIAL_MAX,
      key:           stored!.key,
      activatedAt:   stored!.activatedAt,
      ...(stored!.expiresAt ? { expiresAt: stored!.expiresAt } : {}),
      canSaveMasterWav: true,
      canExportReport:  true,
      canUseAllPresets: true,
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
      lastValidated: activatedAt,
      hmac:        signLicense(normalized, result.tier, activatedAt, machineId, result.expiresAt ?? ''),
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
    // Nothing to count when nothing is limited.
    if (!LICENSE_ENFORCED) return;
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
    // This build ships unlicensed.  Answering "paid" here is what opens the
    // export gates in the main process, which all read this one function.
    if (!LICENSE_ENFORCED) {
      return { allowed: true, isPaid: true, remaining: Infinity };
    }
    // Dev bypass: skip all license checks in development mode
    if (process.env['NODE_ENV'] === 'development' || process.env['AIMASTER_DEV_LICENSE'] === '1') {
      return { allowed: true, isPaid: true, remaining: Infinity };
    }

    const stored    = this._readLicense();
    const trialUsed = this._readTrialUsed();

    if (this._isPaid(stored)) {
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
    if (!LICENSE_ENFORCED) return Infinity;
    const stored = this._readLicense();
    if (this._isPaid(stored)) return Infinity;
    return Math.max(0, TRIAL_MAX - this._readTrialUsed());
  }

  /**
   * Re-validate the stored license against the server.  Call on app startup
   * (online) to pick up subscription renewals and to enforce refunds /
   * revocations / device removals.
   *
   *   - Server says valid  → refresh tier / expiresAt / lastValidated.
   *   - Server says invalid → remove the stored license (revert to free).
   *   - Network error       → keep the stored license unchanged (offline
   *                           grace; monthly still self-expires at expiresAt).
   */
  async revalidate(): Promise<LicenseInfo> {
    const stored = this._readLicense();
    if (!stored) return this.getLicenseState();

    const machineId = getMachineId();
    try {
      const result = await this.validator.validate(stored.key, machineId);
      if (!result.valid) {
        // Definitive server rejection → revoke locally.
        this.store.delete('license');
        return this.getLicenseState();
      }
      const activatedAt = stored.activatedAt;
      const refreshed: StoredLicense = {
        key:           stored.key,
        tier:          result.tier,
        activatedAt,
        ...(result.expiresAt ? { expiresAt: result.expiresAt } : {}),
        machineId,
        lastValidated: new Date().toISOString(),
        hmac:          signLicense(stored.key, result.tier, activatedAt, machineId, result.expiresAt ?? ''),
      };
      this.store.set('license', refreshed);
      return this._buildInfo(refreshed, this._readTrialUsed());
    } catch (err) {
      if (isNetworkValidatorError(err)) {
        // Offline — keep working; don't punish a transient network failure.
        return this.getLicenseState();
      }
      throw err;
    }
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
