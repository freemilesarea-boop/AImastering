/**
 * 라이센스 관리 서비스 v2
 *
 * 정책:
 * ┌───────────────┬──────────────────────────────────────────────┐
 * │ 무료 체험     │ 총 3회 처리 가능                              │
 * │               │ Preview MP3만 저장 가능                       │
 * │               │ Master WAV 저장 불가                          │
 * │               │ 분석/QC 리포트 화면 표시 (내보내기 불가)       │
 * ├───────────────┼──────────────────────────────────────────────┤
 * │ 유료 (basic+) │ 무제한 처리 (또는 라이센스 정책 범위)          │
 * │               │ Master WAV 저장 가능                          │
 * │               │ 모든 프리셋 사용 가능                          │
 * │               │ 분석 리포트 내보내기 가능                      │
 * └───────────────┴──────────────────────────────────────────────┘
 *
 * 인증 방식:
 * - 로컬 HMAC 서명 검증 (1차)
 * - 온라인 시 서버 검증 (2차, 실패 시 오프라인 7일 허용)
 * - 키 형식: AIMASTER-XXXX-XXXX-XXXX
 * - 초기 버전: 만료 없는 1회 등록 (향후 서버 검증 인터페이스 분리됨)
 */
import * as crypto from 'crypto'
import Store from 'electron-store'
import { getMachineId } from 'node-machine-id'
import { logger } from '../utils/logger'

// ─────────────────────────────────────────────────────
// 타입 정의
// ─────────────────────────────────────────────────────
export type LicenseTier = 'free_trial' | 'basic' | 'pro' | 'enterprise'

export interface LicenseInfo {
  tier:             LicenseTier
  key:              string | null
  activatedAt:      string | null
  expiresAt:        string | null
  machineId:        string
  lastValidated:    string | null
  offlineUsedDays:  number
  trialUsed:        number
  trialMax:         number
  isValid:          boolean
  validationMessage:string
  // 기능 권한
  canSaveMasterWav: boolean   // Master WAV 저장 가능 여부
  canExportReport:  boolean   // 리포트 내보내기 가능 여부
  canUseAllPresets: boolean   // 모든 프리셋 사용 가능 여부
}

interface LicenseStore {
  key:             string | null
  activatedAt:     string | null
  expiresAt:       string | null
  lastValidated:   string | null
  offlineUsedDays: number
  tier:            LicenseTier
  trialUsed:       number
  signature:       string | null
}

// ─────────────────────────────────────────────────────
// 상수
// ─────────────────────────────────────────────────────
const TRIAL_MAX              = 3
const OFFLINE_ALLOWANCE_DAYS = 7
const HMAC_SECRET = 'aimaster-local-secret-v2-2024'
const LICENSE_SERVER_URL = process.env.LICENSE_SERVER_URL || 'https://license.aimastering.app/v1'

// ─────────────────────────────────────────────────────
// 서비스
// ─────────────────────────────────────────────────────
class LicenseService {
  private store: Store<LicenseStore>
  private machineId = ''

  constructor() {
    this.store = new Store<LicenseStore>({
      name: 'license',
      encryptionKey: HMAC_SECRET,
      defaults: {
        key:             null,
        activatedAt:     null,
        expiresAt:       null,
        lastValidated:   null,
        offlineUsedDays: 0,
        tier:            'free_trial',
        trialUsed:       0,
        signature:       null,
      },
    })
  }

  async init(): Promise<void> {
    try {
      this.machineId = await getMachineId()
    } catch {
      this.machineId = crypto.randomBytes(16).toString('hex')
      logger.warn('Could not get machine ID, using random ID')
    }
  }

  async getStatus(): Promise<LicenseInfo> {
    const stored = this.store.store

    // ── 무료 체험 ───────────────────────────────────
    if (!stored.key) {
      const remaining = TRIAL_MAX - stored.trialUsed
      const isValid   = remaining > 0

      return this._buildInfo('free_trial', stored, {
        isValid,
        validationMessage: isValid
          ? `무료 체험 — ${remaining}회 남음 (전체 ${TRIAL_MAX}회)`
          : '무료 체험 횟수를 모두 사용했습니다. 라이센스를 구매하세요.',
      })
    }

    // ── 로컬 서명 검증 ─────────────────────────────
    if (!this.verifyLocalSignature(stored)) {
      logger.warn('License signature invalid')
      return this._buildInfo('free_trial', stored, {
        isValid: false,
        validationMessage: '라이센스 파일이 손상되었습니다. 재활성화가 필요합니다.',
      })
    }

    // ── 만료 확인 ─────────────────────────────────
    if (stored.expiresAt && new Date(stored.expiresAt) < new Date()) {
      return this._buildInfo(stored.tier, stored, {
        isValid: false,
        validationMessage: '라이센스가 만료되었습니다.',
      })
    }

    // ── 온라인 검증 ────────────────────────────────
    try {
      const serverResult = await this.validateWithServer(stored.key, stored.tier)
      if (!serverResult.valid) {
        return this._buildInfo(stored.tier, stored, {
          isValid: false,
          validationMessage: serverResult.message || '서버 검증 실패',
        })
      }
      this.store.set('lastValidated', new Date().toISOString())
      this.store.set('offlineUsedDays', 0)
      this.updateSignature()
    } catch {
      // ── 오프라인 처리 ──────────────────────────
      const offlineDays = this.getOfflineDays(stored.lastValidated)
      if (offlineDays > OFFLINE_ALLOWANCE_DAYS) {
        return this._buildInfo(stored.tier, stored, {
          isValid: false,
          validationMessage: `오프라인 허용 기간(${OFFLINE_ALLOWANCE_DAYS}일) 초과. 인터넷 연결 후 재시도하세요.`,
        })
      }
      this.store.set('offlineUsedDays', offlineDays)
      logger.warn(`Offline mode: ${offlineDays}/${OFFLINE_ALLOWANCE_DAYS} days`)
    }

    return this._buildInfo(stored.tier, stored, { isValid: true, validationMessage: '라이센스 유효' })
  }

  /**
   * 라이센스 키 활성화
   */
  async activate(key: string): Promise<{ success: boolean; message: string; tier?: LicenseTier }> {
    const trimmed = key.trim().toUpperCase()

    if (!/^AIMASTER-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(trimmed)) {
      return { success: false, message: '올바른 라이센스 키 형식이 아닙니다.\n형식: AIMASTER-XXXX-XXXX-XXXX' }
    }

    try {
      const result = await this.validateWithServer(trimmed, null)
      if (!result.valid) {
        return { success: false, message: result.message || '유효하지 않은 라이센스 키입니다.' }
      }

      this.store.set('key',           trimmed)
      this.store.set('tier',          result.tier || 'basic')
      this.store.set('activatedAt',   new Date().toISOString())
      this.store.set('expiresAt',     result.expiresAt || null)
      this.store.set('lastValidated', new Date().toISOString())
      this.store.set('offlineUsedDays', 0)
      this.updateSignature()

      logger.info(`License activated: tier=${result.tier}`)
      return { success: true, message: '라이센스가 활성화되었습니다.', tier: result.tier }
    } catch {
      return { success: false, message: '서버에 연결할 수 없습니다.\n인터넷 연결 후 다시 시도하세요.' }
    }
  }

  /**
   * 처리 가능 여부 확인 (라이센스 + 무료 체험 횟수)
   */
  async canProcess(): Promise<{ allowed: boolean; message: string; isPaid: boolean }> {
    const status = await this.getStatus()

    if (!status.isValid) {
      return { allowed: false, message: status.validationMessage, isPaid: false }
    }
    if (status.tier === 'free_trial') {
      if (status.trialUsed >= status.trialMax) {
        return { allowed: false, message: '무료 체험 횟수를 모두 사용했습니다.', isPaid: false }
      }
      return { allowed: true, message: `무료 체험 ${status.trialMax - status.trialUsed}회 남음`, isPaid: false }
    }
    return { allowed: true, message: 'OK', isPaid: true }
  }

  /** 무료 체험 카운터 소모 */
  consumeTrial(): void {
    const current = this.store.get('trialUsed')
    this.store.set('trialUsed', current + 1)
    logger.info(`Trial used: ${current + 1}/${TRIAL_MAX}`)
  }

  async deactivate(): Promise<void> {
    const key = this.store.get('key')
    if (key) {
      try { await this.validateWithServer(key, null, 'deactivate') } catch {}
    }
    this.store.clear()
    logger.info('License deactivated')
  }

  // ─────────────────────────────────────────────────
  // Private
  // ─────────────────────────────────────────────────

  private _buildInfo(
    tier: LicenseTier,
    stored: LicenseStore,
    overrides: Partial<LicenseInfo>
  ): LicenseInfo {
    const isPaid = tier !== 'free_trial'

    return {
      tier,
      key:              stored.key,
      activatedAt:      stored.activatedAt,
      expiresAt:        stored.expiresAt,
      machineId:        this.machineId,
      lastValidated:    stored.lastValidated,
      offlineUsedDays:  stored.offlineUsedDays,
      trialUsed:        stored.trialUsed,
      trialMax:         TRIAL_MAX,
      isValid:          true,
      validationMessage:'',
      // 기능 권한
      canSaveMasterWav: isPaid,
      canExportReport:  isPaid,
      canUseAllPresets: isPaid,
      ...overrides,
    }
  }

  private async validateWithServer(
    key: string | null,
    tier: LicenseTier | null,
    action = 'validate'
  ): Promise<{ valid: boolean; message?: string; tier?: LicenseTier; expiresAt?: string }> {
    // 개발 환경 모의 응답
    if (process.env.NODE_ENV === 'development') {
      return { valid: true, tier: 'pro', expiresAt: '2099-12-31T00:00:00Z' }
    }

    const resp = await globalThis.fetch(`${LICENSE_SERVER_URL}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, machineId: this.machineId }),
      signal: AbortSignal.timeout(5000),
    })

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({})) as Record<string, string>
      return { valid: false, message: err.message || '서버 오류' }
    }
    return resp.json() as Promise<{ valid: boolean; message?: string; tier?: LicenseTier; expiresAt?: string }>
  }

  private getOfflineDays(lastValidated: string | null): number {
    if (!lastValidated) return OFFLINE_ALLOWANCE_DAYS + 1
    const diff = Date.now() - new Date(lastValidated).getTime()
    return Math.floor(diff / (1000 * 60 * 60 * 24))
  }

  private verifyLocalSignature(stored: LicenseStore): boolean {
    if (!stored.signature) return false
    const expected = this.computeSignature(stored)
    try {
      return crypto.timingSafeEqual(
        Buffer.from(stored.signature, 'hex'),
        Buffer.from(expected, 'hex')
      )
    } catch { return false }
  }

  private computeSignature(stored: LicenseStore): string {
    const payload = `${stored.key}|${stored.tier}|${stored.activatedAt}|${this.machineId}`
    return crypto.createHmac('sha256', HMAC_SECRET).update(payload).digest('hex')
  }

  private updateSignature(): void {
    this.store.set('signature', this.computeSignature(this.store.store))
  }
}

export const licenseService = new LicenseService()
