/**
 * LUFS/True Peak 게이지 컴포넌트
 */
import React from 'react'
import clsx from 'clsx'
import { formatLUFS, formatTruePeak, getLUFSColor, getTPColor } from '../../utils/formatters'

interface LoudnessMeterProps {
  label: string
  value: number
  target?: number
  min: number
  max: number
  unit: string
  warningThreshold?: number
  dangerThreshold?: number
}

function LoudnessMeter({ label, value, target, min, max, unit, warningThreshold, dangerThreshold }: LoudnessMeterProps) {
  const range = max - min
  const normalizedValue = Math.min(1, Math.max(0, (value - min) / range))
  const normalizedTarget = target != null ? Math.min(1, Math.max(0, (target - min) / range)) : null

  // 색상 결정
  let barColor = 'bg-green-500'
  if (warningThreshold != null && value > warningThreshold) barColor = 'bg-yellow-500'
  if (dangerThreshold != null && value > dangerThreshold) barColor = 'bg-red-500'

  return (
    <div className="space-y-1.5">
      <div className="flex justify-between text-xs text-gray-400">
        <span>{label}</span>
        <span className="font-mono text-gray-200">{value.toFixed(1)} {unit}</span>
      </div>
      <div className="relative h-3 bg-gray-800 rounded-full overflow-hidden">
        <div
          className={clsx('absolute left-0 h-full rounded-full transition-all duration-500', barColor)}
          style={{ width: `${normalizedValue * 100}%` }}
        />
        {/* 타깃 마커 */}
        {normalizedTarget != null && (
          <div
            className="absolute top-0 h-full w-0.5 bg-white/60"
            style={{ left: `${normalizedTarget * 100}%` }}
          />
        )}
      </div>
      <div className="flex justify-between text-xs text-gray-600">
        <span>{min} {unit}</span>
        {target != null && <span className="text-gray-500">타깃: {target}</span>}
        <span>{max} {unit}</span>
      </div>
    </div>
  )
}

interface LoudnessGaugeProps {
  lufsIntegrated: number
  truePeak: number
  lra?: number
  targetLUFS?: number
  targetTP?: number
  label?: string
}

export function LoudnessGauge({
  lufsIntegrated,
  truePeak,
  lra,
  targetLUFS = -14,
  targetTP = -1.0,
  label,
}: LoudnessGaugeProps) {
  const lufsOk = Math.abs(lufsIntegrated - targetLUFS) <= 1.0
  const tpOk = truePeak <= targetTP

  return (
    <div className="bg-surface-800 rounded-xl p-4 space-y-4">
      {label && (
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-gray-300">{label}</h3>
          <span className={clsx(
            'text-xs px-2 py-0.5 rounded-full',
            lufsOk && tpOk
              ? 'bg-green-900/40 text-green-400'
              : 'bg-yellow-900/40 text-yellow-400'
          )}>
            {lufsOk && tpOk ? '정상' : '조정 필요'}
          </span>
        </div>
      )}

      {/* LUFS 통합 수치 */}
      <div className="flex items-baseline gap-3">
        <span className={clsx('text-3xl font-bold font-mono', getLUFSColor(lufsIntegrated, targetLUFS))}>
          {lufsIntegrated.toFixed(1)}
        </span>
        <span className="text-gray-500 text-sm">LUFS Integrated</span>
      </div>

      {/* 게이지 바들 */}
      <div className="space-y-3">
        <LoudnessMeter
          label="Integrated LUFS"
          value={lufsIntegrated}
          target={targetLUFS}
          min={-30}
          max={0}
          unit="LUFS"
          warningThreshold={targetLUFS + 3}
          dangerThreshold={targetLUFS + 6}
        />
        <LoudnessMeter
          label="True Peak"
          value={truePeak}
          target={targetTP}
          min={-20}
          max={0}
          unit="dBTP"
          warningThreshold={targetTP - 0.5}
          dangerThreshold={targetTP}
        />
        {lra != null && (
          <LoudnessMeter
            label="Loudness Range (LRA)"
            value={lra}
            min={0}
            max={20}
            unit="LU"
          />
        )}
      </div>

      {/* 수치 요약 */}
      <div className="grid grid-cols-2 gap-2 pt-1">
        <div className="bg-surface-900/60 rounded-lg p-2.5 text-center">
          <div className={clsx('text-lg font-mono font-semibold', getLUFSColor(lufsIntegrated, targetLUFS))}>
            {lufsIntegrated.toFixed(1)}
          </div>
          <div className="text-xs text-gray-500 mt-0.5">LUFS Int.</div>
        </div>
        <div className="bg-surface-900/60 rounded-lg p-2.5 text-center">
          <div className={clsx('text-lg font-mono font-semibold', getTPColor(truePeak, targetTP))}>
            {truePeak.toFixed(1)}
          </div>
          <div className="text-xs text-gray-500 mt-0.5">True Peak</div>
        </div>
      </div>
    </div>
  )
}
