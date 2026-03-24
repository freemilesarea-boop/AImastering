/**
 * ResultPage — displays mastering output after processing completes.
 *
 * Free-tier UX:
 *   - WAV save is unavailable: shown with a lock icon + one-line explanation
 *   - MP3 preview is always available and downloadable
 *   - One subtle upgrade prompt (no repetition, no modal auto-open)
 *
 * The page reads from audioStore (to be wired when the store is finalized).
 * Until then, licenseInfo drives the locked/unlocked display.
 */
import React, { useCallback } from 'react';
import { useLicenseStore, selectRemainingTrials } from '../stores/licenseStore.js';
import { useAppStore } from '../stores/appStore.js';

// ── Icon helpers (inline SVG, no external dependency) ─────────────────────────

function LockIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 16 16" fill="none"
         stroke="currentColor" strokeWidth={1.75} strokeLinecap="round">
      <rect x="3" y="7" width="10" height="8" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 16 16" fill="none"
         stroke="currentColor" strokeWidth={1.75} strokeLinecap="round">
      <path d="M8 2v8M5 7l3 3 3-3" />
      <path d="M2 12h12" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 16 16" fill="none"
         stroke="currentColor" strokeWidth={1.75} strokeLinecap="round">
      <path d="M3 8l3.5 3.5L13 4" />
    </svg>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

interface FileRowProps {
  label: string;
  sublabel?: string;
  locked?: boolean;
  onAction?: () => void;
  actionLabel?: string;
}

function FileRow({ label, sublabel, locked, onAction, actionLabel = '저장' }: FileRowProps) {
  return (
    <div className={`flex items-center justify-between p-3 rounded-lg border
      ${locked
        ? 'border-zinc-700/50 bg-zinc-800/40 opacity-60'
        : 'border-zinc-700 bg-zinc-800/70'
      }`}
    >
      <div className="flex items-center gap-2.5 min-w-0">
        {locked
          ? <span className="text-zinc-500 shrink-0"><LockIcon /></span>
          : <span className="text-emerald-400 shrink-0"><CheckIcon /></span>
        }
        <div className="min-w-0">
          <p className={`text-sm font-medium truncate ${locked ? 'text-zinc-500' : 'text-zinc-200'}`}>
            {label}
          </p>
          {sublabel && (
            <p className="text-xs text-zinc-600 truncate">{sublabel}</p>
          )}
        </div>
      </div>

      {!locked && onAction && (
        <button
          onClick={onAction}
          className="ml-3 shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-md
                     text-xs font-medium bg-zinc-700 hover:bg-zinc-600 text-zinc-200
                     transition-colors"
        >
          <DownloadIcon />
          {actionLabel}
        </button>
      )}
    </div>
  );
}

// ── ResultPage ────────────────────────────────────────────────────────────────

export default function ResultPage() {
  const licenseInfo   = useLicenseStore((s) => s.licenseInfo);
  const setShowModal  = useLicenseStore((s) => s.setShowModal);
  const setPage       = useAppStore((s) => s.setPage);
  const remaining     = useLicenseStore(selectRemainingTrials);

  const isPro         = licenseInfo?.tier === 'pro';
  const wavLocked     = !isPro;

  const handleSaveWav  = useCallback(() => {
    // Wire to file:save-dialog IPC when audioStore has outputPath
    window.electronAPI.invoke('file:save-dialog');
  }, []);

  const handleSaveMp3  = useCallback(() => {
    window.electronAPI.invoke('file:save-dialog');
  }, []);

  const handleOpenLicense = useCallback(() => {
    setShowModal(true);
  }, [setShowModal]);

  return (
    <div className="flex-1 flex flex-col items-center justify-center px-6 py-8">
      <div className="w-full max-w-md space-y-3">

        {/* ── Title ──────────────────────────────────────────────────── */}
        <div className="mb-5">
          <h1 className="text-base font-semibold text-zinc-100">마스터링 완료</h1>
          <p className="text-sm text-zinc-500 mt-0.5">
            결과 파일을 확인하고 저장하세요.
          </p>
        </div>

        {/* ── MP3 preview (always available) ────────────────────────── */}
        <FileRow
          label="프리뷰 MP3 (320 kbps)"
          sublabel="무료 및 유료 모두 저장 가능"
          onAction={handleSaveMp3}
          actionLabel="저장"
        />

        {/* ── Master WAV (locked for free tier) ──────────────────────── */}
        <FileRow
          label="마스터 WAV (24-bit)"
          sublabel={wavLocked ? '유료 플랜에서 저장 가능' : undefined}
          locked={wavLocked}
          onAction={wavLocked ? undefined : handleSaveWav}
          actionLabel="저장"
        />

        {/* ── Free-tier upgrade notice (one line, not pushy) ───────────── */}
        {wavLocked && (
          <div className="flex items-center justify-between pt-1 pb-0.5
                          border-t border-zinc-800">
            <p className="text-xs text-zinc-600">
              {remaining === 0
                ? 'WAV 저장 및 무제한 처리는 유료 플랜을 이용해주세요.'
                : `무료 체험 ${remaining === Infinity ? '—' : remaining}회 남음 · WAV 저장은 유료 플랜에서 지원합니다.`
              }
            </p>
            <button
              onClick={handleOpenLicense}
              className="ml-3 shrink-0 text-xs text-zinc-400 hover:text-zinc-200
                         underline underline-offset-2 transition-colors whitespace-nowrap"
            >
              키 입력
            </button>
          </div>
        )}

        {/* ── Back button ────────────────────────────────────────────── */}
        <div className="pt-3">
          <button
            onClick={() => setPage('home')}
            className="w-full py-2.5 rounded-lg text-sm font-medium text-zinc-400
                       border border-zinc-700 hover:border-zinc-600 hover:text-zinc-200
                       transition-colors"
          >
            처음으로
          </button>
        </div>
      </div>
    </div>
  );
}
