/**
 * QC 검사 페이지
 */
import React, { useEffect } from 'react'
import { QCReport } from '../components/qc/QCReport'
import { Button } from '../components/common/Button'
import { useAudioEngine } from '../hooks/useAudioEngine'
import { useAppStore } from '../store/appStore'

export function QCPage() {
  const { qcResult, masteringResult, selectedFile, runQC } = useAudioEngine()
  const { navigateTo } = useAppStore()

  // 페이지 진입 시 QC 자동 실행
  useEffect(() => {
    if (!qcResult) {
      runQC()
    }
  }, [])

  const targetFile = masteringResult?.outputPath || selectedFile

  return (
    <div className="flex-1 overflow-auto p-6 space-y-6">
      <div className="flex items-center gap-3">
        <button
          onClick={() => navigateTo(masteringResult ? 'result' : 'home')}
          className="text-gray-400 hover:text-gray-200 transition-colors"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <div>
          <h1 className="text-xl font-bold text-gray-100">QC 검사</h1>
          <p className="text-xs text-gray-500 mt-0.5">
            플랫폼별 라우드니스 기준 준수 여부 점검
          </p>
        </div>
      </div>

      {/* 대상 파일 */}
      {targetFile && (
        <div className="bg-surface-800 rounded-xl px-4 py-3 text-sm text-gray-400">
          <span className="text-gray-600 mr-2">대상 파일:</span>
          {targetFile.split('/').pop()}
        </div>
      )}

      {/* QC 결과 */}
      {qcResult ? (
        <QCReport result={qcResult} />
      ) : (
        <div className="bg-surface-800 rounded-2xl p-12 flex flex-col items-center justify-center gap-4">
          <div className="w-12 h-12 border-2 border-violet-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-gray-400 text-sm">QC 검사 중...</p>
        </div>
      )}

      {/* 다시 실행 */}
      {qcResult && (
        <Button variant="secondary" size="md" className="w-full" onClick={() => runQC()}>
          다시 검사
        </Button>
      )}
    </div>
  )
}
