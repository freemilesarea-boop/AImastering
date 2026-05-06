/**
 * 마스터링 처리 진행 상태 컴포넌트
 */
import React from 'react'
import clsx from 'clsx'
import { ProgressBar } from '../common/ProgressBar'
import { useAudioStore } from '../../store/audioStore'

const STAGES = [
  { key: 'analyze',   label: '사전 분석' },
  { key: 'eq',        label: 'EQ 처리' },
  { key: 'compress',  label: '컴프레션' },
  { key: 'loudnorm',  label: '라우드니스 정규화' },
  { key: 'limit',     label: '리미터' },
  { key: 'export',    label: '출력 파일 생성' },
]

export function ProcessingStatus() {
  const { processingState, progress, currentStage, error } = useAudioStore()

  if (processingState === 'idle') return null

  // 현재 스테이지 인덱스 추정
  const currentStageIdx = STAGES.findIndex(s =>
    currentStage.toLowerCase().includes(s.key)
  )

  return (
    <div className="bg-surface-800 rounded-2xl p-6 space-y-5">
      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold text-gray-200">
          {processingState === 'analyzing' ? '파일 분석 중...' :
           processingState === 'processing' ? '마스터링 처리 중...' :
           processingState === 'done' ? '처리 완료!' :
           processingState === 'error' ? '오류 발생' : ''}
        </h3>
        {processingState === 'done' && (
          <span className="text-green-400 text-sm font-medium flex items-center gap-1.5">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            완료
          </span>
        )}
      </div>

      {processingState !== 'error' && (
        <ProgressBar value={progress} stage={currentStage} showPercent />
      )}

      {processingState === 'error' && error && (
        <div className="bg-red-900/20 border border-red-800 rounded-xl p-4">
          <p className="text-red-400 text-sm">{error}</p>
        </div>
      )}

      {/* 단계별 진행 상황 */}
      {(processingState === 'processing' || processingState === 'done') && (
        <div className="grid grid-cols-3 gap-2">
          {STAGES.map((stage, idx) => {
            const isDone = processingState === 'done' || idx < currentStageIdx
            const isActive = idx === currentStageIdx && processingState === 'processing'

            return (
              <div
                key={stage.key}
                className={clsx(
                  'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs',
                  isDone   ? 'bg-green-900/20 text-green-400' :
                  isActive ? 'bg-violet-900/30 text-violet-300' :
                             'bg-surface-900/50 text-gray-600'
                )}
              >
                {isDone ? (
                  <svg className="w-3 h-3 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                ) : isActive ? (
                  <div className="w-3 h-3 border border-violet-400 border-t-transparent rounded-full animate-spin flex-shrink-0" />
                ) : (
                  <div className="w-3 h-3 rounded-full border border-gray-700 flex-shrink-0" />
                )}
                {stage.label}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
