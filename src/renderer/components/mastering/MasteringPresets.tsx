/**
 * 빠른 프리셋 바 (v3)
 * YouTube Safe / Streaming Loud / KPOP Loud / EDM Loud
 *
 * 클릭 시 mode + LUFS + TP + Limiter 강도를 한 번에 적용한다.
 */
import React from 'react'
import clsx from 'clsx'
import { MASTERING_PRESETS, MasteringQuickPreset, MasteringMode } from '../../types/audio'
import { useAudioStore } from '../../store/audioStore'

export function MasteringPresets() {
  const { masteringOptions, updateMasteringOptions } = useAudioStore()
  const currentLufs = masteringOptions.targetLUFS
  const currentTp   = masteringOptions.targetTruePeak
  const currentMode = (masteringOptions.mode || masteringOptions.style) as MasteringMode | undefined

  const apply = (p: MasteringQuickPreset) => {
    updateMasteringOptions({
      mode:            p.mode,
      style:           p.mode,
      targetLUFS:      p.targetLUFS,
      targetTruePeak:  p.targetTP,
      limiterStrength: p.limiterStrength,
      preset:          p.id,
    })
  }

  const isActive = (p: MasteringQuickPreset) =>
    masteringOptions.preset === p.id ||
    (currentMode === p.mode &&
      Math.abs((currentLufs ?? 0) - p.targetLUFS) < 0.05 &&
      Math.abs((currentTp ?? 0) - p.targetTP) < 0.05)

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-gray-300">빠른 프리셋</h3>
        <span className="text-xs text-gray-600">한 번에 모드·LUFS·TP·리미터 적용</span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {MASTERING_PRESETS.map(p => {
          const active = isActive(p)
          return (
            <button
              key={p.id}
              onClick={() => apply(p)}
              className={clsx(
                'flex flex-col items-start gap-0.5 p-2.5 rounded-xl border text-left transition-all duration-150',
                active
                  ? 'border-violet-500/70 bg-violet-900/30 text-violet-100 shadow-md shadow-violet-900/30'
                  : 'border-gray-800 bg-surface-800/60 text-gray-300 hover:border-gray-700 hover:bg-surface-800'
              )}
            >
              <div className="flex items-center gap-1.5">
                <span className="text-base leading-none">{p.emoji}</span>
                <span className="text-sm font-semibold">{p.name}</span>
              </div>
              <span className="text-[10px] font-mono text-gray-500">{p.description}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
