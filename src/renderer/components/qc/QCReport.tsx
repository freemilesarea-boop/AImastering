/**
 * QC 리포트 컴포넌트
 */
import React from 'react'
import clsx from 'clsx'
import { QCResult, PlatformQC } from '../../types/audio'
import { StatusBadge } from '../common/StatusBadge'

interface QCReportProps {
  result: QCResult
}

function PlatformRow({ qc }: { qc: PlatformQC }) {
  return (
    <div className={clsx(
      'p-4 rounded-xl border',
      qc.passed ? 'border-green-800/50 bg-green-900/10' : 'border-red-800/50 bg-red-900/10'
    )}>
      <div className="flex items-start justify-between mb-3">
        <div>
          <h4 className="font-medium text-gray-200">{qc.platform}</h4>
          <p className="text-xs text-gray-500 mt-0.5">
            기준: {qc.targetLUFS} LUFS / {qc.targetTP} dBTP
          </p>
        </div>
        <StatusBadge status={qc.passed ? 'success' : 'error'} label={qc.passed ? '통과' : '불합격'} />
      </div>

      <div className="grid grid-cols-2 gap-3">
        {/* LUFS */}
        <div className="bg-black/20 rounded-lg p-2.5">
          <div className="text-xs text-gray-500 mb-1">측정 LUFS</div>
          <div className={clsx(
            'text-lg font-mono font-semibold',
            Math.abs(qc.measuredLUFS - qc.targetLUFS) <= 1.0 ? 'text-green-400' : 'text-red-400'
          )}>
            {qc.measuredLUFS.toFixed(1)}
          </div>
          <div className="text-xs text-gray-600 mt-0.5">
            차이: {(qc.measuredLUFS - qc.targetLUFS).toFixed(1)} LUFS
          </div>
        </div>
        {/* True Peak */}
        <div className="bg-black/20 rounded-lg p-2.5">
          <div className="text-xs text-gray-500 mb-1">True Peak</div>
          <div className={clsx(
            'text-lg font-mono font-semibold',
            qc.measuredTP <= qc.targetTP ? 'text-green-400' : 'text-red-400'
          )}>
            {qc.measuredTP.toFixed(1)}
          </div>
          <div className="text-xs text-gray-600 mt-0.5">
            한계: {qc.targetTP} dBTP
          </div>
        </div>
      </div>

      {/* 이슈 목록 */}
      {qc.issues.length > 0 && (
        <div className="mt-3 space-y-1">
          {qc.issues.map((issue, idx) => (
            <div key={idx} className="flex items-center gap-2 text-xs text-red-300">
              <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
              </svg>
              {issue}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function QCReport({ result }: QCReportProps) {
  const passedCount = result.platforms.filter(p => p.passed).length

  return (
    <div className="space-y-4">
      {/* 전체 결과 요약 */}
      <div className={clsx(
        'flex items-center justify-between p-4 rounded-2xl border',
        result.passed
          ? 'border-green-700 bg-green-900/20'
          : 'border-yellow-700 bg-yellow-900/20'
      )}>
        <div>
          <h3 className={clsx(
            'text-lg font-bold',
            result.passed ? 'text-green-300' : 'text-yellow-300'
          )}>
            {result.passed ? '✓ QC 통과' : '⚠ 일부 플랫폼 미충족'}
          </h3>
          <p className="text-sm text-gray-400 mt-0.5">{result.summary}</p>
        </div>
        <div className="text-right">
          <div className="text-2xl font-bold text-gray-200">{passedCount}/{result.platforms.length}</div>
          <div className="text-xs text-gray-500">플랫폼 통과</div>
        </div>
      </div>

      {/* 플랫폼별 결과 */}
      <div className="space-y-2">
        {result.platforms.map((qc) => (
          <PlatformRow key={qc.platform} qc={qc} />
        ))}
      </div>
    </div>
  )
}
