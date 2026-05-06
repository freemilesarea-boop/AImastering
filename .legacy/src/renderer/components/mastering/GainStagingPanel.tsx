/**
 * Gain-staging report panel (v3.3).
 *
 * Shows every dB the pipeline added at each stage plus the verdict from
 * build_gain_staging_report() — including the user-facing diagnosis of
 * "메인 멜로디가 눌리고 배경이 커짐" (vocal-loss + background-rise).
 *
 * Usage:
 *   <GainStagingPanel report={result.gainStaging} />
 */
import React from 'react'
import clsx from 'clsx'
import type { GainStagingReport } from '../../types/audio'

const VERDICT_STYLE = {
  ok:     { ring: 'border-emerald-800/40', bg: 'bg-emerald-900/15', text: 'text-emerald-300', label: '정상' },
  warn:   { ring: 'border-yellow-800/40',  bg: 'bg-yellow-900/15',  text: 'text-yellow-300',  label: '주의' },
  danger: { ring: 'border-red-800/40',     bg: 'bg-red-900/15',     text: 'text-red-300',     label: '위험' },
}

const STAGE_LABELS: Record<string, string> = {
  compressorMakeupDb: '컴프레서 메이크업',
  preGainDb:          'Limiter 직전 push (entry gain)',
  limiterInputGainDb: 'Limiter input gain',
  correctionGainDb:   '보정 패스 gain',
  ispCorrectionDb:    'ISP safety 보정',
  totalAppliedGainDb: '총 적용 gain',
}

function fmtDb(v: number | undefined | null): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '–'
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)} dB`
}

interface Props {
  report: GainStagingReport | undefined | null
}

export function GainStagingPanel({ report }: Props) {
  if (!report) return null
  if (!report.available) {
    return (
      <div className="rounded-2xl border border-surface-700 bg-surface-900/40 p-4 text-xs text-gray-500">
        gain-staging 분석을 위해 numpy / soundfile 가 필요합니다.
      </div>
    )
  }
  const v = VERDICT_STYLE[report.verdict] ?? VERDICT_STYLE.ok
  const stages = report.stages

  return (
    <div className={clsx('rounded-2xl border p-4 space-y-3', v.bg, v.ring)}>
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-gray-100">Gain Staging</h3>
          <p className="text-xs text-gray-500">단계별 dB push 와 vocal/background 밸런스 분석</p>
        </div>
        <span className={clsx('text-xs font-medium px-2 py-1 rounded-full', v.bg, v.text)}>
          {v.label}
        </span>
      </div>

      {/* Per-stage gain table */}
      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[11px] bg-surface-900/40 rounded-lg p-3">
        {Object.entries(STAGE_LABELS).map(([key, label]) => {
          const val = (stages as Record<string, number>)[key]
          const isTotal = key === 'totalAppliedGainDb'
          return (
            <React.Fragment key={key}>
              <div className={clsx('text-gray-400', isTotal && 'font-semibold text-gray-200')}>
                {label}
              </div>
              <div
                className={clsx(
                  'text-right font-mono',
                  isTotal ? 'font-semibold text-gray-100' :
                  Math.abs(val ?? 0) > 6 ? 'text-yellow-300' : 'text-gray-300',
                )}
              >
                {fmtDb(val)}
              </div>
            </React.Fragment>
          )
        })}
      </div>

      {/* Symptom diagnosis */}
      {(report.vocalLossDb !== null || report.crestFactorDropPct !== null) && (
        <div className="grid grid-cols-2 gap-2 text-[11px]">
          {report.vocalLossDb !== null && (
            <div className="bg-surface-900/40 rounded-lg p-2.5">
              <div className="text-gray-500">보컬 손실 (1.5–5 kHz)</div>
              <div className={clsx(
                'font-mono mt-0.5',
                (report.vocalLossDb ?? 0) >= 1.5 ? 'text-yellow-300' : 'text-gray-200',
              )}>
                {fmtDb(report.vocalLossDb)}
              </div>
            </div>
          )}
          {report.backgroundRiseDb !== null && (
            <div className="bg-surface-900/40 rounded-lg p-2.5">
              <div className="text-gray-500">배경 상승</div>
              <div className={clsx(
                'font-mono mt-0.5',
                (report.backgroundRiseDb ?? 0) >= 1.5 ? 'text-yellow-300' : 'text-gray-200',
              )}>
                {fmtDb(report.backgroundRiseDb)}
              </div>
            </div>
          )}
          {report.crestFactorDropPct !== null && (
            <div className="bg-surface-900/40 rounded-lg p-2.5">
              <div className="text-gray-500">Crest 감소</div>
              <div className={clsx(
                'font-mono mt-0.5',
                (report.crestFactorDropPct ?? 0) >= 0.4 ? 'text-yellow-300' : 'text-gray-200',
              )}>
                {((report.crestFactorDropPct ?? 0) * 100).toFixed(0)}%
              </div>
            </div>
          )}
          {report.lraDropPct !== null && (
            <div className="bg-surface-900/40 rounded-lg p-2.5">
              <div className="text-gray-500">LRA 감소</div>
              <div className={clsx(
                'font-mono mt-0.5',
                (report.lraDropPct ?? 0) >= 0.5 ? 'text-yellow-300' : 'text-gray-200',
              )}>
                {((report.lraDropPct ?? 0) * 100).toFixed(0)}%
              </div>
            </div>
          )}
        </div>
      )}

      {report.issues.length > 0 && (
        <div className="space-y-1">
          {report.issues.map((issue, i) => (
            <div key={i} className="flex items-start gap-1.5 text-[11px]">
              <span className={clsx('mt-0.5', v.text)}>!</span>
              <span className="text-gray-400">{issue}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
