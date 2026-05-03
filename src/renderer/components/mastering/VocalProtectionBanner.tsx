/**
 * Vocal Protection banner (v3.3.1).
 *
 * 보컬 보호 모드는 엔진 기본 활성 — 모드 무관하게 보컬 명료도가 loudness
 * 보다 우선합니다.  배너는 다음 정보를 시각화합니다:
 *
 *   1. 항상 표시되는 정상 안내 (음이 자동 보호되었음)
 *   2. 추가 clamp 적용 시 "보컬 보호 모드 적용됨" + clamp 목록
 *   3. 보컬 손실 감지 시 자동 fallback 안내 + 재마스터링 권장
 */
import React, { useState } from 'react'
import clsx from 'clsx'
import type { VocalProtectionReport } from '../../types/audio'

const SEVERITY_STYLE = {
  ok:     { ring: 'border-emerald-800/40', bg: 'bg-emerald-900/15', text: 'text-emerald-300', label: '정상' },
  warn:   { ring: 'border-yellow-800/40',  bg: 'bg-yellow-900/15',  text: 'text-yellow-300',  label: '주의' },
  danger: { ring: 'border-red-800/40',     bg: 'bg-red-900/15',     text: 'text-red-300',     label: '위험' },
}

interface Props {
  report: VocalProtectionReport | undefined | null
}

export function VocalProtectionBanner({ report }: Props) {
  const [expanded, setExpanded] = useState(false)
  if (!report || !report.enabled) return null

  // Choose severity by vocal-loss verdict; otherwise show the "active clamp" tone.
  const sev = report.vocalLossSeverity !== 'ok'
    ? SEVERITY_STYLE[report.vocalLossSeverity]
    : report.active ? SEVERITY_STYLE.warn : SEVERITY_STYLE.ok

  return (
    <div className={clsx('rounded-2xl border p-4', sev.bg, sev.ring)}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5 min-w-0">
          <div className={clsx('w-7 h-7 rounded-lg flex items-center justify-center shrink-0', sev.bg)}>
            <span className="text-base">🎤</span>
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-gray-100">보컬 보호 모드</h3>
              <span className={clsx('text-[10px] uppercase tracking-wide font-medium', sev.text)}>
                {sev.label}
              </span>
              {report.active && (
                <span className={clsx('text-[10px] px-1.5 py-0.5 rounded', sev.bg, sev.text)}>
                  적용됨
                </span>
              )}
            </div>
            <p className="text-[11px] text-gray-400 mt-1">{report.userMessage}</p>
            {report.autoFallbackTriggered && (
              <p className="text-[11px] text-yellow-300 mt-1.5 font-medium">
                💡 Vocal Safe Mode + Low Limiting Mode 로 재마스터링을 권장합니다.
              </p>
            )}
          </div>
        </div>
        {report.appliedClamps.length > 0 && (
          <button
            type="button"
            onClick={() => setExpanded(v => !v)}
            className="text-[11px] text-gray-400 hover:text-gray-200 shrink-0"
          >
            {expanded ? '숨기기' : `상세 (${report.appliedClamps.length})`}
          </button>
        )}
      </div>

      {expanded && (
        <div className="mt-3 space-y-1 border-t border-surface-700 pt-3">
          {report.appliedClamps.map((c, i) => (
            <div key={i} className="text-[11px] flex items-start gap-2 bg-surface-900/40 rounded p-2">
              <code className="text-gray-300 shrink-0">{c.where}</code>
              <span className="text-gray-500">
                {String(c.original)} → <span className="text-gray-300">{String(c.clamped)}</span>
              </span>
              <span className="text-gray-500 ml-auto truncate">{c.reason}</span>
            </div>
          ))}
          <div className="text-[10px] text-gray-600 mt-2">
            보호 한도:
            {' ratio ≤ '}{report.config.maxRatio},
            {' attack ≥ '}{report.config.minAttackMs}{' ms,'}
            {' makeup ≤ '}{report.config.maxMakeupDb}{' dB,'}
            {' entry gain ≤ +'}{report.config.maxEntryGainDb}{' dB,'}
            {' limiter level_in ≤ +'}{report.config.maxLimiterInputGainDb}{' dB.'}
          </div>
        </div>
      )}
    </div>
  )
}
