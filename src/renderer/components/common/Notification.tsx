/**
 * 전역 알림 토스트 컴포넌트
 */
import React from 'react'
import clsx from 'clsx'
import { useAppStore } from '../../store/appStore'

const typeConfig = {
  success: { bg: 'bg-green-900/90 border-green-700',  icon: '✓', text: 'text-green-300' },
  error:   { bg: 'bg-red-900/90   border-red-700',    icon: '✕', text: 'text-red-300'   },
  warning: { bg: 'bg-yellow-900/90 border-yellow-700', icon: '!', text: 'text-yellow-300' },
  info:    { bg: 'bg-blue-900/90  border-blue-700',   icon: 'i', text: 'text-blue-300'  },
}

export function Notification() {
  const { notification, clearNotification } = useAppStore()

  if (!notification) return null

  const config = typeConfig[notification.type]

  return (
    <div className="fixed bottom-6 right-6 z-50 animate-in slide-in-from-right-4 duration-300">
      <div className={clsx(
        'flex items-center gap-3 px-4 py-3 rounded-xl border shadow-2xl',
        'max-w-sm backdrop-blur-sm',
        config.bg
      )}>
        <span className={clsx('flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold', config.text, 'bg-white/10')}>
          {config.icon}
        </span>
        <p className={clsx('text-sm', config.text)}>{notification.message}</p>
        <button
          onClick={clearNotification}
          className="flex-shrink-0 text-gray-400 hover:text-gray-200 ml-1"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  )
}
