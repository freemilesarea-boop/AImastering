/**
 * QC 검사 페이지 v2
 * 12항목 전체 결과 + 플랫폼 기준 점검
 */
import React, { useEffect } from 'react'
import { QCReport } from '../components/qc/QCReport'
import { Button } from '../components/common/Button'
import { useAudioEngine } from '../hooks/useAudioEngine'
import { useAppStore } from '../store/appStore'
import { useLicense } from '../hooks/useLicense'

export function QCPage() {
  const { qcResult, masteringResult, selectedFile, runQC, isAnalyzing } = useAudioEngine()
  const { navigateTo } = useAppStore()
  const { licenseInfo, setShowModal } = useLicense()

  const targetFile = masteringResult?.outputPath || selectedFile
  const isRunning  = !qcResult && !isAnalyzing

  useEffect(() => {
    if (!qcResult && targetFile) runQC()
  }, [])

  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-3xl mx-auto p-6 space-y-5">
        {/* 헤더 */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigateTo(masteringResult ? 'result' : 'home')}
            className="text-gray-500 hover:text-gray-200 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <div>
            <h1 className="text-lg font-bold text-gray-100">발매 전 QC 검사</h1>
            <p className="text-xs text-gray-500 mt-0.5">
              포맷 · 라우드니스 · 클리핑 · 무음 · 스테레오 밸런스 등 12항목 점검
            </p>
          </div>
        </div>

        {/* 대상 파일 */}
        {targetFile && (
          <div className="bg-surface-800 rounded-xl px-4 py-2.5 flex items-center gap-2.5 text-sm">
            <svg className="w-4 h-4 text-gray-600 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            <span className="text-gray-400 text-xs">검사 대상:</span>
            <span className="text-gray-300 text-xs truncate">{targetFile.split('/').pop()}</span>
          </div>
        )}

        {/* 로딩 */}
        {!qcResult && (
          <div className="bg-surface-800 rounded-2xl p-12 flex flex-col items-center gap-4">
            <div className="w-12 h-12 border-2 border-violet-500 border-t-transparent rounded-full animate-spin" />
            <div className="text-center">
              <p className="text-gray-300 font-medium">QC 검사 중...</p>
              <p className="text-gray-500 text-sm mt-1">12항목 · 5개 플랫폼 기준 확인</p>
            </div>
          </div>
        )}

        {/* QC 리포트 */}
        {qcResult && <QCReport result={qcResult} />}

        {/* 리포트 내보내기 + 재검사 */}
        {qcResult && (
          <div className="flex gap-2.5">
            {/* 리포트 내보내기 — 유료만 */}
            {licenseInfo?.canExportReport ? (
              <Button
                variant="secondary"
                size="md"
                className="flex-1"
                onClick={() => {/* TODO: PDF 내보내기 */}}
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                리포트 내보내기
              </Button>
            ) : (
              <button
                onClick={() => setShowModal(true)}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-lg border border-dashed border-gray-700 text-sm text-gray-600 hover:text-gray-400 hover:border-gray-600 transition-colors"
              >
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/>
                </svg>
                리포트 내보내기 (Pro)
              </button>
            )}

            <Button
              variant="secondary"
              size="md"
              className="flex-1"
              onClick={() => runQC()}
            >
              다시 검사
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
