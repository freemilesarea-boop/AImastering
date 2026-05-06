/**
 * React 진입점
 */
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/index.css'

// ─────────────────────────────────────────
// 전역 Error Boundary: 렌더 오류 시 blank screen 대신 fallback UI 표시
// ─────────────────────────────────────────
interface ErrorBoundaryState {
  hasError: boolean
  error: Error | null
}

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary] Render error caught:', error.message)
    console.error('[ErrorBoundary] Component stack:', info.componentStack)
  }

  render() {
    if (this.state.hasError) {
      const msg = this.state.error?.message ?? '알 수 없는 오류'
      return (
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          justifyContent: 'center', height: '100vh',
          background: '#0a0a1a', color: '#e5e7eb',
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
          padding: '2rem',
        }}>
          {/* 헤더 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1.5rem' }}>
            <div style={{
              width: '2.5rem', height: '2.5rem', borderRadius: '0.5rem',
              background: 'linear-gradient(135deg, #7c3aed, #4f46e5)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="white" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round"
                  d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
              </svg>
            </div>
            <span style={{ fontSize: '1.125rem', fontWeight: 700 }}>AImastering</span>
          </div>

          {/* 에러 메시지 */}
          <p style={{ color: '#9ca3af', fontSize: '0.875rem', marginBottom: '0.75rem' }}>
            앱 초기화 중 오류가 발생했습니다.
          </p>
          <pre style={{
            background: '#1a1a2e', borderRadius: '0.5rem', padding: '0.75rem 1rem',
            fontSize: '0.75rem', color: '#f87171', maxWidth: '560px',
            width: '100%', overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
          }}>
            {msg}
          </pre>

          {/* DevTools 힌트 */}
          <p style={{ color: '#6b7280', fontSize: '0.75rem', marginTop: '0.75rem' }}>
            Ctrl+Shift+I (DevTools 콘솔)에서 상세 오류를 확인하세요.
          </p>

          {/* 재시작 버튼 */}
          <button
            onClick={() => window.location.reload()}
            style={{
              marginTop: '1.5rem', padding: '0.5rem 1.5rem',
              background: '#7c3aed', color: '#fff', border: 'none',
              borderRadius: '0.5rem', cursor: 'pointer', fontSize: '0.875rem',
              fontWeight: 500,
            }}
          >
            다시 시작
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

// ─────────────────────────────────────────
// 시작 진단 로그 (DevTools 콘솔에서 확인)
// ─────────────────────────────────────────
console.log('[AImastering] renderer starting...')
console.log('[AImastering] electronAPI:', (window as Window & { electronAPI?: unknown }).electronAPI ?? 'NOT EXPOSED (preload missing)')

// ─────────────────────────────────────────
// ErrorBoundary 동작 검증용 컴포넌트 (dev only)
// 개발 모드에서 콘솔에 에러를 던져 ErrorBoundary가 잡는지 확인
// ─────────────────────────────────────────
function DevErrorThrower({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) {
    throw new Error('[DevTest] ErrorBoundary test: this error is intentional')
  }
  return null
}

// ─────────────────────────────────────────
// 앱 마운트
// ─────────────────────────────────────────
const isDev = import.meta.env.DEV
// shouldThrow는 false로 유지 — true로 바꾸면 ErrorBoundary 동작 확인 가능
const _testErrorBoundary = false

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      {isDev && <DevErrorThrower shouldThrow={_testErrorBoundary} />}
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
