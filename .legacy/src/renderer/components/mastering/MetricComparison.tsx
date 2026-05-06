/**
 * 마스터링 전/후 metrics 비교 카드 (v3.1)
 *
 * Python 측 build_metric_comparison() 가 만든 row 리스트를 그대로 받아
 * - 원본 값
 * - 마스터링 후 값
 * - 변화량 (delta)
 * - 상태 뱃지 (정상 / 주의 / 위험)
 * 형태로 표시한다.
 */
import React from 'react'
import clsx from 'clsx'
import type { MetricComparisonRow, MetricStatus } from '../../types/audio'

const STATUS_BADGE: Record<MetricStatus, { label: string; cls: string }> = {
  ok:     { label: '정상', cls: 'bg-emerald-900/40 text-emerald-300 border-emerald-800/40' },
  warn:   { label: '주의', cls: 'bg-yellow-900/40 text-yellow-300 border-yellow-800/40' },
  danger: { label: '위험', cls: 'bg-red-900/40 text-red-300 border-red-800/40' },
}

const STATUS_TEXT: Record<MetricStatus, string> = {
  ok:     'text-emerald-300',
  warn:   'text-yellow-300',
  danger: 'text-red-300',
}

interface Props {
  rows: MetricComparisonRow[]
}

export function MetricComparison({ rows }: Props) {
  if (!rows || rows.length === 0) {
    return (
      <div className="bg-surface-800 border border-gray-700 rounded-2xl p-4 text-xs text-gray-500">
        metrics 데이터가 없습니다
      </div>
    )
  }

  return (
    <div className="bg-surface-800 border border-gray-700 rounded-2xl p-4 space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-gray-100">분석 값 비교</h3>
        <p className="text-xs text-gray-500">마스터링 전/후의 핵심 수치 변화</p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {rows.map(row => (
          <MetricRow key={row.key} row={row} />
        ))}
      </div>
    </div>
  )
}

function MetricRow({ row }: { row: MetricComparisonRow }) {
  const badge = STATUS_BADGE[row.status] ?? STATUS_BADGE.ok
  return (
    <div className="bg-surface-900/60 rounded-lg px-3 py-2.5">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-gray-400 font-medium">{row.label}</span>
        <span className={clsx('text-[10px] px-1.5 py-0.5 rounded-full border', badge.cls)}>
          {badge.label}
        </span>
      </div>
      <div className="flex items-baseline gap-3 font-mono">
        <div className="flex flex-col">
          <span className="text-[10px] text-gray-600 uppercase tracking-wide">Before</span>
          <span className="text-sm text-gray-300">{formatValue(row.before, row.unit)}</span>
        </div>
        <svg className="w-3 h-3 text-gray-600 self-center" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
        </svg>
        <div className="flex flex-col">
          <span className="text-[10px] text-violet-400 uppercase tracking-wide">After</span>
          <span className={clsx('text-sm font-semibold', STATUS_TEXT[row.status])}>
            {formatValue(row.after, row.unit)}
          </span>
        </div>
        {row.delta !== null && row.delta !== undefined && (
          <div className="ml-auto flex flex-col items-end">
            <span className="text-[10px] text-gray-600 uppercase tracking-wide">Δ</span>
            <span className="text-xs text-gray-400">
              {row.delta >= 0 ? '+' : ''}{Number(row.delta).toFixed(2)} {row.unit}
            </span>
          </div>
        )}
      </div>
      {row.hint && <div className="text-[10px] text-gray-600 mt-1">{row.hint}</div>}
    </div>
  )
}

function formatValue(v: number | string | null, unit: string): string {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'string') return v
  if (Number.isFinite(v)) {
    const formatted = Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2)
    return unit ? `${formatted} ${unit}` : formatted
  }
  return '—'
}
