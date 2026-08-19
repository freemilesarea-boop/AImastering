// DawMediaBay — the preset browser overlay (F5).
//
// Cubase's MediaBay browses samples and presets; the equivalent here is the
// mastering preset space: style, limiter strength, and the loudness targets
// for the common delivery platforms.  Everything applies instantly to the
// live preview chain.

import React from 'react';
import { useAudioStore } from '../../stores/audioStore.js';
import { useAppStore } from '../../stores/appStore.js';
import { useWorkspaceStore } from '../../stores/workspaceStore.js';
import type { MasteringStyle, LimiterStrength } from '@aimaster/shared-types';

const STYLES: Array<{ id: MasteringStyle; label: string; hint: string }> = [
  { id: 'balanced', label: 'Balanced', hint: '범용' },
  { id: 'warm',     label: 'Warm',     hint: '따뜻한' },
  { id: 'bright',   label: 'Bright',   hint: '선명한' },
  { id: 'punch',    label: 'Punch',    hint: '강한' },
];

const LIMITERS: Array<{ id: LimiterStrength; label: string }> = [
  { id: 'low', label: '약하게' }, { id: 'medium', label: '보통' }, { id: 'high', label: '강하게' },
];

const TARGETS: Array<{ label: string; lufs: number; tp: number }> = [
  { label: 'Spotify / YouTube', lufs: -14, tp: -1 },
  { label: 'Apple Music',       lufs: -16, tp: -1 },
  { label: 'Club / Loud',       lufs: -9,  tp: -0.8 },
  { label: 'CD Master',         lufs: -11, tp: -0.3 },
];

export default function DawMediaBay() {
  const options       = useAudioStore((s) => s.options);
  const setStyle      = useAudioStore((s) => s.setStyle);
  const updateOptions = useAudioStore((s) => s.updateOptions);
  const notify        = useAppStore((s) => s.notify);
  const setPanel      = useWorkspaceStore((s) => s.setPanel);

  const close = () => setPanel('mediaBay', false);

  return (
    <div
      onClick={close}
      className="fixed inset-0 z-[8000] flex items-center justify-center bg-black/65 backdrop-blur-sm"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[min(92vw,460px)] max-h-[80vh] overflow-y-auto rounded-2xl border border-zinc-700
                   bg-[#15151d] shadow-2xl px-5 py-4 space-y-4"
      >
        <div className="flex items-baseline justify-between">
          <p className="text-sm font-semibold text-zinc-100">MediaBay — 프리셋</p>
          <button onClick={close} className="text-zinc-500 hover:text-zinc-300 text-sm">×</button>
        </div>

        <section className="space-y-2">
          <p className="text-[10px] uppercase tracking-[0.14em] text-zinc-500">Style</p>
          <div className="grid grid-cols-2 gap-1.5">
            {STYLES.map((s) => (
              <button key={s.id} onClick={() => { setStyle(s.id); notify(`Style — ${s.label}`); }}
                className={`no-drag px-2 py-1.5 rounded-md text-left border transition-colors ${
                  options.style === s.id
                    ? 'bg-indigo-600/25 border-indigo-500/50 text-indigo-300'
                    : 'bg-zinc-800/60 border-zinc-700/60 text-zinc-400 hover:border-zinc-600'}`}>
                <span className="block text-[11px] font-medium">{s.label}</span>
                <span className="block text-[9px] opacity-60">{s.hint}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="space-y-2">
          <p className="text-[10px] uppercase tracking-[0.14em] text-zinc-500">라우드니스 타깃</p>
          <div className="grid grid-cols-2 gap-1.5">
            {TARGETS.map((t) => (
              <button key={t.label}
                onClick={() => { updateOptions({ targetLufs: t.lufs, targetTp: t.tp }); notify(`${t.label} — ${t.lufs} LUFS`); }}
                className={`no-drag px-2 py-1.5 rounded-md text-left border transition-colors ${
                  options.targetLufs === t.lufs
                    ? 'bg-emerald-600/20 border-emerald-500/50 text-emerald-300'
                    : 'bg-zinc-800/60 border-zinc-700/60 text-zinc-400 hover:border-zinc-600'}`}>
                <span className="block text-[11px] font-medium">{t.label}</span>
                <span className="block text-[9px] font-mono opacity-60">{t.lufs} LUFS · {t.tp} dBTP</span>
              </button>
            ))}
          </div>
        </section>

        <section className="space-y-2">
          <p className="text-[10px] uppercase tracking-[0.14em] text-zinc-500">Limiter</p>
          <div className="flex gap-1.5">
            {LIMITERS.map((l) => (
              <button key={l.id}
                onClick={() => { updateOptions({ limiterStrength: l.id }); notify(`Limiter — ${l.label}`); }}
                className={`no-drag flex-1 px-2 py-1.5 rounded-md text-[11px] border transition-colors ${
                  options.limiterStrength === l.id
                    ? 'bg-indigo-600/25 border-indigo-500/50 text-indigo-300'
                    : 'bg-zinc-800/60 border-zinc-700/60 text-zinc-400 hover:border-zinc-600'}`}>
                {l.label}
              </button>
            ))}
          </div>
        </section>

        <p className="text-[10px] text-zinc-700 text-center pt-1 border-t border-zinc-800">
          F5 또는 ESC 로 닫기
        </p>
      </div>
    </div>
  );
}
