/**
 * AI 음원 특화 감지 결과 알림 컴포넌트
 * 분석 후 감지된 AI 아티팩트를 사용자 친화적으로 표시
 */
import React, { useState } from 'react'
import clsx from 'clsx'
import { AIDetectionResult } from '../../types/audio'

interface Alert {
  key:         string
  title:       string
  description: string
  severity:    'warning' | 'info'
  autoFix:     boolean    // 마스터링 시 자동 보정 여부
  suggestion:  string     // 추천 프리셋 또는 대응 방법
}

function buildAlerts(ai: AIDetectionResult): Alert[] {
  const alerts: Alert[] = []

  if (ai.harshHighmid) {
    alerts.push({
      key: 'harsh_highmid',
      title: '고역 자극 감지 (3~5kHz)',
      description: `AI 음원에서 자주 나타나는 금속성·날카로운 고역대 에너지 과잉 (${(ai.harshHighmidRatio * 100).toFixed(0)}%)`,
      severity: 'warning',
      autoFix: true,
      suggestion: 'Warm 스타일이 자동으로 보정합니다.',
    })
  }

  if (ai.boomyLow) {
    alerts.push({
      key: 'boomy_low',
      title: '저역 과잉 감지 (60~200Hz)',
      description: `저역 에너지가 과도합니다 (${(ai.boomyLowRatio * 100).toFixed(0)}%). 스피커/헤드폰에서 뭉치는 소리가 날 수 있습니다.`,
      severity: 'warning',
      autoFix: true,
      suggestion: 'Punch 또는 Balanced 스타일이 저역을 정리합니다.',
    })
  }

  if (ai.brickwall) {
    alerts.push({
      key: 'brickwall',
      title: '과도한 압축 의심 (Brickwall)',
      description: `다이나믹 레인지가 매우 좁습니다 (LRA ${ai.lra.toFixed(1)} LU). AI 생성 툴의 내부 압축이 과도할 수 있습니다.`,
      severity: 'warning',
      autoFix: false,
      suggestion: '원본 파일의 마스터링 설정을 확인하세요. Balanced 스타일 권장.',
    })
  }

  if (ai.stereoImbalance) {
    alerts.push({
      key: 'stereo_imbalance',
      title: '스테레오 불균형',
      description: `좌/우 채널 에너지 차이: ${ai.stereoImbalanceDb.toFixed(1)} dB. 이어폰/헤드폰에서 한쪽으로 치우쳐 들릴 수 있습니다.`,
      severity: 'warning',
      autoFix: false,
      suggestion: '원본 파일을 확인하거나 DAW에서 스테레오 밸런스를 조정하세요.',
    })
  }

  return alerts
}

interface AIDetectionAlertProps {
  aiDetection:     AIDetectionResult
  compact?:        boolean
}

export function AIDetectionAlert({ aiDetection, compact = false }: AIDetectionAlertProps) {
  const [expanded, setExpanded] = useState(!compact)
  const alerts = buildAlerts(aiDetection)

  if (alerts.length === 0) {
    return (
      <div className="flex items-center gap-2 px-3 py-2.5 bg-green-900/20 border border-green-800/40 rounded-xl">
        <svg className="w-4 h-4 text-green-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <span className="text-sm text-green-300">AI 음원 특화 문제 감지되지 않음</span>
      </div>
    )
  }

  const autoFixable = alerts.filter(a => a.autoFix).length

  return (
    <div className="space-y-2">
      {/* 헤더 */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-3 py-2.5 bg-yellow-900/20 border border-yellow-800/40 rounded-xl hover:bg-yellow-900/30 transition-colors"
      >
        <div className="flex items-center gap-2">
          <svg className="w-4 h-4 text-yellow-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span className="text-sm text-yellow-300 font-medium">
            AI 음원 특성 {alerts.length}건 감지
          </span>
          {autoFixable > 0 && (
            <span className="text-xs bg-violet-900/50 text-violet-300 px-1.5 py-0.5 rounded">
              {autoFixable}건 자동 보정 가능
            </span>
          )}
        </div>
        <svg
          className={clsx('w-4 h-4 text-gray-400 transition-transform', expanded && 'rotate-180')}
          fill="none" viewBox="0 0 24 24" stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* 상세 알림 목록 */}
      {expanded && (
        <div className="space-y-2 pl-1">
          {alerts.map((alert) => (
            <div
              key={alert.key}
              className={clsx(
                'px-3 py-3 rounded-xl border',
                alert.severity === 'warning'
                  ? 'bg-yellow-900/10 border-yellow-900/40'
                  : 'bg-blue-900/10 border-blue-900/40'
              )}
            >
              <div className="flex items-start gap-2.5">
                <div className={clsx(
                  'mt-0.5 w-4 h-4 rounded-full flex items-center justify-center flex-shrink-0 text-xs font-bold',
                  alert.severity === 'warning' ? 'bg-yellow-500/20 text-yellow-400' : 'bg-blue-500/20 text-blue-400'
                )}>
                  !
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-gray-200">{alert.title}</span>
                    {alert.autoFix && (
                      <span className="text-xs bg-green-900/40 text-green-400 px-1.5 py-0.5 rounded">
                        자동 보정
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-gray-400 mt-0.5 leading-relaxed">{alert.description}</p>
                  <p className="text-xs text-violet-400 mt-1">→ {alert.suggestion}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
