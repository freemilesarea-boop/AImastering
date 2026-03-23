/**
 * QC 리포트 컴포넌트 v2
 * 12항목 검사 결과를 "통과 / 주의 / 확인 필요" 중심으로 표시
 * 수치보다 상태 중심의 직관적 UX
 */
import React, { useState } from 'react'
import clsx from 'clsx'
import {
  QCResult,
  QCItem,
  QCStatus,
  PlatformQC,
  QC_STATUS_LABELS,
  QC_STATUS_COLORS,
  QC_STATUS_BG,
} from '../../types/audio'
import { StatusBadge } from '../common/StatusBadge'

// ─────────────────────────────────────────────────────
// 아이콘
// ─────────────────────────────────────────────────────
function StatusIcon({ status }: { status: QCStatus }) {
  if (status === 'pass') {
    return (
      <svg className="w-4 h-4 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
      </svg>
    )
  }
  if (status === 'warning') {
    return (
      <svg className="w-4 h-4 text-yellow-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
      </svg>
    )
  }
  return (
    <svg className="w-4 h-4 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
    </svg>
  )
}

// ─────────────────────────────────────────────────────
// 개별 QC 항목
// ─────────────────────────────────────────────────────
function QCItemRow({ item }: { item: QCItem }) {
  return (
    <div className={clsx(
      'flex items-start gap-3 px-3.5 py-2.5 rounded-xl border',
      QC_STATUS_BG[item.status]
    )}>
      <div className="mt-0.5 flex-shrink-0">
        <StatusIcon status={item.status} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-gray-200">{item.name}</span>
          <span className={clsx('text-xs font-medium', QC_STATUS_COLORS[item.status])}>
            {QC_STATUS_LABELS[item.status]}
          </span>
        </div>
        <p className="text-xs text-gray-400 mt-0.5 leading-relaxed">{item.message}</p>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────
// 전체 통계 도넛
// ─────────────────────────────────────────────────────
function QCScoreRing({ passCount, warnCount, failCount, total }: {
  passCount: number; warnCount: number; failCount: number; total: number
}) {
  const passAngle = (passCount / total) * 360
  const warnAngle = (warnCount / total) * 360
  const score = Math.round((passCount / total) * 100)

  return (
    <div className="flex items-center gap-4">
      {/* 원형 진행 표시 (간이 SVG) */}
      <div className="relative w-20 h-20 flex-shrink-0">
        <svg viewBox="0 0 36 36" className="w-full h-full -rotate-90">
          {/* 배경 */}
          <circle cx="18" cy="18" r="15.9" fill="none" stroke="#1f2937" strokeWidth="3" />
          {/* 경고 (노란색) */}
          {warnCount > 0 && (
            <circle cx="18" cy="18" r="15.9" fill="none" stroke="#f59e0b" strokeWidth="3"
              strokeDasharray={`${(warnCount / total) * 100} 100`}
              strokeDashoffset={`${-(passCount / total) * 100}`}
            />
          )}
          {/* 실패 (빨간색) */}
          {failCount > 0 && (
            <circle cx="18" cy="18" r="15.9" fill="none" stroke="#ef4444" strokeWidth="3"
              strokeDasharray={`${(failCount / total) * 100} 100`}
              strokeDashoffset={`${-((passCount + warnCount) / total) * 100}`}
            />
          )}
          {/* 통과 (초록색) */}
          <circle cx="18" cy="18" r="15.9" fill="none" stroke="#10b981" strokeWidth="3"
            strokeDasharray={`${(passCount / total) * 100} 100`}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-lg font-bold text-gray-100 leading-none">{score}</span>
          <span className="text-xs text-gray-500">점</span>
        </div>
      </div>

      {/* 범례 */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-2 text-xs">
          <div className="w-2.5 h-2.5 rounded-full bg-green-400" />
          <span className="text-gray-300">통과</span>
          <span className="text-gray-500 font-mono">{passCount}건</span>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <div className="w-2.5 h-2.5 rounded-full bg-yellow-400" />
          <span className="text-gray-300">주의</span>
          <span className="text-gray-500 font-mono">{warnCount}건</span>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <div className="w-2.5 h-2.5 rounded-full bg-red-400" />
          <span className="text-gray-300">확인 필요</span>
          <span className="text-gray-500 font-mono">{failCount}건</span>
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────
// 플랫폼 결과
// ─────────────────────────────────────────────────────
function PlatformRow({ qc }: { qc: PlatformQC }) {
  return (
    <div className={clsx(
      'flex items-center justify-between px-3 py-2.5 rounded-lg border',
      qc.passed
        ? 'bg-green-900/10 border-green-900/30'
        : 'bg-red-900/10 border-red-900/30'
    )}>
      <div className="flex items-center gap-2.5">
        <StatusIcon status={qc.passed ? 'pass' : 'fail'} />
        <div>
          <div className="text-sm font-medium text-gray-200">{qc.platform}</div>
          {!qc.passed && (
            <div className="text-xs text-red-300 mt-0.5">{qc.issues[0]}</div>
          )}
        </div>
      </div>
      <div className="text-right text-xs font-mono text-gray-500 space-y-0.5">
        <div className={clsx(
          Math.abs(qc.measuredLUFS - qc.targetLUFS) <= 1 ? 'text-green-400' : 'text-red-400'
        )}>
          {qc.measuredLUFS.toFixed(1)} LUFS
        </div>
        <div className={clsx(qc.measuredTP <= qc.targetTP ? 'text-green-400' : 'text-red-400')}>
          {qc.measuredTP.toFixed(1)} dBTP
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────
// 메인 QC 리포트
// ─────────────────────────────────────────────────────
interface QCReportProps {
  result: QCResult
  compact?: boolean
}

export function QCReport({ result, compact = false }: QCReportProps) {
  const [activeTab, setActiveTab] = useState<'items' | 'platforms'>('items')

  const failItems = result.items.filter(i => i.status === 'fail')
  const warnItems = result.items.filter(i => i.status === 'warning')
  const passItems = result.items.filter(i => i.status === 'pass')

  const overallBg = result.overall === 'pass'
    ? 'bg-green-900/20 border-green-700/50'
    : result.overall === 'warning'
      ? 'bg-yellow-900/20 border-yellow-700/50'
      : 'bg-red-900/20 border-red-700/50'

  const overallIcon = result.overall === 'pass' ? '✓' : result.overall === 'warning' ? '⚠' : '✕'
  const overallColor = result.overall === 'pass' ? 'text-green-300'
    : result.overall === 'warning' ? 'text-yellow-300' : 'text-red-300'

  return (
    <div className="space-y-4">
      {/* 전체 결과 요약 카드 */}
      <div className={clsx('rounded-2xl border p-4', overallBg)}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className={clsx('text-lg font-bold mb-1', overallColor)}>
              {overallIcon} {result.summary}
            </h3>
            <div className="flex items-center gap-3 text-xs text-gray-500">
              <span>총 {result.totalCount}항목</span>
              <span>·</span>
              <span className="text-green-400">{passItems.length}통과</span>
              {warnItems.length > 0 && (
                <>
                  <span>·</span>
                  <span className="text-yellow-400">{warnItems.length}주의</span>
                </>
              )}
              {failItems.length > 0 && (
                <>
                  <span>·</span>
                  <span className="text-red-400">{failItems.length}확인 필요</span>
                </>
              )}
            </div>
          </div>

          {/* 점수 링 */}
          <QCScoreRing
            passCount={passItems.length}
            warnCount={warnItems.length}
            failCount={failItems.length}
            total={result.totalCount}
          />
        </div>

        {/* 핵심 수치 */}
        <div className="grid grid-cols-3 gap-2 mt-4">
          {[
            { label: 'LUFS', value: result.analysis.lufsIntegrated.toFixed(1), unit: '' },
            { label: 'True Peak', value: result.analysis.truePeak.toFixed(1), unit: 'dBTP' },
            { label: 'LRA', value: result.analysis.lra.toFixed(1), unit: 'LU' },
          ].map(({ label, value, unit }) => (
            <div key={label} className="bg-black/20 rounded-lg p-2 text-center">
              <div className="text-base font-bold font-mono text-gray-200">{value}</div>
              <div className="text-xs text-gray-500 mt-0.5">{label} {unit}</div>
            </div>
          ))}
        </div>
      </div>

      {/* 탭 */}
      <div className="flex gap-1 bg-surface-800 rounded-xl p-1">
        {[
          { key: 'items' as const,     label: `세부 항목 (${result.totalCount})` },
          { key: 'platforms' as const, label: `플랫폼 (${result.platforms.length})` },
        ].map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setActiveTab(key)}
            className={clsx(
              'flex-1 py-1.5 rounded-lg text-sm font-medium transition-colors',
              activeTab === key
                ? 'bg-surface-900 text-gray-200'
                : 'text-gray-500 hover:text-gray-300'
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {/* 항목 탭 */}
      {activeTab === 'items' && (
        <div className="space-y-1.5">
          {/* 확인 필요 우선 표시 */}
          {failItems.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs text-red-400 font-medium px-1">확인 필요</p>
              {failItems.map((item) => <QCItemRow key={item.name} item={item} />)}
            </div>
          )}
          {warnItems.length > 0 && (
            <div className="space-y-1.5 mt-2">
              <p className="text-xs text-yellow-400 font-medium px-1">주의</p>
              {warnItems.map((item) => <QCItemRow key={item.name} item={item} />)}
            </div>
          )}
          {passItems.length > 0 && (
            <div className="space-y-1.5 mt-2">
              <p className="text-xs text-gray-600 font-medium px-1">통과</p>
              {passItems.map((item) => <QCItemRow key={item.name} item={item} />)}
            </div>
          )}
        </div>
      )}

      {/* 플랫폼 탭 */}
      {activeTab === 'platforms' && (
        <div className="space-y-1.5">
          {result.platforms.map((qc) => (
            <PlatformRow key={qc.platform} qc={qc} />
          ))}
        </div>
      )}
    </div>
  )
}
