/**
 * Reference-match score panel (v3.4 — Ozone-style iterative mastering).
 *
 * Shows:
 *   1. Overall match % vs reference (large gauge)
 *   2. Per-axis breakdown (LUFS / LRA / TP / 4 bands / stereo)
 *   3. Per-iteration score progression (so users see the loop converging)
 *   4. Reference vs target vs output snapshot (3-column comparison)
 *   5. Why the loop stopped (accepted / no improvement / max iters)
 */
import React from 'react'
import clsx from 'clsx'
import type {
  ReferenceMatchReport, ReferenceProfile, TargetProfile,
} from '../../types/audio'

const SCORE_STYLE = (score: number | null) => {
  if (score === null) return { ring: 'border-gray-700/40',     text: 'text-gray-400',  label: '–' }
  if (score >= 90)    return { ring: 'border-emerald-700/50',  text: 'text-emerald-300', label: 'A' }
  if (score >= 75)    return { ring: 'border-blue-700/50',     text: 'text-blue-300',    label: 'B' }
  if (score >= 60)    return { ring: 'border-yellow-700/50',   text: 'text-yellow-300',  label: 'C' }
  return                  { ring: 'border-red-700/50',         text: 'text-red-300',     label: 'D' }
}

const STOPPED_LABEL: Record<string, string> = {
  accept_threshold_met:        '목표 점수 달성',
  no_significant_improvement:  '추가 반복으로 개선 없음 — 종료',
  max_iterations_reached:      '최대 반복 횟수 도달',
  no_iterations:               '반복 실행 안 됨',
}

interface Props {
  match:     ReferenceMatchReport     | undefined | null
  reference: ReferenceProfile          | undefined | null
  target:    TargetProfile             | undefined | null
  /** Output snapshot — typically use `result.loudnessAfter` etc. */
  output?: {
    integratedLufs: number
    truePeakDbtp:   number
    lra:            number
    bands?: { low: number; mid: number; vocal: number; high: number }
  } | null
}

function fmt(n: number | null | undefined, prec = 1, suffix = ''): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '–'
  return `${n >= 0 ? '+' : ''}${n.toFixed(prec)}${suffix}`
}

export function ReferenceMatchPanel({ match, reference, target, output }: Props) {
  if (!match) return null
  const overall = match.overall
  const sev = SCORE_STYLE(overall)

  const bands = match.perAxis?.bands ?? {}
  const bandKeys: Array<'low'|'mid'|'vocal'|'high'> = ['low', 'mid', 'vocal', 'high']

  return (
    <div className={clsx('rounded-2xl border p-4 space-y-4', sev.ring)}>
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          <div className={clsx(
            'w-14 h-14 rounded-xl border-2 flex flex-col items-center justify-center shrink-0',
            sev.ring,
          )}>
            <span className={clsx('text-xl font-bold leading-none', sev.text)}>
              {overall === null ? '–' : Math.round(overall)}
            </span>
            <span className={clsx('text-[10px] font-medium', sev.text)}>SCORE</span>
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-gray-100">
              레퍼런스 매칭  <span className={clsx('text-xs font-normal', sev.text)}>({sev.label}등급)</span>
            </h3>
            <p className="text-[11px] text-gray-500 mt-0.5">
              {STOPPED_LABEL[match.stoppedReason] ?? match.stoppedReason}
              {' · '}
              반복 {match.iterations}/{match.maxIterations}회
              {' · '}
              임계값 {match.acceptThreshold}점
            </p>
            {match.weakestAxis && (
              <p className="text-[11px] text-gray-400 mt-1">
                가장 차이 나는 축:{' '}
                <code className="text-gray-300">{match.weakestAxis}</code>
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Per-axis breakdown */}
      <div className="grid grid-cols-3 gap-2">
        {[
          ['LUFS',     match.perAxis?.lufs],
          ['LRA',      match.perAxis?.lra],
          ['TP',       match.perAxis?.truePeak],
        ].map(([label, score]) => {
          const s = SCORE_STYLE(score as number | null)
          return (
            <div key={label as string}
                 className={clsx('rounded-lg border p-2', s.ring)}>
              <div className="text-[10px] text-gray-500">{label}</div>
              <div className={clsx('text-lg font-semibold', s.text)}>
                {score === null ? '–' : Math.round(score as number)}
              </div>
            </div>
          )
        })}
      </div>

      {/* Per-band */}
      <div>
        <div className="text-[11px] text-gray-500 mb-1.5">밴드별 매칭</div>
        <div className="grid grid-cols-4 gap-2">
          {bandKeys.map(k => {
            const score = (bands as any)[k] ?? null
            const s = SCORE_STYLE(score)
            return (
              <div key={k} className={clsx('rounded-lg border p-2', s.ring)}>
                <div className="text-[10px] text-gray-500 capitalize">{k}</div>
                <div className={clsx('text-base font-semibold', s.text)}>
                  {score === null ? '–' : Math.round(score)}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Reference / Target / Output 3-column compare */}
      {(reference?.available && target) && (
        <div className="bg-surface-900/40 rounded-lg p-3">
          <div className="text-[11px] text-gray-500 mb-2">레퍼런스 vs 타깃 vs 결과</div>
          <table className="w-full text-[11px] font-mono">
            <thead>
              <tr className="text-gray-500">
                <th className="text-left">  </th>
                <th className="text-right">Reference</th>
                <th className="text-right">Target</th>
                <th className="text-right">Output</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="text-gray-400">LUFS</td>
                <td className="text-right text-gray-300">{fmt(reference?.integratedLufs, 1)}</td>
                <td className="text-right text-gray-300">{fmt(target?.targetLufs, 1)}</td>
                <td className="text-right text-gray-300">{fmt(output?.integratedLufs, 1)}</td>
              </tr>
              <tr>
                <td className="text-gray-400">TP (dBTP)</td>
                <td className="text-right text-gray-300">{fmt(reference?.truePeakDbtp, 2)}</td>
                <td className="text-right text-gray-300">{fmt(target?.targetTruePeak, 2)}</td>
                <td className="text-right text-gray-300">{fmt(output?.truePeakDbtp, 2)}</td>
              </tr>
              <tr>
                <td className="text-gray-400">LRA (LU)</td>
                <td className="text-right text-gray-300">{fmt(reference?.lra, 1)}</td>
                <td className="text-right text-gray-300">{fmt(target?.targetLra, 1)}</td>
                <td className="text-right text-gray-300">{fmt(output?.lra, 1)}</td>
              </tr>
              {bandKeys.map(bk => (
                <tr key={bk}>
                  <td className="text-gray-400 capitalize">{bk}</td>
                  <td className="text-right text-gray-300">
                    {fmt((reference?.bands as any)?.[bk], 1)}
                  </td>
                  <td className="text-right text-gray-300">
                    {fmt((target?.targetBands as any)?.[bk], 1)}
                  </td>
                  <td className="text-right text-gray-300">
                    {fmt((output?.bands as any)?.[bk], 1)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Per-iteration progression */}
      {match.perIteration.length > 0 && (
        <div>
          <div className="text-[11px] text-gray-500 mb-1.5">
            반복 진행 ({match.perIteration.length}회)
          </div>
          <div className="flex items-end gap-2 bg-surface-900/40 rounded-lg p-3 h-20">
            {match.perIteration.map((it, i) => {
              const sc = it.scoreOverall ?? 0
              const h = Math.max(8, sc)
              const s = SCORE_STYLE(it.scoreOverall)
              return (
                <div key={i} className="flex-1 flex flex-col items-center gap-1">
                  <div
                    className={clsx('w-full rounded-t', s.text.replace('text-', 'bg-'))}
                    style={{ height: `${h}%`, opacity: 0.7 }}
                  />
                  <span className={clsx('text-[10px] font-mono', s.text)}>
                    {it.scoreOverall === null ? '–' : Math.round(it.scoreOverall)}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
