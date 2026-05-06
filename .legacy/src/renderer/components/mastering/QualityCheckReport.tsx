/**
 * 마스터링 결과 자동 품질 체크 리포트 (v3.1)
 *
 * Python 측 run_quality_check() 가 만든 결과를 그대로 표시.
 * overall: ok | warn | danger
 */
import React from 'react'
import clsx from 'clsx'
import type { QualityCheckResult, QualityStatus } from '../../types/audio'

const STATUS_STYLE: Record<QualityStatus, {
  ring: string; bg: string; icon: string; text: string; label: string
}> = {
  ok: {
    ring: 'border-emerald-800/40',
    bg: 'bg-emerald-900/15',
    icon: 'text-emerald-400',
    text: 'text-emerald-300',
    label: '정상',
  },
  warn: {
    ring: 'border-yellow-800/40',
    bg: 'bg-yellow-900/15',
    icon: 'text-yellow-400',
    text: 'text-yellow-300',
    label: '주의',
  },
  danger: {
    ring: 'border-red-800/40',
    bg: 'bg-red-900/15',
    icon: 'text-red-400',
    text: 'text-red-300',
    label: '위험',
  },
}

interface Props {
  result: QualityCheckResult | undefined | null
}

export function QualityCheckReport({ result }: Props) {
  if (!result) return null
  const overall = STATUS_STYLE[result.overall] ?? STATUS_STYLE.ok

  return (
    <div className={clsx('rounded-2xl border p-4 space-y-3', overall.bg, overall.ring)}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className={clsx('w-7 h-7 rounded-lg flex items-center justify-center', overall.bg)}>
            <svg className={clsx('w-4 h-4', overall.icon)} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M9 12l2 2 4-4m5 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-gray-100">품질 체크 리포트</h3>
            <p className="text-xs text-gray-500">{result.summary}</p>
          </div>
        </div>
        <span className={clsx('text-xs font-medium px-2 py-1 rounded-full', overall.bg, overall.text)}>
          {overall.label}
        </span>
      </div>

      <div className="space-y-1.5">
        {(result.items ?? []).map((it, idx) => {
          const s = STATUS_STYLE[it.status] ?? STATUS_STYLE.ok
          return (
            <div key={idx} className="flex items-start gap-2.5 bg-surface-900/50 rounded-lg px-3 py-2">
              <div className={clsx('w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5', s.bg)}>
                <span className={clsx('text-[10px] font-bold', s.icon)}>
                  {it.status === 'ok' ? '✓' : it.status === 'warn' ? '!' : '✕'}
                </span>
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-gray-200">{it.name}</span>
                  <span className={clsx('text-[10px] uppercase tracking-wide font-medium', s.text)}>
                    {s.label}
                  </span>
                </div>
                <p className="text-[11px] text-gray-500 mt-0.5">{it.message}</p>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
