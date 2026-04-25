/**
 * 마스터링 모드 카드 선택기 (v3)
 * 5개 메인 모드 + 2개 레거시 (legacy 는 고급 옵션 펼침 시 노출)
 */
import React from 'react'
import clsx from 'clsx'
import { MASTERING_MODES, MasteringMode } from '../../types/audio'
import { useAudioStore } from '../../store/audioStore'
import { useLicense } from '../../hooks/useLicense'

const MODE_VISUALS: Record<MasteringMode, {
  gradient: string
  border:   string
  glow:     string
  waveform: string[]
}> = {
  natural: {
    gradient: 'from-emerald-900/40 to-teal-900/40',
    border:   'border-emerald-700/50',
    glow:     'shadow-emerald-900/30',
    waveform: ['0.4','0.5','0.6','0.5','0.7','0.5','0.6','0.5','0.4','0.5'],
  },
  balanced: {
    gradient: 'from-violet-900/40 to-indigo-900/40',
    border:   'border-violet-700/50',
    glow:     'shadow-violet-900/30',
    waveform: ['0.4','0.6','0.8','0.7','0.9','0.7','0.8','0.6','0.5','0.7'],
  },
  bright: {
    gradient: 'from-cyan-900/40 to-blue-900/40',
    border:   'border-cyan-700/50',
    glow:     'shadow-cyan-900/30',
    waveform: ['0.3','0.5','0.7','0.9','1.0','0.9','0.8','0.9','0.7','0.6'],
  },
  loud: {
    gradient: 'from-orange-900/40 to-red-900/40',
    border:   'border-orange-700/50',
    glow:     'shadow-orange-900/30',
    waveform: ['0.9','1.0','0.95','1.0','0.95','1.0','0.95','1.0','0.9','1.0'],
  },
  kpop_loud: {
    gradient: 'from-pink-900/40 to-rose-900/40',
    border:   'border-pink-700/50',
    glow:     'shadow-pink-900/30',
    waveform: ['0.7','1.0','0.95','1.0','1.0','1.0','0.95','1.0','0.9','1.0'],
  },
  warm: {
    gradient: 'from-amber-900/40 to-orange-900/40',
    border:   'border-amber-700/50',
    glow:     'shadow-amber-900/30',
    waveform: ['0.5','0.7','0.9','0.8','0.7','0.8','0.9','0.7','0.6','0.5'],
  },
  punch: {
    gradient: 'from-red-900/40 to-rose-900/40',
    border:   'border-red-700/50',
    glow:     'shadow-red-900/30',
    waveform: ['0.8','1.0','0.9','1.0','0.9','1.0','0.9','0.8','0.7','0.6'],
  },
}

function MiniWaveform({ heights, active }: { heights: string[]; active: boolean }) {
  return (
    <div className="flex items-end gap-[2px] h-7">
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
  const { masteringOptions, showAdvanced, setMode, updateMasteringOptions } = useAudioStore()
  const { isPro } = useLicense()
  const selectedMode = (masteringOptions.mode || masteringOptions.style || 'balanced') as MasteringMode

  const handleSelect = (id: MasteringMode) => {
    const m = MASTERING_MODES.find(p => p.id === id)
    if (!m) return
    setMode(id)
    updateMasteringOptions({
      targetLUFS: m.targetLUFS,
      targetTruePeak: m.targetTP,
      limiterStrength: m.limiterStrength,
    })
  }

  const visibleModes = showAdvanced
    ? MASTERING_MODES
    : MASTERING_MODES.filter(m => !m.legacy)

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-gray-300">마스터링 모드</h3>
        <span className="text-xs text-gray-600">
          {isPro ? '모든 모드 사용 가능' : '무료 체험: Balanced 만 사용 가능'}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2.5">
        {visibleModes.map((mode) => {
          const isSelected = selectedMode === mode.id
          const isLocked   = !isPro && mode.id !== 'balanced'
          const visuals    = MODE_VISUALS[mode.id]

          return (
            <button
              key={mode.id}
              onClick={() => !isLocked && handleSelect(mode.id)}
              disabled={isLocked}
              className={clsx(
                'relative group flex flex-col p-3 rounded-xl border text-left transition-all duration-200 overflow-hidden',
                isSelected
                  ? `bg-gradient-to-br ${visuals.gradient} ${visuals.border} shadow-lg ${visuals.glow}`
                  : 'border-gray-800 bg-surface-800/60 hover:border-gray-700 hover:bg-surface-800',
                isLocked && 'opacity-50 cursor-not-allowed',
                mode.legacy && 'opacity-80'
              )}
            >
              {isSelected && (
                <div className="absolute top-2 right-2 w-4 h-4 bg-white/20 rounded-full flex items-center justify-center">
                  <div className="w-2 h-2 bg-white rounded-full" />
                </div>
              )}
              {isLocked && (
                <div className="absolute top-2 right-2 text-gray-600">
                  <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/>
                  </svg>
                </div>
              )}

              <div className="flex items-center gap-2 mb-1.5">
                <span className="text-lg leading-none">{mode.emoji}</span>
                <div>
                  <div className="flex items-center gap-1.5">
                    <span className={clsx(
                      'text-sm font-semibold',
                      isSelected ? 'text-white' : 'text-gray-200'
                    )}>
                      {mode.name}
                    </span>
                    {mode.legacy && (
                      <span className="text-[9px] uppercase bg-gray-800 text-gray-500 px-1 py-0.5 rounded">
                        legacy
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-gray-400 mt-0.5">{mode.description}</div>
                </div>
              </div>

              <MiniWaveform heights={visuals.waveform} active={isSelected} />

              <div className={clsx(
                'mt-1.5 text-[10px] font-mono',
                isSelected ? 'text-white/70' : 'text-gray-600'
              )}>
                {mode.targetLUFS} LUFS · {mode.targetTP} dBTP
              </div>

              <div className={clsx(
                'mt-1 text-xs leading-snug transition-all duration-200',
                isSelected
                  ? 'text-white/60 max-h-12'
                  : 'text-gray-600 max-h-0 overflow-hidden group-hover:max-h-12 group-hover:text-gray-500'
              )}>
                {mode.detail}
              </div>
            </button>
          )
        })}
      </div>

      {!isPro && (
        <p className="text-xs text-gray-600 text-center">
          🔒 Bright, Loud, KPOP Loud 등 추가 모드는{' '}
          <button className="text-violet-400 hover:text-violet-300 underline">
            Pro 플랜
          </button>
          에서 사용 가능합니다
        </p>
      )}
    </div>
  )
}
