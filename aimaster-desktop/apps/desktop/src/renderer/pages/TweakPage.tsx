/**
 * TweakPage — source audio preview before mastering.
 *
 * Reached via "조절하며 듣기" (page='tweak').  Only requires selectedFile;
 * masteringResult is NOT needed.  Falls back to HomePage if no file.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import TopBar from '../components/TopBar.js';
import { useAppStore } from '../stores/appStore.js';
import { useAudioStore } from '../stores/audioStore.js';
import { toFileUrl } from '../utils/fileUrl.js';

export default function TweakPage() {
  const setPage      = useAppStore((s) => s.setPage);
  const selectedFile = useAudioStore((s) => s.selectedFile);
  const analysis     = useAudioStore((s) => s.analysis);
  const options      = useAudioStore((s) => s.options);

  // eslint-disable-next-line no-console
  console.log('[TweakPage] render entered');
  // eslint-disable-next-line no-console
  console.log('[TweakPage] selectedFile:', selectedFile);

  // Belt-and-suspenders redirect — AppInner already does this but guard here too.
  useEffect(() => {
    if (!selectedFile) {
      // eslint-disable-next-line no-console
      console.warn('[TweakPage] missing selectedFile -> fallback home');
      setPage('home');
    }
  }, [selectedFile, setPage]);

  const audioRef               = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying]  = useState(false);
  const [time, setTime]        = useState(0);
  const [duration, setDuration] = useState(0);

  const handleBack = useCallback(() => { setPage('home'); }, [setPage]);

  const handleStartMastering = useCallback(() => {
    // MasteringPage handles the single-file mastering flow with current options.
    setPage('mastering');
  }, [setPage]);

  const togglePlay = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) { void a.play(); } else { a.pause(); }
  }, []);

  const handleSeek = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const a = audioRef.current;
    if (!a || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    a.currentTime = ((e.clientX - rect.left) / rect.width) * duration;
  }, [duration]);

  const fmtTime = (s: number) => {
    if (!Number.isFinite(s) || s < 0) return '0:00';
    return `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
  };

  // Guarded render — never show a blank/white screen
  if (!selectedFile) {
    return (
      <div style={{
        height: '100vh', background: '#09090b',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <p style={{ color: '#71717a', fontSize: '0.875rem' }}>음원을 선택하세요</p>
      </div>
    );
  }

  const fileName = selectedFile.split('/').pop()?.split('\\').pop() ?? selectedFile;
  const src      = toFileUrl(selectedFile);

  const lufsLabel = analysis?.loudness?.integratedLufs != null
    ? `${analysis.loudness.integratedLufs.toFixed(1)} LUFS (원본)`
    : null;

  return (
    <div className="h-screen flex flex-col overflow-hidden" style={{ background: '#09090b' }}>
      <TopBar
        subtitle="조절하며 듣기"
        actions={
          <button
            onClick={handleBack}
            className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors"
          >
            ← 돌아가기
          </button>
        }
      />

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-xl mx-auto px-6 py-6 space-y-4">

          {/* ── 파일 정보 ─────────────────────────────────────── */}
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 px-5 py-4">
            <p className="text-[10px] uppercase tracking-[0.16em] text-zinc-600 mb-1">소스 파일</p>
            <p className="text-sm font-medium text-zinc-100 truncate" title={selectedFile}>{fileName}</p>
            {lufsLabel && (
              <p className="text-[11px] text-zinc-500 mt-0.5 font-mono">{lufsLabel}</p>
            )}
          </div>

          {/* ── 오디오 플레이어 ──────────────────────────────── */}
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 px-5 py-4 space-y-3">
            <p className="text-[10px] uppercase tracking-[0.16em] text-zinc-600">미리 듣기</p>

            <audio
              ref={audioRef}
              src={src}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onEnded={() => { setPlaying(false); setTime(0); }}
              onTimeUpdate={() => {
                const a = audioRef.current;
                if (a) setTime(a.currentTime);
              }}
              onLoadedMetadata={() => {
                const a = audioRef.current;
                if (a) setDuration(a.duration);
              }}
            />

            <div className="flex items-center gap-3">
              <button
                onClick={togglePlay}
                className="w-9 h-9 rounded-full flex items-center justify-center
                           bg-zinc-700 hover:bg-zinc-600 text-zinc-200 shrink-0 transition-colors"
              >
                {playing ? (
                  <svg className="w-3.5 h-3.5" viewBox="0 0 12 12" fill="currentColor">
                    <rect x="2" y="1.5" width="2.5" height="9" rx="0.5" />
                    <rect x="7.5" y="1.5" width="2.5" height="9" rx="0.5" />
                  </svg>
                ) : (
                  <svg className="w-3.5 h-3.5" viewBox="0 0 12 12" fill="currentColor">
                    <path d="M3 2l7 4-7 4V2z" />
                  </svg>
                )}
              </button>

              <div className="flex-1 space-y-1">
                <div
                  className="h-1.5 rounded-full bg-zinc-800 cursor-pointer overflow-hidden"
                  onClick={handleSeek}
                >
                  <div
                    className="h-full rounded-full bg-zinc-500 transition-none"
                    style={{ width: duration > 0 ? `${(time / duration) * 100}%` : '0%' }}
                  />
                </div>
                <div className="flex justify-between text-[10px] font-mono text-zinc-600">
                  <span>{fmtTime(time)}</span>
                  <span>{duration > 0 ? fmtTime(duration) : '--:--'}</span>
                </div>
              </div>
            </div>
          </div>

          {/* ── 마스터링 설정 (현재 값 표시) ────────────────── */}
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 px-5 py-4">
            <p className="text-[10px] uppercase tracking-[0.16em] text-zinc-600 mb-3">현재 마스터링 설정</p>
            <div className="grid grid-cols-2 gap-y-2 gap-x-4 text-xs">
              {[
                ['스타일',        options.style],
                ['목표 라우드니스', `${options.targetLufs} LUFS`],
                ['True Peak',    `${options.targetTp} dBTP`],
                ['리미터',        options.limiterStrength],
              ].map(([label, value]) => (
                <div key={label} className="flex gap-1.5">
                  <span className="text-zinc-600">{label}</span>
                  <span className="text-zinc-200 font-medium capitalize">{value}</span>
                </div>
              ))}
            </div>
            <p className="mt-3 text-[11px] text-zinc-600">
              홈 화면에서 설정을 변경할 수 있습니다.
            </p>
          </div>

          {/* ── EQ / Dynamics / Stereo / Loudness 자리 ──────── */}
          {['EQ', 'Dynamics', 'Stereo', 'Loudness'].map((section) => (
            <div
              key={section}
              className="rounded-xl border border-zinc-800/50 bg-zinc-900/20 px-5 py-3
                         flex items-center justify-between"
            >
              <p className="text-xs font-medium text-zinc-500">{section}</p>
              <p className="text-[10px] text-zinc-700">마스터링 완료 후 세밀 조절 가능</p>
            </div>
          ))}

          {/* ── 마스터링 시작 버튼 ────────────────────────────── */}
          <button
            onClick={handleStartMastering}
            className="no-drag w-full py-3 rounded-2xl text-sm font-semibold transition-all
                       hover:opacity-90 active:scale-[0.98]"
            style={{
              background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
              color: '#fff',
              border: '1px solid rgba(99,102,241,0.4)',
            }}
          >
            마스터링 시작
          </button>

          <p className="text-[11px] text-zinc-700 text-center pb-4">
            마스터링 완료 후 결과 페이지에서 EQ · Dynamics · Stereo를 실시간으로 조절할 수 있습니다.
          </p>

        </div>
      </div>
    </div>
  );
}
