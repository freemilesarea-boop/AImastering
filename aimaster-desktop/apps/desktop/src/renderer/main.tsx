import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.js';
import './styles/index.css';
// SAFE_BOOT: load flag helpers first so window.__SAFE_BOOT__ is available
// before any feature code reads them.
import './audio/safe-boot-flags.js';
// The natural-language assistant's route to the main process.  Installed
// here rather than lazily so `ask()` never has to decide whether it is
// running in Electron; outside Electron this returns null and the rule
// parser stays the whole feature.
import { ipcBridge, setAssistantBridge } from './daw/ai/nl-assistant.js';
setAssistantBridge(ipcBridge());
// Autosave: writes when editing pauses, so a crash costs the last few seconds
// rather than the last hour.  See daw/model/autosave.ts for when, and
// main/ipc/autosaveHandlers.ts for the atomic write.
import { autosaveDriver } from './daw/engine/autosave-driver.js';
import { useDawStore as _dawStoreForAutosave } from './stores/dawStore.js';
{
  const api = (window as Window & { electronAPI?: { invoke(c: string, ...a: unknown[]): Promise<unknown> } }).electronAPI;
  if (api) {
    autosaveDriver.start({
      session: () => _dawStoreForAutosave.getState().session,
      invoke: (channel, ...args) => api.invoke(channel, ...args),
    });
  }
}
// What this build can actually host, asked once rather than declared in two
// places that then disagree — see daw/engine/external-host.ts.
import { setHostCapabilities } from './daw/engine/external-host.js';
void (window as Window & { electronAPI?: { invoke(c: string): Promise<unknown> } })
  .electronAPI?.invoke('plugins:capabilities')
  .then((caps) => { if (caps && typeof caps === 'object') setHostCapabilities(caps as never); })
  .catch(() => { /* older main, or not Electron: the defaults are already "no" */ });

// ── 시작 진단 로그 ─────────────────────────────────────────────────────────────
// DevTools(Ctrl+Shift+I) 콘솔에서 이 로그로 preload 상태를 확인하세요.
// eslint-disable-next-line no-console
console.log('[AIMASTER] renderer starting...');
// eslint-disable-next-line no-console
console.log('[AIMASTER] window.electronAPI:', (window as Window & { electronAPI?: unknown }).electronAPI ?? 'NOT EXPOSED — preload missing or CSP blocked');

// ── 글로벌 에러 캐처 (검은 화면 디버깅용) ────────────────────────────────────
// React ErrorBoundary 가 못 잡는 async / effect / promise 에러를 콘솔에
// 강제로 노출.  검은 화면 + DevTools disconnect 같은 상황에서 원인 추적용.
window.addEventListener('error', (e) => {
  // eslint-disable-next-line no-console
  console.error('[AIMASTER:window-error]', e.message, e.error?.stack || '', 'at', e.filename + ':' + e.lineno);
});
window.addEventListener('unhandledrejection', (e) => {
  // eslint-disable-next-line no-console
  console.error('[AIMASTER:unhandled-rejection]', e.reason);
});

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
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary] render error:', error.message);
    // eslint-disable-next-line no-console
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
