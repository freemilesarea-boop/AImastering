/**
 * 마스터링 진행 페이지
 */
import React from 'react'
import { PresetSelector } from '../components/mastering/PresetSelector'
import { ProcessingStatus } from '../components/mastering/ProcessingStatus'
import { Button } from '../components/common/Button'
import { useAudioEngine } from '../hooks/useAudioEngine'
import { useAppStore } from '../store/appStore'

export function MasteringPage() {
  const { processingState, startMastering, reset } = useAudioEngine()
  const { navigateTo } = useAppStore()

  const handleStart = async () => {
    const result = await startMastering()
    if (result) navigateTo('result')
  }

  return (
    <div className="flex-1 overflow-auto p-6 space-y-6">
      <div className="flex items-center gap-3">
        <button
          onClick={() => navigateTo('home')}
          className="text-gray-400 hover:text-gray-200 transition-colors"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <h1 className="text-xl font-bold text-gray-100">마스터링 설정</h1>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* 프리셋 선택 */}
        <div className="bg-surface-800 rounded-2xl p-5">
          <PresetSelector />
        </div>

        {/* 처리 상태 */}
        <div className="space-y-4">
          <ProcessingStatus />

          {processingState === 'idle' && (
            <Button size="lg" className="w-full" onClick={handleStart}
              icon={
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
              }
            >
              마스터링 시작
            </Button>
          )}

          {processingState === 'error' && (
            <div className="flex gap-2">
              <Button variant="secondary" className="flex-1" onClick={() => reset()}>
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
  )
}
