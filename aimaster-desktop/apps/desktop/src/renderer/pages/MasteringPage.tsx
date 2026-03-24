/**
 * Screen 3: Processing
 *
 * Shows a 5-stage progress pipeline while mastering runs.
 * Reads progress % from audioStore (set by AnalysisPage's IPC listener).
 * On error: shows message + retry button.
 */
import React, { useCallback } from 'react';
import TopBar from '../components/TopBar.js';
import { useAppStore } from '../stores/appStore.js';
import { useAudioStore } from '../stores/audioStore.js';
import type { MasteringResult } from '@aimaster/shared-types';

// ── Stage definitions ─────────────────────────────────────────────────────────

interface Stage {
  label: string;
  /** Progress % range where this stage is active. */
  range: [number, number];
}

const STAGES: Stage[] = [
  { label: '파일 검사',             range: [0,  15] },
  { label: '분석',                  range: [15, 30] },
  { label: '톤 보정',               range: [30, 42] },
  { label: 'Loudness normalization', range: [42, 78] },
  { label: '사후 검증',             range: [78, 100] },
];

type StageStatus = 'done' | 'active' | 'pending';

function getStageStatus(stage: Stage, progress: number): StageStatus {
  if (progress >= stage.range[1]) return 'done';
  if (progress >= stage.range[0]) return 'active';
  return 'pending';
}

// ── Stage row ─────────────────────────────────────────────────────────────────

function StageRow({ label, status }: { label: string; status: StageStatus }) {
  return (
    <div className="flex items-center gap-3">
      {/* Indicator */}
      <div className="shrink-0 w-5 h-5 flex items-center justify-center">
        {status === 'done' ? (
          // Check circle
          <svg className="w-5 h-5 text-emerald-400" viewBox="0 0 20 20" fill="none"
               stroke="currentColor" strokeWidth={1.75} strokeLinecap="round">
            <circle cx="10" cy="10" r="8" />
            <path d="M6.5 10.5l2.5 2.5 4.5-4.5" />
          </svg>
        ) : status === 'active' ? (
          // Spinning ring
          <div className="w-4 h-4 rounded-full border-2 border-zinc-600 border-t-zinc-200 animate-spin" />
        ) : (
          // Empty circle
          <div className="w-4 h-4 rounded-full border border-zinc-700" />
        )}
      </div>

      {/* Label */}
      <span className={`text-sm transition-colors ${
        status === 'done'   ? 'text-zinc-500 line-through decoration-zinc-700'
        : status === 'active' ? 'text-zinc-100 font-medium'
        : 'text-zinc-600'
      }`}>
        {label}
      </span>
    </div>
  );
}

// ── Error card ────────────────────────────────────────────────────────────────

function ErrorCard({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="rounded-xl bg-red-500/5 border border-red-500/20 p-4">
      <p className="text-xs text-red-400 font-medium mb-1">처리 실패</p>
      <p className="text-sm text-zinc-400 leading-relaxed">{message}</p>
      <button
        onClick={onRetry}
        className="no-drag mt-3 px-4 py-2 rounded-lg text-sm font-medium
                   bg-zinc-800 border border-zinc-700 text-zinc-300
                   hover:border-zinc-600 hover:text-zinc-100 transition-colors"
      >
        다시 시도
      </button>
    </div>
  );
}

// ── MasteringPage ─────────────────────────────────────────────────────────────

export default function MasteringPage() {
  const setPage            = useAppStore((s) => s.setPage);
  const notify             = useAppStore((s) => s.notify);
  const {
    selectedFile, analysis, options,
    progress, isMastering, error,
    setIsMastering, setProgress, setError, setMasteringResult,
  } = useAudioStore();

  const fileName = analysis?.fileInfo.name ?? selectedFile?.split('/').pop() ?? '…';

  // ── Retry handler ─────────────────────────────────────────────────────
  const handleRetry = useCallback(async () => {
    if (!selectedFile) { setPage('home'); return; }

    setIsMastering(true);
    setError(null);

    const cleanupProgress = window.electronAPI.on('audio:progress', (msg: unknown) => {
      const m = msg as { percent: number; stage: string };
      setProgress(m.percent, m.stage);
    });

    try {
      const result = await window.electronAPI.invoke(
        'audio:master',
        selectedFile,
        '',
        {
          style:              options.style,
          targetLufs:         options.targetLufs,
          targetTp:           options.targetTp,
          sampleRate:         options.sampleRate,
          bitDepth:           options.bitDepth,
          applyAiCorrections: options.applyAiCorrections,
        },
      ) as MasteringResult;
      setMasteringResult(result);
      setPage('result');
    } catch (err) {
      setError((err as Error).message);
      notify('마스터링 실패. 파일을 확인해주세요.', 'error');
    } finally {
      cleanupProgress();
      setIsMastering(false);
    }
  }, [selectedFile, options, setIsMastering, setError, setProgress, setMasteringResult, setPage, notify]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <TopBar subtitle="처리 중" />

      <div className="flex-1 flex items-center justify-center px-8">
        <div className="w-full max-w-sm space-y-6 animate-in">

          {/* File name */}
          <div>
            <p className="text-xs text-zinc-600 mb-1">처리 중인 파일</p>
            <p className="text-sm text-zinc-300 truncate">{fileName}</p>
          </div>

          {/* Stage list */}
          <div className="space-y-3">
            {STAGES.map((stage) => (
              <StageRow
                key={stage.label}
                label={stage.label}
                status={error ? 'pending' : getStageStatus(stage, progress)}
              />
            ))}
          </div>

          {/* Overall progress bar */}
          {!error && (
            <div>
              <div className="h-1 rounded-full bg-zinc-800 overflow-hidden">
                <div
                  className="h-full rounded-full bg-zinc-400 transition-all duration-500 ease-out"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <p className="mt-2 text-xs text-zinc-600 text-right font-mono">
                {isMastering ? `${progress}%` : '완료'}
              </p>
            </div>
          )}

          {/* Error state */}
          {error && <ErrorCard message={error} onRetry={handleRetry} />}

        </div>
      </div>
    </div>
  );
}
