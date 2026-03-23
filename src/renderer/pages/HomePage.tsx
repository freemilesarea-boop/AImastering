/**
 * 홈 페이지 v2
 * UX 흐름: 업로드 → 분석 결과 → 스타일 선택 → 마스터링 시작
 * 수치보다 상태("문제 없음 / 주의 / 확인 필요") 중심
 */
import React, { useEffect } from 'react'
import clsx from 'clsx'
import { DropZone } from '../components/upload/DropZone'
import { LoudnessGauge } from '../components/mastering/LoudnessGauge'
import { StylePresetCards } from '../components/mastering/StylePresetCards'
import { AIDetectionAlert } from '../components/mastering/AIDetectionAlert'
import { Button } from '../components/common/Button'
import { useAudioEngine } from '../hooks/useAudioEngine'
import { useAppStore } from '../store/appStore'
import { useLicense } from '../hooks/useLicense'
import { formatDuration, formatFileSize, formatSampleRate } from '../utils/formatters'
import { AIDetectionResult } from '../types/audio'

export function HomePage() {
  const {
    selectedFile, fileInfo, analysisResult,
    isAnalyzing, processingState, masteringOptions,
    selectAndAnalyze, startMastering: handleStartMastering,
  } = useAudioEngine()

  const { recentFiles, setRecentFiles, navigateTo } = useAppStore()
  const { licenseInfo, setShowModal, isTrial, trialRemaining } = useLicense()

  // 최근 파일 목록 로드
  useEffect(() => {
    window.electronAPI.invoke<{ success: boolean; data: string[] }>('file:get-recent')
      .then(r => { if (r.success) setRecentFiles(r.data) }).catch(() => {})
  }, [setRecentFiles])

  // 메뉴 파일 열기 이벤트
  useEffect(() => {
    const cleanup = window.electronAPI.on('menu:open-file', () => {
      window.electronAPI.invoke<string[] | null>('file:open-dialog')
        .then(paths => { if (paths?.[0]) selectAndAnalyze(paths[0]) })
    })
    return cleanup
  }, [selectAndAnalyze])

  const handleMaster = async () => {
    const result = await handleStartMastering()
    if (result) navigateTo('result')
  }

  const ai = analysisResult?.aiDetection as AIDetectionResult | undefined
  const hasAIWarnings = ai && (ai.harshHighmid || ai.boomyLow || ai.brickwall || ai.stereoImbalance)
  const isProcessing = processingState === 'processing'

  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-5xl mx-auto p-6 space-y-6">

        {/* ── 상단 헤더 ── */}
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-xl font-bold text-gray-100">AI 음원 마스터링</h1>
            <p className="text-sm text-gray-500 mt-0.5">
              WAV 파일을 올리면 자동으로 분석·마스터링·QC 검사까지 진행합니다
            </p>
          </div>
          {/* 무료 체험 뱃지 */}
          {isTrial && licenseInfo && (
            <button
              onClick={() => setShowModal(true)}
              className={clsx(
                'flex items-center gap-2 px-3 py-1.5 rounded-xl border text-xs font-medium transition-colors',
                trialRemaining > 0
                  ? 'bg-yellow-900/20 border-yellow-800/50 text-yellow-300 hover:bg-yellow-900/30'
                  : 'bg-red-900/20 border-red-800/50 text-red-300 hover:bg-red-900/30'
              )}
            >
              <span>{trialRemaining > 0 ? `무료 체험 ${trialRemaining}회 남음` : '무료 체험 종료'}</span>
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>
          )}
        </div>

        {/* ── 메인 레이아웃 ── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

          {/* 좌: 파일 드롭존 + 분석 결과 */}
          <div className="space-y-4">
            <DropZone />

            {/* 파일 기본 정보 */}
            {fileInfo && selectedFile && (
              <div className="bg-surface-800 rounded-xl p-3.5 flex items-center gap-3">
                <div className="w-9 h-9 bg-violet-900/40 rounded-lg flex items-center justify-center flex-shrink-0">
                  <svg className="w-4.5 h-4.5 text-violet-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                      d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
                  </svg>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-200 truncate">{fileInfo.name}</p>
                  <div className="flex items-center gap-2 mt-0.5 text-xs text-gray-500">
                    <span className="uppercase">{fileInfo.ext}</span>
                    <span>·</span>
                    <span>{formatFileSize(fileInfo.size)}</span>
                    {analysisResult && (
                      <>
                        <span>·</span>
                        <span>{formatDuration(analysisResult.duration)}</span>
                        <span>·</span>
                        <span>{formatSampleRate(analysisResult.sampleRate)}</span>
                        <span>·</span>
                        <span>{analysisResult.bitDepth}bit</span>
                      </>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* 분석 로딩 */}
            {isAnalyzing && (
              <div className="bg-surface-800 rounded-xl p-6 flex items-center gap-3">
                <div className="w-8 h-8 border-2 border-violet-500 border-t-transparent rounded-full animate-spin flex-shrink-0" />
                <div>
                  <p className="text-sm text-gray-200 font-medium">파일 분석 중...</p>
                  <p className="text-xs text-gray-500 mt-0.5">LUFS, True Peak, AI 음원 특성 검사</p>
                </div>
              </div>
            )}

            {/* 분석 결과: LUFS 게이지 */}
            {analysisResult && !isAnalyzing && (
              <LoudnessGauge
                label="원본 분석 결과"
                lufsIntegrated={analysisResult.lufsIntegrated}
                truePeak={analysisResult.truePeak}
                lra={analysisResult.lra}
                targetLUFS={masteringOptions.targetLUFS ?? -14}
                targetTP={masteringOptions.targetTruePeak ?? -1.0}
              />
            )}

            {/* 최근 파일 */}
            {!selectedFile && !isAnalyzing && recentFiles.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-xs text-gray-600 uppercase tracking-wide font-medium">최근 파일</p>
                {recentFiles.slice(0, 4).map(f => (
                  <button
                    key={f}
                    onClick={() => selectAndAnalyze(f)}
                    className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg hover:bg-surface-800 text-left group transition-colors"
                  >
                    <svg className="w-3.5 h-3.5 text-gray-700 group-hover:text-gray-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <span className="text-sm text-gray-500 group-hover:text-gray-300 truncate">
                      {f.split('/').pop()}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* 우: 스타일 선택 + AI 감지 + 마스터링 버튼 */}
          <div className="space-y-4">
            {analysisResult && !isAnalyzing ? (
              <>
                {/* AI 음원 특성 경고 */}
                {ai && <AIDetectionAlert aiDetection={ai} compact />}

                {/* 스타일 프리셋 선택 */}
                <div className="bg-surface-800 rounded-2xl p-4">
                  <StylePresetCards />
                </div>

                {/* 추가 분석 정보 */}
                <div className="grid grid-cols-2 gap-2">
                  {[
                    {
                      label: '다이나믹 레인지',
                      value: `DR${analysisResult.dynamicRange.toFixed(0)}`,
                      ok: analysisResult.dynamicRange >= 8,
                    },
                    {
                      label: 'LRA',
                      value: `${analysisResult.lra.toFixed(1)} LU`,
                      ok: analysisResult.lra >= 5,
                    },
                    {
                      label: '클리핑',
                      value: analysisResult.clippingDetected
                        ? `감지 (${analysisResult.clippingSamples}샘플)`
                        : '없음',
                      ok: !analysisResult.clippingDetected,
                    },
                    {
                      label: '무음 구간',
                      value: analysisResult.silenceStartMs > 500 || analysisResult.silenceEndMs > 500
                        ? `${Math.max(analysisResult.silenceStartMs, analysisResult.silenceEndMs).toFixed(0)}ms`
                        : '정상',
                      ok: analysisResult.silenceStartMs <= 500 && analysisResult.silenceEndMs <= 500,
                    },
                  ].map(({ label, value, ok }) => (
                    <div key={label} className="bg-surface-800 rounded-xl p-3">
                      <div className="text-xs text-gray-500 mb-1">{label}</div>
                      <div className={clsx('text-sm font-medium', ok ? 'text-gray-200' : 'text-yellow-400')}>
                        {!ok && <span className="mr-1">⚠</span>}
                        {value}
                      </div>
                    </div>
                  ))}
                </div>

                {/* 마스터링 시작 버튼 */}
                <div className="space-y-2">
                  <Button
                    size="lg"
                    className="w-full"
                    onClick={handleMaster}
                    disabled={isProcessing || (isTrial && trialRemaining === 0)}
                    loading={isProcessing}
                    icon={
                      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                      </svg>
                    }
                  >
                    {isProcessing ? '마스터링 중...' : '마스터링 시작'}
                  </Button>

                  {/* 무료 체험 만료 안내 */}
                  {isTrial && trialRemaining === 0 && (
                    <div className="text-center">
                      <p className="text-xs text-red-400 mb-1.5">무료 체험 횟수를 모두 사용했습니다</p>
                      <Button variant="secondary" size="sm" onClick={() => setShowModal(true)}>
                        라이센스 활성화
                      </Button>
                    </div>
                  )}

                  {/* 무료 체험 중 저장 안내 */}
                  {isTrial && trialRemaining > 0 && (
                    <p className="text-xs text-gray-600 text-center">
                      무료 체험: Preview MP3만 저장됩니다.{' '}
                      <button className="text-violet-400 hover:text-violet-300" onClick={() => setShowModal(true)}>
                        WAV 저장 →
                      </button>
                    </p>
                  )}

                  {/* QC 검사 */}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full text-gray-500"
                    onClick={() => navigateTo('qc')}
                  >
                    발매 전 QC 검사만 실행
                  </Button>
                </div>
              </>
            ) : (
              /* 파일 미선택 시 안내 */
              !isAnalyzing && (
                <div className="bg-surface-800/40 rounded-2xl p-8 text-center space-y-4 border border-dashed border-gray-800 h-full flex flex-col items-center justify-center">
                  <div className="space-y-3">
                    <div className="w-14 h-14 mx-auto bg-surface-800 rounded-2xl flex items-center justify-center">
                      <svg className="w-7 h-7 text-gray-700" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                          d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
                      </svg>
                    </div>
                    <div>
                      <p className="text-gray-400 font-medium">파일을 선택하면</p>
                      <p className="text-gray-600 text-sm mt-1 leading-relaxed">
                        자동 분석 → 스타일 선택<br />→ 마스터링 → 다운로드
                      </p>
                    </div>
                    <div className="pt-2 space-y-1.5 text-xs text-gray-600">
                      <div className="flex items-center gap-2 justify-center">
                        <span className="w-1.5 h-1.5 rounded-full bg-gray-700" />
                        LUFS · True Peak · LRA · 스펙트럼 분석
                      </div>
                      <div className="flex items-center gap-2 justify-center">
                        <span className="w-1.5 h-1.5 rounded-full bg-gray-700" />
                        AI 음원 특화 (harsh/boomy/brickwall) 감지
                      </div>
                      <div className="flex items-center gap-2 justify-center">
                        <span className="w-1.5 h-1.5 rounded-full bg-gray-700" />
                        12항목 QC · 5개 플랫폼 기준 점검
                      </div>
                    </div>
                  </div>
                </div>
              )
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
