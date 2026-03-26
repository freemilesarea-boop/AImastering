import React, { useEffect } from 'react';
import { useAppStore } from './stores/appStore.js';
import { useLicenseStore } from './stores/licenseStore.js';
import LicenseModal from './components/LicenseModal.js';
import HomePage     from './pages/HomePage.js';
import AnalysisPage from './pages/AnalysisPage.js';
import MasteringPage from './pages/MasteringPage.js';
import ResultPage   from './pages/ResultPage.js';
import QCPage       from './pages/QCPage.js';
import SettingsPage from './pages/SettingsPage.js';
import { useAppStore as useAppStoreNotification } from './stores/appStore.js';

// ── Toast notification ────────────────────────────────────────────────────────

function Toast() {
  const notif = useAppStoreNotification((s) => s.notification);
  if (!notif) return null;

  const colors: Record<string, string> = {
    info:    'bg-zinc-800  border-zinc-700   text-zinc-200',
    success: 'bg-zinc-800  border-emerald-700/50 text-emerald-300',
    warning: 'bg-zinc-800  border-amber-700/50   text-amber-300',
    error:   'bg-zinc-800  border-red-700/50     text-red-300',
  };

  return (
    <div className={`fixed bottom-5 left-1/2 -translate-x-1/2 z-50
                     px-4 py-2.5 rounded-xl border shadow-xl
                     text-sm animate-in-fast whitespace-nowrap
                     ${colors[notif.type] ?? colors.info}`}>
      {notif.message}
    </div>
  );
}

// ── Preload 미노출 시 fallback UI ────────────────────────────────────────────
// Python / IPC 없어도 앱 제목·업로드 영역·스타일 선택·실행 버튼이 표시됩니다.

function NoApiUI() {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', height: '100vh',
      background: '#09090b', color: '#e4e4e7',
      fontFamily: 'ui-sans-serif, system-ui, sans-serif',
      gap: '1.5rem', padding: '2rem',
    }}>
      {/* 앱 제목 */}
      <p style={{ fontSize: '11px', letterSpacing: '0.18em', textTransform: 'uppercase', color: '#52525b' }}>
        AIMASTER
      </p>

      {/* 파일 업로드 영역 */}
      <div style={{
        width: '100%', maxWidth: '28rem', height: '180px',
        border: '2px dashed #3f3f46', borderRadius: '1rem',
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: '0.75rem',
      }}>
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none"
          stroke="#52525b" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 16V4M8 8l4-4 4 4" />
          <path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
        </svg>
        <span style={{ color: '#71717a', fontSize: '0.875rem' }}>오디오 파일 업로드</span>
        <span style={{ color: '#52525b', fontSize: '0.75rem' }}>WAV · FLAC · AIFF · MP3</span>
      </div>

      {/* 스타일 선택 UI */}
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        {['Balanced', 'Warm', 'Bright', 'Punch'].map((s) => (
          <div key={s} style={{
            padding: '0.4rem 0.9rem', background: '#18181b',
            border: '1px solid #3f3f46', borderRadius: '0.5rem',
            fontSize: '0.8rem', color: '#52525b',
          }}>
            {s}
          </div>
        ))}
      </div>

      {/* 실행 버튼 */}
      <button disabled style={{
        padding: '0.6rem 2rem', background: 'rgba(99,102,241,0.2)',
        color: '#818cf8', border: '1px solid rgba(99,102,241,0.3)',
        borderRadius: '0.5rem', fontSize: '0.875rem',
        fontWeight: 600, cursor: 'not-allowed',
      }}>
        마스터링 시작
      </button>

      {/* 경고 */}
      <div style={{
        background: 'rgba(120,53,15,0.2)', border: '1px solid rgba(180,83,9,0.4)',
        borderRadius: '0.75rem', padding: '0.75rem 1.25rem',
        maxWidth: '28rem', width: '100%', textAlign: 'center',
      }}>
        <p style={{ color: '#fbbf24', fontSize: '0.8rem', fontWeight: 600 }}>
          Electron preload 미노출 (window.electronAPI undefined)
        </p>
        <p style={{ color: '#92400e', fontSize: '0.72rem', marginTop: '0.3rem' }}>
          DevTools(Ctrl+Shift+I) → Console 탭에서 오류를 확인하세요.
        </p>
      </div>
    </div>
  );
}

// ── App ───────────────────────────────────────────────────────────────────────

export default function App() {
  // preload 가용성 확인 — 없으면 즉시 fallback UI
  const hasAPI = Boolean(window.electronAPI);

  useEffect(() => {
    console.log('[App] mounted. window.electronAPI available:', hasAPI);
    if (!hasAPI) {
      console.warn('[App] electronAPI is undefined. Preload did not run. Check: 1) dist/preload/index.js 존재 여부 2) CSP 3) sandbox 설정');
    }
  }, [hasAPI]);

  if (!hasAPI) return <NoApiUI />;

  return <AppInner />;
}

function AppInner() {
  const page = useAppStore((s) => s.currentPage);
  const load = useLicenseStore((s) => s.load);

  // Load license state once on startup
  useEffect(() => { void load(); }, [load]);

  const pages: Record<string, React.ReactNode> = {
    home:      <HomePage />,
    analysis:  <AnalysisPage />,
    mastering: <MasteringPage />,
    result:    <ResultPage />,
    qc:        <QCPage />,
    settings:  <SettingsPage />,
  };

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      {pages[page] ?? <HomePage />}

      {/* License modal — overlays any page */}
      <LicenseModal />

      {/* Toast notifications */}
      <Toast />
    </div>
  );
}
