/**
 * 상태 배지 컴포넌트
 */
import React from 'react'
import clsx from 'clsx'

type Status = 'success' | 'warning' | 'error' | 'info' | 'neutral'

interface StatusBadgeProps {
  status: Status
  label: string
  className?: string
}

const statusClasses: Record<Status, string> = {
  success: 'bg-green-900/40  text-green-400  border-green-800',
  warning: 'bg-yellow-900/40 text-yellow-400 border-yellow-800',
  error:   'bg-red-900/40    text-red-400    border-red-800',
  info:    'bg-blue-900/40   text-blue-400   border-blue-800',
  neutral: 'bg-gray-800      text-gray-400   border-gray-700',
}

const dotClasses: Record<Status, string> = {
  success: 'bg-green-400',
  warning: 'bg-yellow-400',
  error:   'bg-red-400',
  info:    'bg-blue-400',
  neutral: 'bg-gray-400',
}

export function StatusBadge({ status, label, className }: StatusBadgeProps) {
  return (
    <span className={clsx(
      'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border',
      statusClasses[status],
      className
    )}>
      <span className={clsx('w-1.5 h-1.5 rounded-full', dotClasses[status])} />
      {label}
    </span>
  )
}
