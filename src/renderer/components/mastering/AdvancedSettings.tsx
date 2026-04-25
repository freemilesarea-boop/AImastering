/**
 * 고급 마스터링 설정 패널 (v3)
 *
 * 노출 컨트롤:
 *   - Target LUFS (-16 ~ -7)
 *   - True Peak Ceiling (-2.0 ~ -0.3 dBTP)
 *   - Limiter Strength (Low/Medium/High)
 *   - Output Gain (-6 ~ +6 dB) [optional]
 *   - Stereo Width (0.8 ~ 1.5)  [optional]
 *   - Saturation Amount (0 ~ 1) [optional]
 *
 * 토글로 펼치고 접을 수 있고, 모드 선택 시 권장값으로 자동 갱신된다
 * (사용자가 직접 조정한 값은 그대로 유지).
 */
import React from 'react'
import clsx from 'clsx'
import { LimiterStrength, LIMITER_STRENGTH_LABELS } from '../../types/audio'
import { useAudioStore } from '../../store/audioStore'

interface SliderProps {
  label:        string
  value:        number
  min:          number
  max:          number
  step:         number
  unit?:        string
  hint?:        string
  onChange:     (v: number) => void
  /** 표시값 포맷 함수 (기본: toFixed(1)) */
  format?:      (v: number) => string
  monoTone?:    boolean
}

function Slider({ label, value, min, max, step, unit, hint, onChange, format, monoTone }: SliderProps) {
  const display = format ? format(value) : value.toFixed(step >= 1 ? 0 : 1)
  const pct = ((value - min) / (max - min)) * 100
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs">
        <span className="text-gray-400">{label}</span>
        <span className={clsx('font-mono', monoTone ? 'text-gray-300' : 'text-violet-300')}>
          {display}{unit ? ` ${unit}` : ''}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full appearance-none h-2 rounded-full bg-surface-900 cursor-pointer focus:outline-none"
        style={{
          background: `linear-gradient(to right, rgb(139 92 246 / 0.7) 0%, rgb(139 92 246 / 0.7) ${pct}%, rgb(31 41 55) ${pct}%, rgb(31 41 55) 100%)`,
        }}
      />
      {hint && <p className="text-[10px] text-gray-600">{hint}</p>}
    </div>
  )
}

function SegmentedButton<T extends string>({
  options,
  value,
  onChange,
  labels,
}: {
  options: T[]
  value: T
  onChange: (v: T) => void
  labels: Record<T, string>
}) {
  return (
    <div className="grid grid-cols-3 gap-1.5">
      {options.map(opt => (
        <button
          key={opt}
          onClick={() => onChange(opt)}
          className={clsx(
            'py-1.5 rounded-lg text-xs font-medium transition-all border',
            value === opt
              ? 'bg-violet-600 text-white border-violet-500'
              : 'bg-surface-900 text-gray-400 hover:text-gray-200 border-gray-700'
          )}
        >
          {labels[opt]}
        </button>
      ))}
    </div>
  )
}

export function AdvancedSettings() {
  const { showAdvanced, setShowAdvanced, masteringOptions, updateMasteringOptions } = useAudioStore()

  const targetLUFS    = masteringOptions.targetLUFS    ?? -14
  const targetTP      = masteringOptions.targetTruePeak ?? -1.0
  const limiterStr    = (masteringOptions.limiterStrength ?? 'medium') as LimiterStrength
  const outputGainDb  = masteringOptions.outputGainDb  ?? 0
  const stereoWidth   = masteringOptions.stereoWidth   ?? 1.0
  const saturation    = masteringOptions.saturationAmount ?? 0.2

  return (
    <div className="bg-surface-800 rounded-2xl border border-gray-800">
      <button
        onClick={() => setShowAdvanced(!showAdvanced)}
        className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium text-gray-300 hover:text-gray-100 transition-colors"
      >
        <span className="flex items-center gap-2">
          <svg className="w-4 h-4 text-violet-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
              d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
          고급 설정
        </span>
        <svg
          className={clsx('w-4 h-4 transition-transform', showAdvanced && 'rotate-180')}
          fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {showAdvanced && (
        <div className="px-4 pb-4 pt-1 space-y-4 border-t border-gray-800/60">
          {/* Target LUFS */}
          <Slider
            label="Target LUFS"
            value={targetLUFS}
            min={-16}
            max={-7}
            step={0.5}
            unit="LUFS"
            hint="-14 = YouTube/Spotify, -11 = streaming loud, -9 = KPOP, -8 = EDM"
            onChange={(v) => updateMasteringOptions({ targetLUFS: v, preset: undefined })}
          />

          {/* True Peak Ceiling */}
          <Slider
            label="True Peak Ceiling"
            value={targetTP}
            min={-2.0}
            max={-0.3}
            step={0.1}
            unit="dBTP"
            hint="대부분 플랫폼은 -1.0 dBTP 이하 권장"
            onChange={(v) => updateMasteringOptions({ targetTruePeak: v, preset: undefined })}
          />

          {/* Limiter Strength */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="text-gray-400">Limiter Strength</span>
              <span className="font-mono text-violet-300">{LIMITER_STRENGTH_LABELS[limiterStr]}</span>
            </div>
            <SegmentedButton<LimiterStrength>
              options={['low', 'medium', 'high']}
              value={limiterStr}
              labels={{
                low:    'Low',
                medium: 'Medium',
                high:   'High',
              }}
              onChange={(v) => updateMasteringOptions({ limiterStrength: v, preset: undefined })}
            />
            <p className="text-[10px] text-gray-600">
              High = 음압 강함 + 다이나믹 손상 가능 / Low = 부드럽고 자연스러움
            </p>
          </div>

          {/* Optional 그룹 */}
          <details className="bg-surface-900/40 rounded-lg border border-gray-800/60">
            <summary className="px-3 py-2 text-xs text-gray-500 cursor-pointer hover:text-gray-300 select-none">
              선택 옵션 (Output Gain · Stereo Width · Saturation)
            </summary>
            <div className="px-3 pb-3 pt-1 space-y-3.5">
              <Slider
                label="Output Gain"
                value={outputGainDb}
                min={-6}
                max={6}
                step={0.5}
                unit="dB"
                hint="최종 출력 게인 (limiter 입력 직전에 적용)"
                onChange={(v) => updateMasteringOptions({ outputGainDb: v })}
                monoTone
              />
              <Slider
                label="Stereo Width"
                value={stereoWidth}
                min={0.8}
                max={1.5}
                step={0.05}
                unit="x"
                hint="1.0 = 그대로 / >1 = 더 넓게 / <1 = 좁게"
                onChange={(v) => updateMasteringOptions({ stereoWidth: v })}
                format={(v) => v.toFixed(2)}
                monoTone
              />
              <Slider
                label="Saturation Amount"
                value={saturation}
                min={0}
                max={1}
                step={0.05}
                hint="고조파 saturation 강도 (0 = 무처리, 1 = 강함)"
                onChange={(v) => updateMasteringOptions({ saturationAmount: v })}
                format={(v) => v.toFixed(2)}
                monoTone
              />
            </div>
          </details>

          {/* 리셋 */}
          <button
            onClick={() => updateMasteringOptions({
              outputGainDb: 0,
              stereoWidth: undefined,
              saturationAmount: undefined,
            })}
            className="text-xs text-gray-500 hover:text-gray-300 underline"
          >
            선택 옵션 초기화
          </button>
        </div>
      )}
    </div>
  )
}
