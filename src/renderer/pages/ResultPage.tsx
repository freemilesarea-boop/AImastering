/**
 * 마스터링 결과 페이지 v2
 * - 유료: Master WAV + Preview MP3 다운로드
 * - 무료: Preview MP3만 다운로드, WAV는 업그레이드 유도
 * - AI 자동 보정 결과 표시
 */
import React from 'react'
import clsx from 'clsx'
import { LoudnessGauge } from '../components/mastering/LoudnessGauge'
import { Button } from '../components/common/Button'
import { useAudioEngine } from '../hooks/useAudioEngine'
import { useAppStore } from '../store/appStore'
import { useLicense } from '../hooks/useLicense'
import { formatDuration, formatFileSize, formatProcessingTime } from '../utils/formatters'
import { STYLE_PRESETS, MasteringStyle } from '../types/audio'

// AI 자동 보정 항목 레이블
const AI_CORRECTION_LABELS: Record<string, string> = {
  harsh_highmid: '고역 자극 (3~5kHz) 보정 적용',
  boomy_low:     '저역 과잉 보정 적용',
}

export function ResultPage() {
  const { masteringResult, masteringOptions, showInFinder, runQC, reset } = useAudioEngine()
  const { navigateTo } = useAppStore()
  const { licenseInfo, setShowModal } = useLicense()

  if (!masteringResult) {
    navigateTo('home')
    return null
  }

  const { inputAnalysis: input, outputAnalysis: output } = masteringResult
  const isPaid = licenseInfo?.canSaveMasterWav ?? false
  const stylePreset = STYLE_PRESETS.find(p => p.id === (masteringResult.style as MasteringStyle))

  // LUFS 개선량
  const lfusDiff = output.lufsIntegrated - input.lufsIntegrated
  const lfusDiffStr = `${lfusDiff >= 0 ? '+' : ''}${lfusDiff.toFixed(1)} LUFS`

  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-5xl mx-auto p-6 space-y-5">

        {/* ── 헤더 ── */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-green-900/40 rounded-full flex items-center justify-center">
              <svg className="w-4 h-4 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <div>
              <h1 className="text-lg font-bold text-gray-100">마스터링 완료</h1>
              <p className="text-xs text-gray-500">
                {stylePreset?.emoji} {stylePreset?.name} 스타일 ·{' '}
                {formatProcessingTime(masteringResult.processingTimeMs)}
              </p>
            </div>
          </div>
        </div>

        {/* ── AI 자동 보정 결과 ── */}
        {masteringResult.aiCorrectionsApplied.length > 0 && (
          <div className="bg-violet-900/20 border border-violet-800/40 rounded-xl px-4 py-3">
            <div className="flex items-start gap-2.5">
              <span className="text-violet-400 text-sm flex-shrink-0">✦</span>
              <div>
                <p className="text-sm text-violet-300 font-medium">AI 자동 보정 적용됨</p>
                <ul className="mt-1 space-y-0.5">
                  {masteringResult.aiCorrectionsApplied.map(c => (
                    <li key={c} className="text-xs text-violet-400/70">
                      · {AI_CORRECTION_LABELS[c] || c}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        )}

        {/* ── 전/후 비교 ── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div>
            <p className="text-xs text-gray-600 uppercase tracking-wide font-medium mb-2 px-0.5">원본</p>
            <LoudnessGauge
              lufsIntegrated={input.lufsIntegrated}
              truePeak={input.truePeak}
              lra={input.lra}
              targetLUFS={masteringOptions.targetLUFS ?? -14}
              targetTP={masteringOptions.targetTruePeak ?? -1.0}
            />
          </div>
          <div>
            <p className="text-xs text-violet-400 uppercase tracking-wide font-medium mb-2 px-0.5">
              마스터링 후
            </p>
            <LoudnessGauge
              lufsIntegrated={output.lufsIntegrated}
              truePeak={output.truePeak}
              lra={output.lra}
              targetLUFS={masteringOptions.targetLUFS ?? -14}
              targetTP={masteringOptions.targetTruePeak ?? -1.0}
            />
          </div>
        </div>

        {/* ── 요약 수치 ── */}
        <div className="grid grid-cols-4 gap-2">
          {[
            {
              label: 'LUFS 변화',
              value: lfusDiffStr,
              sub: `${output.lufsIntegrated.toFixed(1)} LUFS`,
              ok: Math.abs(output.lufsIntegrated - (masteringOptions.targetLUFS ?? -14)) <= 0.5,
            },
            {
              label: 'True Peak',
              value: `${output.truePeak.toFixed(1)} dBTP`,
              sub: output.truePeak <= (masteringOptions.targetTruePeak ?? -1.0) ? '✓ 한계 내' : '⚠ 초과',
              ok: output.truePeak <= (masteringOptions.targetTruePeak ?? -1.0),
            },
            {
              label: 'LRA',
              value: `${output.lra.toFixed(1)} LU`,
              sub: output.lra >= 5 ? '다이나믹 양호' : '압축됨',
              ok: output.lra >= 5,
            },
            {
              label: '처리 시간',
              value: formatProcessingTime(masteringResult.processingTimeMs),
              sub: formatDuration(input.duration) + ' 파일',
              ok: true,
            },
          ].map(({ label, value, sub, ok }) => (
            <div key={label} className="bg-surface-800 rounded-xl p-3 text-center">
              <div className="text-xs text-gray-500 mb-1">{label}</div>
              <div className={clsx('text-base font-bold font-mono', ok ? 'text-green-400' : 'text-yellow-400')}>
                {value}
              </div>
              <div className="text-xs text-gray-600 mt-0.5">{sub}</div>
            </div>
          ))}
        </div>

        {/* ── 파일 다운로드 ── */}
        <div className="space-y-2.5">
          <h3 className="text-sm font-medium text-gray-400">다운로드</h3>

          {/* Master WAV — 유료만 */}
          <div className={clsx(
            'flex items-center gap-3 p-3.5 rounded-xl border',
            isPaid
              ? 'bg-surface-800 border-gray-700'
              : 'bg-surface-800/40 border-gray-800 opacity-75'
          )}>
            <div className={clsx(
              'w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0',
              isPaid ? 'bg-green-900/40' : 'bg-gray-800'
            )}>
              <svg className={clsx('w-4.5 h-4.5', isPaid ? 'text-green-400' : 'text-gray-600')}
                fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                  d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-gray-200">Master WAV</span>
                <span className="text-xs bg-green-900/30 text-green-400 px-1.5 py-0.5 rounded">고품질</span>
                {!isPaid && (
                  <span className="text-xs bg-gray-800 text-gray-500 px-1.5 py-0.5 rounded">유료 전용</span>
                )}
              </div>
              <p className="text-xs text-gray-500 mt-0.5">
                {isPaid
                  ? masteringResult.outputPath.split('/').pop()
                  : '24-bit WAV — Pro 플랜에서 저장 가능'}
              </p>
            </div>
            {isPaid ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => showInFinder(masteringResult.outputPath)}
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                저장 위치 열기
              </Button>
            ) : (
              <Button variant="secondary" size="sm" onClick={() => setShowModal(true)}>
                업그레이드
              </Button>
            )}
          </div>

          {/* Preview MP3 — 무료 포함 항상 가능 */}
          {masteringResult.previewPath && (
            <div className="flex items-center gap-3 p-3.5 bg-surface-800 border border-gray-700 rounded-xl">
              <div className="w-9 h-9 bg-violet-900/40 rounded-lg flex items-center justify-center flex-shrink-0">
                <svg className="w-4.5 h-4.5 text-violet-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                    d="M15.536 8.464a5 5 0 010 7.072M12 6v12m0 0l-3-3m3 3l3-3M6.343 5.657a10 10 0 000 14.142" />
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-gray-200">Preview MP3</span>
                  <span className="text-xs bg-violet-900/30 text-violet-400 px-1.5 py-0.5 rounded">320kbps</span>
                  <span className="text-xs bg-green-900/20 text-green-500 px-1.5 py-0.5 rounded">무료 포함</span>
                </div>
                <p className="text-xs text-gray-500 mt-0.5">
                  {masteringResult.previewPath.split('/').pop()}
                </p>
              </div>
              <Button
                size="sm"
                onClick={() => showInFinder(masteringResult.previewPath!)}
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                저장 위치 열기
              </Button>
            </div>
          )}
        </div>

        {/* ── 액션 버튼 ── */}
        <div className="flex gap-2.5">
          <Button
            variant="secondary"
            size="md"
            className="flex-1"
            onClick={() => { runQC(isPaid ? masteringResult.outputPath : masteringResult.previewPath || undefined); navigateTo('qc') }}
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
        </div>

        {/* 무료 체험 업그레이드 배너 */}
        {!isPaid && (
          <div className="bg-gradient-to-r from-violet-900/30 to-indigo-900/30 border border-violet-800/30 rounded-2xl p-4 flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-semibold text-violet-300">Master WAV를 저장하려면 Pro 플랜이 필요합니다</p>
              <p className="text-xs text-gray-500 mt-0.5">무제한 처리 · Warm/Bright/Punch 스타일 · 리포트 내보내기</p>
            </div>
            <Button size="sm" onClick={() => setShowModal(true)} className="flex-shrink-0">
              업그레이드
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
