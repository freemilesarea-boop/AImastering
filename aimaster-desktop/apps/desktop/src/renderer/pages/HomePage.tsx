/**
 * Screen 1: Batch Queue Hub
 *
 * - Drag & drop or click to add up to 20 audio files at once
 * - Files appear in the queue with live status
 * - Single style selector applies to all files
 * - "모두 마스터링 시작" processes each file sequentially
 * - Per-item inline: progress bar, WAV download, MP3 download, preview player
 */
import React, { useCallback, useRef, useState } from 'react';
import { useDropzone } from 'react-dropzone';
import TopBar from '../components/TopBar.js';
import { useAppStore } from '../stores/appStore.js';
import {
  useAudioStore,
  toStructuredError,
  MAX_QUEUE_SIZE,
} from '../stores/audioStore.js';
import type { QueueItem } from '../stores/audioStore.js';
import type { AudioAnalysisResult, MasteringResult, MasteringStyle } from '@aimaster/shared-types';

// ── Constants ─────────────────────────────────────────────────────────────────

const ACCEPT = {
  'audio/wav':  ['.wav'],
  'audio/flac': ['.flac'],
  'audio/aiff': ['.aiff', '.aif'],
  'audio/mpeg': ['.mp3'],
  'audio/mp4':  ['.m4a'],
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function toFileUrl(p: string): string {
  if (!p) return '';
  const normalized = p.replace(/\\/g, '/');
  const withSlash = normalized.startsWith('/') ? normalized : `/${normalized}`;
  return `file://${encodeURI(withSlash)}`;
}

// ── Icons ─────────────────────────────────────────────────────────────────────

function UploadIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none"
         stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 16V4M8 8l4-4 4 4" />
      <path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
    </svg>
  );
}

function XIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none"
         stroke="currentColor" strokeWidth={1.75} strokeLinecap="round">
      <path d="M3 3l10 10M13 3L3 13" />
    </svg>
  );
}

// ── Style preset selector (compact) ──────────────────────────────────────────

const STYLES: { id: MasteringStyle; label: string; hint: string }[] = [
  { id: 'balanced', label: 'Balanced', hint: '범용' },
  { id: 'warm',     label: 'Warm',     hint: '따뜻한' },
  { id: 'bright',   label: 'Bright',   hint: '선명한' },
  { id: 'punch',    label: 'Punch',    hint: '강한 저음' },
];

function StyleSelector({
  selected,
  disabled,
  onChange,
}: {
  selected: MasteringStyle;
  disabled: boolean;
  onChange: (s: MasteringStyle) => void;
}) {
  return (
    <div className="flex gap-2">
      {STYLES.map((s) => (
        <button
          key={s.id}
          disabled={disabled}
          onClick={() => onChange(s.id)}
          className={`flex-1 py-2 px-1 rounded-lg text-xs font-medium transition-all
                      disabled:opacity-40 disabled:cursor-not-allowed
                      ${selected === s.id
                        ? 'bg-zinc-700 border border-zinc-500 text-zinc-100'
                        : 'bg-zinc-900/40 border border-zinc-800 text-zinc-500 hover:border-zinc-700 hover:text-zinc-400'
                      }`}
        >
          <div>{s.label}</div>
          <div className="text-[10px] font-normal text-zinc-600 mt-0.5">{s.hint}</div>
        </button>
      ))}
    </div>
  );
}

// ── Mini audio player ─────────────────────────────────────────────────────────

function MiniPlayer({
  src,
  isActive,
  onActivate,
}: {
  src: string;
  isActive: boolean;
  onActivate: () => void;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);

  // When another item becomes active, pause this one
  React.useEffect(() => {
    if (!isActive && audioRef.current && !audioRef.current.paused) {
      audioRef.current.pause();
    }
  }, [isActive]);

  const toggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) {
      onActivate();
      void a.play();
    } else {
      a.pause();
    }
  }, [onActivate]);

  const handleSeek = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    e.stopPropagation();
    const a = audioRef.current;
    if (!a || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    a.currentTime = ((e.clientX - rect.left) / rect.width) * duration;
  }, [duration]);

  const fmt = (s: number) => `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`;

  return (
    <div className="flex items-center gap-2 mt-2 pt-2 border-t border-zinc-800/60">
      <audio
        ref={audioRef}
        src={src}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => { setPlaying(false); setProgress(0); }}
        onTimeUpdate={() => {
          const a = audioRef.current;
          if (a && a.duration) setProgress(a.currentTime / a.duration);
        }}
        onLoadedMetadata={() => {
          if (audioRef.current) setDuration(audioRef.current.duration);
        }}
      />

      <button
        onClick={toggle}
        className="no-drag w-7 h-7 flex items-center justify-center rounded-full
                   bg-zinc-700 hover:bg-zinc-600 text-zinc-200 shrink-0 transition-colors"
      >
        {playing ? (
          <svg className="w-3 h-3" viewBox="0 0 12 12" fill="currentColor">
            <rect x="2" y="1.5" width="2.5" height="9" rx="0.5" />
            <rect x="7.5" y="1.5" width="2.5" height="9" rx="0.5" />
          </svg>
        ) : (
          <svg className="w-3 h-3" viewBox="0 0 12 12" fill="currentColor">
            <path d="M3 2l7 4-7 4V2z" />
          </svg>
        )}
      </button>

      <div className="flex-1 space-y-0.5">
        <div
          className="h-1 rounded-full bg-zinc-800 cursor-pointer overflow-hidden"
          onClick={handleSeek}
        >
          <div
            className="h-full rounded-full bg-zinc-500 transition-none"
            style={{ width: `${progress * 100}%` }}
          />
        </div>
        <div className="flex justify-between">
          <span className="text-[9px] font-mono text-zinc-700">{fmt(progress * duration)}</span>
          <span className="text-[9px] font-mono text-zinc-700">{duration ? fmt(duration) : '--:--'}</span>
        </div>
      </div>
    </div>
  );
}

// ── Queue item row ────────────────────────────────────────────────────────────

function QueueRow({
  item,
  activePlayerId,
  onSetActivePlayer,
  onRemove,
  onViewResult,
  notify,
}: {
  item: QueueItem;
  activePlayerId: string | null;
  onSetActivePlayer: (id: string) => void;
  onRemove: (id: string) => void;
  onViewResult: (item: QueueItem) => void;
  notify: (msg: string, type?: 'success' | 'error' | 'info' | 'warning') => void;
}) {
  const previewSrc = item.masteringResult?.previewPath
    ? toFileUrl(item.masteringResult.previewPath)
    : '';

  const handleSaveWav = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!item.masteringResult?.outputPath) return;
    const dest = await window.electronAPI!.invoke('file:save-wav', item.masteringResult.outputPath) as string | null;
    if (dest) notify('WAV 저장 완료', 'success');
  }, [item, notify]);

  const handleSaveMp3 = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!item.masteringResult?.previewPath) return;
    const dest = await window.electronAPI!.invoke('file:save-wav', item.masteringResult.previewPath) as string | null;
    if (dest) notify('MP3 저장 완료', 'success');
  }, [item, notify]);

  const statusDot = {
    pending:   'bg-zinc-700',
    analyzing: 'bg-amber-400 animate-pulse',
    mastering: 'bg-blue-400 animate-pulse',
    done:      'bg-emerald-400',
    error:     'bg-red-400',
  }[item.status];

  const statusLabel = {
    pending:   '대기',
    analyzing: '분석 중',
    mastering: item.progressStage || '처리 중',
    done:      '완료',
    error:     '오류',
  }[item.status];

  return (
    <div className={`rounded-xl border p-3 transition-colors
                     ${item.status === 'done'
                       ? 'border-zinc-700/60 bg-zinc-900/40'
                       : item.status === 'error'
                         ? 'border-red-900/40 bg-red-950/10'
                         : 'border-zinc-800 bg-zinc-900/20'
                     }`}
    >
      {/* Row 1: file name + status + remove */}
      <div className="flex items-center gap-2.5">
        <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${statusDot}`} />
        <span className="flex-1 text-xs text-zinc-300 truncate">{item.fileName}</span>
        <span className="text-[10px] text-zinc-600 shrink-0">{statusLabel}</span>
        {(item.status === 'pending' || item.status === 'error') && (
          <button
            onClick={(e) => { e.stopPropagation(); onRemove(item.id); }}
            className="no-drag w-4 h-4 text-zinc-700 hover:text-zinc-400 transition-colors shrink-0"
          >
            <XIcon className="w-full h-full" />
          </button>
        )}
      </div>

      {/* Progress bar (mastering only) */}
      {item.status === 'mastering' && (
        <div className="mt-2">
          <div className="h-1 rounded-full bg-zinc-800 overflow-hidden">
            <div
              className="h-full rounded-full bg-blue-500/70 transition-all duration-300"
              style={{ width: `${item.progress}%` }}
            />
          </div>
        </div>
      )}

      {/* Error message */}
      {item.status === 'error' && item.error && (
        <p className="mt-1.5 text-[11px] text-red-400 leading-snug">{item.error.userMessage}</p>
      )}

      {/* Done: LUFS info + download buttons + preview */}
      {item.status === 'done' && item.masteringResult && (
        <>
          {/* Stats */}
          <div className="mt-2 flex gap-3 text-[10px] font-mono text-zinc-600">
            <span>
              {item.masteringResult.loudnessAfter.integratedLufs.toFixed(1)} LUFS
            </span>
            <span>
              TP {item.masteringResult.loudnessAfter.truePeakDbtp.toFixed(1)} dBTP
            </span>
            <span>
              LRA {item.masteringResult.loudnessAfter.lra.toFixed(1)} LU
            </span>
          </div>

          {/* Buttons */}
          <div className="mt-2 flex gap-2">
            <button
              onClick={handleSaveWav}
              className="no-drag flex-1 py-1.5 rounded-lg text-[11px] font-medium
                         bg-zinc-700 hover:bg-zinc-600 text-zinc-200 transition-colors"
            >
              WAV 저장
            </button>
            <button
              onClick={handleSaveMp3}
              disabled={!previewSrc}
              className="no-drag flex-1 py-1.5 rounded-lg text-[11px] font-medium
                         bg-zinc-800 hover:bg-zinc-700 text-zinc-400 transition-colors
                         disabled:opacity-40 disabled:cursor-not-allowed"
            >
              MP3 저장
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onViewResult(item); }}
              className="no-drag px-3 py-1.5 rounded-lg text-[11px]
                         border border-zinc-700 text-zinc-500 hover:text-zinc-300
                         hover:border-zinc-600 transition-colors"
            >
              상세
            </button>
          </div>

          {/* Mini player */}
          {previewSrc && (
            <MiniPlayer
              src={previewSrc}
              isActive={activePlayerId === item.id}
              onActivate={() => onSetActivePlayer(item.id)}
            />
          )}
        </>
      )}
    </div>
  );
}

// ── Drop zone (used in both empty and queue states) ────────────────────────────

function DropZone({
  onFiles,
  isDisabled,
  compact,
}: {
  onFiles: (paths: string[]) => void;
  isDisabled: boolean;
  compact: boolean;
}) {
  const onDrop = useCallback(
    (accepted: File[]) => {
      const paths = accepted.map((f) => (f as File & { path: string }).path).filter(Boolean);
      if (paths.length) onFiles(paths);
    },
    [onFiles],
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: ACCEPT,
    maxFiles: MAX_QUEUE_SIZE,
    multiple: true,
    disabled: isDisabled,
    noClick: false,
  });

  if (compact) {
    return (
      <div
        {...getRootProps()}
        className={`no-drag flex items-center justify-center gap-2 w-full py-3
                    rounded-xl border border-dashed cursor-pointer transition-all
                    ${isDisabled
                      ? 'border-zinc-800 opacity-40 cursor-not-allowed'
                      : isDragActive
                        ? 'border-zinc-400 bg-zinc-800/40'
                        : 'border-zinc-800 hover:border-zinc-600 hover:bg-zinc-900/30'
                    }`}
      >
        <input {...getInputProps()} />
        <UploadIcon className="w-4 h-4 text-zinc-600" />
        <span className="text-xs text-zinc-600">
          {isDragActive ? '파일을 놓으세요' : '파일 추가 (드래그 또는 클릭)'}
        </span>
      </div>
    );
  }

  return (
    <div
      {...getRootProps()}
      className={`no-drag relative flex flex-col items-center justify-center
                  w-full rounded-2xl border-2 border-dashed transition-all duration-200
                  cursor-pointer select-none
                  ${isDisabled
                    ? 'border-zinc-700 bg-zinc-900/30 cursor-not-allowed'
                    : isDragActive
                      ? 'border-zinc-400 bg-zinc-800/50 scale-[1.01]'
                      : 'border-zinc-700 bg-zinc-900/30 hover:border-zinc-500 hover:bg-zinc-900/50'
                  }`}
      style={{ minHeight: 220 }}
    >
      <input {...getInputProps()} />
      {isDragActive ? (
        <div className="flex flex-col items-center gap-3">
          <svg className="w-10 h-10 text-zinc-300" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
            <path d="M2 12h2M20 12h2M6 8v8M18 8v8M10 5v14M14 5v14" />
          </svg>
          <p className="text-sm text-zinc-300">파일을 놓으세요</p>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3 pointer-events-none">
          <UploadIcon className="w-9 h-9 text-zinc-600" />
          <div className="text-center">
            <p className="text-sm text-zinc-300">
              파일을 끌어다 놓거나&nbsp;
              <span className="text-zinc-100 underline underline-offset-2">클릭해서 선택</span>
            </p>
            <p className="mt-1 text-xs text-zinc-600">
              WAV · FLAC · AIFF · MP3 · M4A &nbsp;·&nbsp; 최대 {MAX_QUEUE_SIZE}곡
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

// ── HomePage ──────────────────────────────────────────────────────────────────

export default function HomePage() {
  const setPage  = useAppStore((s) => s.setPage);
  const notify   = useAppStore((s) => s.notify);

  const {
    queue,
    isBatchRunning,
    options,
    addFilesToQueue,
    removeFromQueue,
    clearQueue,
    updateQueueItem,
    setIsBatchRunning,
    setStyle,
    // single-file compat (for ResultPage navigation)
    setFile,
    setAnalysis,
    setMasteringResult,
  } = useAudioStore();

  const [activePlayerId, setActivePlayerId] = useState<string | null>(null);

  // ── Add files ─────────────────────────────────────────────────────────
  const handleFiles = useCallback((paths: string[]) => {
    addFilesToQueue(paths);
  }, [addFilesToQueue]);

  const handleOpenMulti = useCallback(async () => {
    const paths = await window.electronAPI!.invoke('file:open-dialog-multi') as string[] | null;
    if (paths?.length) addFilesToQueue(paths);
  }, [addFilesToQueue]);

  // ── Navigate to detail view ───────────────────────────────────────────
  const handleViewResult = useCallback((item: QueueItem) => {
    if (!item.analysis || !item.masteringResult) return;
    setFile(item.filePath);
    setAnalysis(item.analysis);
    setMasteringResult(item.masteringResult);
    setPage('result');
  }, [setFile, setAnalysis, setMasteringResult, setPage]);

  // ── Batch processing ──────────────────────────────────────────────────
  const handleStartBatch = useCallback(async () => {
    const pending = queue.filter((i) => i.status === 'pending' || i.status === 'error');
    if (!pending.length || isBatchRunning) return;

    setIsBatchRunning(true);

    for (const item of pending) {
      try {
        // Step 1: Analyze
        updateQueueItem(item.id, { status: 'analyzing', error: undefined });
        const analysis = await window.electronAPI!.invoke('audio:analyze', item.filePath) as AudioAnalysisResult;
        updateQueueItem(item.id, { analysis, status: 'mastering', progress: 0 });

        // Step 2: Progress listener for this item
        const cleanupProgress = window.electronAPI!.on('audio:progress', (msg: unknown) => {
          const m = msg as { percent: number; stage: string };
          updateQueueItem(item.id, { progress: m.percent, progressStage: m.stage });
        });

        // Step 3: Master
        const result = await window.electronAPI!.invoke(
          'audio:master',
          item.filePath,
          '',
          {
            style:              options.style,
            targetLufs:         options.targetLufs,
            targetTp:           options.targetTp,
            sampleRate:         options.sampleRate,
            bitDepth:           options.bitDepth,
            applyAiCorrections: options.applyAiCorrections,
            aiDetections:       analysis.aiDetection ?? {},
          },
        ) as MasteringResult;

        cleanupProgress();
        updateQueueItem(item.id, { masteringResult: result, status: 'done', progress: 100 });

      } catch (err) {
        updateQueueItem(item.id, { error: toStructuredError(err), status: 'error', progress: 0 });
      }
    }

    setIsBatchRunning(false);
    const doneCount = useAudioStore.getState().queue.filter((i) => i.status === 'done').length;
    if (doneCount > 0) notify(`${doneCount}곡 마스터링 완료`, 'success');
  }, [queue, isBatchRunning, options, updateQueueItem, setIsBatchRunning, notify]);

  // ── Derived state ─────────────────────────────────────────────────────
  const pendingCount  = queue.filter((i) => i.status === 'pending' || i.status === 'error').length;
  const doneCount     = queue.filter((i) => i.status === 'done').length;
  const hasQueue      = queue.length > 0;

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <TopBar />

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-lg mx-auto px-6 py-5 space-y-4 animate-in">

          {/* ── Empty state ───────────────────────────────────── */}
          {!hasQueue && (
            <>
              <DropZone onFiles={handleFiles} isDisabled={false} compact={false} />
              <div className="flex items-center gap-3">
                <div className="flex-1 h-px bg-zinc-800" />
                <button
                  onClick={handleOpenMulti}
                  className="no-drag text-xs text-zinc-600 hover:text-zinc-400 transition-colors"
                >
                  파일 탐색기로 열기
                </button>
                <div className="flex-1 h-px bg-zinc-800" />
              </div>
            </>
          )}

          {/* ── Queue view ────────────────────────────────────── */}
          {hasQueue && (
            <>
              {/* Compact drop zone + add more button */}
              <div className="flex gap-2">
                <div className="flex-1">
                  <DropZone
                    onFiles={handleFiles}
                    isDisabled={isBatchRunning || queue.length >= MAX_QUEUE_SIZE}
                    compact
                  />
                </div>
                <button
                  onClick={handleOpenMulti}
                  disabled={isBatchRunning || queue.length >= MAX_QUEUE_SIZE}
                  className="no-drag px-3 rounded-xl border border-zinc-800 text-xs text-zinc-600
                             hover:border-zinc-700 hover:text-zinc-400 transition-colors
                             disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  열기
                </button>
              </div>

              {/* Queue summary */}
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-zinc-600">
                  {queue.length}곡
                  {doneCount > 0 && (
                    <span className="text-emerald-500 ml-1.5">· {doneCount}곡 완료</span>
                  )}
                </span>
                <button
                  onClick={clearQueue}
                  disabled={isBatchRunning}
                  className="no-drag text-zinc-700 hover:text-zinc-500 transition-colors
                             disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  전체 삭제
                </button>
              </div>

              {/* File list */}
              <div className="space-y-2">
                {queue.map((item) => (
                  <QueueRow
                    key={item.id}
                    item={item}
                    activePlayerId={activePlayerId}
                    onSetActivePlayer={setActivePlayerId}
                    onRemove={removeFromQueue}
                    onViewResult={handleViewResult}
                    notify={notify}
                  />
                ))}
              </div>

              {/* Style selector */}
              <div>
                <p className="text-[10px] text-zinc-600 uppercase tracking-wider mb-2">스타일</p>
                <StyleSelector
                  selected={options.style}
                  disabled={isBatchRunning}
                  onChange={setStyle}
                />
              </div>

              {/* Start button */}
              {pendingCount > 0 && (
                <button
                  onClick={handleStartBatch}
                  disabled={isBatchRunning}
                  className="no-drag w-full py-3 rounded-xl text-sm font-medium transition-colors
                             bg-zinc-100 text-zinc-900
                             hover:bg-white active:bg-zinc-200
                             disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isBatchRunning
                    ? '처리 중…'
                    : `마스터링 시작 (${pendingCount}곡)`}
                </button>
              )}

              {/* All done CTA */}
              {doneCount > 0 && pendingCount === 0 && !isBatchRunning && (
                <button
                  onClick={clearQueue}
                  className="no-drag w-full py-2.5 rounded-xl text-xs font-medium
                             border border-zinc-800 text-zinc-600
                             hover:border-zinc-700 hover:text-zinc-400 transition-colors"
                >
                  큐 비우기 · 새 파일 추가
                </button>
              )}
            </>
          )}

        </div>
      </div>
    </div>
  );
}
