/**
 * 마스터링 결과 위험 신호에 따른 모드 추천 (v3.3).
 *
 * Python 측 recommend_modes() 결과를 그대로 표시.  사용자가 추천 모드를
 * 클릭하면 onApplyMode(mode) 콜백으로 재마스터링을 트리거할 수 있다.
 *
 * mode 매핑:
 *   safe            — 라디오 음질 / 보컬 뭉개짐 → Safe Mode
 *   vocal_safe      — brickwall 평탄화 / 보컬 손상 → Vocal Safe Mode
 *   low_limit       — 과도한 리미팅 → Low Limiting Mode
 *   convert_to_wav  — MP3 / VBR 입력 → WAV 변환 후 재시도
 */
import React from 'react'
import clsx from 'clsx'
import type { ModeRecommendation, SafeModeKey } from '../../types/audio'

const MODE_INFO: Record<string, { label: string; emoji: string; cta: string }> = {
  safe:           { label: 'Safe Mode',          emoji: '🛡️', cta: 'Safe Mode 로 재마스터링' },
  vocal_safe:     { label: 'Vocal Safe Mode',    emoji: '🎤', cta: 'Vocal Safe Mode 로 재마스터링' },
  low_limit:      { label: 'Low Limiting Mode',  emoji: '🔉', cta: 'Low Limiting Mode 로 재마스터링' },
  convert_to_wav: { label: 'WAV 변환',           emoji: '📁', cta: 'WAV 로 변환 후 재시도' },
}

const SEVERITY_STYLE = {
  info: {
    ring: 'border-blue-800/40',
    bg:   'bg-blue-900/15',
    icon: 'text-blue-400',
    text: 'text-blue-300',
    label: '권장',
  },
  warn: {
    ring: 'border-yellow-800/40',
    bg:   'bg-yellow-900/15',
    icon: 'text-yellow-400',
    text: 'text-yellow-300',
    label: '주의',
  },
  danger: {
    ring: 'border-red-800/40',
    bg:   'bg-red-900/15',
    icon: 'text-red-400',
    text: 'text-red-300',
    label: '위험',
  },
}

interface Props {
  recommendations: ModeRecommendation[] | undefined | null
  /** Apply a safe-mode preset and re-master.  Pass null when convert_to_wav is selected. */
  onApplyMode?: (mode: SafeModeKey | 'convert_to_wav') => void
}

export function ModeRecommendations({ recommendations, onApplyMode }: Props) {
  if (!recommendations || recommendations.length === 0) return null

  // Worst severity drives the banner color.
  const worstSeverity = recommendations
    .map(r => r.severity)
    .reduce<'info' | 'warn' | 'danger'>((acc, s) => {
      const rank: Record<string, number> = { info: 0, warn: 1, danger: 2 }
      return rank[s] > rank[acc] ? (s as any) : acc
    }, 'info')
  const banner = SEVERITY_STYLE[worstSeverity]

  return (
    <div className={clsx('rounded-2xl border p-4 space-y-3', banner.bg, banner.ring)}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className={clsx('w-7 h-7 rounded-lg flex items-center justify-center', banner.bg)}>
            <span className={clsx('text-sm', banner.icon)}>💡</span>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-gray-100">추천 마스터링 모드</h3>
            <p className="text-xs text-gray-500">
              결과 분석 결과 다음 모드로 재시도하면 음질이 개선될 수 있습니다.
            </p>
          </div>
        </div>
        <span className={clsx('text-xs font-medium px-2 py-1 rounded-full', banner.bg, banner.text)}>
          {banner.label}
        </span>
      </div>

      <div className="space-y-1.5">
        {recommendations.map((rec, idx) => {
          const info = MODE_INFO[rec.mode] ?? {
            label: rec.mode, emoji: 'ℹ️', cta: '재시도',
          }
          const sev = SEVERITY_STYLE[rec.severity] ?? SEVERITY_STYLE.info
          return (
            <div
              key={`${rec.mode}-${idx}`}
              className="flex items-start gap-2.5 bg-surface-900/50 rounded-lg px-3 py-2"
            >
              <div className="text-lg leading-none mt-0.5">{info.emoji}</div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-gray-200">{info.label}</span>
                  <span className={clsx('text-[10px] uppercase tracking-wide font-medium', sev.text)}>
                    {sev.label}
                  </span>
                </div>
                <p className="text-[11px] text-gray-400 mt-0.5">{rec.reason}</p>
                {rec.evidence?.length > 0 && (
                  <p className="text-[10px] text-gray-600 mt-1 font-mono">
                    {rec.evidence.join(' · ')}
                  </p>
                )}
              </div>
              {onApplyMode && (
                <button
                  type="button"
                  onClick={() => onApplyMode(rec.mode as SafeModeKey)}
                  className={clsx(
                    'text-[11px] px-2.5 py-1 rounded-md font-medium transition-colors',
                    'bg-surface-800 hover:bg-surface-700 text-gray-200',
                    'border border-surface-700 hover:border-surface-600',
                  )}
                >
                  {info.cta}
                </button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
