/**
 * Screen 3: Processing
 *
 * Shows a 5-stage progress pipeline while mastering runs.
 * Reads progress % from audioStore (set by AnalysisPage's IPC listener).
 * On error: shows error-type-specific card with conditional retry button.
 */
import React, { useCallback } from 'react';
import TopBar from '../components/TopBar.js';
import { useAppStore } from '../stores/appStore.js';
import { useAudioStore, toStructuredError } from '../stores/audioStore.js';
import type { StructuredError } from '../stores/audioStore.js';
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

/** Map error codes to actionable hint text shown below the message. */
function errorHint(code: StructuredError['code']): string | null {
  switch (code) {
    case 'FFMPEG_NOT_FOUND':
    case 'FFPROBE_NOT_FOUND':
      return 'FFmpeg를 설치한 후 앱을 재시작해주세요. (https://ffmpeg.org/download.html)';
    case 'FILE_CORRUPTED':
      return '다른 파일로 시도하거나 파일을 다시 내보내주세요.';
    case 'FORMAT_UNSUPPORTED':
      return 'WAV, FLAC, AIFF, MP3, M4A 형식의 파일을 사용해주세요.';
    case 'PATH_ENCODING_ERROR':
      return '파일을 경로에 한글/특수문자가 없는 폴더로 이동한 후 다시 시도해주세요.';
    case 'OUTPUT_DIR_NOT_WRITABLE':
      return '디스크 여유 공간을 확인하거나 권한 설정을 확인해주세요.';
    case 'LOUDNORM_PARSE_FAILED':
      return '파일이 너무 짧거나 무음인지 확인해주세요.';
    case 'PYTHON_PROCESS_FAILED':
      return '잠시 후 다시 시도해주세요.';
    case 'LICENSE_STORE_CORRUPTED':
    case 'TRIAL_COUNT_ANOMALY':
      return '앱을 재시작하거나 라이선스를 다시 활성화해주세요.';
    default:
      return null;
  }
}

function ErrorCard({
  error,
  onRetry,
}: {
  error: StructuredError;
  onRetry: () => void;
}) {
  const hint = errorHint(error.code);

  return (
    <div className="rounded-xl bg-red-500/5 border border-red-500/20 p-4 space-y-2">
      <p className="text-xs text-red-400 font-medium uppercase tracking-wide">처리 실패</p>
      <p className="text-sm text-zinc-300 leading-relaxed">{error.userMessage}</p>
      {hint && (
        <p className="text-xs text-zinc-500 leading-relaxed">{hint}</p>
      )}
      <div className="flex items-center gap-2 pt-1">
        {error.recoverable && (
          <button
            onClick={onRetry}
            className="no-drag px-4 py-2 rounded-lg text-sm font-medium
                       bg-zinc-800 border border-zinc-700 text-zinc-300
                       hover:border-zinc-600 hover:text-zinc-100 transition-colors"
          >
            다시 시도
          </button>
        )}
        <span className="text-[10px] text-zinc-700 font-mono">{error.code}</span>
      </div>
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
      const structured = toStructuredError(err);
      setError(structured);
      notify(structured.userMessage, 'error');
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
          {error && <ErrorCard error={error} onRetry={handleRetry} />}

        </div>
      </div>
    </div>
  );
}
