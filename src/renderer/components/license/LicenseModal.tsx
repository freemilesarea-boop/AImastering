/**
 * 라이센스 관리 모달
 */
import React, { useState } from 'react'
import clsx from 'clsx'
import { Modal } from '../common/Modal'
import { Button } from '../common/Button'
import { useLicense } from '../../hooks/useLicense'
import { TIER_LABELS, TIER_COLORS } from '../../types/license'

export function LicenseModal() {
  const {
    licenseInfo,
    isLoading,
    showModal,
    setShowModal,
    activate,
    deactivate,
    isTrial,
  } = useLicense()

  const [keyInput, setKeyInput] = useState('')
  const [activating, setActivating] = useState(false)

  const handleActivate = async () => {
    if (!keyInput.trim()) return
    setActivating(true)
    await activate(keyInput)
    setActivating(false)
    setKeyInput('')
  }

  return (
    <Modal open={showModal} onClose={() => setShowModal(false)} title="라이센스 관리" size="md">
      <div className="space-y-5">
        {/* 현재 상태 */}
        {licenseInfo && (
          <div className="bg-surface-900 rounded-xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-400">현재 플랜</span>
              <span className={clsx('text-sm font-semibold', TIER_COLORS[licenseInfo.tier])}>
                {TIER_LABELS[licenseInfo.tier]}
              </span>
            </div>

            {licenseInfo.tier !== 'free_trial' && licenseInfo.key && (
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-400">라이센스 키</span>
                <span className="text-sm font-mono text-gray-300">
                  {licenseInfo.key.slice(0, 12)}...
                </span>
              </div>
            )}

            {licenseInfo.expiresAt && (
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-400">만료일</span>
                <span className="text-sm text-gray-300">
                  {new Date(licenseInfo.expiresAt).toLocaleDateString('ko-KR')}
                </span>
              </div>
            )}

            {isTrial && (
              <div className="bg-yellow-900/20 border border-yellow-800/50 rounded-lg p-3">
                <p className="text-sm text-yellow-300">
                  무료 체험 {licenseInfo.trialMax - licenseInfo.trialUsed}회 남음
                  ({licenseInfo.trialUsed}/{licenseInfo.trialMax})
                </p>
                <p className="text-xs text-gray-500 mt-1">
                  라이센스 구매 후 무제한으로 사용하세요
                </p>
              </div>
            )}

            {!licenseInfo.isValid && (
              <div className="bg-red-900/20 border border-red-800/50 rounded-lg p-3">
                <p className="text-sm text-red-300">{licenseInfo.validationMessage}</p>
              </div>
            )}
          </div>
        )}

        {/* 라이센스 키 입력 */}
        {(isTrial || !licenseInfo?.isValid) && (
          <div className="space-y-3">
            <div className="border-t border-gray-800 pt-4">
              <h4 className="text-sm font-medium text-gray-300 mb-3">라이센스 키 활성화</h4>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={keyInput}
                  onChange={(e) => setKeyInput(e.target.value.toUpperCase())}
                  placeholder="AIMASTER-XXXX-XXXX-XXXX"
                  className="flex-1 bg-surface-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-600 font-mono focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500/20"
                  onKeyDown={(e) => e.key === 'Enter' && handleActivate()}
                />
                <Button
                  onClick={handleActivate}
                  loading={activating}
                  disabled={!keyInput.trim() || activating}
                  size="md"
                >
                  활성화
                </Button>
              </div>
              <p className="text-xs text-gray-600 mt-2">
                구매 후 이메일로 발송된 키를 입력하세요
              </p>
            </div>
          </div>
        )}

        {/* 라이센스 구매 링크 */}
        <div className="bg-gradient-to-r from-violet-900/30 to-indigo-900/30 border border-violet-800/30 rounded-xl p-4">
          <h4 className="text-sm font-semibold text-violet-300 mb-1">Pro 플랜 업그레이드</h4>
          <ul className="text-xs text-gray-400 space-y-1 mb-3">
            <li>• 무제한 파일 처리</li>
            <li>• 배치 처리 (복수 파일)</li>
            <li>• 고급 EQ/컴프레서 파라미터 조절</li>
            <li>• QC 리포트 PDF 내보내기</li>
          </ul>
          <Button variant="primary" size="sm" className="w-full">
            Pro 플랜 구매하기
          </Button>
        </div>

        {/* 비활성화 버튼 */}
        {licenseInfo?.tier !== 'free_trial' && licenseInfo?.isValid && (
          <div className="border-t border-gray-800 pt-3">
            <button
              onClick={deactivate}
              disabled={isLoading}
              className="text-xs text-gray-600 hover:text-red-400 transition-colors w-full text-center"
            >
              이 기기에서 라이센스 비활성화
            </button>
          </div>
        )}
      </div>
    </Modal>
  )
}
