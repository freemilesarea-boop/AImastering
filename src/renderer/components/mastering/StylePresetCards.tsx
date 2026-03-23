/**
 * 마스터링 스타일 프리셋 카드 선택기
 * 4가지 프리셋을 카드 UI로 표시, 시각적으로 차별화
 */
import React from 'react'
import clsx from 'clsx'
import { STYLE_PRESETS, MasteringStyle } from '../../types/audio'
import { useAudioStore } from '../../store/audioStore'
import { useLicense } from '../../hooks/useLicense'

// 스타일별 비주얼 설정
const STYLE_VISUALS: Record<MasteringStyle, {
  gradient: string
  border:   string
  glow:     string
  waveform: string[]  // 간이 파형 높이 비율 (시각적 표현)
}> = {
  balanced: {
    gradient: 'from-violet-900/40 to-indigo-900/40',
    border:   'border-violet-700/50',
    glow:     'shadow-violet-900/30',
    waveform: ['0.4','0.6','0.8','0.7','0.9','0.7','0.8','0.6','0.5','0.7'],
  },
  warm: {
    gradient: 'from-amber-900/40 to-orange-900/40',
    border:   'border-amber-700/50',
    glow:     'shadow-amber-900/30',
    waveform: ['0.5','0.7','0.9','0.8','0.7','0.8','0.9','0.7','0.6','0.5'],
  },
  bright: {
    gradient: 'from-cyan-900/40 to-blue-900/40',
    border:   'border-cyan-700/50',
    glow:     'shadow-cyan-900/30',
    waveform: ['0.3','0.5','0.7','0.9','1.0','0.9','0.8','0.9','0.7','0.6'],
  },
  punch: {
    gradient: 'from-red-900/40 to-rose-900/40',
    border:   'border-red-700/50',
    glow:     'shadow-red-900/30',
    waveform: ['0.8','1.0','0.9','1.0','0.9','1.0','0.9','0.8','0.7','0.6'],
  },
}

// 파형 시각화 컴포넌트
function MiniWaveform({ heights, active }: { heights: string[]; active: boolean }) {
  return (
    <div className="flex items-end gap-[2px] h-8">
      {heights.map((h, i) => (
        <div
          key={i}
          className={clsx(
            'w-1.5 rounded-full transition-all duration-300',
            active ? 'bg-white/60' : 'bg-white/20'
          )}
          style={{ height: `${parseFloat(h) * 100}%` }}
        />
      ))}
    </div>
  )
}

export function StylePresetCards() {
  const { masteringOptions, setStyle } = useAudioStore()
  const { isPro } = useLicense()
  const selectedStyle = (masteringOptions.style as MasteringStyle) || 'balanced'

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-gray-300">마스터링 스타일</h3>
        <span className="text-xs text-gray-600">
          {isPro ? '모든 스타일 사용 가능' : '무료 체험: Balanced만 사용 가능'}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2.5">
        {STYLE_PRESETS.map((preset) => {
          const isSelected = selectedStyle === preset.id
          const isLocked   = !isPro && preset.id !== 'balanced'
          const visuals    = STYLE_VISUALS[preset.id]

          return (
            <button
              key={preset.id}
              onClick={() => !isLocked && setStyle(preset.id)}
              disabled={isLocked}
              className={clsx(
                'relative group flex flex-col p-3.5 rounded-xl border text-left transition-all duration-200',
                'overflow-hidden',
                isSelected
                  ? `bg-gradient-to-br ${visuals.gradient} ${visuals.border} shadow-lg ${visuals.glow}`
                  : 'border-gray-800 bg-surface-800/60 hover:border-gray-700 hover:bg-surface-800',
                isLocked && 'opacity-50 cursor-not-allowed'
              )}
            >
              {/* 선택 표시 */}
              {isSelected && (
                <div className="absolute top-2.5 right-2.5 w-4 h-4 bg-white/20 rounded-full flex items-center justify-center">
                  <div className="w-2 h-2 bg-white rounded-full" />
                </div>
              )}

              {/* 잠금 표시 */}
              {isLocked && (
                <div className="absolute top-2.5 right-2.5 text-gray-600">
                  <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/>
                  </svg>
                </div>
              )}

              {/* 이모지 + 이름 */}
              <div className="flex items-center gap-2 mb-2">
                <span className="text-xl leading-none">{preset.emoji}</span>
                <div>
                  <div className={clsx(
                    'text-sm font-semibold',
                    isSelected ? 'text-white' : 'text-gray-200'
                  )}>
                    {preset.name}
                  </div>
                  <div className="text-xs text-gray-400 mt-0.5">{preset.description}</div>
                </div>
              </div>

              {/* 미니 파형 */}
              <MiniWaveform heights={visuals.waveform} active={isSelected} />

              {/* 상세 설명 (호버/선택 시) */}
              <div className={clsx(
                'mt-2 text-xs leading-relaxed transition-all duration-200',
                isSelected ? 'text-white/60 max-h-10' : 'text-gray-600 max-h-0 overflow-hidden group-hover:max-h-10 group-hover:text-gray-500'
              )}>
                {preset.detail}
              </div>
            </button>
          )
        })}
      </div>

      {/* 잠긴 프리셋 안내 */}
      {!isPro && (
        <p className="text-xs text-gray-600 text-center">
          🔒 Warm, Bright, Punch 스타일은{' '}
          <button className="text-violet-400 hover:text-violet-300 underline">
            Pro 플랜
          </button>
          에서 사용 가능합니다
        </p>
      )}
    </div>
  )
}
