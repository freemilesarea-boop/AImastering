/**
 * 라이센스 관련 타입 정의 v2
 */

export type LicenseTier = 'free_trial' | 'basic' | 'pro' | 'enterprise'

export interface LicenseInfo {
  tier:              LicenseTier
  key:               string | null
  activatedAt:       string | null
  expiresAt:         string | null
  machineId:         string
  lastValidated:     string | null
  offlineUsedDays:   number
  trialUsed:         number
  trialMax:          number
  isValid:           boolean
  validationMessage: string
  // 기능 권한
  canSaveMasterWav:  boolean
  canExportReport:   boolean
  canUseAllPresets:  boolean
}

export const TIER_LABELS: Record<LicenseTier, string> = {
  free_trial: '무료 체험',
  basic:      'Basic',
  pro:        'Pro',
  enterprise: 'Enterprise',
}

export const TIER_COLORS: Record<LicenseTier, string> = {
  free_trial: 'text-gray-400',
  basic:      'text-blue-400',
  pro:        'text-violet-400',
  enterprise: 'text-yellow-400',
}
