/**
 * 마스터링 프리셋 선택 컴포넌트
 */
import React from 'react'
import clsx from 'clsx'
import { MASTERING_PRESETS, MasteringPreset } from '../../types/audio'
import { useAudioStore } from '../../store/audioStore'

export function PresetSelector() {
  const { masteringOptions, updateMasteringOptions } = useAudioStore()
  const selectedId = masteringOptions.preset || 'youtube_music'

  const handleSelect = (preset: MasteringPreset) => {
    updateMasteringOptions({
      preset: preset.id,
      targetLUFS: preset.targetLUFS,
      targetTruePeak: preset.targetTruePeak,
      enableEQ: preset.enableEQ,
      enableCompression: preset.enableCompression,
      enableStereoEnhance: preset.enableStereoEnhance,
    })
  }

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium text-gray-300">마스터링 프리셋</h3>
      <div className="grid grid-cols-1 gap-2">
        {MASTERING_PRESETS.map((preset) => {
          const isSelected = selectedId === preset.id
          return (
            <button
              key={preset.id}
              onClick={() => handleSelect(preset)}
              className={clsx(
                'flex items-center justify-between p-3 rounded-xl border text-left transition-all duration-150',
                isSelected
                  ? 'border-violet-600 bg-violet-900/30 text-violet-200'
                  : 'border-gray-700 bg-surface-800 text-gray-300 hover:border-gray-600 hover:bg-surface-700'
              )}
            >
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{preset.name}</span>
                  {preset.id === 'youtube_music' && (
                    <span className="text-xs bg-violet-700/50 text-violet-300 px-1.5 py-0.5 rounded">기본값</span>
                  )}
                </div>
                <p className="text-xs text-gray-500 mt-0.5">{preset.description}</p>
              </div>
              <div className="text-right text-xs font-mono text-gray-400 flex-shrink-0 ml-3">
                <div>{preset.targetLUFS} LUFS</div>
                <div>{preset.targetTruePeak} dBTP</div>
              </div>
            </button>
          )
        })}
      </div>

      {/* 사용자 정의 설정 (Custom 선택 시) */}
      {selectedId === 'custom' && (
        <div className="bg-surface-800 rounded-xl p-4 space-y-3 border border-gray-700">
          <h4 className="text-xs font-medium text-gray-400 uppercase tracking-wide">사용자 정의 설정</h4>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">타깃 LUFS</label>
              <input
                type="number"
                value={masteringOptions.targetLUFS ?? -14}
                min={-30}
                max={-6}
                step={0.5}
                onChange={(e) => updateMasteringOptions({ targetLUFS: parseFloat(e.target.value) })}
                className="w-full bg-surface-900 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-200 focus:border-violet-500 focus:outline-none font-mono"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">True Peak 한계 (dBTP)</label>
              <input
                type="number"
                value={masteringOptions.targetTruePeak ?? -1.0}
                min={-6}
                max={0}
                step={0.1}
                onChange={(e) => updateMasteringOptions({ targetTruePeak: parseFloat(e.target.value) })}
                className="w-full bg-surface-900 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-200 focus:border-violet-500 focus:outline-none font-mono"
              />
            </div>
          </div>

          {/* 처리 옵션 토글 */}
          <div className="space-y-2">
            {[
              { key: 'enableEQ' as const, label: 'EQ 처리' },
              { key: 'enableCompression' as const, label: '컴프레션' },
              { key: 'enableStereoEnhance' as const, label: '스테레오 이미징' },
            ].map(({ key, label }) => (
              <label key={key} className="flex items-center gap-3 cursor-pointer group">
                <div className={clsx(
                  'relative w-9 h-5 rounded-full transition-colors duration-200',
                  masteringOptions[key] ? 'bg-violet-600' : 'bg-gray-700'
                )}>
                  <div className={clsx(
                    'absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform duration-200',
                    masteringOptions[key] ? 'left-4' : 'left-0.5'
                  )} />
                  <input
                    type="checkbox"
                    className="sr-only"
                    checked={!!masteringOptions[key]}
                    onChange={(e) => updateMasteringOptions({ [key]: e.target.checked })}
                  />
                </div>
                <span className="text-sm text-gray-300 group-hover:text-gray-200">{label}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
