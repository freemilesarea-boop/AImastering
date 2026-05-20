import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.js';
import './styles/index.css';

// ── 시작 진단 로그 ─────────────────────────────────────────────────────────────
// DevTools(Ctrl+Shift+I) 콘솔에서 이 로그로 preload 상태를 확인하세요.
console.log('[AIMASTER] renderer starting...');
console.log('[AIMASTER] window.electronAPI:', (window as Window & { electronAPI?: unknown }).electronAPI ?? 'NOT EXPOSED — preload missing or CSP blocked');

// ── ErrorBoundary ──────────────────────────────────────────────────────────────
// 렌더 타임 에러를 잡아 blank screen 대신 fallback UI를 표시합니다.

interface EBState { hasError: boolean; error: Error | null }

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, EBState> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): EBState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary] render error:', error.message);
    console.error('[ErrorBoundary] component stack:', info.componentStack);
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    const msg = this.state.error?.message ?? '알 수 없는 오류';
    return (
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', height: '100vh',
        background: '#13131A', color: '#e4e4e7',
        fontFamily: 'ui-monospace, "SF Mono", monospace',
        padding: '2rem', gap: '1rem',
      }}>
        {/* 헤더 */}
        <p style={{ fontSize: '11px', letterSpacing: '0.18em', textTransform: 'uppercase', color: '#52525b' }}>
          AIMASTER
        </p>
        <p style={{ fontSize: '0.875rem', color: '#a1a1aa' }}>
          앱 초기화 중 렌더 오류가 발생했습니다.
        </p>

        {/* 에러 메시지 */}
        <pre style={{
          background: '#18181b', borderRadius: '0.5rem',
          padding: '0.75rem 1rem', fontSize: '0.75rem',
          color: '#f87171', maxWidth: '560px', width: '100%',
          overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
          border: '1px solid #3f3f46',
        }}>
          {msg}
        </pre>

        <p style={{ fontSize: '0.7rem', color: '#52525b' }}>
          Ctrl+Shift+I → Console 탭에서 상세 오류를 확인하세요.
        </p>

        {/* 재시작 */}
        <button
          onClick={() => window.location.reload()}
          style={{
            padding: '0.4rem 1.2rem', background: '#3f3f46', color: '#e4e4e7',
            border: '1px solid #52525b', borderRadius: '0.5rem',
            cursor: 'pointer', fontSize: '0.8rem',
          }}
        >
          다시 시작
        </button>
      </div>
    );
  }
}

// ── ErrorBoundary 동작 검증용 (dev only) ─────────────────────────────────────
// _testErrorBoundary = true 로 바꾸면 ErrorBoundary가 에러를 잡는지 확인 가능
function DevErrorThrower({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) throw new Error('[DevTest] ErrorBoundary 동작 확인용 에러');
  return null;
}
const _testErrorBoundary = false;
const isDev = import.meta.env.DEV;

// ── React 마운트 ───────────────────────────────────────────────────────────────
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      {isDev && <DevErrorThrower shouldThrow={_testErrorBoundary} />}
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
