/**
 * Screen 4: Result
 *
 * Layout:
 *   TopBar
 *   Before / After loudness comparison card
 *   Preview player (HTML5 audio)
 *   Save buttons (MP3 always · WAV locked for free tier)
 *   QC summary chips
 *   YouTube Music notice
 */
import React, { useCallback, useRef, useState } from 'react';
import TopBar from '../components/TopBar.js';
import { useAppStore } from '../stores/appStore.js';
import { useAudioStore } from '../stores/audioStore.js';
import { useLicenseStore } from '../stores/licenseStore.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n: number, d = 1) { return n.toFixed(d); }

/** Convert a filesystem path to a file:// URL usable in <audio src=...> */
function toFileUrl(p: string): string {
  if (!p) return '';
  // Windows: C:\path → file:///C:/path
  const normalized = p.replace(/\\/g, '/');
  return normalized.startsWith('/') ? `file://${normalized}` : `file:///${normalized}`;
}

// ── Arrow delta ───────────────────────────────────────────────────────────────

function Delta({ before, after, unit }: { before: number; after: number; unit: string }) {
  const diff   = after - before;
  const absStr = Math.abs(diff).toFixed(1);
  const color  = diff > 0 ? 'text-emerald-400' : diff < 0 ? 'text-amber-400' : 'text-zinc-500';
  const sign   = diff > 0 ? '+' : diff < 0 ? '−' : '';
  return (
    <span className={`text-xs font-mono ${color}`}>
      {sign}{absStr} {unit}
    </span>
  );
}

// ── Before / After card ───────────────────────────────────────────────────────

function BeforeAfterCard() {
  const analysis  = useAudioStore((s) => s.analysis);
  const result    = useAudioStore((s) => s.masteringResult);
  if (!analysis || !result) return null;

  const rows = [
    {
      label:  'Integrated Loudness',
      before: analysis.loudness.integratedLufs,
      after:  result.loudnessAfter.integratedLufs,
      unit:   'LUFS',
    },
    {
      label:  'True Peak',
      before: analysis.loudness.truePeakDbtp,
      after:  result.loudnessAfter.truePeakDbtp,
      unit:   'dBTP',
    },
    {
      label:  'Loudness Range',
      before: analysis.loudness.lra,
      after:  result.loudnessAfter.lra,
      unit:   'LU',
    },
  ];

  return (
    <div className="rounded-xl bg-zinc-900/50 border border-zinc-800 overflow-hidden">
      {/* Header */}
      <div className="grid grid-cols-4 px-4 pt-3 pb-2 border-b border-zinc-800">
        <span className="col-span-2 text-[10px] text-zinc-600 uppercase tracking-wider">항목</span>
        <span className="text-[10px] text-zinc-600 uppercase tracking-wider text-right">이전</span>
        <span className="text-[10px] text-zinc-500 uppercase tracking-wider text-right">이후</span>
      </div>
      {rows.map(({ label, before, after, unit }) => (
        <div key={label}
             className="grid grid-cols-4 items-center px-4 py-2.5 border-b border-zinc-800/60 last:border-0">
          <span className="col-span-2 text-xs text-zinc-500">{label}</span>
          <span className="font-mono text-xs text-zinc-600 text-right">
            {fmt(before)} <span className="text-zinc-700">{unit}</span>
          </span>
          <div className="text-right space-y-0.5">
            <div className="font-mono text-sm text-zinc-200">
              {fmt(after)} <span className="text-zinc-600 text-xs">{unit}</span>
            </div>
            <Delta before={before} after={after} unit={unit} />
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Audio preview player ──────────────────────────────────────────────────────

function PreviewPlayer({ src }: { src: string }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying]   = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);

  const toggle = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) { void a.play(); } else { a.pause(); }
  }, []);

  const handleSeek = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const a = audioRef.current;
    if (!a || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    a.currentTime = ratio * duration;
  }, [duration]);

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    return `${m}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
  };

  if (!src) return null;

  return (
    <div className="rounded-xl bg-zinc-900/50 border border-zinc-800 p-4">
      <p className="text-xs text-zinc-600 uppercase tracking-wider mb-3">프리뷰 (MP3)</p>

      {/* Hidden audio element */}
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
          const a = audioRef.current;
          if (a) setDuration(a.duration);
        }}
      />

      <div className="flex items-center gap-3">
        {/* Play/pause button */}
        <button
          onClick={toggle}
          className="no-drag w-9 h-9 flex items-center justify-center rounded-full
                     bg-zinc-200 text-zinc-900 hover:bg-white active:bg-zinc-300
                     shrink-0 transition-colors"
        >
          {playing ? (
            // Pause icon
            <svg className="w-4 h-4" viewBox="0 0 16 16" fill="currentColor">
              <rect x="3" y="2" width="3.5" height="12" rx="1" />
              <rect x="9.5" y="2" width="3.5" height="12" rx="1" />
            </svg>
          ) : (
            // Play icon
            <svg className="w-4 h-4" viewBox="0 0 16 16" fill="currentColor">
              <path d="M4 2.5l10 5.5-10 5.5V2.5z" />
            </svg>
          )}
        </button>

        {/* Seek bar */}
        <div className="flex-1 space-y-1">
          <div
            className="h-1.5 rounded-full bg-zinc-800 cursor-pointer overflow-hidden"
            onClick={handleSeek}
          >
            <div
              className="h-full rounded-full bg-zinc-400 transition-none"
              style={{ width: `${progress * 100}%` }}
            />
          </div>
          <div className="flex justify-between">
            <span className="text-[10px] font-mono text-zinc-600">
              {formatTime(progress * duration)}
            </span>
            <span className="text-[10px] font-mono text-zinc-700">
              {duration ? formatTime(duration) : '--:--'}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Save buttons ──────────────────────────────────────────────────────────────

function SaveButtons() {
  const masteringResult = useAudioStore((s) => s.masteringResult);
  const licenseInfo     = useLicenseStore((s) => s.licenseInfo);
  const setShowModal    = useLicenseStore((s) => s.setShowModal);
  const notify          = useAppStore((s) => s.notify);
  const isPro           = licenseInfo?.tier === 'pro';

  const handleSaveMp3 = useCallback(async () => {
    if (!masteringResult?.previewPath) return;
    const dest = await window.electronAPI.invoke(
      'file:save-wav',
      masteringResult.previewPath,
    ) as string | null;
    if (dest) notify('MP3 저장 완료', 'success');
  }, [masteringResult, notify]);

  const handleSaveWav = useCallback(async () => {
    if (!masteringResult?.outputPath) return;
    const dest = await window.electronAPI.invoke(
      'file:save-wav',
      masteringResult.outputPath,
    ) as string | null;
    if (dest) notify('WAV 저장 완료', 'success');
  }, [masteringResult, notify]);

  return (
    <div className="space-y-2">
      {/* MP3 — always available */}
      <button
        onClick={handleSaveMp3}
        className="no-drag w-full flex items-center justify-between px-4 py-3
                   rounded-xl border border-zinc-700 bg-zinc-900/40
                   hover:border-zinc-600 hover:bg-zinc-900/60 transition-colors group"
      >
        <div className="flex items-center gap-2.5">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />
          <span className="text-sm text-zinc-300">프리뷰 MP3 저장</span>
          <span className="text-xs text-zinc-700">320 kbps</span>
        </div>
        <span className="text-xs text-zinc-500 group-hover:text-zinc-400 transition-colors">
          저장
        </span>
      </button>

      {/* WAV — locked for free */}
      <button
        onClick={isPro ? handleSaveWav : () => setShowModal(true)}
        className={`no-drag w-full flex items-center justify-between px-4 py-3
                    rounded-xl border transition-colors
                    ${isPro
                      ? 'border-zinc-700 bg-zinc-900/40 hover:border-zinc-600 hover:bg-zinc-900/60 group'
                      : 'border-zinc-800 bg-zinc-900/20 opacity-70 cursor-default'
                    }`}
      >
        <div className="flex items-center gap-2.5">
          {isPro ? (
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />
          ) : (
            // Lock icon
            <svg className="w-3.5 h-3.5 text-zinc-600 shrink-0" viewBox="0 0 14 14"
                 fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
              <rect x="2.5" y="6" width="9" height="7" rx="1.5" />
              <path d="M4.5 6V4.5a2.5 2.5 0 0 1 5 0V6" />
            </svg>
          )}
          <span className={`text-sm ${isPro ? 'text-zinc-300' : 'text-zinc-600'}`}>
            마스터 WAV 저장
          </span>
          <span className="text-xs text-zinc-700">24-bit</span>
        </div>
        <span className={`text-xs ${
          isPro
            ? 'text-zinc-500 group-hover:text-zinc-400 transition-colors'
            : 'text-zinc-700'
        }`}>
          {isPro ? '저장' : '유료 플랜'}
        </span>
      </button>
    </div>
  );
}

// ── QC summary ────────────────────────────────────────────────────────────────

function QCSummary() {
  const result = useAudioStore((s) => s.masteringResult);
  if (!result) return null;

  const after = result.loudnessAfter;
  const targetLufs = -14.0;
  const targetTp   = -1.0;

  const lufsOk = Math.abs(after.integratedLufs - targetLufs) <= 1.0;
  const tpOk   = after.truePeakDbtp <= targetTp;

  const items = [
    { label: `-14 LUFS 달성`,  ok: lufsOk,
      note: `${after.integratedLufs.toFixed(1)} LUFS` },
    { label: `True Peak -1 dBTP 이하`, ok: tpOk,
      note: `${after.truePeakDbtp.toFixed(1)} dBTP` },
    { label: '처리 완료', ok: true, note: `${result.processingTimeSec.toFixed(1)}s` },
  ];

  return (
    <div className="rounded-xl bg-zinc-900/50 border border-zinc-800 p-4">
      <p className="text-xs text-zinc-600 uppercase tracking-wider mb-3">QC 결과</p>
      <div className="space-y-2">
        {items.map(({ label, ok, note }) => (
          <div key={label} className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className={`w-1.5 h-1.5 rounded-full ${ok ? 'bg-emerald-400' : 'bg-amber-400'}`} />
              <span className="text-xs text-zinc-400">{label}</span>
            </div>
            <span className="font-mono text-xs text-zinc-600">{note}</span>
          </div>
        ))}
      </div>
      {/* YouTube Music note */}
      <p className="mt-3 pt-3 border-t border-zinc-800 text-[11px] text-zinc-700 leading-snug">
        YouTube Music · Spotify · Apple Music 기본 타깃 −14 LUFS / −1 dBTP 기준 적용
      </p>
    </div>
  );
}

// ── ResultPage ────────────────────────────────────────────────────────────────

export default function ResultPage() {
  const setPage         = useAppStore((s) => s.setPage);
  const masteringResult = useAudioStore((s) => s.masteringResult);
  const reset           = useAudioStore((s) => s.reset);

  const handleNewFile = useCallback(() => {
    reset();
    setPage('home');
  }, [reset, setPage]);

  const previewSrc = masteringResult?.previewPath
    ? toFileUrl(masteringResult.previewPath)
    : '';

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <TopBar
        subtitle="결과"
        actions={
          <button
            onClick={handleNewFile}
            className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors"
          >
            새 파일
          </button>
        }
      />

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-lg mx-auto px-6 py-5 space-y-4 animate-in">

          <BeforeAfterCard />
          {previewSrc && <PreviewPlayer src={previewSrc} />}
          <SaveButtons />
          <QCSummary />

          <div className="h-4" />
        </div>
      </div>
    </div>
  );
}
