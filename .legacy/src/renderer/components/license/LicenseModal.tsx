/**
 * 라이센스 관리 모달 v2
 * 무료/유료 기능 차이를 명확히 표시
 */
import React, { useState } from 'react'
import clsx from 'clsx'
import { Modal } from '../common/Modal'
import { Button } from '../common/Button'
import { useLicense } from '../../hooks/useLicense'
import { TIER_LABELS, TIER_COLORS } from '../../types/license'

// 무료 vs 유료 기능 비교
const FEATURE_TABLE = [
  { feature: '오디오 분석',           free: true,  paid: true  },
  { feature: 'QC 검사 (12항목)',      free: true,  paid: true  },
  { feature: 'Preview MP3 저장',      free: true,  paid: true  },
  { feature: 'Master WAV 저장',       free: false, paid: true  },
  { feature: '리포트 내보내기',        free: false, paid: true  },
  { feature: 'Warm/Bright/Punch 스타일', free: false, paid: true },
  { feature: '무제한 처리',           free: false, paid: true  },
]

export function LicenseModal() {
  const {
    licenseInfo, isLoading, showModal,
    setShowModal, activate, deactivate, isTrial,
  } = useLicense()

  const [keyInput,   setKeyInput]   = useState('')
  const [activating, setActivating] = useState(false)
  const [activeTab,  setActiveTab]  = useState<'status' | 'activate'>('status')

  const handleActivate = async () => {
    if (!keyInput.trim()) return
    setActivating(true)
    const ok = await activate(keyInput)
    if (ok) { setKeyInput(''); setActiveTab('status') }
    setActivating(false)
  }

  const trialRemaining = licenseInfo ? licenseInfo.trialMax - licenseInfo.trialUsed : 0

  return (
    <Modal open={showModal} onClose={() => setShowModal(false)} title="라이센스" size="md">
      <div className="space-y-4">
        {/* 탭 */}
        <div className="flex gap-1 bg-surface-900 rounded-xl p-1">
          {[
            { key: 'status'   as const, label: '현재 상태' },
            { key: 'activate' as const, label: '키 입력' },
          ].map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setActiveTab(key)}
              className={clsx(
                'flex-1 py-1.5 rounded-lg text-sm font-medium transition-colors',
                activeTab === key
                  ? 'bg-surface-800 text-gray-200'
                  : 'text-gray-500 hover:text-gray-300'
              )}
            >
              {label}
            </button>
          ))}
        </div>

        {/* ── 상태 탭 ── */}
        {activeTab === 'status' && (
          <div className="space-y-4">
            {/* 현재 플랜 */}
            <div className="bg-surface-900 rounded-xl p-4">
              <div className="flex items-center justify-between mb-3">
                <span className="text-sm text-gray-400">현재 플랜</span>
                <span className={clsx(
                  'text-sm font-bold px-2.5 py-1 rounded-full',
                  licenseInfo?.tier === 'free_trial'
                    ? 'bg-gray-800 text-gray-300'
                    : 'bg-violet-900/40 text-violet-300'
                )}>
                  {licenseInfo ? TIER_LABELS[licenseInfo.tier] : '...'}
                </span>
              </div>

              {/* 무료 체험 진행 바 */}
              {isTrial && licenseInfo && (
                <div className="space-y-2">
                  <div className="flex justify-between text-xs text-gray-500">
                    <span>무료 처리 사용</span>
                    <span className={trialRemaining > 0 ? 'text-yellow-400' : 'text-red-400'}>
                      {licenseInfo.trialUsed} / {licenseInfo.trialMax}회
                    </span>
                  </div>
                  <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
                    <div
                      className={clsx(
                        'h-full rounded-full transition-all',
                        trialRemaining === 0 ? 'bg-red-500' :
                        trialRemaining === 1 ? 'bg-yellow-500' : 'bg-green-500'
                      )}
                      style={{ width: `${(licenseInfo.trialUsed / licenseInfo.trialMax) * 100}%` }}
                    />
                  </div>
                  {trialRemaining === 0 ? (
                    <p className="text-xs text-red-400">무료 체험이 종료되었습니다. 라이센스를 구매하세요.</p>
                  ) : (
                    <p className="text-xs text-gray-500">
                      {trialRemaining}회 처리 후 Master WAV 저장 불가 (Preview MP3는 항상 가능)
                    </p>
                  )}
                </div>
              )}

              {/* 유료 라이센스 정보 */}
              {!isTrial && licenseInfo?.key && (
                <div className="space-y-1.5 text-xs text-gray-500">
                  <div className="flex justify-between">
                    <span>라이센스 키</span>
                    <span className="font-mono text-gray-400">{licenseInfo.key.slice(0, 14)}...</span>
                  </div>
                  {licenseInfo.activatedAt && (
                    <div className="flex justify-between">
                      <span>활성화일</span>
                      <span>{new Date(licenseInfo.activatedAt).toLocaleDateString('ko-KR')}</span>
                    </div>
                  )}
                  {licenseInfo.expiresAt && (
                    <div className="flex justify-between">
                      <span>만료일</span>
                      <span>{new Date(licenseInfo.expiresAt).toLocaleDateString('ko-KR')}</span>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* 기능 비교 테이블 */}
            <div className="bg-surface-900 rounded-xl overflow-hidden">
              <div className="grid grid-cols-3 text-xs font-medium text-gray-500 px-3 py-2 border-b border-gray-800">
                <span>기능</span>
                <span className="text-center">무료</span>
                <span className="text-center text-violet-400">Pro</span>
              </div>
              {FEATURE_TABLE.map(({ feature, free, paid }) => (
                <div key={feature} className="grid grid-cols-3 items-center px-3 py-2 border-b border-gray-800/50 last:border-0">
                  <span className="text-xs text-gray-300">{feature}</span>
                  <div className="flex justify-center">
                    {free ? (
                      <svg className="w-4 h-4 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                      </svg>
                    ) : (
                      <svg className="w-4 h-4 text-gray-700" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    )}
                  </div>
                  <div className="flex justify-center">
                    <svg className="w-4 h-4 text-violet-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                    </svg>
                  </div>
                </div>
              ))}
            </div>

            {/* CTA */}
            {isTrial && (
              <div className="space-y-2">
                <Button
                  size="md"
                  className="w-full"
                  onClick={() => setActiveTab('activate')}
                >
                  라이센스 키 입력하기
                </Button>
                <button className="w-full text-xs text-gray-600 hover:text-violet-400 transition-colors py-1">
                  라이센스 구매 → aimastering.app
                </button>
              </div>
            )}

            {/* 비활성화 */}
            {!isTrial && licenseInfo?.isValid && (
              <button
                onClick={deactivate}
                className="w-full text-xs text-gray-700 hover:text-red-400 transition-colors py-1"
              >
                이 기기에서 라이센스 비활성화
              </button>
            )}
          </div>
        )}

        {/* ── 키 입력 탭 ── */}
        {activeTab === 'activate' && (
          <div className="space-y-4">
            <div>
              <label className="block text-xs text-gray-400 mb-2">
                라이센스 키 입력
              </label>
              <input
                type="text"
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, ''))}
                placeholder="AIMASTER-XXXX-XXXX-XXXX"
                className={clsx(
                  'w-full bg-surface-900 border rounded-xl px-4 py-3 text-sm font-mono text-gray-200',
                  'placeholder-gray-700 focus:outline-none focus:ring-2 focus:ring-violet-500/30',
                  'border-gray-700 focus:border-violet-500',
                  'transition-colors'
                )}
                onKeyDown={(e) => e.key === 'Enter' && handleActivate()}
              />
              <p className="text-xs text-gray-600 mt-1.5">
                구매 완료 후 이메일로 발송된 키를 입력하세요
              </p>
            </div>

            <Button
              size="lg"
              className="w-full"
              onClick={handleActivate}
              loading={activating}
              disabled={keyInput.length < 10 || activating}
            >
              활성화
            </Button>

            <div className="border-t border-gray-800 pt-3 text-center">
              <p className="text-xs text-gray-600">
                아직 구매하지 않으셨나요?{' '}
                <button className="text-violet-400 hover:text-violet-300">
                  구매 페이지 바로가기 →
                </button>
              </p>
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}
