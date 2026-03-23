/**
 * 마스터링 설정 + 진행 페이지 v2
 */
import React from 'react'
import { StylePresetCards } from '../components/mastering/StylePresetCards'
import { ProcessingStatus } from '../components/mastering/ProcessingStatus'
import { Button } from '../components/common/Button'
import { useAudioEngine } from '../hooks/useAudioEngine'
import { useAppStore } from '../store/appStore'
import { useLicense } from '../hooks/useLicense'

export function MasteringPage() {
  const { processingState, startMastering, reset } = useAudioEngine()
  const { navigateTo } = useAppStore()
  const { isTrial, trialRemaining, setShowModal } = useLicense()

  const handleStart = async () => {
    const result = await startMastering()
    if (result) navigateTo('result')
  }

  const isProcessing = processingState === 'processing'

  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-4xl mx-auto p-6 space-y-5">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigateTo('home')}
            className="text-gray-500 hover:text-gray-200 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <h1 className="text-lg font-bold text-gray-100">마스터링 설정</h1>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          {/* 프리셋 선택 */}
          <div className="bg-surface-800 rounded-2xl p-5">
            <StylePresetCards />
          </div>

          {/* 진행 상태 + 시작 버튼 */}
          <div className="space-y-4">
            <ProcessingStatus />

            {processingState === 'idle' && (
              <div className="space-y-2">
                {isTrial && trialRemaining === 0 ? (
                  <div className="text-center space-y-2">
                    <p className="text-sm text-red-400">무료 체험 횟수를 모두 사용했습니다</p>
                    <Button className="w-full" onClick={() => setShowModal(true)}>
                      라이센스 활성화
                    </Button>
                  </div>
                ) : (
                  <Button
                    size="lg"
                    className="w-full"
                    onClick={handleStart}
                    icon={
                      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                      </svg>
                    }
                  >
                    마스터링 시작
                  </Button>
                )}

                {isTrial && trialRemaining > 0 && (
                  <p className="text-xs text-center text-gray-600">
                    ※ 무료 체험: Preview MP3만 저장됩니다
                  </p>
                )}
              </div>
            )}

            {processingState === 'error' && (
              <div className="flex gap-2">
                <Button variant="secondary" className="flex-1" onClick={() => { reset(); navigateTo('home') }}>
                  처음으로
                </Button>
                <Button className="flex-1" onClick={handleStart}>
                  다시 시도
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
