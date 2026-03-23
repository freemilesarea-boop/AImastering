/**
 * 라이센스 관리 서비스
 *
 * 구조:
 * - 로컬 우선 (HMAC 서명 검증)
 * - 온라인 시 서버 검증
 * - 무료 체험: 3회 처리 또는 7일
 * - 오프라인 허용: 7일
 */
import * as crypto from 'crypto'
import Store from 'electron-store'
import { getMachineId } from 'node-machine-id'
import fetch from 'electron/common' // 실제로는 node-fetch 또는 electron net
import { logger } from '../utils/logger'
import { getUserDataPath } from '../utils/pathUtils'

// ─────────────────────────────────────────
// 타입 정의
// ─────────────────────────────────────────

export type LicenseTier = 'free_trial' | 'basic' | 'pro' | 'enterprise'

export interface LicenseInfo {
  tier: LicenseTier
  key: string | null
  activatedAt: string | null
  expiresAt: string | null
  machineId: string
  lastValidated: string | null
  offlineUsedDays: number
  trialUsed: number        // 무료 체험 처리 횟수
  trialMax: number         // 최대 무료 체험 횟수
  isValid: boolean
  validationMessage: string
}

interface LicenseStore {
  key: string | null
  activatedAt: string | null
  expiresAt: string | null
  lastValidated: string | null
  offlineUsedDays: number
  tier: LicenseTier
  trialUsed: number
  signature: string | null  // HMAC 서명 (위변조 방지)
}

// ─────────────────────────────────────────
// 상수
// ─────────────────────────────────────────

const TRIAL_MAX = 3
const OFFLINE_ALLOWANCE_DAYS = 7
// 실제 배포 시에는 환경 변수 또는 빌드 시 주입
const HMAC_SECRET = 'aimastering-local-secret-2024'
const LICENSE_SERVER_URL = process.env.LICENSE_SERVER_URL || 'https://license.aimastering.app/v1'

// ─────────────────────────────────────────
// 서비스 구현
// ─────────────────────────────────────────

class LicenseService {
  private store: Store<LicenseStore>
  private machineId: string = ''

  constructor() {
    this.store = new Store<LicenseStore>({
      name: 'license',
      encryptionKey: HMAC_SECRET, // electron-store 내장 암호화
      defaults: {
        key: null,
        activatedAt: null,
        expiresAt: null,
        lastValidated: null,
        offlineUsedDays: 0,
        tier: 'free_trial',
        trialUsed: 0,
        signature: null,
      },
    })
  }

  /**
   * 서비스 초기화 (머신 ID 획득)
   */
  async init(): Promise<void> {
    try {
      this.machineId = await getMachineId()
    } catch {
      // 머신 ID 획득 실패 시 랜덤 ID 생성 후 저장
      this.machineId = crypto.randomBytes(16).toString('hex')
      logger.warn('Could not get machine ID, using random ID')
    }
  }

  /**
   * 현재 라이센스 상태 반환
   */
  async getStatus(): Promise<LicenseInfo> {
    const stored = this.store.store

    // 1. 라이센스 키 없음 → 무료 체험
    if (!stored.key) {
      const trialRemaining = TRIAL_MAX - stored.trialUsed
      return {
        tier: 'free_trial',
        key: null,
        activatedAt: null,
        expiresAt: null,
        machineId: this.machineId,
        lastValidated: null,
        offlineUsedDays: stored.offlineUsedDays,
        trialUsed: stored.trialUsed,
        trialMax: TRIAL_MAX,
        isValid: trialRemaining > 0,
        validationMessage: trialRemaining > 0
          ? `무료 체험 ${trialRemaining}회 남음`
          : '무료 체험 횟수 초과. 라이센스를 구매하세요.',
      }
    }

    // 2. 로컬 서명 검증
    const isLocalValid = this.verifyLocalSignature(stored)
    if (!isLocalValid) {
      logger.warn('License signature invalid - possible tampering')
      return this.buildInvalidResult('라이센스 파일이 손상되었습니다.')
    }

    // 3. 만료 확인
    if (stored.expiresAt && new Date(stored.expiresAt) < new Date()) {
      return this.buildInvalidResult('라이센스가 만료되었습니다.')
    }

    // 4. 온라인 검증 시도
    try {
      const serverResult = await this.validateWithServer(stored.key, stored.tier)
      if (!serverResult.valid) {
        return this.buildInvalidResult(serverResult.message || '서버 검증 실패')
      }
      // 검증 시간 업데이트
      this.store.set('lastValidated', new Date().toISOString())
      this.store.set('offlineUsedDays', 0)
      this.updateSignature()
    } catch {
      // 5. 오프라인 처리: 허용 기간 확인
      logger.warn('License server unreachable, checking offline allowance')
      const offlineDays = this.getOfflineDays(stored.lastValidated)
      if (offlineDays > OFFLINE_ALLOWANCE_DAYS) {
        return this.buildInvalidResult(
          `오프라인 허용 기간(${OFFLINE_ALLOWANCE_DAYS}일) 초과. 인터넷 연결 후 재시도하세요.`
        )
      }
      this.store.set('offlineUsedDays', offlineDays)
    }

    return {
      tier: stored.tier,
      key: stored.key,
      activatedAt: stored.activatedAt,
      expiresAt: stored.expiresAt,
      machineId: this.machineId,
      lastValidated: stored.lastValidated,
      offlineUsedDays: stored.offlineUsedDays,
      trialUsed: stored.trialUsed,
      trialMax: TRIAL_MAX,
      isValid: true,
      validationMessage: '라이센스가 유효합니다.',
    }
  }

  /**
   * 라이센스 키 활성화
   */
  async activate(key: string): Promise<{ success: boolean; message: string; tier?: LicenseTier }> {
    const trimmedKey = key.trim().toUpperCase()

    // 키 형식 검증 (예: AIMASTER-XXXX-XXXX-XXXX)
    if (!/^AIMASTER-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(trimmedKey)) {
      return { success: false, message: '올바른 라이센스 키 형식이 아닙니다.' }
    }

    try {
      const result = await this.validateWithServer(trimmedKey, null)
      if (!result.valid) {
        return { success: false, message: result.message || '유효하지 않은 라이센스 키입니다.' }
      }

      // 라이센스 저장
      this.store.set('key', trimmedKey)
      this.store.set('tier', result.tier || 'basic')
      this.store.set('activatedAt', new Date().toISOString())
      this.store.set('expiresAt', result.expiresAt || null)
      this.store.set('lastValidated', new Date().toISOString())
      this.store.set('offlineUsedDays', 0)
      this.updateSignature()

      logger.info(`License activated: tier=${result.tier}`)
      return { success: true, message: '라이센스가 활성화되었습니다.', tier: result.tier }
    } catch {
      return { success: false, message: '서버에 연결할 수 없습니다. 나중에 다시 시도하세요.' }
    }
  }

  /**
   * 처리 1회 소모 (무료 체험 카운터 증가)
   */
  consumeTrial(): void {
    const current = this.store.get('trialUsed')
    this.store.set('trialUsed', current + 1)
  }

  /**
   * 처리 가능 여부 확인
   */
  async canProcess(): Promise<{ allowed: boolean; message: string }> {
    const status = await this.getStatus()
    if (!status.isValid) {
      return { allowed: false, message: status.validationMessage }
    }
    if (status.tier === 'free_trial' && status.trialUsed >= status.trialMax) {
      return { allowed: false, message: '무료 체험 횟수를 모두 사용했습니다.' }
    }
    return { allowed: true, message: 'OK' }
  }

  /**
   * 라이센스 비활성화 (기기 변경 시)
   */
  async deactivate(): Promise<void> {
    const key = this.store.get('key')
    if (key) {
      try {
        await this.validateWithServer(key, null, 'deactivate')
      } catch {
        logger.warn('Deactivation server call failed (continuing locally)')
      }
    }
    this.store.clear()
    logger.info('License deactivated')
  }

  // ─────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────

  private async validateWithServer(
    key: string | null,
    tier: LicenseTier | null,
    action = 'validate'
  ): Promise<{ valid: boolean; message?: string; tier?: LicenseTier; expiresAt?: string }> {
    // 개발 환경에서는 모의 서버 응답
    if (process.env.NODE_ENV === 'development') {
      return { valid: true, tier: 'pro', expiresAt: '2025-12-31T00:00:00Z' }
    }

    const response = await globalThis.fetch(`${LICENSE_SERVER_URL}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, machineId: this.machineId, action }),
      signal: AbortSignal.timeout(5000), // 5초 타임아웃
    })

    if (!response.ok) {
      const error = await response.json().catch(() => ({}))
      return { valid: false, message: (error as Record<string, string>).message || '서버 오류' }
    }
    return response.json() as Promise<{ valid: boolean; message?: string; tier?: LicenseTier; expiresAt?: string }>
  }

  private buildInvalidResult(message: string): LicenseInfo {
    return {
      tier: 'free_trial',
      key: null,
      activatedAt: null,
      expiresAt: null,
      machineId: this.machineId,
      lastValidated: null,
      offlineUsedDays: 0,
      trialUsed: this.store.get('trialUsed'),
      trialMax: TRIAL_MAX,
      isValid: false,
      validationMessage: message,
    }
  }

  private getOfflineDays(lastValidated: string | null): number {
    if (!lastValidated) return OFFLINE_ALLOWANCE_DAYS + 1
    const diff = Date.now() - new Date(lastValidated).getTime()
    return Math.floor(diff / (1000 * 60 * 60 * 24))
  }

  private verifyLocalSignature(stored: LicenseStore): boolean {
    if (!stored.signature) return false
    const expected = this.computeSignature(stored)
    return crypto.timingSafeEqual(
      Buffer.from(stored.signature, 'hex'),
      Buffer.from(expected, 'hex')
    )
  }

  private computeSignature(stored: LicenseStore): string {
    const payload = `${stored.key}|${stored.tier}|${stored.activatedAt}|${this.machineId}`
    return crypto.createHmac('sha256', HMAC_SECRET).update(payload).digest('hex')
  }

  private updateSignature(): void {
    const stored = this.store.store
    const sig = this.computeSignature(stored)
    this.store.set('signature', sig)
  }
}

export const licenseService = new LicenseService()
