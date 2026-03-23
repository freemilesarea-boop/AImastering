/**
 * 마스터링 결과 페이지
 */
import React from 'react'
import clsx from 'clsx'
import { LoudnessGauge } from '../components/mastering/LoudnessGauge'
import { Button } from '../components/common/Button'
import { useAudioEngine } from '../hooks/useAudioEngine'
import { useAppStore } from '../store/appStore'
import { formatDuration, formatFileSize, formatProcessingTime } from '../utils/formatters'

export function ResultPage() {
  const { masteringResult, masteringOptions, showInFinder, runQC, reset } = useAudioEngine()
  const { navigateTo } = useAppStore()

  if (!masteringResult) {
    navigateTo('home')
    return null
  }

  const { inputAnalysis: input, outputAnalysis: output } = masteringResult

  return (
    <div className="flex-1 overflow-auto p-6 space-y-6">
      {/* 헤더 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-bold text-gray-100">마스터링 완료</h1>
          <span className="text-xs bg-green-900/40 text-green-400 border border-green-800 px-2.5 py-1 rounded-full">
            ✓ 처리 완료
          </span>
        </div>
        <div className="text-xs text-gray-600">
          처리 시간: {formatProcessingTime(masteringResult.processingTimeMs)}
        </div>
      </div>

      {/* 전/후 비교 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div>
          <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2 px-1">원본</div>
          <LoudnessGauge
            label="원본"
            lufsIntegrated={input.lufsIntegrated}
            truePeak={input.truePeak}
            lra={input.lra}
            targetLUFS={masteringOptions.targetLUFS ?? -14}
            targetTP={masteringOptions.targetTruePeak ?? -1.0}
          />
        </div>
        <div>
          <div className="text-xs font-medium text-violet-400 uppercase tracking-wide mb-2 px-1">마스터링 후</div>
          <LoudnessGauge
            label="마스터링 후"
            lufsIntegrated={output.lufsIntegrated}
            truePeak={output.truePeak}
            lra={output.lra}
            targetLUFS={masteringOptions.targetLUFS ?? -14}
            targetTP={masteringOptions.targetTruePeak ?? -1.0}
          />
        </div>
      </div>

      {/* 개선 요약 */}
      <div className="bg-surface-800 rounded-xl p-4 grid grid-cols-3 gap-4">
        {[
          {
            label: 'LUFS 변화',
            value: `${output.lufsIntegrated.toFixed(1)}`,
            sub: `${input.lufsIntegrated > output.lufsIntegrated ? '↓' : '↑'} ${Math.abs(output.lufsIntegrated - input.lufsIntegrated).toFixed(1)} LUFS`,
            ok: Math.abs(output.lufsIntegrated - (masteringOptions.targetLUFS ?? -14)) <= 0.5,
          },
          {
            label: 'True Peak',
            value: `${output.truePeak.toFixed(1)} dBTP`,
            sub: output.truePeak <= (masteringOptions.targetTruePeak ?? -1.0) ? '한계 내' : '한계 초과',
            ok: output.truePeak <= (masteringOptions.targetTruePeak ?? -1.0),
          },
          {
            label: '처리 시간',
            value: formatProcessingTime(masteringResult.processingTimeMs),
            sub: `${formatDuration(input.duration)} 파일`,
            ok: true,
          },
        ].map(({ label, value, sub, ok }) => (
          <div key={label} className="bg-surface-900/60 rounded-lg p-3 text-center">
            <div className="text-xs text-gray-500 mb-1">{label}</div>
            <div className={clsx('text-lg font-bold font-mono', ok ? 'text-green-400' : 'text-yellow-400')}>
              {value}
            </div>
            <div className="text-xs text-gray-500 mt-0.5">{sub}</div>
          </div>
        ))}
      </div>

      {/* 출력 파일 */}
      <div className="bg-surface-800 rounded-xl p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-gray-300">출력 파일</h3>
        </div>
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-violet-900/40 rounded-lg flex items-center justify-center flex-shrink-0">
            <svg className="w-5 h-5 text-violet-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm text-gray-200 truncate">
              {masteringResult.outputPath.split('/').pop()}
            </p>
            <p className="text-xs text-gray-500 truncate mt-0.5">
              {masteringResult.outputPath}
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => showInFinder(masteringResult.outputPath)}
          >
            Finder에서 열기
          </Button>
        </div>
      </div>

      {/* 액션 버튼 */}
      <div className="flex gap-3">
        <Button
          variant="secondary"
          size="md"
          className="flex-1"
          onClick={() => { runQC(masteringResult.outputPath); navigateTo('qc') }}
        >
          QC 검사
        </Button>
        <Button
          variant="secondary"
          size="md"
          className="flex-1"
          onClick={() => { reset(); navigateTo('home') }}
        >
          새 파일 처리
        </Button>
        <Button
          size="md"
          className="flex-1"
          onClick={() => showInFinder(masteringResult.outputPath)}
          icon={
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
          }
        >
          다운로드
        </Button>
      </div>
    </div>
  )
}
