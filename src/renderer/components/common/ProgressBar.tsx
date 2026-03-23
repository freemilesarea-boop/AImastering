/**
 * 진행률 바 컴포넌트
 */
import React from 'react'
import clsx from 'clsx'

interface ProgressBarProps {
  value: number          // 0-100
  label?: string
  stage?: string
  showPercent?: boolean
  className?: string
  color?: 'violet' | 'green' | 'blue'
}

const colorClasses = {
  violet: 'from-violet-600 to-violet-400',
  green:  'from-green-600 to-green-400',
  blue:   'from-blue-600 to-blue-400',
}

export function ProgressBar({
  value,
  label,
  stage,
  showPercent = true,
  className,
  color = 'violet',
}: ProgressBarProps) {
  const clamped = Math.min(100, Math.max(0, value))

  return (
    <div className={clsx('space-y-1.5', className)}>
      {(label || showPercent) && (
        <div className="flex justify-between items-center text-sm">
          {label && <span className="text-gray-400">{label}</span>}
          {showPercent && <span className="text-gray-300 font-mono">{clamped.toFixed(0)}%</span>}
        </div>
      )}
      <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
        <div
          className={clsx(
            'h-full bg-gradient-to-r rounded-full transition-all duration-300 ease-out',
            colorClasses[color]
          )}
          style={{ width: `${clamped}%` }}
        />
      </div>
      {stage && (
        <p className="text-xs text-gray-500 animate-pulse">{stage}</p>
      )}
    </div>
  )
}
