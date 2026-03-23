/**
 * 홈 페이지 — 드롭존 + 최근 파일 + 분석 결과
 */
import React, { useEffect } from 'react'
import clsx from 'clsx'
import { DropZone } from '../components/upload/DropZone'
import { LoudnessGauge } from '../components/mastering/LoudnessGauge'
import { Button } from '../components/common/Button'
import { useAudioEngine } from '../hooks/useAudioEngine'
import { useAppStore } from '../store/appStore'
import { formatDuration, formatFileSize, formatSampleRate } from '../utils/formatters'

export function HomePage() {
  const {
    selectedFile,
    fileInfo,
    analysisResult,
    isAnalyzing,
    processingState,
    masteringOptions,
    selectAndAnalyze,
    startMastering: handleStartMastering,
  } = useAudioEngine()

  const { recentFiles, setRecentFiles, navigateTo } = useAppStore()

  // 최근 파일 목록 로드
  useEffect(() => {
    window.electronAPI.invoke<{ success: boolean; data: string[] }>('file:get-recent')
      .then((resp) => { if (resp.success) setRecentFiles(resp.data) })
      .catch(console.error)
  }, [setRecentFiles])

  // 메뉴에서 파일 열기 이벤트 수신
  useEffect(() => {
    const cleanup = window.electronAPI.on('menu:open-file', () => {
      window.electronAPI.invoke<string[] | null>('file:open-dialog')
        .then((paths) => { if (paths?.[0]) selectAndAnalyze(paths[0]) })
    })
    return cleanup
  }, [selectAndAnalyze])

  const handleMaster = async () => {
    const result = await handleStartMastering()
    if (result) navigateTo('result')
  }

  return (
    <div className="flex-1 overflow-auto p-6 space-y-6">
      {/* 헤더 */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-100">AI 음원 마스터링</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            YouTube Music 대응형 마스터링 프로필 기본 적용
          </p>
        </div>
        {selectedFile && (
          <Button variant="ghost" size="sm" onClick={() => navigateTo('settings')}>
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            설정
          </Button>
        )}
      </div>

      {/* 메인 영역 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* 좌: 드롭존 + 파일 정보 */}
        <div className="space-y-4">
          <DropZone />

          {/* 파일 정보 */}
          {fileInfo && selectedFile && (
            <div className="bg-surface-800 rounded-xl p-4">
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 bg-violet-900/40 rounded-lg flex items-center justify-center flex-shrink-0">
                  <svg className="w-5 h-5 text-violet-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                      d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
                  </svg>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-200 truncate">{fileInfo.name}</p>
                  <div className="flex items-center gap-3 mt-1">
                    <span className="text-xs text-gray-500 uppercase">{fileInfo.ext}</span>
                    <span className="text-xs text-gray-600">·</span>
                    <span className="text-xs text-gray-500">{formatFileSize(fileInfo.size)}</span>
                    {analysisResult && (
                      <>
                        <span className="text-xs text-gray-600">·</span>
                        <span className="text-xs text-gray-500">{formatDuration(analysisResult.duration)}</span>
                        <span className="text-xs text-gray-600">·</span>
                        <span className="text-xs text-gray-500">{formatSampleRate(analysisResult.sampleRate)}</span>
                      </>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* 최근 파일 목록 */}
          {!selectedFile && recentFiles.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wide">최근 파일</h3>
              <div className="space-y-1">
                {recentFiles.slice(0, 5).map((f) => (
                  <button
                    key={f}
                    onClick={() => selectAndAnalyze(f)}
                    className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg hover:bg-surface-800 text-left group transition-colors"
                  >
                    <svg className="w-4 h-4 text-gray-600 group-hover:text-gray-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19V6l12-3v13..." />
                    </svg>
                    <span className="text-sm text-gray-400 group-hover:text-gray-200 truncate">
                      {f.split('/').pop()}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* 우: 분석 결과 + 마스터링 버튼 */}
        <div className="space-y-4">
          {isAnalyzing && (
            <div className="bg-surface-800 rounded-2xl p-8 flex items-center justify-center">
              <div className="text-center space-y-3">
                <div className="w-12 h-12 border-2 border-violet-500 border-t-transparent rounded-full animate-spin mx-auto" />
                <p className="text-gray-400 text-sm">오디오 분석 중...</p>
              </div>
            </div>
          )}

          {analysisResult && !isAnalyzing && (
            <>
              {/* 분석 결과 게이지 */}
              <LoudnessGauge
                label="원본 파일 분석"
                lufsIntegrated={analysisResult.lufsIntegrated}
                truePeak={analysisResult.truePeak}
                lra={analysisResult.lra}
                targetLUFS={masteringOptions.targetLUFS ?? -14}
                targetTP={masteringOptions.targetTruePeak ?? -1.0}
              />

              {/* 분석 세부 정보 */}
              <div className="bg-surface-800 rounded-xl p-4 grid grid-cols-2 gap-3">
                {[
                  { label: '다이나믹 레인지', value: `DR${analysisResult.dynamicRange.toFixed(0)}` },
                  { label: 'LRA', value: `${analysisResult.lra.toFixed(1)} LU` },
                  { label: '채널', value: analysisResult.channels === 2 ? '스테레오' : '모노' },
                  { label: '클리핑', value: analysisResult.clippingDetected ? `감지됨 (${analysisResult.clippingSamples}샘플)` : '없음',
                    alert: analysisResult.clippingDetected },
                ].map(({ label, value, alert }) => (
                  <div key={label} className="bg-surface-900/60 rounded-lg p-2.5">
                    <div className="text-xs text-gray-500 mb-0.5">{label}</div>
                    <div className={clsx('text-sm font-medium', alert ? 'text-red-400' : 'text-gray-200')}>
                      {value}
                    </div>
                  </div>
                ))}
              </div>

              {/* 마스터링 시작 버튼 */}
              <Button
                size="lg"
                className="w-full"
                onClick={handleMaster}
                disabled={processingState === 'processing'}
                loading={processingState === 'processing'}
                icon={
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                  </svg>
                }
              >
                마스터링 시작
              </Button>

              {/* QC 검사 버튼 */}
              <Button
                variant="secondary"
                size="md"
                className="w-full"
                onClick={() => navigateTo('qc')}
              >
                QC 검사만 실행
              </Button>
            </>
          )}

          {/* 파일 미선택 안내 */}
          {!selectedFile && !isAnalyzing && (
            <div className="bg-surface-800/50 rounded-2xl p-8 text-center space-y-3 border border-dashed border-gray-800">
              <div className="w-16 h-16 mx-auto bg-surface-800 rounded-2xl flex items-center justify-center">
                <svg className="w-8 h-8 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                    d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
                </svg>
              </div>
              <div>
                <p className="text-gray-400 font-medium">파일을 선택하면</p>
                <p className="text-gray-500 text-sm mt-1">LUFS, True Peak, 다이나믹 레인지 분석 결과가 여기에 표시됩니다</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
