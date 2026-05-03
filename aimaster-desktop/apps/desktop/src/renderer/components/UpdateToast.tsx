/**
 * Auto-update toast (v3.4.3).
 *
 * Bottom-right corner card.  Reflects every state from window.updater:
 *
 *   idle              → hidden
 *   checking          → "업데이트 확인 중…"  (shown briefly)
 *   not-available     → "최신 버전입니다"     (auto-dismiss after 3 s)
 *   available         → "새 버전 vX.Y.Z" + [지금 받기] / [나중에]
 *   download-progress → progress bar + "% (X MB/s)"
 *   downloaded        → "재시작하면 업데이트 적용" + [재시작] / [닫기]
 *   error             → "업데이트 실패: <msg>" (dismissible)
 *
 * UI is intentionally small and out of the way so it never blocks the
 * mastering workflow.  Users can dismiss every state and reopen via
 * a future "Check for updates…" menu item (window.updater.checkForUpdates()).
 */
import React, { useEffect, useState } from 'react';

const AUTO_DISMISS_MS = 4_000;

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

export function UpdateToast(): React.ReactElement | null {
  const [status, setStatus]     = useState<UpdaterStatus>({ type: 'idle' });
  const [dismissed, setDismissed] = useState(false);
  const [working, setWorking]   = useState(false);

  // Subscribe to updater events
  useEffect(() => {
    if (typeof window === 'undefined' || !window.updater) return;
    // Pull initial state in case the renderer mounted after a status was sent
    void window.updater.getStatus().then(s => {
      if (s) setStatus(s);
    }).catch(() => { /* dev build, ignore */ });
    const unsub = window.updater.onStatus(s => {
      setStatus(s);
      setDismissed(false);   // any new event re-shows the toast
    });
    return unsub;
  }, []);

  // Auto-dismiss "not-available" after a few seconds
  useEffect(() => {
    if (status.type !== 'not-available') return;
    const t = setTimeout(() => setDismissed(true), AUTO_DISMISS_MS);
    return () => clearTimeout(t);
  }, [status.type]);

  if (typeof window === 'undefined' || !window.updater) return null;
  if (status.type === 'idle') return null;
  if (dismissed) return null;
  // Hide checking after 1s if nothing else happened — avoids a stuck toast
  // when the user has perfect connectivity and the request returns instantly.
  if (status.type === 'checking') {
    // Render briefly; auto-dismiss handled inline
  }

  const handleDownload = async () => {
    setWorking(true);
    try { await window.updater.downloadUpdate(); }
    finally { setWorking(false); }
  };

  const handleInstall = async () => {
    setWorking(true);
    try { await window.updater.quitAndInstall(); }
    finally { setWorking(false); }
  };

  // ── Render per state ─────────────────────────────────────────────────────
  let body: React.ReactNode;
  let tone: 'info' | 'success' | 'progress' | 'error' = 'info';

  if (status.type === 'checking') {
    body = (
      <div className="flex items-center gap-2">
        <Spinner /> <span>업데이트 확인 중…</span>
      </div>
    );
  } else if (status.type === 'not-available') {
    tone = 'success';
    body = <span>최신 버전입니다 (v{status.info?.version})</span>;
  } else if (status.type === 'available') {
    body = (
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <span className="text-base">⬆️</span>
          <span className="font-medium">새 버전 v{status.info.version}</span>
        </div>
        <p className="text-[11px] text-zinc-400">새 버전이 있습니다. 지금 받으시겠어요?</p>
        <div className="flex gap-1.5">
          <button onClick={handleDownload} disabled={working}
                  className="flex-1 text-[11px] px-2 py-1 rounded bg-emerald-700/40 hover:bg-emerald-700/60
                             text-emerald-200 border border-emerald-700/50 disabled:opacity-50">
            {working ? '시작 중…' : '지금 받기'}
          </button>
          <button onClick={() => setDismissed(true)}
                  className="text-[11px] px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300">
            나중에
          </button>
        </div>
      </div>
    );
  } else if (status.type === 'download-progress') {
    tone = 'progress';
    const pct = Math.max(0, Math.min(100, status.progress.percent));
    body = (
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-zinc-300">다운로드 중</span>
          <span className="text-[11px] font-mono text-zinc-400">{pct.toFixed(0)}%</span>
        </div>
        <div className="h-1.5 bg-zinc-800 rounded overflow-hidden">
          <div className="h-full bg-emerald-500 transition-all"
               style={{ width: `${pct}%` }} />
        </div>
        <div className="flex justify-between text-[10px] text-zinc-500 font-mono">
          <span>{fmtSize(status.progress.transferred)} / {fmtSize(status.progress.total)}</span>
          <span>{fmtSize(status.progress.bytesPerSecond)}/s</span>
        </div>
      </div>
    );
  } else if (status.type === 'downloaded') {
    tone = 'success';
    body = (
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <span className="text-base">✅</span>
          <span className="font-medium">v{status.info.version} 준비 완료</span>
        </div>
        <p className="text-[11px] text-zinc-400">재시작하면 업데이트가 적용됩니다.</p>
        <div className="flex gap-1.5">
          <button onClick={handleInstall} disabled={working}
                  className="flex-1 text-[11px] px-2 py-1 rounded bg-emerald-700/40 hover:bg-emerald-700/60
                             text-emerald-200 border border-emerald-700/50 disabled:opacity-50">
            {working ? '재시작 중…' : '지금 재시작'}
          </button>
          <button onClick={() => setDismissed(true)}
                  className="text-[11px] px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300">
            닫기
          </button>
        </div>
      </div>
    );
  } else if (status.type === 'error') {
    tone = 'error';
    body = (
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <span className="text-base">⚠️</span>
          <span className="font-medium">업데이트 실패</span>
        </div>
        <p className="text-[11px] text-zinc-400 break-all">{status.message}</p>
        <button onClick={() => setDismissed(true)}
                className="text-[11px] px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300">
          닫기
        </button>
      </div>
    );
  } else {
    return null;
  }

  const toneStyle = {
    info:     'border-zinc-700  bg-zinc-900/95',
    success:  'border-emerald-700/50 bg-zinc-900/95',
    progress: 'border-emerald-700/50 bg-zinc-900/95',
    error:    'border-red-700/50  bg-zinc-900/95',
  }[tone];

  return (
    <div className={`fixed bottom-5 right-5 z-50 w-72 p-3 rounded-xl border shadow-xl
                     text-sm text-zinc-100 ${toneStyle}`}>
      {body}
    </div>
  );
}

function Spinner(): React.ReactElement {
  return (
    <svg className="animate-spin h-3 w-3 text-zinc-300" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.25" />
      <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
