/**
 * 앱 루트 컴포넌트
 * 사이드바 레이아웃 + 페이지 라우팅
 */
import React, { useEffect } from 'react'
import clsx from 'clsx'
import { HomePage } from './pages/HomePage'
import { MasteringPage } from './pages/MasteringPage'
import { ResultPage } from './pages/ResultPage'
import { QCPage } from './pages/QCPage'
import { SettingsPage } from './pages/SettingsPage'
import { LicenseModal } from './components/license/LicenseModal'
import { Notification } from './components/common/Notification'
import { useAppStore } from './store/appStore'
import { useLicense } from './hooks/useLicense'
import { TIER_LABELS, TIER_COLORS } from './types/license'
import { useAudioStore } from './store/audioStore'

const NAV_ITEMS = [
  { id: 'home',      label: '마스터링', icon: HomeIcon },
  { id: 'qc',        label: 'QC 검사',  icon: QCIcon },
  { id: 'settings',  label: '설정',     icon: SettingsIcon },
] as const

type NavId = typeof NAV_ITEMS[number]['id']

export default function App() {
  const { currentPage, navigateTo, pythonReady, setPythonReady } = useAppStore()
  const { processingState, masteringResult } = useAudioStore()
  const { licenseInfo, setShowModal, isTrial, trialRemaining } = useLicense()

  // IPC navigate 이벤트 수신 (메뉴에서 호출)
  useEffect(() => {
    if (!window.electronAPI) return
    const cleanup = window.electronAPI.on('navigate', (path) => {
      const pageMap: Record<string, Parameters<typeof navigateTo>[0]> = {
        '/': 'home', '/settings': 'settings', '/qc': 'qc',
      }
      const target = pageMap[path as string]
      if (target) navigateTo(target)
    })
    return cleanup
  }, [navigateTo])

  // Python 브릿지 상태 확인 (개발 환경에서 true로 처리)
  useEffect(() => {
    // 실제로는 Python 브릿지 ready 이벤트를 수신
    // 개발/프로덕션 모두 1초 후 ready 처리 (브릿지가 main에서 시작됨)
    const timer = setTimeout(() => setPythonReady(true), 1500)
    return () => clearTimeout(timer)
  }, [setPythonReady])

  const currentNavId = (['home', 'mastering', 'result'].includes(currentPage)
    ? 'home'
    : currentPage) as NavId

  return (
    <div className="flex h-screen bg-surface-950 text-gray-100 overflow-hidden">
      {/* 사이드바 */}
      <aside className="w-[220px] flex-shrink-0 flex flex-col bg-surface-900 border-r border-gray-800">
        {/* 로고 */}
        <div className="px-5 py-5 border-b border-gray-800">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 bg-gradient-to-br from-violet-600 to-indigo-600 rounded-lg flex items-center justify-center">
              <svg className="w-4.5 h-4.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
              </svg>
            </div>
            <div>
              <div className="text-sm font-bold text-gray-100">AImastering</div>
              <div className="text-xs text-gray-600">v1.0.0</div>
            </div>
          </div>
        </div>

        {/* 네비게이션 */}
        <nav className="flex-1 px-3 py-4 space-y-1">
          {NAV_ITEMS.map(({ id, label, icon: Icon }) => {
            const isActive = currentNavId === id
            return (
              <button
                key={id}
                onClick={() => navigateTo(id === 'home' ? 'home' : id as Parameters<typeof navigateTo>[0])}
                className={clsx(
                  'w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-150',
                  isActive
                    ? 'bg-violet-600/20 text-violet-300 border border-violet-700/40'
                    : 'text-gray-400 hover:text-gray-200 hover:bg-white/5'
                )}
              >
                <Icon className={clsx('w-4.5 h-4.5', isActive ? 'text-violet-400' : '')} />
                {label}
              </button>
            )
          })}

          {/* 결과 페이지 링크 (마스터링 완료 시) */}
          {masteringResult && (
            <button
              onClick={() => navigateTo('result')}
              className={clsx(
                'w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-150',
                currentPage === 'result'
                  ? 'bg-green-600/20 text-green-300 border border-green-700/40'
                  : 'text-gray-400 hover:text-gray-200 hover:bg-white/5'
              )}
            >
              <svg className="w-4.5 h-4.5 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              결과 보기
            </button>
          )}
        </nav>

        {/* 하단: 라이센스 상태 */}
        <div className="px-3 py-4 border-t border-gray-800 space-y-2">
          {/* Python 엔진 상태 */}
          <div className="flex items-center gap-2 px-3 py-1.5">
            <div className={clsx(
              'w-1.5 h-1.5 rounded-full',
              pythonReady ? 'bg-green-400' : 'bg-yellow-400 animate-pulse'
            )} />
            <span className="text-xs text-gray-600">
              {pythonReady ? '엔진 준비 완료' : '엔진 로딩 중...'}
            </span>
          </div>

          {/* 라이센스 배지 */}
          <button
            onClick={() => setShowModal(true)}
            className="w-full flex items-center justify-between px-3 py-2 rounded-xl hover:bg-white/5 transition-colors group"
          >
            <div className="flex items-center gap-2">
              <svg className="w-4 h-4 text-gray-600 group-hover:text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
              </svg>
              <span className={clsx('text-xs font-medium', licenseInfo ? TIER_COLORS[licenseInfo.tier] : 'text-gray-500')}>
                {licenseInfo ? TIER_LABELS[licenseInfo.tier] : '...'}
              </span>
            </div>
            {isTrial && (
              <span className="text-xs bg-yellow-900/40 text-yellow-400 px-1.5 py-0.5 rounded">
                {trialRemaining}회
              </span>
            )}
          </button>
        </div>
      </aside>

      {/* 메인 콘텐츠 */}
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* macOS 트래픽 라이트 공간 */}
        {window.electronAPI?.platform === 'darwin' && (
          <div className="h-8 flex-shrink-0 [-webkit-app-region:drag]" />
        )}

        {/* 페이지 라우팅 */}
        <div className="flex-1 overflow-hidden flex flex-col">
          {currentPage === 'home'      && <HomePage />}
          {currentPage === 'mastering' && <MasteringPage />}
          {currentPage === 'result'    && <ResultPage />}
          {currentPage === 'qc'        && <QCPage />}
          {currentPage === 'settings'  && <SettingsPage />}
        </div>
      </main>

      {/* 전역 모달/알림 */}
      <LicenseModal />
      <Notification />
    </div>
  )
}

// ─────────────────────────────────────────
// 아이콘 컴포넌트
// ─────────────────────────────────────────
function HomeIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
        d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
    </svg>
  )
}

function QCIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
        d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
    </svg>
  )
}

function SettingsIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
        d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  )
}
