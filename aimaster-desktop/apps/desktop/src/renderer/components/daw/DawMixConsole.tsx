// DawMixConsole — the bottom "mixer" strip (F3).
//
// A mastering session has one stereo bus, so the channels here are the four
// chain modules plus the master.  Each strip toggles that module's realtime
// bypass, which the native DSP chain picks up immediately — the fastest way
// to hear what a single module is contributing.

import React from 'react';
import { useAudioStore } from '../../stores/audioStore.js';
import { useWorkspaceStore } from '../../stores/workspaceStore.js';
import { useAppStore } from '../../stores/appStore.js';
import type { RealtimeDspOverrides } from '../../stores/audioStore.js';

type BypassKey = 'eqBypass' | 'dynBypass' | 'imgBypass' | 'limBypass';

const STRIPS: Array<{ key: BypassKey; label: string; hint: string }> = [
  { key: 'eqBypass',  label: 'EQ',      hint: 'Low Cut · Shelf · Presence · Air' },
  { key: 'dynBypass', label: 'DYN',     hint: 'Threshold · Ratio · Attack · Release' },
  { key: 'imgBypass', label: 'IMAGER',  hint: 'Width · Low Mono' },
  { key: 'limBypass', label: 'LIMITER', hint: 'Ceiling · True Peak' },
];

export default function DawMixConsole() {
  const options       = useAudioStore((s) => s.options);
  const updateOptions = useAudioStore((s) => s.updateOptions);
  const muted         = useWorkspaceStore((s) => s.muted);
  const setMuted      = useWorkspaceStore((s) => s.setMuted);
  const notify        = useAppStore((s) => s.notify);

  const rt: RealtimeDspOverrides = options.rt ?? {};
  const patch = (p: Partial<RealtimeDspOverrides>) => updateOptions({ rt: { ...rt, ...p } });

  return (
    <div className="border-t border-zinc-800 bg-[#0d0d14]/95 px-3 py-2">
      <div className="flex items-stretch gap-2 overflow-x-auto">
        {STRIPS.map((s) => {
          const bypassed = rt[s.key] ?? false;
          return (
            <div key={s.key}
                 className="min-w-[104px] rounded-md border border-zinc-800 bg-zinc-900/60 px-2 py-1.5">
              <p className="text-[10px] uppercase tracking-[0.14em] text-zinc-400 font-semibold">{s.label}</p>
              <p className="text-[9px] text-zinc-700 truncate" title={s.hint}>{s.hint}</p>
              <button
                type="button"
                onClick={() => patch({ [s.key]: !bypassed } as Partial<RealtimeDspOverrides>)}
                className={`no-drag mt-1.5 w-full h-6 rounded text-[10px] border transition-colors
                            ${bypassed
                              ? 'bg-amber-600/25 border-amber-500/50 text-amber-300'
                              : 'bg-zinc-800/60 border-zinc-700 text-zinc-400 hover:text-zinc-200'}`}
              >
                {bypassed ? 'BYPASS' : 'ACTIVE'}
              </button>
            </div>
          );
        })}

        {/* Master strip */}
        <div className="min-w-[128px] rounded-md border border-zinc-700 bg-zinc-900/80 px-2 py-1.5">
          <p className="text-[10px] uppercase tracking-[0.14em] text-zinc-200 font-semibold">MASTER</p>
          <p className="text-[9px] text-zinc-700 truncate">
            {(options.outputGainDb ?? 0) >= 0 ? '+' : ''}{(options.outputGainDb ?? 0).toFixed(1)} dB · {options.targetLufs} LUFS
          </p>
          <div className="mt-1.5 flex gap-1">
            <button
              type="button"
              title="원본 솔로 — 마스터 체인 바이패스 (S)"
              onClick={() => patch({ masterBypass: !(rt.masterBypass ?? false) })}
              className={`no-drag flex-1 h-6 rounded text-[10px] border transition-colors
                          ${rt.masterBypass
                            ? 'bg-indigo-600/25 border-indigo-500/50 text-indigo-300'
                            : 'bg-zinc-800/60 border-zinc-700 text-zinc-400 hover:text-zinc-200'}`}
            >S</button>
            <button
              type="button"
              title="뮤트 (M)"
              onClick={() => setMuted(!muted)}
              className={`no-drag flex-1 h-6 rounded text-[10px] border transition-colors
                          ${muted
                            ? 'bg-red-600/25 border-red-500/50 text-red-300'
                            : 'bg-zinc-800/60 border-zinc-700 text-zinc-400 hover:text-zinc-200'}`}
            >M</button>
            <button
              type="button"
              title="모든 Solo / Mute 해제 (Alt+S)"
              onClick={() => {
                setMuted(false);
                patch({ masterBypass: false, eqBypass: false, dynBypass: false, imgBypass: false, limBypass: false });
                notify('모든 Bypass / Mute 해제');
              }}
              className="no-drag flex-1 h-6 rounded text-[10px] border bg-zinc-800/60
                         border-zinc-700 text-zinc-400 hover:text-zinc-200 transition-colors"
            >RST</button>
          </div>
        </div>
      </div>
    </div>
  );
}
