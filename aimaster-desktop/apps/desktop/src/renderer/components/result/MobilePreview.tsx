// Result — lightweight mobile A/B preview (mobile-only).
//
// Plays the ORIGINAL source vs the MASTER preview MP3 through a plain
// <audio> element — NO createMediaElementSource / WebAudio analyzer / native
// DSP (those are desktop-only and the source of the WASM analyzer panic).
// Just enough to let a mobile user hear before/after and decide save vs
// re-master.  No fine-tuning controls.
import React, { useCallback, useRef, useState } from 'react';
import { styleAccent } from '../../theme/loui-tokens.js';

interface Props {
  /** aimaster-local URL for the original source audio. */
  originalSrc: string;
  /** aimaster-local URL for the mastered preview (MP3). */
  masterSrc: string;
  styleKey: string;
}

function fmt(s: number): string {
  if (!Number.isFinite(s)) return '0:00';
  const m = Math.floor(s / 60);
  return `${m}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
}

export default function MobilePreview({ originalSrc, masterSrc, styleKey }: Props) {
  const accent = styleAccent(styleKey);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [which, setWhich] = useState<'orig' | 'master'>('master');
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0); // 0..1
  const [duration, setDuration] = useState(0);

  const src = which === 'master' ? masterSrc : originalSrc;

  const switchAB = useCallback((next: 'orig' | 'master') => {
    if (next === which) return;
    const a = audioRef.current;
    const wasPlaying = a ? !a.paused : false;
    const t = a?.currentTime ?? 0;
    setWhich(next);
    // After React swaps the src, restore the position (and resume) so the
    // A/B comparison stays at the same point in the track.
    requestAnimationFrame(() => {
      const el = audioRef.current;
      if (!el) return;
      const restore = () => {
        try { el.currentTime = t; } catch { /* ignore */ }
        if (wasPlaying) void el.play();
        el.removeEventListener('loadedmetadata', restore);
      };
      if (el.readyState >= 1) restore();
      else el.addEventListener('loadedmetadata', restore);
    });
  }, [which]);

  const togglePlay = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) void a.play(); else a.pause();
  }, []);

  const seek = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const a = audioRef.current;
    if (!a || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    a.currentTime = ((e.clientX - rect.left) / rect.width) * duration;
  }, [duration]);

  return (
    <div className="rounded-2xl bg-[#1A1A22] border border-zinc-700 p-4">
      <div className="text-[12px] text-zinc-500 font-bold tracking-[.14em] uppercase mb-3">미리듣기</div>

      {/* A/B toggle */}
      <div className="flex gap-[5px] p-[5px] rounded-xl border border-zinc-700 bg-[#15151D] mb-3">
        <button
          type="button"
          onClick={() => switchAB('orig')}
          className={`flex-1 py-[11px] rounded-[9px] text-[15px] font-bold ${which === 'orig' ? 'bg-[#20202A] text-zinc-100' : 'text-zinc-400'}`}
        >
          원본
        </button>
        <button
          type="button"
          onClick={() => switchAB('master')}
          className="flex-1 py-[11px] rounded-[9px] text-[15px] font-bold"
          style={which === 'master'
            ? { background: accent.grad, color: accent.isKpop ? '#1A0A10' : '#fff' }
            : { color: '#9A9AA8' }}
        >
          마스터
        </button>
      </div>

      {/* Transport */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={togglePlay}
          className="w-11 h-11 shrink-0 rounded-full bg-zinc-200 text-zinc-900 flex items-center justify-center"
          aria-label={playing ? '일시정지' : '재생'}
        >
          {playing ? (
            <svg className="w-4 h-4" viewBox="0 0 16 16" fill="currentColor"><rect x="3" y="2" width="3.5" height="12" rx="1" /><rect x="9.5" y="2" width="3.5" height="12" rx="1" /></svg>
          ) : (
            <svg className="w-4 h-4" viewBox="0 0 16 16" fill="currentColor"><path d="M4 2.5l10 5.5-10 5.5V2.5z" /></svg>
          )}
        </button>

        <div className="flex-1">
          <div className="h-2 rounded-full bg-[#16161E] cursor-pointer overflow-hidden" onClick={seek}>
            <div className="h-full rounded-full" style={{ width: `${progress * 100}%`, background: accent.grad }} />
          </div>
          <div className="flex justify-between mt-1">
            <span className="text-[11px] font-mono text-zinc-500">{fmt(progress * duration)}</span>
            <span className="text-[11px] font-mono text-zinc-600">{duration ? fmt(duration) : '--:--'}</span>
          </div>
        </div>
      </div>

      <p className="text-[12px] text-zinc-500 mt-2">
        지금 듣는 중: <span className="text-zinc-300 font-semibold">{which === 'master' ? '마스터' : '원본'}</span>
      </p>

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
          if (a && Number.isFinite(a.duration)) setDuration(a.duration);
        }}
      />
    </div>
  );
}
