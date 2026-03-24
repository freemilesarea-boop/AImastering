/**
 * Screen 1: Home / Upload
 *
 * Layout:
 *   TopBar (drag region + license badge)
 *   Center content:
 *     Drop zone  ← primary focus
 *     Format hint
 *     Recent files placeholder (empty state for v1)
 */
import React, { useCallback } from 'react';
import { useDropzone } from 'react-dropzone';
import TopBar from '../components/TopBar.js';
import { useAppStore } from '../stores/appStore.js';
import { useAudioStore } from '../stores/audioStore.js';
import type { AudioAnalysisResult } from '@aimaster/shared-types';

// ── Icon ──────────────────────────────────────────────────────────────────────

function UploadIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none"
         stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 16V4M8 8l4-4 4 4" />
      <path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
    </svg>
  );
}

function WaveIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none"
         stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
      <path d="M2 12h2M20 12h2M6 8v8M18 8v8M10 5v14M14 5v14" />
    </svg>
  );
}

// ── Formats ───────────────────────────────────────────────────────────────────

const SUPPORTED = ['WAV', 'FLAC', 'AIFF', 'MP3', 'M4A'];
const ACCEPT = {
  'audio/wav':  ['.wav'],
  'audio/flac': ['.flac'],
  'audio/aiff': ['.aiff', '.aif'],
  'audio/mpeg': ['.mp3'],
  'audio/mp4':  ['.m4a'],
};

// ── DropZone ──────────────────────────────────────────────────────────────────

interface DropZoneProps {
  onFile: (path: string) => void;
  isLoading: boolean;
}

function DropZone({ onFile, isLoading }: DropZoneProps) {
  const onDrop = useCallback(
    (accepted: File[]) => {
      if (accepted[0]) onFile((accepted[0] as File & { path: string }).path);
    },
    [onFile],
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: ACCEPT,
    maxFiles: 1,
    disabled: isLoading,
    noClick: false,
  });

  return (
    <div
      {...getRootProps()}
      className={`no-drag relative flex flex-col items-center justify-center
                  w-full rounded-2xl border-2 border-dashed transition-all duration-200
                  cursor-pointer select-none
                  ${isLoading
                    ? 'border-zinc-700 bg-zinc-900/30 cursor-not-allowed'
                    : isDragActive
                      ? 'border-zinc-400 bg-zinc-800/50 scale-[1.01]'
                      : 'border-zinc-700 bg-zinc-900/30 hover:border-zinc-500 hover:bg-zinc-900/50'
                  }`}
      style={{ minHeight: 240 }}
    >
      <input {...getInputProps()} />

      {isLoading ? (
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 rounded-full border-2 border-zinc-600 border-t-zinc-300 animate-spin" />
          <p className="text-sm text-zinc-400">분석 중…</p>
        </div>
      ) : isDragActive ? (
        <div className="flex flex-col items-center gap-3">
          <WaveIcon className="w-10 h-10 text-zinc-300" />
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
              {SUPPORTED.join(' · ')}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

// ── HomePage ──────────────────────────────────────────────────────────────────

export default function HomePage() {
  const setPage       = useAppStore((s) => s.setPage);
  const notify        = useAppStore((s) => s.notify);
  const { setFile, setAnalysis, setIsAnalyzing, isAnalyzing } = useAudioStore();

  const handleFile = useCallback(async (filePath: string) => {
    setFile(filePath);
    setIsAnalyzing(true);
    try {
      const result = await window.electronAPI.invoke('audio:analyze', filePath) as AudioAnalysisResult;
      setAnalysis(result);
      setPage('analysis');
    } catch (err) {
      notify(`분석 실패: ${(err as Error).message}`, 'error');
      setFile(null);
    } finally {
      setIsAnalyzing(false);
    }
  }, [setFile, setAnalysis, setIsAnalyzing, setPage, notify]);

  // Also support clicking "열기" via the file dialog
  const handleOpenDialog = useCallback(async () => {
    const path = await window.electronAPI.invoke('file:open-dialog') as string | null;
    if (path) handleFile(path);
  }, [handleFile]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <TopBar />

      {/* Main content */}
      <div className="flex-1 flex flex-col items-center justify-center px-8 pb-10 animate-in">
        <div className="w-full max-w-lg space-y-5">

          {/* Drop zone */}
          <DropZone onFile={handleFile} isLoading={isAnalyzing} />

          {/* Native dialog divider */}
          <div className="flex items-center gap-3">
            <div className="flex-1 h-px bg-zinc-800" />
            <button
              onClick={handleOpenDialog}
              disabled={isAnalyzing}
              className="no-drag text-xs text-zinc-600 hover:text-zinc-400 transition-colors
                         disabled:opacity-40 disabled:cursor-not-allowed"
            >
              파일 탐색기로 열기
            </button>
            <div className="flex-1 h-px bg-zinc-800" />
          </div>

          {/* Recent files — v1 placeholder */}
          <div>
            <p className="text-xs text-zinc-700 mb-2 uppercase tracking-wider">최근 파일</p>
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/20
                            flex items-center justify-center py-6">
              <p className="text-xs text-zinc-700">최근 작업 내역이 없습니다</p>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
