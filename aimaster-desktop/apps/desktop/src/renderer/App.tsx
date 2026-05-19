import React, { useEffect, useRef, useState } from 'react';
import { useAppStore } from './stores/appStore.js';
// License gate disabled for the internal RC (v3.6.0-rc.1+1) — license
// store / modal imports removed.  See main/index.ts header.
import HomePage     from './pages/HomePage.js';
import AnalysisPage from './pages/AnalysisPage.js';
import MasteringPage from './pages/MasteringPage.js';
import ResultPage   from './pages/ResultPage.js';
import QCPage       from './pages/QCPage.js';
import SettingsPage from './pages/SettingsPage.js';
// Dev-only: analyzer streaming smoke route.  Mounted when URL contains
// `?dev=analyzer-stream`.  No production navigation entry.
import { DevAnalyzerStreamPage } from './pages/DevAnalyzerStreamPage.js';
import { useAppStore as useAppStoreNotification } from './stores/appStore.js';
import { useAudioStore, MAX_QUEUE_SIZE } from './stores/audioStore.js';
import { UpdateToast } from './components/UpdateToast.js';

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

// ── Global file drag overlay ──────────────────────────────────────────────────
// Electron issue: when dragging files from an external app (Finder/Explorer),
// the drag enters via the TopBar which has -webkit-app-region: drag.  That CSS
// property intercepts native drag events before they reach react-dropzone.
// Solution: listen at the document level and show a full-screen overlay
// (z-index > TopBar, -webkit-app-region: no-drag) that captures the drop.

const AUDIO_EXTENSIONS = new Set(['.wav', '.flac', '.aiff', '.aif', '.mp3', '.m4a']);

function isAudioDrag(dt: DataTransfer | null): boolean {
  if (!dt) return false;
  return Array.from(dt.types).includes('Files');
}

function GlobalDropOverlay() {
  const [active, setActive] = useState(false);
  const counter = useRef(0);
  const addFilesToQueue = useAudioStore((s) => s.addFilesToQueue);
  const setPage         = useAppStore((s) => s.setPage);

  useEffect(() => {
    const onEnter = (e: DragEvent) => {
      if (!isAudioDrag(e.dataTransfer)) return;
      counter.current += 1;
      setActive(true);
    };
    const onLeave = (e: DragEvent) => {
      if (!isAudioDrag(e.dataTransfer)) return;
      counter.current -= 1;
      if (counter.current <= 0) { counter.current = 0; setActive(false); }
    };
    const onDragOver = (e: DragEvent) => { if (isAudioDrag(e.dataTransfer)) e.preventDefault(); };
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      counter.current = 0;
      setActive(false);

      const files = Array.from(e.dataTransfer?.files ?? []);
      const paths = files
        .map((f) => (f as File & { path?: string }).path ?? '')
        .filter((p) => {
          if (!p) return false;
          const ext = p.slice(p.lastIndexOf('.')).toLowerCase();
          return AUDIO_EXTENSIONS.has(ext);
        })
        .slice(0, MAX_QUEUE_SIZE);

      if (paths.length) {
        addFilesToQueue(paths);
        setPage('home');
      }
    };

    document.addEventListener('dragenter', onEnter);
    document.addEventListener('dragleave', onLeave);
    document.addEventListener('dragover',  onDragOver);
    document.addEventListener('drop',      onDrop);
    return () => {
      document.removeEventListener('dragenter', onEnter);
      document.removeEventListener('dragleave', onLeave);
      document.removeEventListener('dragover',  onDragOver);
      document.removeEventListener('drop',      onDrop);
    };
  }, [addFilesToQueue, setPage]);

  if (!active) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-3
                 bg-zinc-900/90 backdrop-blur-sm pointer-events-none"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      <svg className="w-12 h-12 text-zinc-300" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
        <path d="M2 12h2M20 12h2M6 8v8M18 8v8M10 5v14M14 5v14" />
      </svg>
      <p className="text-base font-medium text-zinc-200">파일을 놓으세요</p>
      <p className="text-xs text-zinc-500">WAV · FLAC · AIFF · MP3 · M4A</p>
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
      console.warn('[App] electronAPI is undefined. Preload did not run. Check: 1) dist-electron/preload/index.js 존재 여부 2) CSP 3) sandbox 설정');
    }
  }, [hasAPI]);

  if (!hasAPI) return <NoApiUI />;

  return <AppInner />;
}

function AppInner() {
  const page = useAppStore((s) => s.currentPage);

  // Dev-only: route via URL query so the analyzer-stream smoke page can
  // be reached without touching the appStore page enum.  Production
  // navigation never lands here.
  const isDevRoute =
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('dev') === 'analyzer-stream';

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
      {isDevRoute ? <DevAnalyzerStreamPage /> : (pages[page] ?? <HomePage />)}

      {/* Creator watermark — fixed bottom-left */}
      <div className="fixed bottom-3 left-4 pointer-events-none select-none z-10">
        <span className="text-[10px] font-mono text-zinc-700 tracking-widest uppercase">
          루베르
        </span>
      </div>

      {/* License modal removed — license gate disabled for internal RC. */}

      {/* Toast notifications */}
      <Toast />

      {/* v3.4.3 — auto-update bottom-right card */}
      <UpdateToast />

      {/* Global drag overlay — captures drops from external apps (Finder/Explorer)
          even when TopBar has -webkit-app-region: drag */}
      <GlobalDropOverlay />
    </div>
  );
}
