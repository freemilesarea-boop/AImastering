// Guided flow — Import screen (PROTOTYPE-PORT T3).
//
// Single-file import for the guided "three picks" flow.  Reuses the existing
// file:open-dialog IPC (single select) and audioStore.setFile.  No DSP / IPC
// changes — just selects a source file and advances to Choose.
import React, { useCallback, useState } from 'react';
import { useAudioStore } from '../../stores/audioStore.js';

const AUDIO_EXT = new Set(['.wav', '.flac', '.aiff', '.aif', '.mp3', '.m4a']);

function isAudioPath(p: string): boolean {
  const i = p.lastIndexOf('.');
  return i >= 0 && AUDIO_EXT.has(p.slice(i).toLowerCase());
}

interface Props {
  /** Called after a file is selected (GuidedHome advances to Choose). */
  onPicked: () => void;
}

export default function ImportView({ onPicked }: Props) {
  const setFile = useAudioStore((s) => s.setFile);
  const [dragging, setDragging] = useState(false);

  const pick = useCallback((path: string | null) => {
    if (!path) return;
    setFile(path);
    onPicked();
  }, [setFile, onPicked]);

  const openDialog = useCallback(async () => {
    if (!window.electronAPI) return;
    const path = (await window.electronAPI.invoke('file:open-dialog')) as string | null;
    pick(path);
  }, [pick]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer?.files?.[0] as (File & { path?: string }) | undefined;
    const path = f?.path ?? '';
    if (path && isAudioPath(path)) pick(path);
  }, [pick]);

  return (
    <div className="h-full flex flex-col px-7 py-8 max-w-[680px] mx-auto w-full">
      <div className="flex items-center gap-[10px] mb-2">
        <span className="w-[26px] h-[26px] rounded-lg"
          style={{ background: 'conic-gradient(from 220deg,#6C5CE7,#8B7BFF,#FF3D77,#6C5CE7)' }} />
        <span className="font-bold text-[15px]">Loui Mastering</span>
      </div>
      <h2 className="text-[25px] font-bold tracking-tight mt-[10px]">트랙을 올리면, 마스터가 됩니다.</h2>
      <p className="text-[16px] text-zinc-400 mt-1">파일을 끌어다 놓거나 선택하세요.</p>

      <div
        role="button"
        tabIndex={0}
        onClick={openDialog}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') openDialog(); }}
        onDragEnter={(e) => { e.preventDefault(); setDragging(true); }}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={(e) => { e.preventDefault(); setDragging(false); }}
        onDrop={onDrop}
        className={`mt-[18px] rounded-[18px] min-h-[230px] flex flex-col items-center justify-center gap-[14px]
                    cursor-pointer border-2 border-dashed transition-all
                    ${dragging ? 'border-[#8B7BFF] scale-[1.01] bg-[rgba(108,92,231,.14)]' : 'border-zinc-600'}`}
      >
        <div className="text-[42px] leading-none">⤓</div>
        <div className="text-[18px] font-semibold">오디오 파일 올리기</div>
        <div className="text-[13px] text-zinc-500">WAV · MP3 · FLAC · M4A</div>
      </div>

      <p className="text-center text-[12px] text-zinc-600 mt-[14px]">업로드 없이 · 내 컴퓨터에서 처리</p>
    </div>
  );
}
